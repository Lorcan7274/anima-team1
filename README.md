# Homeward — discharge-readiness orchestrator

Built at the OpenAI × Anima Healthtech Hackathon (12 Sep 2026, Team 1) on the
[NHS-SIM](https://sim.animahacks.com/docs/) synthetic healthcare simulator.
The full brief is in `discharge-orchestrator-brief.md`; this file is how to run it.

Patients stay in hospital beds after they are medically fit because the services
outside the hospital are not lined up. Homeward is a neighbourhood discharge desk:
per patient it **detects** discharge barriers from the record with quoted evidence,
**resolves** each one by acting in the owning service through the API, **verifies**
after time moves by re-reading the specific resource it created, and **stops for a
human** where it must — a clinical hold only a clinician can clear, an external
decision (care-package funding) no API can make.

The model boundary is explicit: the LLM (Anima ADK, OpenAI provider) reads free text
and writes prose — barrier proposals with verbatim quotes, the seven discharge-summary
sections, lab-request clinical details, escalation handovers. Deterministic code
acts, advances the clock, verifies and drives the state machine.

## Setup

Node 22.18 or newer; the backend runs `.ts` files directly (no build step).

```bash
npm install                # typescript for typecheck + @animahealth/adk, openai, zod
cp .env.example .env       # SIM_KEY (team key), OPENAI_API_KEY (optional), OPENAI_MODEL (optional)
```

Without `OPENAI_API_KEY` every model call falls back to a canned draft and the UI
labels it as such — nothing silently pretends to be the model.

**World discipline.** `POST /api/keys {teamName}` creates *or joins* a world, so team
names are join codes. The demo runner mints an unguessable `discharge-<hex>` world by
default. Never develop against the team world in `.env`; never commit `.env`.

## Run the demo

```bash
npm run demo                              # new random world, UI on http://localhost:4600
npm run demo -- --world discharge-<hex>   # a specific world (re-runs are safe: settled items stay settled)
npm run demo:detect                       # read-only: seven red items with evidence, no actions
npm run demo -- --approve --clear-holds   # headless: auto-approve the plan and simulate the clinician
npm run demo -- --ward                    # also track the two seeded inpatients (SIM-000007/8)
```

What happens (`scripts/demo-discharge.ts`):

1. **Setup** admits Amira Khan (SIM-000001) to AMU bed 12 and Eleanor Chen (SIM-000006) to
   AMU bed 1 by walking the attendance stage machine (assign → assess → refer → admit).
2. **Detect** builds the checklist per patient: rule-based readers over the sim views plus
   a model pass over the record's free text; every quote is located in the record
   before it is shown.
3. **Approve** — the runner waits for *Approve plan* in the UI (staff approval of the
   operational plan). Clinical holds and external decisions are never approvable.
4. **Resolve → advance 121 sim-minutes → verify**, up to three rounds. Each verifier
   re-reads only the resource its resolver created (the seeded world contains an old
   `sent` summary, old visits and tasks that would fool a lazy check).
5. **Clinical hold** — the runner waits for *Confirm reviewed* in the UI; that is the
   only way a hold clears, and it is recorded in the audit trail.
6. **Discharge** whoever is fully green; Eleanor stays blocked on the funding decision
   with a prepared escalation handover (the "knows when to stop" beat).

Every simulator request lands in the UI's trace (method, payload, idempotency key,
response) — that is the compliance record shown to judges. Board snapshots are written
to `fallback-board.json` after each phase.

### The UI (`src/ui/server.ts`)

One page served by `node:http` on `localhost:4600`, polling `/state`:

- **Left — the work.** KPI tiles (click for detail), a card per patient with the
  barrier dependency graph, click any task for its story: record evidence, plan and
  approval, every call the agent made to the owning service, drafting provenance
  (model vs fallback), independent verification, escalation.
- **Right rail.** Open items per service and the live wire trace.
- **Receipt.** Each patient card downloads a consolidated Markdown discharge
  coordination record (`GET /receipt?patient=…`).

### The second screen: the whole ward (`scripts/flow-sim.ts`)

For a second laptop at the stall. Its own throwaway world, running unattended for as
long as you leave it: every tick advances the simulator clock, ingests the new A&E
arrivals the simulator generates (about 6–8 per sim-hour, each a synthetic patient
with a record), and moves every person one station along with real actions — assign
and assess in A&E, home from A&E or refer to the take, admit when a ward bed is free,
the discharge checklist through the same resolvers and verifiers as the ward-round
demo, discharge when everything is verified.

```bash
npm run flow                              # new world, screen on http://localhost:4700
npm run flow -- --step 30 --beds 12       # sim-minutes per tick, ward size (defaults)
npm run flow -- --llm                     # let the model draft the letters (slower)
npm run flow:replay                       # no simulator: animate the last flow-state.json (add -- --port 4701 to run beside a live one)
```

The screen shows two journeys with the same arrivals: **With Homeward** (the live
world) and **Today's ward** (the illustrative manual-working model in
`src/story/baseline.ts`, same beds, so it fills and people queue). Counters: arrivals,
beds occupied, waiting for a bed vs the model, home, median door-to-home, bed-hours
saved vs the model. The page states what is real and what is assumed: nobody in the
simulator gets better on their own, so treatment before "medically fit" is a seeded
2–8 h stay; acuity 1–2 are admitted and 35% of acuity 3; the ward has 12 beds.
Every tick is written to `flow-state.json` for `--replay`.

### Offline fallback

```bash
npm run fallback                              # serve fallback-board.json with no simulator
node scripts/serve-fallback.ts path/to.json   # any saved snapshot
```

Approve / clear-hold / escalate still work on the local copy, so the whole flow can be
walked through if the shared simulator is down.

## Checks

```bash
npm test            # unit + invariant tests, mocked fetch / fake sim — no network or key needed
npm run evals       # the same suite; engine invariants live in test/invariants.test.ts
npm run typecheck
```

The invariants are the promises the demo makes: verifiers trust only resolver-created
resources, re-runs never re-resolve settled items, the loop never acts before approval,
a draft-only summary is never sent, holds and external decisions have no resolver, and
nobody is discharged with a hold or blocker open.

## Layout

```
discharge-orchestrator-brief.md   the brief: mission, verified API mechanics, checklist, milestones
scripts/demo-discharge.ts         the demo runner (flags above)
scripts/serve-fallback.ts         offline UI from a snapshot
scripts/flow-sim.ts               the second screen: a whole ward running unattended
scripts/quickstart.ts             handbook quickstart against a team world
scripts/capture.ts                record read-only responses into fixtures/
src/orchestrator/model.ts         ChecklistItem / PatientRow / BoardState — the meeting point of all workstreams
src/orchestrator/detect.ts        rule-based readers + model free-text pass → items with quoted evidence
src/orchestrator/llm.ts           the model boundary (ADK + OpenAI, Zod-typed, honest fallbacks)
src/orchestrator/resolve.ts       one resolver per item type; acts in the owning service
src/orchestrator/verify.ts        re-reads resolver-created resources only
src/orchestrator/run.ts           detect → resolve → advance → verify loop, approval, holds, escalation
src/orchestrator/world.ts         world join, admission stage machine, discharge
src/story/baseline.ts             the illustrative manual-ward model (stated parameters, seeded RNG)
src/flow/engine.ts                the whole-ward flow simulation (ingest arrivals, move people, model lane)
src/flow/ui.ts                    the second screen
src/ui/server.ts                  the ward-round page + tiny HTTP API
src/sim/                          the simulator client (below)
test/                             unit, UI, baseline-model and invariant tests
```

## The simulator client (`src/sim/`)

Plain TypeScript, no runtime dependencies, one method per endpoint:

```ts
import { SimClient } from './src/sim/index.ts'

const sim = SimClient.fromEnv()
const patients = await sim.searchPatients('gp', 'SIM-000001')
const task = await sim.createTask('gp', 'SIM-000001', 'Check discharge follow-up', 'first-gp-task')
const view = await sim.siteView('hospital', { patient: 'SIM-000001' })
await sim.advanceClock(121)                       // keeps the world paused
```

| Area | Methods |
| --- | --- |
| Discovery | `health()`, `catalogue()`, `openapi()` |
| Team | `createTeam(name)`, `team()`, `withKey(key)`, `createBrowserSession()` |
| Service workspaces | `siteView(site, query)`, `searchPatients(site, q)`, `siteAction(site, action, key)`, `createTask(...)`, `orderBloodTest(...)`, `connectDevice(...)`, `createReferral(...)`, `siteAppointments(site, {date})`, `wearables(patient)` |
| GP, hospital, pharmacy, messaging | `gpDocuments()`, `hospitalAttendances()`, `hospitalDocuments()`, `pharmacyWorkspace()`, `gpMessagingWorkspace()`, `patientMessagingWorkspace()` |
| Simulation time | `clock()`, `changeClock(change)`, `advanceClock(minutes)` |
| NHS-shaped adapters | `adapter(name)`, `adapterAction(name, action, key)` |
| FHIR read-only | `fhir.searchPatients()`, `fhir.readPatient(id)`, `fhir.searchOrganizations()`, `fhir.readOrganization(id)` |
| Operator (separate token) | `OperatorClient` with `worlds()`, `teams()`, `snapshot()`, `setIncident()`, and more |

Mutating calls take an idempotency key; a retry with the same key and payload returns
the original result. Updates to existing records need `resourceId` + `expectedVersion`.
Failed calls throw `SimApiError` with the HTTP status and parsed body. Requests time
out after `SIM_TIMEOUT_MS` (default 45 s) and every request is reported to an optional
`trace` callback — the UI's wire trace.

`node scripts/quickstart.ts --create-team "Name"` reproduces the handbook quickstart;
`node scripts/capture.ts` records read-only responses (keys redacted) into `fixtures/`.
