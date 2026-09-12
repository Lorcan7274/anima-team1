/**
 * LLM boundary. The model READS free text and WRITES clinical prose;
 * deterministic code does everything else (see brief, "Where the AI is").
 *
 * TODO(team): wire to the Anima ADK / OpenAI. Everything below is a typed stub
 * returning canned-but-honest content so the pipeline runs end to end without
 * a key. Keep the interfaces; swap the internals.
 */

export interface DraftedSummary {
  reason: string
  course: string
  diagnoses: string
  medicationChanges: string
  results: string
  followUp: string
  gpActions: string
}

export interface ProposedBarrier {
  title: string
  /** Verbatim quotes from the source text that justify the barrier. */
  quotes: string[]
}

/** Read free text (documents, letters, threads) and propose barriers with quoted evidence. */
export async function proposeBarriersFromText(_source: string, text: string): Promise<ProposedBarrier[]> {
  // TODO(team): real LLM call. Until then: no free-text proposals, rule-based
  // detectors carry the demo. This hook exists so detect.ts already has the seam.
  void text
  return []
}

/** Draft all seven discharge sections, citing the actual record. */
export async function draftDischargeSummary(context: {
  patientName: string
  conditions: string[]
  documentTexts: string[]
  bloodSummary: string
  planned: string[]
}): Promise<DraftedSummary> {
  // TODO(team): real LLM call with the context above in the prompt.
  return {
    reason: 'Admitted with decompensated heart failure (day 3 of admission).',
    course: 'Diuresis on AMU; symptoms and weight improving; stable for discharge planning.',
    diagnoses: `${context.conditions.join('; ')}.`,
    medicationChanges:
      'Furosemide continued; discharge supply arranged and collected. ' +
      'Medicines reconciliation completed and included here (this is the attachment ' +
      'the cardiology letter was chasing).',
    results: context.bloodSummary,
    followUp: context.planned.join(' '),
    gpActions: 'Review repeat U&E + FBC when resulted; assess diuretic tolerance at telephone review.',
  }
}

/** Clinical details for a blood test order, citing the real trend. */
export async function draftClinicalDetails(bloodSummary: string): Promise<string> {
  // TODO(team): real LLM call.
  return `Routine post-discharge monitoring: CKD on loop diuretic. ${bloodSummary}`
}
