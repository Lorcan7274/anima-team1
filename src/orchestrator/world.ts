/**
 * World setup: create/join a world and stage the demo narrative.
 *
 * Verified stage machine: assign (clinician) -> assess -> refer -> admit
 * (free-text location ok) -> discharge. Always re-read for resourceId +
 * expectedVersion between steps.
 */
import { randomBytes } from 'node:crypto'
import { SimClient } from '../sim/index.ts'

const ORIGIN = process.env.SIM_ORIGIN?.replace(/\/+$/, '') || 'https://sim.animahealth.com'

export function randomWorldName(): string {
  // Team names are JOIN CODES — anyone who guesses one can enter the world.
  return `discharge-${randomBytes(6).toString('hex')}`
}

export async function joinWorld(worldName: string): Promise<{ sim: SimClient; world: string }> {
  const bootstrap = new SimClient({ origin: ORIGIN })
  const created = (await bootstrap.createTeam(worldName)) as { apiKey: string }
  return { sim: bootstrap.withKey(created.apiKey), world: worldName }
}

interface Attendance {
  id: string
  version: number
  data?: { stage?: string; [key: string]: unknown }
  [key: string]: unknown
}

async function readAttendance(sim: SimClient, patientId: string): Promise<Attendance | undefined> {
  const view = await sim.siteView('hospital', { patient: patientId, limit: 100 })
  return (view.resources ?? []).find((r: any) => r.kind === 'hospital-attendance') as Attendance | undefined
}

async function stageStep(sim: SimClient, patientId: string, att: Attendance, cmd: string, extra: Record<string, unknown>, keyPrefix: string) {
  await sim.siteAction(
    'hospital',
    { type: 'update_attendance', patientId, resourceId: att.id, expectedVersion: att.version, hospitalCommand: cmd, ...extra },
    `${keyPrefix}-${cmd}-1`,
  )
}

/**
 * Walk an attendance to inpatient. Skips steps already done, so it is safe on
 * seeded attendances at any stage and on re-runs.
 */
export async function admitToWard(sim: SimClient, patientId: string, location: string, clinician = 'Dr Ada Sim 0'): Promise<void> {
  const ORDER = ['waiting', 'assessing', 'take', 'inpatient', 'discharged']
  const NEXT: Record<string, [string, Record<string, unknown>]> = {
    waiting: ['assign', { clinician }],
    assigned: ['assess', {}],
    assessing: ['refer', {}],
    take: ['admit', { location }],
  }
  for (let guard = 0; guard < 6; guard++) {
    const att = await readAttendance(sim, patientId)
    if (!att) throw new Error(`no attendance for ${patientId}`)
    const stage = att.data?.stage ?? 'waiting'
    if (ORDER.indexOf(stage) >= ORDER.indexOf('inpatient')) return
    // 'assign' does not change the stage (still waiting) — detect by clinician set.
    const step = stage === 'waiting' && (att.data as any)?.clinician !== 'Unassigned' ? NEXT['assigned'] : NEXT[stage]
    if (!step) throw new Error(`no next step from stage ${stage}`)
    await stageStep(sim, patientId, att, step[0], step[1], `setup-${patientId}`)
  }
  throw new Error(`admitToWard did not converge for ${patientId}`)
}

/** Register a directory patient and admit them, to grow the ward (verified). */
export async function registerAndAdmit(sim: SimClient, patientId: string, complaint: string, location: string): Promise<void> {
  const existing = await readAttendance(sim, patientId)
  if (!existing) {
    await sim.siteAction(
      'hospital',
      { type: 'register_attendance', patientId, title: complaint, presentingComplaint: complaint, acuity: '3', location: 'Waiting room' },
      `setup-reg-${patientId}-1`,
    )
  }
  await admitToWard(sim, patientId, location)
}

/** Final demo beat: discharge an inpatient attendance (verified). */
export async function dischargeAttendance(sim: SimClient, patientId: string, disposition: string): Promise<void> {
  const att = await readAttendance(sim, patientId)
  if (!att) throw new Error(`no attendance for ${patientId}`)
  if (att.data?.stage === 'discharged') return
  await stageStep(sim, patientId, att, 'discharge', { disposition }, `finale-${patientId}`)
}
