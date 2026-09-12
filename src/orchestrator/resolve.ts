/**
 * Resolvers: one per checklist item type. A resolver ACTS in the owning service
 * and returns the Resolution (action + created resourceId + idempotency key).
 * It never marks anything verified — that's verify.ts, after time moves.
 *
 * Verified mechanics (see brief): siteAction targets use resourceId +
 * expectedVersion; idempotency keys are per-attempt.
 */
import type { ChecklistItem, OrchestratorContext, Resolution } from './model.ts'
import { bloodSummary } from './detect.ts'
import { draftClinicalDetails, draftDischargeSummary } from './llm.ts'

type Resolver = (ctx: OrchestratorContext, item: ChecklistItem) => Promise<Resolution>

const key = (ctx: OrchestratorContext, item: ChecklistItem, step: string) =>
  `${ctx.world}-${item.id}-${step}-1`

const simNow = async (ctx: OrchestratorContext) => Number((await ctx.sim.clock()).now)

/** Routine U&E order citing the real trend. Verified: open -> available by +121 min. */
const resolveBloods: Resolver = async (ctx, item) => {
  const summary = await bloodSummary(ctx.sim, item.patientId)
  const details = await draftClinicalDetails(summary)
  // TODO(team): add a second order for FBC (neutropenia history) — same shape, panelId 'fbc'.
  const order = await ctx.sim.orderBloodTest(
    'hospital',
    item.patientId,
    'Post-discharge U&E',
    {
      panelId: 'ue',
      panel: 'Urea & electrolytes',
      specimen: 'blood',
      priority: 'routine', // routine, not urgent: yesterday's U&E was near-normal
      collection: 'now',
      clinicalDetails: details,
    },
    key(ctx, item, 'order'),
  )
  return { action: 'order_test', resourceId: order.id, idempotencyKey: key(ctx, item, 'order'), atSimTime: await simNow(ctx) }
}

/** Verified: first reading arrives +10 min after connect. */
const resolveDevice: Resolver = async (ctx, item) => {
  const device = await ctx.sim.connectDevice(item.patientId, 'Home activity watch', key(ctx, item, 'connect'))
  return { action: 'connect_device', resourceId: device.id, idempotencyKey: key(ctx, item, 'connect'), atSimTime: await simNow(ctx) }
}

/** Verified: visit lands on community board, completes within the 121-min advance. */
const resolveVisit: Resolver = async (ctx, item) => {
  const visit = await ctx.sim.siteAction(
    'hospital',
    { type: 'schedule_visit', patientId: item.patientId, title: 'Post-discharge home support visit' },
    key(ctx, item, 'visit'),
  )
  return { action: 'schedule_visit', resourceId: visit.id, idempotencyKey: key(ctx, item, 'visit'), atSimTime: await simNow(ctx) }
}

/** Verified two-step: save draft (hospital-only) then process_document send -> GP inbox. */
const resolveSummary: Resolver = async (ctx, item) => {
  const row = ctx.board.patients.find((p) => p.patientId === item.patientId)
  const bloods = await bloodSummary(ctx.sim, item.patientId)
  const sections = await draftDischargeSummary({
    patientName: row?.name ?? item.patientId,
    conditions: row?.conditions ?? [],
    documentTexts: item.evidence.map((e) => e.quote),
    bloodSummary: bloods,
    planned: [
      'Community home-support visit booked.',
      'Home activity watch issued.',
      'GP telephone review within 48h.',
    ],
  })
  const saved = await ctx.sim.siteAction(
    'hospital',
    { type: 'save_discharge_summary', patientId: item.patientId, title: `Discharge summary - ${row?.name ?? item.patientId}`, dischargeSections: sections },
    key(ctx, item, 'save'),
  )
  await ctx.sim.siteAction(
    'hospital',
    { type: 'process_document', patientId: item.patientId, resourceId: saved.id, expectedVersion: saved.version, documentCommand: 'send' },
    key(ctx, item, 'send'),
  )
  // TODO(team): share_record to community for the summary + the seeded r-1 document (UNTESTED).
  return { action: 'save_discharge_summary+send', resourceId: saved.id, idempotencyKey: key(ctx, item, 'save'), atSimTime: await simNow(ctx) }
}

/** Verified: create_task. TODO: rebook today's 08:15 in-person as telephone (UNTESTED). */
const resolveFollowUp: Resolver = async (ctx, item) => {
  const task = await ctx.sim.createTask(
    'gp',
    item.patientId,
    'Post-discharge telephone review within 48h',
    key(ctx, item, 'task'),
  )
  // TODO(team): cancel_appointment + book_appointment {mode:'telephone'} — check
  // schemas in /api/openapi.json first, smoke-test in a scratch world.
  return { action: 'create_task', resourceId: task.id, idempotencyKey: key(ctx, item, 'task'), atSimTime: await simNow(ctx) }
}

/** UNTESTED pharmacy chain — throws so the item shows 'failed' in the UI until built. */
const resolveMedicines: Resolver = async () => {
  // TODO(team): prescription is already 'approved', so the chain should be
  // link_prescription_stock -> dispense -> collect on the pharmacy site.
  // Pull payloads from /api/openapi.json (pharmacyCommand enum) and smoke-test
  // in a scratch world before wiring here.
  throw new Error('medicines resolver not implemented yet (pharmacy chain untested)')
}

/** item.id suffix -> resolver. clinical_hold / blocked_human items have none by design. */
export function resolverFor(item: ChecklistItem): Resolver | undefined {
  if (item.id.endsWith('-bloods')) return resolveBloods
  if (item.id.endsWith('-device')) return resolveDevice
  if (item.id.endsWith('-visit')) return resolveVisit
  if (item.id.endsWith('-summary')) return resolveSummary
  if (item.id.endsWith('-follow-up')) return resolveFollowUp
  if (item.id.endsWith('-medicines')) return resolveMedicines
  return undefined
}
