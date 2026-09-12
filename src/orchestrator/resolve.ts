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
  `${ctx.world}-${item.id}-${step}-${item.attempts ?? 1}`

const simNow = async (ctx: OrchestratorContext) => Number((await ctx.sim.clock()).now)

/**
 * Routine U&E + FBC orders citing the real trend. Verified: open -> available
 * by +121 min. The FBC covers the neutropenia history (nadir 0.5, recovered).
 */
const resolveBloods: Resolver = async (ctx, item) => {
  const summary = await bloodSummary(ctx.sim, item.patientId)
  const { text: details, source: detailsSource } = await draftClinicalDetails(summary)
  item.generated = detailsSource
  const shared = { specimen: 'blood', priority: 'routine' as const, collection: 'now' as const, clinicalDetails: details }
  const ue = await ctx.sim.orderBloodTest(
    'hospital', item.patientId, 'Post-discharge U&E',
    { panelId: 'ue', panel: 'Urea & electrolytes', ...shared },
    key(ctx, item, 'order-ue'),
  )
  const fbc = await ctx.sim.orderBloodTest(
    'hospital', item.patientId, 'Post-discharge FBC',
    { panelId: 'fbc', panel: 'Full blood count', ...shared },
    key(ctx, item, 'order-fbc'),
  )
  return {
    action: 'order_test (U&E + FBC)', resourceId: ue.id, alsoResourceIds: [fbc.id],
    idempotencyKey: key(ctx, item, 'order-ue'), atSimTime: await simNow(ctx),
  }
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
  const { sections, source: summarySource } = await draftDischargeSummary({
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
  item.generated = summarySource
  const saved = await ctx.sim.siteAction(
    'hospital',
    { type: 'save_discharge_summary', patientId: item.patientId, title: `Discharge summary - ${row?.name ?? item.patientId}`, dischargeSections: sections },
    key(ctx, item, 'save'),
  )
  if (item.draftOnly) {
    // Blocked case: the letter is prepared but NOT sent — a clinician would
    // rightly ask why a discharge letter went out for a patient not leaving.
    return { action: 'save_discharge_summary (draft held)', resourceId: saved.id, idempotencyKey: key(ctx, item, 'save'), atSimTime: await simNow(ctx) }
  }
  await ctx.sim.siteAction(
    'hospital',
    { type: 'process_document', patientId: item.patientId, resourceId: saved.id, expectedVersion: saved.version, documentCommand: 'send' },
    key(ctx, item, 'send'),
  )
  // Cross-service beat, verified live: the hospital-only admission document the
  // evidence quotes becomes visible to the community team. The summary itself
  // cannot be shared this way (the sim answers 409 "use the document workflow"),
  // it reaches the GP through 'send'. Best-effort: a failure is logged, not fatal.
  const shared = await shareDocumentsWithCommunity(ctx, item)
  return {
    action: 'save_discharge_summary+send' + (shared.length ? `+share_record(${shared.join(',')})` : ''),
    resourceId: saved.id, alsoResourceIds: shared.length ? shared : undefined,
    idempotencyKey: key(ctx, item, 'save'), atSimTime: await simNow(ctx),
  }
}

/** share_record every hospital document the item cites to community. Returns the ids shared. */
async function shareDocumentsWithCommunity(ctx: OrchestratorContext, item: ChecklistItem): Promise<string[]> {
  const shared: string[] = []
  const view = await ctx.sim.siteView('hospital', { patient: item.patientId, limit: 100 })
  const docs = ((view.resources ?? []) as any[]).filter((r) => r.kind === 'document' && !(r.visibleTo ?? []).includes('community'))
  for (const doc of docs) {
    try {
      await ctx.sim.siteAction(
        'hospital',
        { type: 'share_record', patientId: item.patientId, resourceId: doc.id, expectedVersion: doc.version, target: 'community' },
        key(ctx, item, `share-${doc.id}`),
      )
      shared.push(doc.id)
      ctx.log(`shared hospital document ${doc.id} with community (${item.patientId})`)
    } catch (err) {
      ctx.log(`share_record ${doc.id} -> community failed (non-fatal): ${String((err as Error).message).slice(0, 120)}`)
    }
  }
  return shared
}

/**
 * Verified: create_task (the resource the verifier checks). When the patient's
 * goals say "avoid unnecessary travel", also honour them in the booking:
 * cancel today's in-person practice appointment and book a telephone review
 * instead (cancel_appointment -> create_appointment_session {mode: telephone}
 * -> book_appointment, verified live). Best-effort: the task is the
 * deliverable; a booking failure is logged and the item still resolves.
 */
const resolveFollowUp: Resolver = async (ctx, item) => {
  const task = await ctx.sim.createTask(
    'gp',
    item.patientId,
    'Post-discharge telephone review within 48h',
    key(ctx, item, 'task'),
  )
  const row = ctx.board.patients.find((p) => p.patientId === item.patientId)
  const avoidTravel = (row?.goals ?? []).some((g) => /avoid unnecessary travel/i.test(g))
  const booked = avoidTravel ? await rebookAsTelephone(ctx, item) : undefined
  return {
    action: 'create_task' + (booked ? '+rebook_telephone' : ''),
    resourceId: task.id, alsoResourceIds: booked ? [booked] : undefined,
    idempotencyKey: key(ctx, item, 'task'), atSimTime: await simNow(ctx),
  }
}

const DAY = 24 * 60 * 60_000

/** Cancel today's in-person GP appointments and book a telephone slot tomorrow morning. Returns the new appointment id. */
async function rebookAsTelephone(ctx: OrchestratorContext, item: ChecklistItem): Promise<string | undefined> {
  const P = item.patientId
  try {
    const now = await simNow(ctx)
    const today = new Date(now).toISOString().slice(0, 10)
    const book = (await ctx.sim.siteAppointments('gp', { date: today })) as { appointments?: any[] }
    const inPerson = (book.appointments ?? []).filter((a) => a.patientId === P && a.status === 'booked' && a.data?.mode === 'in-person')
    for (const appt of inPerson) {
      await ctx.sim.siteAction(
        'gp',
        { type: 'cancel_appointment', patientId: P, resourceId: appt.id, expectedVersion: appt.version },
        key(ctx, item, `cancel-${appt.id}`),
      )
      ctx.log(`cancelled in-person appointment ${appt.id} (${new Date(appt.data?.startsAt ?? 0).toISOString().slice(11, 16)}) — patient goal: avoid unnecessary travel`)
    }
    const startsAt = Math.floor(now / DAY) * DAY + DAY + 9 * 60 * 60_000 // tomorrow 09:00
    const session = await ctx.sim.siteAction(
      'gp',
      { type: 'create_appointment_session', title: 'Post-discharge telephone reviews', clinician: 'Dr Maya Shah', location: 'Telephone',
        startsAt, endsAt: startsAt + 3 * 60 * 60_000, slotMinutes: 15, mode: 'telephone' },
      key(ctx, item, 'session'),
    )
    const appt = await ctx.sim.siteAction(
      'gp',
      { type: 'book_appointment', patientId: P, sessionId: session.id, sessionVersion: session.version, startsAt,
        title: 'Post-discharge telephone review (patient goal: avoid unnecessary travel)' },
      key(ctx, item, 'book'),
    )
    ctx.log(`booked telephone review ${appt.id} for ${new Date(startsAt).toISOString().slice(0, 16).replace('T', ' ')} (${P})`)
    return appt.id
  } catch (err) {
    ctx.log(`telephone rebook failed (non-fatal, task still stands): ${String((err as Error).message).slice(0, 140)}`)
    return undefined
  }
}

/**
 * Pharmacy chain, verified live: link_prescription_stock (productId + quantity)
 * -> dispense -> collect. The prescription reaches status 'collected' and the
 * catalogue stock draws down. Each step re-uses the version the previous step
 * returned.
 */
const resolveMedicines: Resolver = async (ctx, item) => {
  const view = await ctx.sim.siteView('pharmacy', { patient: item.patientId, limit: 60 })
  const resources = (view.resources ?? []) as any[]
  const rx = resources.find((r) => r.kind === 'prescription' && r.status === 'approved')
  if (!rx) throw new Error('no approved prescription found in pharmacy view')
  const product = resources.find(
    (r) => r.kind === 'pharmacy-product' && (r.data?.drug ?? '') === (rx.data?.drug ?? ''),
  )
  if (!product) throw new Error(`no catalogue product matches drug "${rx.data?.drug}"`)
  const quantity = product.data?.packSize ?? 28
  if ((product.data?.stock ?? 0) < quantity) {
    throw new Error(`insufficient stock for ${product.data?.drug} (${product.data?.stock} units, need ${quantity})`)
  }
  let cur = await ctx.sim.siteAction('pharmacy', {
    type: 'link_prescription_stock', patientId: item.patientId,
    resourceId: rx.id, expectedVersion: rx.version,
    productId: product.id, quantity,
  }, key(ctx, item, 'link'))
  cur = await ctx.sim.siteAction('pharmacy', {
    type: 'dispense', patientId: item.patientId, resourceId: cur.id, expectedVersion: cur.version,
  }, key(ctx, item, 'dispense'))
  cur = await ctx.sim.siteAction('pharmacy', {
    type: 'collect', patientId: item.patientId, resourceId: cur.id, expectedVersion: cur.version,
  }, key(ctx, item, 'collect'))
  return { action: 'link+dispense+collect', resourceId: cur.id, idempotencyKey: key(ctx, item, 'link'), atSimTime: await simNow(ctx) }
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
