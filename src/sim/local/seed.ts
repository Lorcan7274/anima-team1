/**
 * The seeded demo world, following discharge-orchestrator-brief.md: the same
 * eight hospital attendances a fresh NHS-SIM world starts with, Amira Khan's
 * record with the facts the brief verified analyte by analyte, Eleanor Chen's
 * community blocker, thin records for everyone else, and the traps the
 * verifier rule exists for (an old sent discharge summary, an old completed
 * visit, an old open GP task).
 *
 * Everything here is fictional and synthetic. Ids follow the shared
 * simulator's shapes (r-N for records, hospital-attendance-seed-N for the
 * seeded attendances) so the demo can discover them by query, never by
 * hardcoding.
 */
import { DAY, HOUR, MIN, PANELS, type DirectoryPatient, type LocalSite, type LocalWorld } from './world.ts'

/** The demo clock at world creation: 2026-09-12T08:00:00Z, the FIT constant the tests use. */
export const DEMO_START = 1789200000000

const AMIRA = 'SIM-000001'
const ELEANOR = 'SIM-000006'
const GP_NAME = 'Dr Maya Shah'
const SURGERY = 'Riverside Surgery, room 2'

/** Seed a fresh world. Called once per world by the local API when a team key is first minted. */
export function seedDemoWorld(world: LocalWorld): void {
  const start = world.now
  const ago = (days: number, hours = 0) => start - days * DAY - hours * HOUR
  const dayStart = Math.floor(start / DAY) * DAY

  // --- Directory --------------------------------------------------------------
  const p = (id: string, name: string, birthDate: string, conditions: string[], needs: string[], goals: string[]): DirectoryPatient =>
    world.addPatient({ id, name, birthDate, conditions, needs, goals, synthetic: true })
  p(AMIRA, 'Amira Khan', '1952-03-14', ['Heart failure', 'CKD stage 3'], ['Home visit', 'Carer involvement'], ['Stay at home with a clear contact for help', 'Avoid unnecessary travel'])
  p('SIM-000002', 'Thomas Nowak', '1988-07-02', ['Irritable bowel syndrome'], [], ['Arrange follow-up without losing a full day of work'])
  p('SIM-000003', 'Priya Sharma', '1995-11-23', ['Asthma'], ['telephone preferred'], ['Keep follow-up connected between home and study'])
  p('SIM-000004', 'George Evans', '1979-01-30', ['Hypertension'], [], ['Get back to work quickly'])
  p('SIM-000005', 'Fatima Begum', '1961-05-09', ['Atrial fibrillation', 'Type 2 diabetes'], ['Interpreter'], ['Know which team is visiting and when'])
  p(ELEANOR, 'Eleanor Chen', '1941-09-18', ['Frailty', 'Osteoarthritis'], ['Step-free access', 'Home visit'], ['Get back to the garden'])
  p('SIM-000007', 'Samuel Okafor', '1958-12-04', ['Hypertension', 'Type 2 diabetes'], ['Carer involvement'], ['Avoid unnecessary travel'])
  p('SIM-000008', 'Grace Williams', '1947-04-26', ['Osteoarthritis', 'Hypertension'], ['Home visit', 'Step-free access'], ['Stay at home with a clear contact for help'])
  // Directory-only patients, so register_attendance has someone to register.
  p('SIM-000009', 'Mohammed Ali', '1966-08-15', ['COPD'], ['Early appointment'], ['Avoid unnecessary travel'])
  p('SIM-000010', 'Oliver Khan', '1990-02-11', ['Asthma'], [], ['Arrange follow-up without losing a full day of work'])
  p('SIM-000011', 'Sofia Reed', '1984-10-05', ['Depression'], ['letter preferred'], ['Keep follow-up connected between home and study'])
  p('SIM-000012', 'Daniel Hughes', '1972-06-21', ['Type 2 diabetes'], [], ['Know which team is visiting and when'])

  // --- The eight seeded attendances ----------------------------------------------
  const attendance = (n: number, patientId: string, complaint: string, acuity: string, stage: string, location: string, arrivedMinutesAgo: number, clinician = 'Unassigned') => {
    const arrivalAt = start - arrivedMinutesAgo * MIN
    const data: Record<string, unknown> = { stage, acuity, location, arrivalAt, presentingComplaint: complaint, clinician }
    if (stage !== 'waiting') data.assessedAt = arrivalAt + 40 * MIN
    if (stage === 'take' || stage === 'inpatient') data.referredAt = arrivalAt + 90 * MIN
    if (stage === 'inpatient') data.admittedAt = arrivalAt + 4 * HOUR
    return world.put({ id: `hospital-attendance-seed-${n}`, kind: 'hospital-attendance', status: stage, patientId, title: complaint, createdAt: arrivalAt, visibleTo: ['hospital'], data })
  }
  attendance(0, AMIRA, 'Breathlessness', '2', 'waiting', 'Waiting room', 35)
  attendance(1, 'SIM-000002', 'Abdominal pain', '3', 'waiting', 'Waiting room', 50)
  attendance(2, 'SIM-000003', 'Wheeze', '3', 'waiting', 'Waiting room', 20)
  attendance(3, 'SIM-000004', 'Head injury', '3', 'assessing', 'Majors 1', 80, 'Dr Ada Sim 1')
  attendance(4, 'SIM-000005', 'Dizziness', '2', 'take', 'Majors 2', 150, 'Dr Ada Sim 1')
  attendance(5, ELEANOR, 'Reduced mobility', '2', 'take', 'AMU bed 1', 6 * 60, 'Dr Ada Sim 2')
  attendance(6, 'SIM-000007', 'Chest discomfort', '2', 'inpatient', 'AMU bed 2', 20 * 60, 'Dr Ada Sim 2')
  attendance(7, 'SIM-000008', 'Fall at home', '2', 'inpatient', 'AMU bed 3', 26 * 60, 'Dr Ada Sim 2')

  // --- Amira Khan: the named records the brief verified ---------------------------
  world.put({
    id: 'r-1', kind: 'document', status: 'filed', patientId: AMIRA, title: 'Admission note', createdAt: ago(3), visibleTo: ['hospital'],
    data: { documentType: 'admission-note', author: 'Dr Ada Sim 0', text: 'Blood monitoring requested; home equipment and medication handover not confirmed.' },
  })
  world.put({
    id: 'r-2', kind: 'document', status: 'unassigned', priority: 'urgent', patientId: AMIRA, title: 'Cardiology clinic letter', createdAt: ago(1, 6), visibleTo: ['gp'],
    data: { documentType: 'clinic-letter', author: 'Dr R Osei, Cardiology', text: 'Seen in heart failure clinic. The medicines reconciliation attachment referred to in the last discharge correspondence was not received; please forward before the next review.' },
  })
  world.put({
    id: 'r-3', kind: 'prescription', status: 'approved', patientId: AMIRA, title: 'Discharge medication supply', createdAt: ago(1), visibleTo: ['hospital', 'pharmacy'],
    data: { drug: 'Furosemide tablets', dose: '40 mg', directions: 'One tablet each morning', quantity: 28, prescriber: 'Dr Ada Sim 0', approvedAt: ago(1) },
  })
  world.put({
    id: 'r-4', kind: 'pharmacy-product', status: 'in-stock', title: 'Furosemide tablets 40 mg', createdAt: ago(30), visibleTo: ['pharmacy'],
    data: { drug: 'Furosemide tablets', packSize: 28, stock: 84, unit: 'tablet' },
  })
  world.put({
    id: 'r-5', kind: 'bed', status: 'occupied', patientId: AMIRA, title: 'AMU bed 12', createdAt: ago(3), visibleTo: ['hospital'],
    data: { ward: 'AMU', bed: 12, expectedDischarge: new Date(start).toISOString().slice(0, 10) },
  })
  world.put({
    id: 'r-6', kind: 'message', status: 'open', priority: 'urgent', patientId: AMIRA, title: 'Respiratory: review worsening oxygen requirement', createdAt: ago(0, 1), visibleTo: ['hospital'],
    data: { from: 'Respiratory team', text: 'Oxygen requirement rose overnight from 2 L to 4 L via nasal cannula. Please review before any discharge decision is made.' },
  })
  world.put({
    id: 'r-7', kind: 'message', status: 'open', priority: 'urgent', patientId: AMIRA, title: 'Discharge & flow: confirm medication handover', createdAt: ago(0, 2), visibleTo: ['hospital'],
    data: { from: 'Discharge & flow team', text: 'Please confirm the medication handover to community pharmacy is complete before the bed is released.' },
  })
  // The verifier trap: a discharge summary from a PREVIOUS admission, already sent to the GP.
  world.put({
    id: 'discharge-summary-example', kind: 'discharge-summary', status: 'sent', patientId: AMIRA, title: 'Discharge summary (previous admission)', createdAt: ago(120), visibleTo: ['hospital', 'gp'],
    data: {
      documentType: 'discharge-summary', author: 'Dr Ada Sim 0', sentAt: ago(120) + 2 * HOUR, sentTo: 'gp',
      sections: {
        reason: 'Admitted with fluid overload on a background of heart failure.', course: 'Diuresed over four days and mobilised.',
        diagnoses: 'Decompensated heart failure; CKD stage 3.', medicationChanges: 'Furosemide increased to 40 mg each morning.',
        results: 'Potassium 5.4 on discharge, repeat requested.', followUp: 'Heart failure clinic in six weeks.', gpActions: 'Repeat U&E in one week.',
      },
    },
  })
  // GP record: allergies and problems, repeated across encounters as the real record does (detect dedupes them).
  const problems = [
    { term: 'Heart failure', status: 'active', onset: '2021-02-10' }, { term: 'CKD stage 3', status: 'active', onset: '2022-08-01' },
    { term: 'Hypertension', status: 'active', onset: '2015-05-20' }, { term: 'Ankle fracture', status: 'resolved', onset: '2019-03-03' },
  ]
  world.put({
    kind: 'ehr-record', status: 'active', patientId: AMIRA, title: 'GP record', createdAt: ago(365), visibleTo: ['gp'],
    data: {
      allergies: [{ term: 'Penicillin', reaction: 'Rash', severity: 'moderate' }],
      problems: [...problems, ...problems.filter((x) => x.status === 'active'), ...problems.filter((x) => x.status === 'active')],
      medications: [{ drug: 'Furosemide tablets', dose: '40 mg each morning' }, { drug: 'Bisoprolol tablets', dose: '2.5 mg each morning' }, { drug: 'Ramipril capsules', dose: '2.5 mg each morning' }],
      registeredGp: GP_NAME,
    },
  })
  world.put({
    kind: 'observation', status: 'final', patientId: AMIRA, title: 'Personal context', createdAt: ago(45), visibleTo: ['gp'],
    data: { context: 'I want to be at home with my daughter nearby, not travelling back and forth to clinics. I need to know who to ring if I get breathless.', goal: 'Stay at home with a clear contact for help', recordedBy: GP_NAME },
  })
  for (const [days, text] of [[200, 'Routine heart failure review. Weight stable, no oedema. Bloods requested.'], [95, 'Breathless on exertion, furosemide dose reviewed. Repeat U&E in two weeks.'], [30, 'Telephone review. Feels better, potassium falling on repeat bloods.']] as const) {
    world.put({ kind: 'encounter', status: 'filed', patientId: AMIRA, title: 'GP consultation', createdAt: ago(days), visibleTo: ['gp'], data: { author: GP_NAME, text } })
  }
  // Another trap: an old open GP task, so "any task for this patient" would pass a lazy verifier.
  world.put({ kind: 'task', status: 'open', patientId: AMIRA, title: 'Annual heart failure review due', createdAt: ago(40), visibleTo: ['gp'], data: { site: 'gp' } })
  // And an old completed community visit: history, not a plan for this discharge.
  world.put({ kind: 'visit', status: 'completed', patientId: AMIRA, title: 'Community nursing visit', createdAt: ago(60), visibleTo: ['community', 'hospital'], data: { scheduledAt: ago(61), completedAt: ago(60), team: 'Community nursing' } })

  // --- Amira's bloods: a year of U&E and FBC, the numbers the brief checked ----------
  // Potassium peaked at 5.7 four months ago and has fallen since; yesterday K 5.1,
  // creatinine 107 (in range), eGFR 49 flagged low against a reference of 60.
  const UE: Array<[days: number, potassium: number, creatinine: number, egfr: number, sodium: number, urea: number]> = [
    [365, 4.6, 96, 55, 139, 7.1], [300, 4.9, 99, 53, 138, 7.6], [240, 5.2, 101, 52, 137, 8.0], [180, 5.4, 104, 50, 137, 8.4],
    [120, 5.7, 109, 48, 136, 9.1], [90, 5.5, 108, 48, 137, 8.6], [60, 5.3, 106, 49, 138, 8.1], [30, 5.2, 105, 50, 139, 7.7], [1, 5.1, 107, 49, 139, 7.6],
  ]
  for (const [days, potassium, creatinine, egfr, sodium, urea] of UE) report(world, AMIRA, 'ue', ago(days), { potassium, creatinine, egfr, sodium, urea })
  // Neutrophils 2.0 -> 1.0 -> 0.5 -> 0.8 -> 1.7 over the year, recovered to 2.6 yesterday; white cell count still 3.5, flagged below 4.0.
  const FBC: Array<[days: number, neutrophils: number, wcc: number, haemoglobin: number, platelets: number]> = [
    [360, 2.0, 4.2, 128, 210], [270, 1.0, 3.1, 125, 198], [180, 0.5, 2.4, 121, 190], [120, 0.8, 2.9, 123, 201], [60, 1.7, 3.4, 126, 205], [1, 2.6, 3.5, 127, 208],
  ]
  for (const [days, neutrophils, wcc, haemoglobin, platelets] of FBC) report(world, AMIRA, 'fbc', ago(days), { neutrophils, 'white-cell-count': wcc, haemoglobin, platelets })

  // --- The practice appointment book ---------------------------------------------
  // Today: an in-person surgery with Amira booked at 08:15 (the slot the agent cancels and rebooks by telephone).
  const surgery = world.put({
    kind: 'appointment-session', status: 'open', title: `${GP_NAME}, morning surgery`, createdAt: ago(7), visibleTo: ['gp'],
    data: { clinician: GP_NAME, location: SURGERY, startsAt: dayStart + 8 * HOUR, endsAt: dayStart + 11 * HOUR, slotMinutes: 15, mode: 'in-person', blockedSlots: [] },
  })
  const booking = (patientId: string, session: { id: string; data: Record<string, any> }, startsAt: number, title: string, visibleTo: LocalSite[] = ['gp', 'patient']) =>
    world.put({
      kind: 'appointment', status: 'booked', patientId, title, createdAt: ago(5), visibleTo,
      data: { mode: session.data.mode, startsAt, endsAt: startsAt + session.data.slotMinutes * MIN, clinician: session.data.clinician, location: session.data.location, sessionId: session.id, bookedAt: ago(5) },
    })
  booking(AMIRA, surgery, dayStart + 8 * HOUR + 15 * MIN, 'Heart failure review')
  booking('SIM-000012', surgery, dayStart + 8 * HOUR + 45 * MIN, 'Diabetes review')
  // Tomorrow: the telephone session the practice runs, with one slot blocked and one already taken, so a free-slot search has to skip both.
  const telephone = world.put({
    kind: 'appointment-session', status: 'open', title: `${GP_NAME}, telephone clinic`, createdAt: ago(7), visibleTo: ['gp'],
    data: { clinician: GP_NAME, location: 'Telephone', startsAt: dayStart + DAY + 14 * HOUR, endsAt: dayStart + DAY + 16 * HOUR, slotMinutes: 15, mode: 'telephone', blockedSlots: [{ startsAt: dayStart + DAY + 14 * HOUR, reason: 'Admin' }] },
  })
  booking('SIM-000009', telephone, dayStart + DAY + 14 * HOUR + 15 * MIN, 'COPD telephone review')

  // --- Eleanor Chen: the blocker lives in the community view, not the hospital ------
  world.put({
    kind: 'care-package', status: 'waiting', patientId: ELEANOR, title: 'Home care assessment awaiting allocation', createdAt: ago(2), visibleTo: ['community'],
    data: { fundingDecision: 'pending', requestedAt: ago(2), package: 'Two care calls a day', assessor: 'Community social care team' },
  })
  world.put({
    kind: 'care-plan', status: 'open', patientId: ELEANOR, title: 'Home support not yet arranged', createdAt: ago(2), visibleTo: ['community'],
    data: { homeAccessConfirmed: false, carerAvailable: false, stairsAtHome: true, note: 'Lives alone; daughter abroad. Front door has three steps.' },
  })
  world.put({
    kind: 'observation', status: 'final', patientId: ELEANOR, title: 'Activity trend below personal baseline', createdAt: ago(1), visibleTo: ['community', 'wearables'],
    data: { metric: 'steps', value: 1800, baseline: 4200, unit: 'steps/day', observedAt: ago(1), quality: 'good' },
  })
  world.put({ kind: 'device', status: 'active', patientId: ELEANOR, title: 'Home activity watch', createdAt: ago(200), visibleTo: ['wearables'], data: { metric: 'steps', battery: 62, quality: 'good', connectedAt: ago(200) } })
  world.put({
    kind: 'document', status: 'filed', patientId: ELEANOR, title: 'Therapy assessment', createdAt: ago(1), visibleTo: ['hospital'],
    data: { documentType: 'therapy-note', author: 'Physiotherapy', text: 'Mobilising with a frame; stairs not yet attempted. Occupational therapy home assessment recommended before discharge.' },
  })
  thinGpRecord(world, ELEANOR, ago(150), 'Falls clinic follow-up. Mobility reduced since the spring; referred for a community package.')

  // --- The rest of the ward: thin but plausible ---------------------------------
  thinGpRecord(world, 'SIM-000002', ago(20), 'Recurrent abdominal pain, bloods normal, dietary advice given.')
  thinGpRecord(world, 'SIM-000003', ago(60), 'Asthma review, inhaler technique checked, peak flow stable.')
  thinGpRecord(world, 'SIM-000004', ago(90), 'Blood pressure review, ramipril continued.')
  thinGpRecord(world, 'SIM-000005', ago(15), 'Atrial fibrillation on apixaban, HbA1c improving. Daughter interprets at appointments.')
  thinGpRecord(world, 'SIM-000007', ago(40), 'Hypertension and type 2 diabetes review. Wife is main carer.')
  world.put({
    kind: 'document', status: 'filed', patientId: 'SIM-000007', title: 'Admission note', createdAt: ago(0, 14), visibleTo: ['hospital'],
    data: { documentType: 'admission-note', author: 'Dr Ada Sim 2', text: 'Chest discomfort, troponin negative twice, ECG unchanged. Awaiting cardiology opinion before discharge planning.' },
  })
  thinGpRecord(world, 'SIM-000008', ago(25), 'Osteoarthritis pain, paracetamol regular. Lives alone with stairlift.')
  world.put({
    kind: 'document', status: 'filed', patientId: 'SIM-000008', title: 'Therapy note', createdAt: ago(0, 20), visibleTo: ['hospital'],
    data: { documentType: 'therapy-note', author: 'Physiotherapy', text: 'Fall at home, no fracture on imaging. Safe on the flat with a stick; home environment check needed before discharge.' },
  })
  for (const id of ['SIM-000009', 'SIM-000010', 'SIM-000011', 'SIM-000012']) thinGpRecord(world, id, ago(100), 'Routine review, no change to treatment.')

  world.event('world.seeded', `${world.allPatients().length} directory patients, ${world.all().length} records, clock at ${new Date(start).toISOString()}`)
}

/** One available blood report for a patient, built from the panel's reference ranges so history and new results agree. */
export function report(world: LocalWorld, patientId: string, panelId: string, at: number, values: Record<string, number>) {
  const panel = PANELS[panelId]
  const analytes = panel.analytes
    .filter((a) => values[a.id] !== undefined)
    .map((a) => ({ id: a.id, name: a.name, value: values[a.id], unit: a.unit, referenceLow: a.low, referenceHigh: a.high }))
  return world.put({
    kind: 'report', status: 'available', patientId, title: panel.name, createdAt: at, visibleTo: ['diagnostics', 'hospital', 'gp'],
    data: { kind: 'blood-result', panel: { id: panelId, name: panel.name }, specimen: 'blood', priority: 'routine', analytes, resultedAt: at },
  })
}

/** A GP record with the directory conditions as active problems and one encounter note. */
function thinGpRecord(world: LocalWorld, patientId: string, at: number, note: string): void {
  const patient = world.patient(patientId)
  if (!patient) return
  world.put({
    kind: 'ehr-record', status: 'active', patientId, title: 'GP record', createdAt: at - 30 * DAY, visibleTo: ['gp'],
    data: { allergies: [], problems: patient.conditions.map((term) => ({ term, status: 'active' })), medications: [], registeredGp: GP_NAME },
  })
  world.put({ kind: 'encounter', status: 'filed', patientId, title: 'GP consultation', createdAt: at, visibleTo: ['gp'], data: { author: GP_NAME, text: note } })
}
