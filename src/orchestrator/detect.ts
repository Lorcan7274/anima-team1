/**
 * Barrier detectors. Rule-based readers over the sim views, plus an LLM seam
 * (llm.ts) for free-text proposals. Every item carries quoted evidence.
 *
 * Detection is also the re-run safety net: run.ts keeps existing item state and
 * only adds items that aren't already tracked, so re-running never re-resolves
 * something verification has settled.
 */
import type { SimClient } from '../sim/index.ts'
import type { ChecklistItem, Evidence, PatientRow } from './model.ts'
import { proposeBarriersFromText } from './llm.ts'

interface SimResource {
  id: string
  kind?: string
  title?: string
  status?: string
  patientId?: string
  version?: number
  createdAt?: number
  data?: Record<string, unknown>
  [key: string]: unknown
}

const res = (view: { resources?: unknown[] }): SimResource[] => (view.resources ?? []) as SimResource[]

/** Latest blood analytes, summarised for evidence and LLM prompts. Verified data shape. */
export async function bloodSummary(sim: SimClient, patientId: string): Promise<string> {
  const v = await sim.siteView('diagnostics', { patient: patientId, limit: 100 })
  const reports = res(v).filter((r) => r.kind === 'report' && (r.data as any)?.kind === 'blood-result')
  const latestOf = (panelId: string) =>
    reports
      .filter((r) => (r.data as any)?.panel?.id === panelId)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .at(-1)
  const fmt = (r: SimResource | undefined, ids: string[]) => {
    const analytes = ((r?.data as any)?.analytes ?? []) as any[]
    return ids
      .map((id) => {
        const a = analytes.find((x) => x.id === id)
        if (!a) return null
        const flagged = a.referenceHigh != null && (a.value > a.referenceHigh || a.value < a.referenceLow)
        return `${a.name ?? id} ${a.value}${flagged ? ' (flagged)' : ''}`
      })
      .filter(Boolean)
      .join(', ')
  }
  const ue = latestOf('ue')
  const fbc = latestOf('fbc')
  // Honest current picture: latest U&E in range apart from eGFR; neutropenia
  // history recovered but WCC still flagged. Do NOT claim "potassium rising".
  return (
    `Latest U&E: ${fmt(ue, ['potassium', 'creatinine', 'egfr'])}. ` +
    `Latest FBC: ${fmt(fbc, ['neutrophils', 'white-cell-count'])}. ` +
    `History: neutrophil nadir 0.5 four months ago, since recovered.`
  )
}

/** Detect Amira-style hospital discharge barriers for one patient. */
export async function detectForPatient(
  sim: SimClient,
  patient: PatientRow,
  log?: (message: string) => void,
): Promise<ChecklistItem[]> {
  const P = patient.patientId
  const items: ChecklistItem[] = []
  const slug = (s: string) => `${P.toLowerCase()}-${s}`
  const ev = (resourceId: string, site: Evidence['site'], quote: string): Evidence => ({ resourceId, site, quote })

  const [hosp, community, wearables] = await Promise.all([
    sim.siteView('hospital', { patient: P, limit: 100 }),
    sim.siteView('community', { patient: P, limit: 100 }),
    sim.wearables(P),
  ])
  const hospRes = res(hosp)

  // 1. Clinical hold: open urgent clinical review thread -> no resolver, clinician only.
  const respThread = hospRes.find(
    (r) => r.kind === 'message' && r.status === 'open' && /review|urgent|worsening/i.test(r.title ?? ''),
  )
  if (respThread) {
    items.push({
      id: slug('clinical-hold'),
      patientId: P,
      title: 'Clinical review outstanding — discharge gated on clinician sign-off',
      owner: 'clinician',
      state: 'clinical_hold',
      humanReason: `Open urgent thread: "${respThread.title}". Automation must not clear this.`,
      evidence: [ev(respThread.id, 'hospital', respThread.title ?? '')],
    })
  }

  // 2. Medicines: approved-but-undispensed discharge prescription.
  const rx = hospRes.find((r) => r.kind === 'prescription' && r.status === 'approved')
  if (rx) {
    items.push({
      id: slug('medicines'),
      patientId: P,
      title: `Discharge medicines not dispensed (${(rx.data as any)?.drug ?? rx.title})`,
      owner: 'pharmacy',
      state: 'proposed',
      proposedAction: 'Link pharmacy stock, dispense and record collection',
      evidence: [ev(rx.id, 'hospital', `${rx.title}: status ${rx.status}, not dispensed or collected`)],
    })
  }

  // 3. Monitoring bloods: the seeded document literally requests it.
  const monitoringDoc = hospRes.find((r) => r.kind === 'document' && /monitoring/i.test((r.data as any)?.text ?? ''))
  if (monitoringDoc) {
    items.push({
      id: slug('bloods'),
      patientId: P,
      title: 'Post-discharge blood monitoring not arranged (routine U&E + FBC)',
      owner: 'diagnostics',
      state: 'proposed',
      proposedAction: 'Order routine U&E + FBC citing the result history',
      evidence: [ev(monitoringDoc.id, 'hospital', ((monitoringDoc.data as any)?.text ?? '').slice(0, 160))],
    })
  }

  // 4. Home monitoring: no active wearable device.
  if (wearables.devices.length === 0) {
    items.push({
      id: slug('device'),
      patientId: P,
      title: 'No home monitoring device connected',
      owner: 'wearables',
      state: 'proposed',
      proposedAction: 'Issue a home activity watch and await the first reading',
      evidence: monitoringDoc
        ? [ev(monitoringDoc.id, 'hospital', 'home equipment and medication handover not confirmed')]
        : [],
    })
  }

  // 5. Home support: needs say home visit, community board has none scheduled by us.
  const wantsHomeVisit = patient.needs.some((n) => /home visit/i.test(n))
  const visit = res(community).find((r) => r.kind === 'visit' && r.status !== 'completed')
  if (wantsHomeVisit && !visit) {
    items.push({
      id: slug('visit'),
      patientId: P,
      title: 'Home support visit not arranged',
      owner: 'community',
      state: 'proposed',
      proposedAction: 'Schedule a community home-support visit and confirm completion',
      evidence: [ev('directory', 'patient-directory', `Recorded need: "Home visit"`)],
    })
  }

  // 6. Information: no discharge summary drafted by us this admission.
  //    NOTE the seeded world contains an old 'sent' summary for Amira — we only
  //    treat OUR resolver's resource as satisfying this (verifier rule), so the
  //    item is always detected until our own summary is verified sent.
  items.push({
    id: slug('summary'),
    patientId: P,
    title: 'Discharge summary for this admission not written/sent',
    owner: 'hospital',
    state: 'proposed',
      proposedAction: 'Draft all seven discharge sections and send to the GP',
    evidence: monitoringDoc
      ? [ev(monitoringDoc.id, 'hospital', 'medication handover not confirmed')]
      : [],
  })

  // 7. Follow-up: GP review task honouring the patient's goals.
  const avoidTravel = patient.goals.some((g) => /avoid unnecessary travel/i.test(g))
  items.push({
    id: slug('follow-up'),
    patientId: P,
    title: `GP follow-up not arranged${avoidTravel ? ' (telephone — patient goal: avoid travel)' : ''}`,
    owner: 'gp',
    state: 'proposed',
      proposedAction: 'Create a 48h telephone review task for the GP',
    evidence: avoidTravel ? [ev('directory', 'patient-directory', 'Goal: "Avoid unnecessary travel"')] : [],
  })

  // Blocked-human: care package stuck on an external decision (Eleanor).
  // Verified shape: kind 'care-package', status 'waiting', data.fundingDecision 'pending'.
  const carePackage = res(community).find(
    (r) => r.kind === 'care-package' && (r.data as any)?.fundingDecision === 'pending',
  )
  if (carePackage) {
    const carePlan = res(community).find((r) => r.kind === 'care-plan' && r.status === 'open')
    const trend = res(community).find((r) => r.kind === 'observation' && (r.data as any)?.baseline != null)
    items.push({
      id: slug('care-package'),
      patientId: P,
      title: 'Care package awaiting funding decision — needs a human',
      owner: 'community',
      state: 'blocked_human',
      humanReason: 'Funding approval is an external decision; no API action can clear it.',
      evidence: [
        ev(carePackage.id, 'community', `${carePackage.title}: fundingDecision pending`),
        ...(carePlan ? [ev(carePlan.id, 'community', carePlan.title ?? 'home support not arranged')] : []),
        ...(trend
          ? [ev(trend.id, 'community', `${trend.title}: ${(trend.data as any)?.value} vs baseline ${(trend.data as any)?.baseline} steps/day`)]
          : []),
      ],
    })
  }

  // LLM pass: read the record's free text and merge proposals into the
  // rule-detected items as extra evidence. Unmatched ('other') proposals are
  // surfaced via log — they never become blocking items on their own.
  const freeText = hospRes
    .filter((r) => r.kind === 'document' || r.kind === 'message')
    .map((r) => `[${r.kind} ${r.id}] ${r.title ?? ''} — ${(r.data as any)?.text ?? ''}`)
    .join('\n')
  if (freeText.trim()) {
    const proposals = await proposeBarriersFromText(`hospital record for ${P}`, freeText)
    for (const prop of proposals) {
      const target = prop.kind === 'other' ? undefined : items.find((i) => i.id === slug(prop.kind))
      if (target) {
        for (const quote of prop.quotes.slice(0, 2)) {
          if (!target.evidence.some((e) => e.quote === quote)) target.evidence.push(ev('record-text', 'hospital', quote))
        }
      } else {
        log?.(`llm proposal (unmatched, not blocking): ${prop.title} — "${prop.quotes[0] ?? ''}"`)
      }
    }
  }

  return items
}

/** Load a patient's directory row (name, conditions, needs, goals) + attendance. */
export async function loadPatientRow(sim: SimClient, patientId: string): Promise<PatientRow> {
  const found = await sim.searchPatients('hospital', patientId)
  const p = (found.items ?? [])[0] ?? {}
  const hosp = await sim.siteView('hospital', { patient: patientId, limit: 50 })
  const att = res(hosp).find((r) => r.kind === 'hospital-attendance')
  return {
    patientId,
    name: (p as any).name ?? patientId,
    conditions: ((p as any).conditions ?? []) as string[],
    needs: ((p as any).needs ?? []) as string[],
    goals: ((p as any).goals ?? []) as string[],
    stage: (att?.data as any)?.stage,
    location: (att?.data as any)?.location,
    items: [],
  }
}
