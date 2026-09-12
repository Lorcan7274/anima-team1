/**
 * Barrier detectors. Rule-based readers over the sim views, plus an LLM seam
 * (llm.ts) for free-text proposals. Every item carries quoted evidence.
 *
 * Detection is also the re-run safety net: run.ts keeps existing item state and
 * only adds items that aren't already tracked, so re-running never re-resolves
 * something verification has settled.
 */
import type { SimClient } from '../sim/index.ts'
import type { ChecklistItem, Evidence, PatientFact, PatientProfile, PatientRow } from './model.ts'
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
  // History is computed from this patient's own FBC series: the lowest
  // neutrophil count on record, when it was, and whether it has recovered.
  // Nothing here is a template, a patient without a dip gets no sentence.
  const history = neutrophilHistory(reports.filter((r) => (r.data as any)?.panel?.id === 'fbc'), fbc)
  return (
    `Latest U&E: ${fmt(ue, ['potassium', 'creatinine', 'egfr'])}. ` +
    `Latest FBC: ${fmt(fbc, ['neutrophils', 'white-cell-count'])}.` +
    (history ? ` ${history}` : '')
  )
}

/** "History: neutrophil nadir 0.5 four months ago, since recovered to 2.6." from the FBC series, or '' when there is no dip. */
export function neutrophilHistory(fbcReports: SimResource[], latest: SimResource | undefined): string {
  const value = (r: SimResource | undefined) => {
    const a = (((r?.data as any)?.analytes ?? []) as any[]).find((x) => x.id === 'neutrophils')
    return a ? { value: Number(a.value), low: a.referenceLow as number | undefined } : undefined
  }
  const now = value(latest)
  if (!latest || !now) return ''
  let nadir: { value: number; at: number; low?: number } | undefined
  for (const r of fbcReports) {
    if (r.id === latest.id) continue
    const v = value(r)
    if (v && (!nadir || v.value < nadir.value)) nadir = { value: v.value, at: r.createdAt ?? 0, low: v.low }
  }
  if (!nadir || nadir.value >= now.value) return ''
  if (nadir.low != null && nadir.value >= nadir.low) return '' // never dipped below range: not a history worth citing
  const months = Math.max(1, Math.round(((latest.createdAt ?? 0) - nadir.at) / (30 * 86_400_000)))
  const recovered = now.low == null || now.value >= now.low
  return `History: neutrophil nadir ${nadir.value} ${months === 1 ? 'a month' : `${months} months`} ago, since ${recovered ? 'recovered to' : 'risen to'} ${now.value}.`
}

/** Detect Amira-style hospital discharge barriers for one patient. */
export async function detectForPatient(
  sim: SimClient,
  patient: PatientRow,
  log?: (message: string) => void,
): Promise<ChecklistItem[]> {
  if (patient.stage === 'discharged') return []
  const P = patient.patientId
  const items: ChecklistItem[] = []
  const slug = (s: string) => `${P.toLowerCase()}-${s}`
  const ev = (resourceId: string, site: Evidence['site'], quote: string, raisedAt?: number): Evidence =>
    raisedAt ? { resourceId, site, quote, raisedAt } : { resourceId, site, quote }

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
      title: 'Clinical review outstanding: discharge gated on clinician sign-off',
      owner: 'clinician',
      state: 'clinical_hold',
      humanReason: `Open urgent thread: "${respThread.title}". Automation must not clear this.`,
      evidence: [ev(respThread.id, 'hospital', respThread.title ?? '', respThread.createdAt)],
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
      evidence: [ev(rx.id, 'hospital', `${rx.title}: status ${rx.status}, not dispensed or collected`, rx.createdAt)],
    })
  }

  // 3. Monitoring bloods: the seeded document literally requests it.
  const monitoringDoc = hospRes.find((r) => r.kind === 'document' && /monitoring/i.test((r.data as any)?.text ?? ''))
  const docText = String((monitoringDoc?.data as any)?.text ?? '')
  /** Real clause from the document containing the keyword, never a hardcoded string. */
  const clauseWith = (keyword: string): string => {
    const m = docText.match(new RegExp(`[^.;]*${keyword}[^.;]*`, 'i'))
    return (m?.[0] ?? docText.slice(0, 120)).trim()
  }
  if (monitoringDoc) {
    items.push({
      id: slug('bloods'),
      patientId: P,
      title: 'Post-discharge blood monitoring not arranged (routine U&E + FBC)',
      owner: 'diagnostics',
      state: 'proposed',
      proposedAction: 'Order routine U&E + FBC citing the result history',
      evidence: [ev(monitoringDoc.id, 'hospital', ((monitoringDoc.data as any)?.text ?? '').slice(0, 160), monitoringDoc.createdAt)],
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
      evidence: monitoringDoc ? [ev(monitoringDoc.id, 'hospital', clauseWith('home equipment'))] : [],
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
  //    NOTE the seeded world contains an old 'sent' summary for Amira, we only
  //    treat OUR resolver's resource as satisfying this (verifier rule), so the
  //    item is always detected until our own summary is verified sent.
  items.push({
    id: slug('summary'),
    patientId: P,
    title: 'Discharge summary for this admission not written/sent',
    owner: 'hospital',
    state: 'proposed',
      proposedAction: 'Draft all seven discharge sections and send to the GP',
    evidence: monitoringDoc ? [ev(monitoringDoc.id, 'hospital', clauseWith('handover'))] : [],
  })

  // 7. Follow-up: GP review task honouring the patient's goals.
  const avoidTravel = patient.goals.some((g) => /avoid unnecessary travel/i.test(g))
  items.push({
    id: slug('follow-up'),
    patientId: P,
    title: `GP follow-up not arranged${avoidTravel ? ' (telephone, patient goal: avoid travel)' : ''}`,
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
    const summaryItem = items.find((i) => i.id === slug('summary'))
    if (summaryItem) {
      summaryItem.draftOnly = true
      summaryItem.title = 'Discharge summary pre-drafted only: held while the case is blocked'
    }
    items.push({
      id: slug('care-package'),
      patientId: P,
      title: 'Care package awaiting funding decision: needs a human',
      owner: 'community',
      state: 'blocked_human',
      humanReason: 'Funding approval is an external decision; no API action can clear it.',
      evidence: [
        ev(carePackage.id, 'community', `${carePackage.title}: fundingDecision pending`, carePackage.createdAt),
        ...(carePlan ? [ev(carePlan.id, 'community', carePlan.title ?? 'home support not arranged', carePlan.createdAt)] : []),
        ...(trend
          ? [ev(trend.id, 'community', `${trend.title}: ${(trend.data as any)?.value} vs baseline ${(trend.data as any)?.baseline} steps/day`)]
          : []),
      ],
    })
  }

  // LLM pass: read the record's free text and merge proposals into the
  // rule-detected items as extra evidence. Every quote must be LOCATED in the
  // actual record before it is cited, a hallucinated line must never render
  // as a record quote. Unlocatable quotes are dropped and counted.
  const sources = hospRes
    .filter((r) => r.kind === 'document' || r.kind === 'message')
    .map((r) => ({ id: r.id, haystack: `${r.title ?? ''}: ${String((r.data as any)?.text ?? '')}`.toLowerCase() }))
  const locateQuote = (quote: string): string | undefined =>
    sources.find((src) => src.haystack.includes(quote.trim().toLowerCase()))?.id
  const freeText = hospRes
    .filter((r) => r.kind === 'document' || r.kind === 'message')
    .map((r) => `[${r.kind} ${r.id}] ${r.title ?? ''}: ${(r.data as any)?.text ?? ''}`)
    .join('\n')
  if (freeText.trim()) {
    const { barriers: proposals } = await proposeBarriersFromText(`hospital record for ${P}`, freeText)
    let dropped = 0
    for (const prop of proposals) {
      const located = prop.quotes
        .map((quote) => ({ quote, sourceId: locateQuote(quote) }))
        .filter((x): x is { quote: string; sourceId: string } => !!x.sourceId)
      dropped += prop.quotes.length - located.length
      const target = prop.kind === 'other' ? undefined : items.find((i) => i.id === slug(prop.kind))
      if (target) {
        for (const { quote, sourceId } of located.slice(0, 2)) {
          if (!target.evidence.some((e) => e.quote === quote)) target.evidence.push(ev(sourceId, 'hospital', quote))
        }
      } else if (located.length) {
        patient.insights ??= []
        if (!patient.insights.some((x) => x.title === prop.title)) {
          patient.insights.push({ title: prop.title, quote: located[0].quote })
          log?.(`agent reading noted (non-blocking): ${prop.title}`)
        }
      } else {
        dropped += prop.quotes.length === 0 ? 1 : 0
      }
    }
    if (dropped > 0) log?.(`dropped ${dropped} model quote(s) not found verbatim in the record`)
  }

  return items
}

/** Load a patient's directory row (name, conditions, needs, goals) + attendance + record profile. */
export async function loadPatientRow(sim: SimClient, patientId: string): Promise<PatientRow> {
  const found = await sim.searchPatients('hospital', patientId)
  const p = (found.items ?? [])[0] ?? {}
  const hosp = await sim.siteView('hospital', { patient: patientId, limit: 50 })
  const att = res(hosp).find((r) => r.kind === 'hospital-attendance')
  const row: PatientRow = {
    patientId,
    name: (p as any).name ?? patientId,
    conditions: ((p as any).conditions ?? []) as string[],
    needs: ((p as any).needs ?? []) as string[],
    goals: ((p as any).goals ?? []) as string[],
    stage: (att?.data as any)?.stage,
    location: (att?.data as any)?.location,
    items: [],
  }
  try {
    row.profile = await loadProfile(sim, patientId, (p as any).birthDate, att)
  } catch (err) {
    console.error(`profile for ${patientId} unavailable: ${String((err as Error).message).slice(0, 120)}`)
  }
  return row
}

/** Re-read the attendance so stage/location reflect what the hospital record says now (e.g. after discharge). */
export async function refreshStage(sim: SimClient, row: PatientRow): Promise<void> {
  const hosp = await sim.siteView('hospital', { patient: row.patientId, limit: 50 })
  const att = res(hosp).find((r) => r.kind === 'hospital-attendance')
  if (!att) return
  row.stage = (att.data as any)?.stage ?? row.stage
  row.location = (att.data as any)?.location ?? row.location
}

/**
 * Banner facts read straight from the record: allergies and active problems
 * (GP), the patient's own words (GP personal-context note), latest flagged
 * bloods (diagnostics), activity vs baseline (wearables), home access and
 * carer availability (community care plan), prescriptions (pharmacy).
 * Every fact names its source so the banner never asserts more than the
 * record does. No interpretation, that would be clinical judgement.
 */
export async function loadProfile(sim: SimClient, patientId: string, birthDate: string | undefined, att: SimResource | undefined): Promise<PatientProfile> {
  const [gp, dx, wear, comm, pharm] = await Promise.all([
    sim.siteView('gp', { patient: patientId, limit: 200 }),
    sim.siteView('diagnostics', { patient: patientId, limit: 100 }),
    sim.siteView('wearables', { patient: patientId, limit: 100 }),
    sim.siteView('community', { patient: patientId, limit: 100 }),
    sim.siteView('pharmacy', { patient: patientId, limit: 60 }),
  ])
  const facts: PatientFact[] = []
  const ehr = res(gp).find((r) => r.kind === 'ehr-record')
  const allergies = (((ehr?.data as any)?.allergies ?? []) as any[])
    .map((a) => (typeof a === 'string' ? a : a?.term ?? a?.name ?? a?.substance))
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
  const problems = (((ehr?.data as any)?.problems ?? []) as any[])
    .filter((x) => x?.status === 'active' && typeof x?.term === 'string')
    .map((x) => x.term as string)
    .filter((term, i, all) => all.indexOf(term) === i) // the GP record repeats problems per encounter; list each once
  const context = res(gp)
    .filter((r) => r.kind === 'observation' && typeof (r.data as any)?.context === 'string')
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
  const ownWords = context
    ? { text: String((context.data as any).context), goal: (context.data as any).goal as string | undefined, resourceId: context.id }
    : undefined
  const encounter = res(gp)
    .filter((r) => r.kind === 'encounter' && typeof (r.data as any)?.author === 'string')
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]

  // Latest blood analytes: only those the lab flagged, plus eGFR/potassium when present.
  const reports = res(dx).filter((r) => r.kind === 'report' && (r.data as any)?.kind === 'blood-result')
  const latest = (panelId: string) =>
    reports.filter((r) => (r.data as any)?.panel?.id === panelId).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)).at(-1)
  for (const panelId of ['ue', 'fbc']) {
    const r = latest(panelId)
    for (const a of (((r?.data as any)?.analytes ?? []) as any[])) {
      const flagged = a.referenceHigh != null && (a.value > a.referenceHigh || a.value < a.referenceLow)
      if (flagged || a.id === 'egfr' || a.id === 'potassium') {
        facts.push({ label: a.name ?? a.id, value: `${a.value}${a.unit ? ' ' + a.unit : ''}`, bad: !!flagged, source: `diagnostics · ${(r!.data as any)?.panel?.name ?? panelId} report ${r!.id}` })
      }
    }
  }
  const trend = res(wear).find((r) => r.kind === 'observation' && (r.data as any)?.baseline != null)
  if (trend) {
    const d = trend.data as any
    facts.push({ label: 'Activity', value: `${d.value} vs ${d.baseline} ${d.unit ?? ''} baseline`.trim(), bad: Number(d.value) < Number(d.baseline), source: `wearables · ${trend.id}` })
  }
  const plan = res(comm).find((r) => r.kind === 'care-plan')
  if (plan) {
    const d = plan.data as any
    if (d?.homeAccessConfirmed === false) facts.push({ label: 'Home access', value: 'not confirmed', bad: true, source: `community · ${plan.id}` })
    if (d?.carerAvailable === false) facts.push({ label: 'Carer', value: 'none available', bad: true, source: `community · ${plan.id}` })
  }
  const prescriptions = res(pharm)
    .filter((r) => r.kind === 'prescription')
    .map((r) => ({ id: r.id, drug: String((r.data as any)?.drug ?? r.title ?? 'prescription'), status: r.status ?? 'unknown' }))
  return {
    birthDate,
    clinician: (att?.data as any)?.clinician && (att?.data as any)?.clinician !== 'Unassigned' ? String((att?.data as any).clinician) : undefined,
    gp: encounter ? String((encounter.data as any).author) : undefined,
    allergies,
    problems,
    ownWords,
    facts,
    prescriptions,
  }
}
