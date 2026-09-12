/**
 * Verifiers: after time advances, re-read the owning service and check the
 * SPECIFIC resource the resolver created. Never "any matching resource for
 * this patient" — the seeded world contains an old sent summary, old visits
 * and old tasks that would green-light a lazy verifier instantly.
 */
import type { ChecklistItem, OrchestratorContext, Verification } from './model.ts'

type Verifier = (ctx: OrchestratorContext, item: ChecklistItem) => Promise<Verification>

interface SimResource {
  id: string
  status?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

async function findInView(
  ctx: OrchestratorContext,
  site: 'diagnostics' | 'community' | 'wearables' | 'gp' | 'pharmacy' | 'hospital',
  patientId: string,
  resourceId: string,
): Promise<SimResource | undefined> {
  const view = await ctx.sim.siteView(site, { patient: patientId, limit: 200 })
  return ((view.resources ?? []) as SimResource[]).find((r) => r.id === resourceId)
}

const at = async (ctx: OrchestratorContext) => Number((await ctx.sim.clock()).now)

const verdict = async (ctx: OrchestratorContext, passed: boolean, observed: string): Promise<Verification> => ({
  passed,
  observed,
  atSimTime: await at(ctx),
})

/** Blood order flips open -> available with a blood-result payload (verified). */
const verifyBloods: Verifier = async (ctx, item) => {
  const r = await findInView(ctx, 'diagnostics', item.patientId, item.resolution!.resourceId)
  const resulted = r?.status === 'available' && (r.data as any)?.kind === 'blood-result'
  return verdict(ctx, !!resulted, r ? `order ${r.id} status=${r.status}` : 'order not found')
}

/** Device verified only when an observation exists at/after connect time. */
const verifyDevice: Verifier = async (ctx, item) => {
  const w = await ctx.sim.wearables(item.patientId)
  const connectedAt = item.resolution!.atSimTime
  const reading = w.observations.find((o) => (o.data?.observedAt ?? 0) >= connectedAt)
  return verdict(
    ctx,
    !!reading,
    reading ? `reading ${reading.data.metric}=${reading.data.value} at ${reading.data.observedAt}` : 'no reading since connect',
  )
}

/** A scheduled visit is not a completed visit. */
const verifyVisit: Verifier = async (ctx, item) => {
  const r = await findInView(ctx, 'community', item.patientId, item.resolution!.resourceId)
  return verdict(ctx, r?.status === 'completed', r ? `visit ${r.id} status=${r.status}` : 'visit not found')
}

/**
 * Our summary (by id) must show as sent in the GP's own documents feed —
 * unless the item is draft-only (blocked case), where the draft existing on
 * the hospital side is the correct end state.
 */
const verifySummary: Verifier = async (ctx, item) => {
  if (item.draftOnly) {
    const r = await findInView(ctx, 'hospital', item.patientId, item.resolution!.resourceId)
    return verdict(ctx, !!r && r.status !== 'sent', r ? `summary ${r.id} held as ${r.status} (deliberately unsent)` : 'draft not found')
  }
  const d = (await ctx.sim.gpDocuments()) as { documents?: SimResource[]; items?: SimResource[]; resources?: SimResource[] }
  const docs = d.documents ?? d.items ?? d.resources ?? []
  const mine = docs.find((x) => x.id === item.resolution!.resourceId)
  return verdict(ctx, mine?.status === 'sent', mine ? `summary ${mine.id} status=${mine.status} in GP inbox` : 'summary not in GP inbox')
}

/** A task's deliverable is existing on the GP worklist. */
const verifyFollowUp: Verifier = async (ctx, item) => {
  const r = await findInView(ctx, 'gp', item.patientId, item.resolution!.resourceId)
  return verdict(ctx, !!r, r ? `task ${r.id} status=${r.status} on GP worklist` : 'task not found')
}

/** Collected is the observable end state, read from the pharmacy's own view. */
const verifyMedicines: Verifier = async (ctx, item) => {
  const r = await findInView(ctx, 'pharmacy', item.patientId, item.resolution!.resourceId)
  return verdict(ctx, r?.status === 'collected', r ? `prescription ${r.id} status=${r.status}` : 'prescription not found')
}

export function verifierFor(item: ChecklistItem): Verifier | undefined {
  if (item.id.endsWith('-bloods')) return verifyBloods
  if (item.id.endsWith('-device')) return verifyDevice
  if (item.id.endsWith('-visit')) return verifyVisit
  if (item.id.endsWith('-summary')) return verifySummary
  if (item.id.endsWith('-follow-up')) return verifyFollowUp
  if (item.id.endsWith('-medicines')) return verifyMedicines
  return undefined
}
