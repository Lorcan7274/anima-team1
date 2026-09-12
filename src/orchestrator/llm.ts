/**
 * LLM boundary, wired to the Anima ADK (@animahealth/adk) with the OpenAI
 * provider. The model READS free text and WRITES clinical prose; deterministic
 * code (resolve/verify) does everything else.
 *
 * Needs OPENAI_API_KEY in .env (gitignored). Without a key, or on any model
 * error, every function falls back to an honest canned draft so the demo,
 * tests and teammates without the key keep working — fallbacks are logged.
 * Override the model with OPENAI_MODEL.
 */
import { z } from 'zod'
import { adk } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'
import { loadDotEnv } from '../sim/config.ts'

loadDotEnv()

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna'
const app = adk()

const SYSTEM = `You are the drafting assistant of a hospital discharge-coordination
agent working in a SYNTHETIC healthcare simulator (no real patients). You write
operational, factual prose. Never invent clinical facts: use only the record
text you are given. Frame everything as operational readiness pending clinician
sign-off, never as clinical judgement.`

async function structured<T>(name: string, schema: z.ZodType<T>, prompt: string, fallback: () => T): Promise<T> {
  if (!process.env.OPENAI_API_KEY) return fallback()
  try {
    const agent = app.agent({
      name,
      model: openai(MODEL),
      context: [app.context.system(SYSTEM), app.context.history()],
      tools: [],
      output: { schema },
    })
    const result = await app.run(agent, prompt)
    return result.output.value as T
  } catch (err) {
    console.error(`llm ${name} failed, using fallback: ${String((err as Error).message).slice(0, 160)}`)
    return fallback()
  }
}

// --- Barrier proposals from free text ---------------------------------------

const BarrierKind = z.enum(['medicines', 'bloods', 'device', 'visit', 'summary', 'follow-up', 'other'])

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
export async function proposeBarriersFromText(source: string, text: string): Promise<ProposedBarrier[]> {
  const out = await structured(
    'barrier_reader',
    ProposedBarrierSchema,
    `Source: ${source}\n\nRecord text:\n"""\n${text}\n"""\n\n` +
      `List every discharge barrier this text evidences. Quote the exact words. ` +
      `Use kind 'other' only when no listed kind fits.`,
    () => ({ barriers: [] }),
  )
  return out.barriers
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
}): Promise<DraftedSummary> {
  return structured(
    'summary_writer',
    SummarySchema,
    `Draft the seven sections of a discharge summary for ${context.patientName} ` +
      `(conditions: ${context.conditions.join(', ') || 'as documented'}).\n` +
      `Record extracts:\n${context.documentTexts.map((t) => `- ${t}`).join('\n')}\n` +
      `Blood results: ${context.bloodSummary}\n` +
      `Arrangements already made by the discharge agent:\n${context.planned.map((t) => `- ${t}`).join('\n')}\n\n` +
      `medicationChanges MUST include the medicines reconciliation content ` +
      `(a GP letter is chasing a missing reconciliation attachment). ` +
      `Keep each section to 1-3 sentences, operational tone.`,
    () => ({
      reason: 'Admitted with decompensated heart failure (day 3 of admission).',
      course: 'Diuresis on AMU; stable for discharge planning.',
      diagnoses: `${context.conditions.join('; ')}.`,
      medicationChanges: 'Furosemide continued; discharge supply arranged. Medicines reconciliation completed and included here.',
      results: context.bloodSummary,
      followUp: context.planned.join(' '),
      gpActions: 'Review repeat bloods when resulted; assess diuretic tolerance at telephone review.',
    }),
  )
}

// --- Test-order clinical details ---------------------------------------------

const DetailsSchema = z.object({
  clinicalDetails: z.string().describe('1-2 sentences for the lab request form, citing the actual values'),
})

/** Clinical details for a blood-test order, citing the real result history. */
export async function draftClinicalDetails(bloodSummary: string): Promise<string> {
  const out = await structured(
    'order_writer',
    DetailsSchema,
    `Write the clinicalDetails field for a ROUTINE post-discharge U&E + FBC order. ` +
      `Patient has CKD and takes a loop diuretic. Result history: ${bloodSummary} ` +
      `Be accurate about trends — do not exaggerate. 1-2 sentences.`,
    () => ({ clinicalDetails: `Routine post-discharge monitoring: CKD on loop diuretic. ${bloodSummary}` }),
  )
  return out.clinicalDetails
}
