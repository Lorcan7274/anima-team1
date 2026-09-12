/**
 * LLM boundary, wired to the Anima ADK (@animahealth/adk) with the OpenAI
 * provider. The model READS free text and WRITES clinical prose; deterministic
 * code (resolve/verify) does everything else.
 *
 * Needs OPENAI_API_KEY in .env (gitignored). Without a key, or on any model
 * error, every function falls back to an honest canned draft so the demo,
 * tests and teammates without the key keep working, fallbacks are logged.
 * Override the model with OPENAI_MODEL.
 */
import { z } from 'zod'
import { adk } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'
import { loadDotEnv } from '../sim/config.ts'

loadDotEnv()

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna'
/** The discharge letter deserves the strongest model; override independently. */
const WRITER_MODEL = process.env.OPENAI_MODEL_WRITER || MODEL
const app = adk()

const SYSTEM = `You are the drafting assistant of a hospital discharge-coordination
agent working in a SYNTHETIC healthcare simulator (no real patients). You write
operational, factual prose. Never invent clinical facts: use only the record
text you are given. Frame everything as operational readiness pending clinician
sign-off, never as clinical judgement.`

export type LlmSource = 'model' | 'fallback'

/**
 * Runs a structured model call and reports HOW the answer was produced.
 * Callers must surface source === 'fallback' in the UI, a judge asking
 * "is that the model?" must never get a silent "no".
 */
async function structured<T>(
  name: string,
  schema: z.ZodType<T>,
  prompt: string,
  fallback: () => T,
  model = MODEL,
): Promise<{ value: T; source: LlmSource }> {
  if (!process.env.OPENAI_API_KEY) return { value: fallback(), source: 'fallback' }
  try {
    const agent = app.agent({
      name,
      model: openai(model),
      context: [app.context.system(SYSTEM), app.context.history()],
      tools: [],
      output: { schema },
    })
    const result = await app.run(agent, prompt)
    return { value: result.output.value as T, source: 'model' }
  } catch (err) {
    console.error(`llm ${name} failed, using fallback: ${String((err as Error).message).slice(0, 160)}`)
    return { value: fallback(), source: 'fallback' }
  }
}

// --- Barrier proposals from free text ---------------------------------------

/** Item slugs the model may file a barrier under; 'clinical-hold' routes clinical concerns to the hold, never to a service item. */
export const BARRIER_KINDS = ['clinical-hold', 'medicines', 'bloods', 'device', 'visit', 'summary', 'follow-up', 'other'] as const
const BarrierKind = z.enum(BARRIER_KINDS)

const ProposedBarrierSchema = z.object({
  barriers: z.array(
    z.object({
      kind: BarrierKind.describe('Which known discharge-barrier type this maps to, or other'),
      title: z.string().describe('One-line operational statement of the barrier'),
      quotes: z.array(z.string()).describe('Verbatim quotes from the source text that justify it'),
    }),
  ),
})

export type ProposedBarrier = z.infer<typeof ProposedBarrierSchema>['barriers'][number]

/**
 * Read record free text (documents, letters, threads) and propose discharge
 * barriers, each justified by verbatim quotes. detect.ts merges known kinds
 * into the rule-detected items as extra evidence and logs 'other' proposals.
 */
export async function proposeBarriersFromText(
  source: string,
  text: string,
): Promise<{ barriers: ProposedBarrier[]; source: LlmSource }> {
  // Stable instructions first, variable record text last, the OpenAI prompt
  // cache matches on stable prefixes, so keep everything constant up front.
  const out = await structured(
    'barrier_reader',
    ProposedBarrierSchema,
    `List every discharge barrier the record text evidences. Quote the exact words. ` +
      `Kinds: clinical-hold = an open clinical review or clinical concern only a clinician can clear; ` +
      `medicines = discharge medication not dispensed or handover unconfirmed; bloods = monitoring bloods requested; ` +
      `device = home monitoring equipment; visit = home support visit; summary = discharge letter; ` +
      `follow-up = GP review. Use kind 'other' only when no listed kind fits.\n\n` +
      `Source: ${source}\nRecord text:\n"""\n${text}\n"""`,
    () => ({ barriers: [] }),
  )
  return { barriers: out.value.barriers, source: out.source }
}

// --- Discharge summary --------------------------------------------------------

const SummarySchema = z.object({
  reason: z.string(),
  course: z.string(),
  diagnoses: z.string(),
  medicationChanges: z.string(),
  results: z.string(),
  followUp: z.string(),
  gpActions: z.string(),
})

export type DraftedSummary = z.infer<typeof SummarySchema>

/** Draft all seven discharge sections, citing only the provided record. */
export async function draftDischargeSummary(context: {
  patientName: string
  conditions: string[]
  documentTexts: string[]
  bloodSummary: string
  planned: string[]
}): Promise<{ sections: DraftedSummary; source: LlmSource }> {
  const out = await structured(
    'summary_writer',
    SummarySchema,
    `Draft the seven sections of a discharge summary for ${context.patientName} ` +
      `(conditions: ${context.conditions.join(', ') || 'as documented'}).\n` +
      `Record extracts:\n${context.documentTexts.map((t) => `- ${t}`).join('\n')}\n` +
      `Blood results: ${context.bloodSummary}\n` +
      `Arrangements already made by the discharge agent:\n${context.planned.map((t) => `- ${t}`).join('\n')}\n\n` +
      `medicationChanges must state the medicines reconciliation position exactly as the extracts ` +
      `evidence it (completed, outstanding, or not documented), never assert a reconciliation ` +
      `or a medication change the extracts do not show. Use only the record above; do not carry ` +
      `facts from any other patient. Keep each section to 1-3 sentences, operational tone.`,
    () => ({
      // Generic template, must read correctly for ANY patient, not just Amira.
      reason: `Admitted for management of ${context.conditions[0]?.toLowerCase() ?? 'the documented condition'}.`,
      course: 'Inpatient course as documented; operationally ready for discharge planning pending clinician sign-off.',
      diagnoses: `${context.conditions.join('; ') || 'As per record'}.`,
      medicationChanges: 'Discharge medication supply arranged. Medicines reconciliation position: as documented in the record; not confirmed by the drafting agent.',
      results: context.bloodSummary,
      followUp: context.planned.join(' '),
      gpActions: 'Review outstanding results when available; assess at the arranged follow-up.',
    }),
    WRITER_MODEL,
  )
  return { sections: out.value, source: out.source }
}

// --- Escalation handover ------------------------------------------------------

const EscalationSchema = z.object({
  responsibleTeam: z.string().describe('The team that owns this decision, e.g. "Community social care team"'),
  nextAction: z.string().describe('The single concrete next step for that team'),
  note: z.string().describe('2-3 sentence handover note citing the evidence'),
})

export type Escalation = z.infer<typeof EscalationSchema>

/**
 * Draft the escalation handover for a barrier the agent cannot clear.
 * The output NEVER resolves the barrier, it names the owner and next step.
 */
export async function draftEscalation(context: {
  patientName: string
  title: string
  humanReason: string
  quotes: string[]
}): Promise<{ escalation: Escalation; source: LlmSource }> {
  const out = await structured(
    'escalation_writer',
    EscalationSchema,
    `Draft an escalation handover for a discharge barrier the coordination agent ` +
      `cannot and must not resolve itself. Name the responsible team, one concrete ` +
      `next action, and a short factual note. Do not suggest the barrier is resolved.\n\n` +
      `Patient: ${context.patientName}\nBarrier: ${context.title}\n` +
      `Why a human is needed: ${context.humanReason}\n` +
      `Evidence:\n${context.quotes.map((q) => `- "${q}"`).join('\n')}`,
    () => ({
      responsibleTeam: 'Community social care team',
      nextAction: 'Confirm the funding decision, home access and carer availability for the care package',
      note: `${context.patientName}'s ${context.title.toLowerCase()}. ${context.humanReason} Evidence: ${context.quotes[0] ?? 'see record'}.`,
    }),
  )
  return { escalation: out.value, source: out.source }
}

// --- Test-order clinical details ---------------------------------------------

const DetailsSchema = z.object({
  clinicalDetails: z.string().describe('1-2 sentences for the lab request form, citing the actual values'),
})

/** Clinical details for a blood-test order, citing the real result history. */
export async function draftClinicalDetails(
  bloodSummary: string,
  conditions: string[] = [],
): Promise<{ text: string; source: LlmSource }> {
  const who = conditions.length ? `Recorded conditions: ${conditions.join(', ')}. ` : ''
  const out = await structured(
    'order_writer',
    DetailsSchema,
    `Write the clinicalDetails field for a ROUTINE post-discharge blood monitoring order. ` +
      `${who}Result history: ${bloodSummary} ` +
      `Be accurate about trends, do not exaggerate or add conditions not listed. 1-2 sentences.`,
    () => ({ clinicalDetails: `Routine post-discharge monitoring${conditions.length ? ` (${conditions.join(', ')})` : ''}. ${bloodSummary}` }),
  )
  return { text: out.value.clinicalDetails, source: out.source }
}
