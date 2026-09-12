# Build brief: Homeward — Discharge-Readiness Orchestrator (v3)

Product name: **Homeward**. The team demo plan (approval gate before execution,
escalation handovers, static fallback mode) is implemented in the scaffold.

You are building a hackathon project on the NHS-SIM synthetic healthcare simulator.
This brief encodes facts verified against the live API on 2026-09-12 in scratch
worlds — trust them, and re-verify only where marked UNTESTED.

**Origin:** `https://sim.animahealth.com` and `https://sim.animahacks.com` both serve
the same simulator (verified: identical healthz, same worlds). Everything in this
brief was verified against `sim.animahealth.com`, which is what `.env` uses. Docs at
`/docs/`, OpenAPI at `/api/openapi.json`.

## Mission

Patients stay in hospital beds after they are medically fit because the services
outside the hospital are not lined up. Build a **neighbourhood discharge desk** — an
agent that sits above GP, hospital, pharmacy, community, diagnostics and wearables
(your team key has all these scopes; no single real organisation would) and, per
patient:

1. **Detects** discharge barriers from record evidence — documents, letters, results,
   pharmacy/community state, patient needs and goals — into a readiness checklist,
   one owner and state per item.
2. **Resolves** each barrier by acting in the owning service through the API.
3. **Verifies** after time moves: advance the clock, re-read, and only mark an item
   green when *the specific resource the resolver created* is observably complete.
4. **Stops for a human** where it must: a clinical hold only a clinician can clear,
   and an external decision (care-package funding) no API can make.

Frame it in chapter-2 / "Anima 2.0" language: care organised around the person, a
coordination layer across the neighbourhood, not another site-level tool.

## Where the AI is (define this or lose the AI hackathon)

The model boundary is explicit. **The LLM does the reading and writing; deterministic
code does the acting and checking.**

LLM responsibilities:
- Read free text (hospital documents, the cardiology letter, message threads, needs
  and goals) and **propose checklist items with quoted evidence** — the judges should
  see why each item is red in the record's own words.
- **Draft the seven discharge-summary sections**, including the medicines
  reconciliation content the cardiology letter is chasing.
- Write the `clinicalDetails` on test orders, citing the actual result history.
- Choose follow-up mode from the patient's goals (telephone because "avoid
  unnecessary travel").

Deterministic code responsibilities:
- Execute actions (exact envelope below), advance the clock, re-read, verify against
  resolver-created resource ids, drive the state machine.

`blocked_human` and `clinical_hold` are pause-and-resume points — the Anima ADK's
pause/resume is the natural implementation; the judges built it.

## World and key discipline

- `POST /api/keys` with `{teamName}` creates or joins a world; the same name returns
  the same world and key — **team names are join codes**. Use unguessable names for
  dev and demo (e.g. `scratch-<12 random hex>`); a guessable demo world can be
  joined and mutated by anyone. `lorcan-scratch-smoke-a` and `scratch-1baaa88572fc`
  are already dirty.
- **Never develop against the `team1` world** (the key in `.env`).
- Fresh worlds seed identically and instantly (verified twice). Create the demo world
  minutes before the demo. Worlds started paused at speed 60 in testing, but don't
  rely on it: confirm the clock state at demo start and send `paused: true` on every
  clock call (`sim.advanceClock` already defaults to keeping paused).

## Verified API mechanics

### Action envelope
All mutations are `POST /api/sites/{site}/actions` via
`sim.siteAction(site, body, idempotencyKey)`.

- Target existing resources with **`resourceId` + `expectedVersion`** (its current
  `version`). Using `id` fails with a confusing `400 "Versioned <kind> required"`.
  Every update bumps `version` — always re-read immediately before acting.
- **Idempotency keys protect retries of the *identical* request only.** A re-run
  re-reads versions, the payload changes, and a reused key with a changed payload is
  rejected. Safe re-runs come from **detection**: an item verification already shows
  complete is skipped, never re-resolved. Keys are per attempt
  (`{world}-{item}-{step}-{attempt}`), not per item forever.
- `messaging_action` is the documented messaging type; `send_message` also appears in
  the enum but is undocumented — if you touch messaging, use `messaging_action` and
  smoke-test first.

### Attendance stage machine — verified end to end, including admission
Amira's seeded attendance `hospital-attendance-seed-0` ("Breathlessness", acuity 2,
arrived 35 min before world start, stage `waiting`) is an A&E record, separate from
the bed-12 occupancy. The full verified sequence, each step with fresh
`resourceId`/`expectedVersion`:

```
assign (needs clinician) -> waiting v2
assess                   -> assessing v3
refer                    -> take v4          # REQUIRED before admit
admit + location         -> inpatient v5     # free text ok: "AMU bed 12"
discharge + disposition  -> discharged
```

Discharging straight from `assessing` works but reads as "came in breathless,
discharged two hours later" — clinically absurd. **In the demo-world setup step,
admit her to AMU bed 12 and narrate day three of an admission** (the seeded bed
already says expected discharge today, so the story lines up).

### Discharge summary is a two-step
`save_discharge_summary` creates a draft **visible only to the hospital**; it needs
`dischargeSections` with all seven fields
(`reason, course, diagnoses, medicationChanges, results, followUp, gpActions`).
Then `process_document` with `documentCommand: 'send'` (`resourceId` +
`expectedVersion`) — verified to appear in `GET /api/sites/gp/documents` immediately.
`documentCommand` enum: `send | assign | review | file | annotate`.

Also use **`share_record`** to make the hospital-only document `r-1` and the new
summary visible to community — a cheap, visible cross-service beat the handover
otherwise lacks (UNTESTED — check schema, likely `resourceId` + target).

### Verified timings
One `sim.advanceClock(121)` — the method exists in `src/sim/client.ts` and wraps
`changeClock` keeping `paused: true`; max 10080 min/call, time never goes backwards —
flipped all of:

| Item | Action | Observed |
| --- | --- | --- |
| Home watch | `connect_device` (wearables) | first reading **+10 min**, then hourly |
| Bloods | `order_test` with `bloodTestOrder` | `open` → `available` with full analytes by **+121** |
| Home visit | `schedule_visit` from hospital | on community board at once; `completed` by **+121** |

Capacity per fresh world: gp 6 · hospital 2 · community 4 · diagnostics 4 · beds 2.
Exhausting returns 409. `order_test` consumed a diagnostics slot. A completed visit
showed community back at 4/4 — capacity is probably consumed while scheduled and
released on completion, but **do not rely on visits being free**; the handbook says
community is 4.

### Known dead ends
- The `bed` resource (`r-47`) has no action and never empties. Readiness is your
  checklist + the attendance reaching `discharged`, not the bed.
- Outbound patient channels are SMS/email only. No letters, calls, or interpreter
  booking. Goals/needs choose the *mode* of what you book, nothing more.
- Closing the seeded "Discharge & flow" message thread is probably impossible — it is
  a `message` resource owned by the messaging service, not a GP conversation.
  Timebox 10 minutes, then drop the beat.

## Amira's actual clinical data (verified analyte by analyte — get this right)

Amira Khan, SIM-000001, 74, heart failure + CKD, on furosemide.

- **U&E across a year:** potassium peaked at 5.7 four months ago and has *fallen
  since* — yesterday's U&E is in range (K+ 5.1, creatinine 107) **except eGFR 49,
  flagged low**. Do NOT say "potassium rising". The bloods item is justified by the
  seeded hospital document — it literally says **"Blood monitoring requested"** — plus
  CKD + loop diuretic needing follow-up U&E. Order it **routine**, not urgent:
  urgent repeat of yesterday's normal U&E is clinically odd.
- **FBC: a real neutropenia arc a judge will find if you don't.** Neutrophils
  2.0 → 1.0* → 0.5* → 0.8* → 1.7* over the year, recovered to 2.6 yesterday, but
  WCC is still flagged (3.5*). Include an FBC alongside the U&E in the monitoring
  order and let the LLM cite the trend in `clinicalDetails` — cheap, and it shows
  the agent actually read the results.

Other seeded facts (fresh world, discover by query, never hardcode ids):

- `r-1` hospital document — "Blood monitoring requested; home equipment and
  medication handover not confirmed." Hospital-visible only.
- `r-3` prescription — furosemide, status **approved**, not dispensed, stock 3.
- `r-6` message — "Respiratory: review worsening oxygen requirement", **urgent,
  open** → this is the CLINICAL HOLD (below).
- `r-7` message — "Discharge & flow: confirm medication handover", urgent, open.
- GP inbox: cardiology letter (urgent, unassigned) chasing a missing medicines-
  reconciliation attachment; **also a seeded `discharge-summary-example` for Amira
  already `sent`** — see the verifier rule.
- **She already has an 08:15 in-person practice appointment today** (booked, 15 min).
  Don't book another on top: **cancel and rebook as telephone** to honour "avoid
  unnecessary travel" (`cancel_appointment` + `book_appointment`, UNTESTED — check
  schemas), or book the post-discharge review a week out.
- Needs: "Home visit", "Carer involvement". Goals: "Stay at home with a clear
  contact for help", "Avoid unnecessary travel".

Eleanor Chen is **SIM-000006** (frailty, need "Step-free access") and is already on
the seeded hospital take list — attendance `hospital-attendance-seed-5`, "Reduced
mobility", stage `take`, AMU bed 1. Her blocker lives in the **community view** (not
hospital): care package awaiting allocation, **funding pending**, home support not
arranged, carer unavailable, steps ~1,800/day vs ~4,200 baseline. She is the
`blocked_human` patient.

## Demo scale — build the ward you want, and time fills the ED (all verified)

A fresh world seeds **8 hospital attendances** (SIM-000001..000008) at realistic
stages: Amira waiting (you admit her in setup), two waiting (abdominal pain, wheeze),
one assessing (head injury, Majors 1), two on the take (dizziness Majors 2; Eleanor,
AMU bed 1), and two already inpatient (chest discomfort AMU bed 2, fall at home
AMU bed 3). Each has a name, conditions, needs and goals.

The ward is NOT capped at 8 — both scaling levers are verified:

- **`register_attendance` + the stage walk puts anyone in a bed.** Required fields:
  `patientId`, `presentingComplaint`, `acuity`, `location` (400 error names them).
  Verified end to end: registered directory patient SIM-000010 ("Oliver Khan"),
  walked assign → assess → refer → admit to "AMU bed 4". **Neither
  `capacity-hospital` nor `capacity-beds` decremented (2/2 throughout)** — admissions
  are not capacity-gated; the setup script can build any ward size.
- **Advancing time fills the ED on its own, indefinitely.** Arrivals run at ~6/hour
  with no observed cap: 8 seeded → 57 at +8h → 201 at +32h → **484 at +80h** (per the
  attendances endpoint; the site view stops returning them all past ~230 — count via
  `GET /api/sites/hospital/attendances`, not the view). Every arrival sits at
  `waiting` forever: **nothing self-progresses, no one is ever seen, admitted or
  discharged without an action**. Consequences: (a) the demo's 121-min advance adds
  ~12 waiting patients, so the ward-list UI must filter to `take`/`inpatient`;
  (b) free pressure narrative — "while we cleared Amira's barriers, twelve more
  people arrived downstairs"; (c) the world being inert without an agent IS the
  pitch.
- **Capacity counters are action budgets, not admission gates.** Verified across
  80 sim-hours and multiple admissions: `capacity-hospital` and `capacity-beds`
  never moved (2/2 throughout), while `order_test` visibly consumed a diagnostics
  slot (4→3). So counters are drawn down by bookable *actions* in the owning site,
  and `capacity-beds` is most plausibly the knob the winter-pressure incident turns
  ("increase urgent arrivals and reduce available beds" — operator-controlled).
  Bed occupancy in your UI = count of `inpatient`-stage attendances, nothing else.

Recommended ward: the seeded 8 (they have the richest records — documents, bloods,
pharmacy, community state) plus 2–4 directory admits for size. Directory patients
have needs/goals/conditions but thinner clinical records, so their detected barriers
will mostly come from needs/goals. Resolve end-to-end only for Amira and Eleanor;
the rest are live-detected rows proving generalisation. Bed *resources* don't exist
per patient (only Amira's r-47); "in a bed" is the attendance's free-text location.

## The clinical hold — the safety beat on Amira herself

An orchestrator that discharges a breathless heart-failure patient while
"Respiratory: review worsening oxygen requirement" is urgent and open gets laughed
off stage by any doctor judge. Model it:

- Item type `clinical_hold`, evidence = the open r-6 thread. **No resolver.** It can
  only be cleared by explicit clinician confirmation in your UI (the ADK
  pause/resume moment), recorded in the audit trail. Discharge is gated on it.
- This gives you the human-in-the-loop beat on Amira *and* the external-decision
  beat on Eleanor — two different reasons automation must stop, both deliberate.

## The verifier rule (the trap is seeded)

**Every verifier checks the specific `resourceId` its resolver created — never "any
matching resource for this patient."** The seeded world contains a `sent` discharge
summary for Amira, historical visits, tasks and appointments; a "does one exist"
verifier goes green before you've done anything. Resolver returns
`{itemId, action, resourceId, idempotencyKey}`; verifier re-reads that id in the
owning service and checks its state (`completed` / `available` / `sent` /
`collected` / reading present). Detection uses the same records to skip
already-verified items on re-run.

## Amira's checklist (seven items)

1. **Clinical hold** (clinician): open urgent respiratory review → human sign-off
   only.
2. **Medicines** (pharmacy): furosemide approved, not dispensed. The prescription is
   already approved, so the chain starts at **`link_prescription_stock` →
   `dispense` → `collect`** — review/accept shouldn't be needed. UNTESTED: pull
   payloads from openapi (`pharmacyCommand` enum exists) and smoke-test first.
3. **Monitoring bloods** (diagnostics): routine U&E + FBC, LLM-written
   clinicalDetails citing eGFR 49 and the neutrophil recovery. Verified mechanism.
4. **Home monitoring** (wearables): `connect_device`; verify a reading exists.
   Verified.
5. **Home support** (community): `schedule_visit`; verify that visit `completed`.
   Verified.
6. **Information** (hospital→GP/community): LLM drafts all seven sections including
   the med-rec the letter chases → `save_discharge_summary` → `process_document`
   send (verified) → `share_record` to community (UNTESTED).
7. **Follow-up** (GP): `create_task` 48h review (verified) + rebook today's 08:15
   in-person as telephone (UNTESTED).

Finale: clinician clears the hold on screen → attendance already `inpatient` from
setup → `discharge` with disposition → show the sim's own four apps: hospital
discharged list, GP inbox, community board, home dashboard.

## Architecture

```
src/orchestrator/
  model.ts    # ChecklistItem {id, patientId, title, owner, state, evidence[],
              #  proposedAction?, approval?, resolution?, verification?, escalation?}
              #  states: proposed -> approved (staff gate) -> resolving ->
              #  awaiting_verification -> verified | blocked_human | clinical_hold
              #  blocked_human items can carry a prepared escalation (team +
              #  next action + note) and STAY blocked
  detect.ts   # rule-based readers + LLM free-text pass -> items with quoted evidence
  resolve.ts  # one resolver per item type; returns {resourceId, key, action} for audit
  verify.ts   # re-reads resolver-created resourceIds only
  run.ts      # loop: detect -> resolve unblocked -> advance clock -> verify -> repeat
src/ui/       # tiny http server + one page: ward list, red/amber/green rows,
              # evidence on click, clinician "confirm hold cleared" button
scripts/
  demo-discharge.ts  # --world <name> [--step]; setup admits Amira to AMU bed 12
```

The sim is the system of record for clinical facts and is not extensible; **all
orchestration state (checklist, item states, evidence, audit trail) lives app-side,
keyed by sim `resourceId`**. The sim's own UIs render the same world state as the
API, so admitted patients, sent documents and completed visits appear there
automatically — demo with two windows: your ward list acting, the sim's apps as
ground truth filling in behind it. Optional flourish: mirror open barriers into the
sim's UI as `create_task` / `hospital_note` entries so their hospital view shows the
agent's worklist.

## Milestones — ~8 build hours, timings are the scope knife

| # | What | Time | Demo-able result |
| --- | --- | --- | --- |
| M1 | Detectors + checklist, read-only, Amira | 1.5h | Seven red items with quoted evidence |
| M2 | **Minimal web ward list** (rows, colours, evidence) | 1h | A screen — never demo scrolling JSON |
| M3 | Resolvers+verifiers for verified items (3,4,5,6-send,7-task) + 121-min advance | 2h | Checklist goes green live |
| M4 | Clinical hold UI gate + admission setup + discharge finale | 1.5h | Full Amira arc |
| M5 | Pharmacy chain, rebook-as-telephone, share_record (the UNTESTED trio) | 1h | All seven items real |
| M6 | Eleanor `blocked_human` + audit trail polish | 1h | The "knows when to stop" beat |

**Record the submission video as soon as M3 works** (mandatory: problem, product,
impact); re-record if M4/M6 land. If a milestone runs over, cut from the bottom of
this table, never from verification.

Four-person split: (a) detectors + LLM evidence pass, (b) resolvers/verifiers,
(c) UI, (d) demo-world scripting + video. Streams (a)–(d) only meet at `model.ts` —
agree its types first.

## Risks

- Version conflicts are the top live-demo failure: re-read → act → re-read; never
  cache versions across steps.
- Resource ids look deterministic per seed but must be discovered by query.
- Frame everything as **operational readiness with clinician sign-off** — the sim
  doesn't model outcomes, and the clinical hold is your proof you know the
  difference.

## Definition of done

`node scripts/demo-discharge.ts --world scratch-<hex> --step` runs: setup (admit to
AMU bed 12) → seven red items with evidence → resolve → advance 121 → green except
the clinical hold → clinician clears it in the UI → discharge → handover visible in
GP/community/wearables via API reads. Then the Eleanor arc ending in one
`blocked_human` item. Re-running against the same world no-ops cleanly because
detection sees verified state.
