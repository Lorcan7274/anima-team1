# Homeward, discharge-readiness orchestrator

Built at the OpenAI × Anima Healthtech Hackathon (12 Sep 2026, Team 1) on the
[NHS-SIM](https://sim.animahacks.com/docs/) synthetic healthcare simulator.
The full brief is in `discharge-orchestrator-brief.md`; this file is how to run it.

Patients stay in hospital beds after they are medically fit because the services
outside the hospital are not lined up. Homeward is a neighbourhood discharge desk:
per patient it **detects** discharge barriers from the record with quoted evidence,
**resolves** each one by acting in the owning service through the API, **verifies**
after time moves by re-reading the specific resource it created, and **stops for a
human** where it must, a clinical hold only a clinician can clear, an external
decision (care-package funding) no API can make.

The model boundary is explicit: the LLM (Anima ADK, OpenAI provider) reads free text
and writes prose, barrier proposals with verbatim quotes, the seven discharge-summary
sections, lab-request clinical details, escalation handovers. Deterministic code
acts, advances the clock, verifies and drives the state machine.

## The shared simulator is gone, the demo still runs

The hackathon's shared NHS-SIM instance no longer answers: `POST /api/keys`, the only
way to get a world key, timed out after 100 seconds on 13 Sep 2026, and the API
explorer is intermittent. So the demo now runs against a **local stand-in of the
simulator** (`src/sim/local/`), a re-implementation of the API subset Homeward uses,
served over real HTTP from inside the demo process. Nothing in the agent changed to
make that work: the same client, the same requests, the same wire trace, the same
verifiers, only the origin differs. The page and the receipt state which simulator a
run used, so a stand-in is never mistaken for the shared world.

- `npm run demo` starts the stand-in and runs the whole flow against it (no key,
  no network).
- `npm run demo -- --live` runs against a real simulator at `SIM_ORIGIN`, exactly as
  before, for whenever an instance exists again.
- The code as it stood when the shared simulator was last used is kept unchanged on
  the branch `live-api`.

What the stand-in reproduces (`src/sim/local/world.ts`): team names as join codes,
bearer auth, site views filtered by visibility, idempotency-key replay (and a 409 on
the same key with a different body), `resourceId` + `expectedVersion` updates with a
409 on a stale version, the attendance stage machine (assign, assess, refer, admit,
discharge), the pharmacy chain (link stock, dispense, collect), the two-step discharge
summary (`save_discharge_summary`, then `process_document send` into the GP's
documents), `share_record` refused on the summary, appointment sessions and bookings,
and the outcomes the brief measured live: first watch reading 10 sim-minutes after
connecting, a visit completed at 90, blood results available at 120, and A&E arrivals
at about six an hour as the clock advances. `src/sim/local/seed.ts` is the demo world
from the brief: the eight seeded attendances, Amira Khan's record analyte by analyte
(potassium peaking at 5.7 four months ago and falling since, eGFR 49 flagged low, the
neutrophil dip and recovery), the seeded traps the verifier rule exists for (an old
sent summary, an old task, an old visit), Eleanor Chen's care package blocked on
funding. Everything in it is fictional and synthetic.

## Setup

Node 22.18 or newer; the backend runs `.ts` files directly (no build step).

```bash
npm install                # typescript for typecheck + @animahealth/adk, openai, zod
cp .env.example .env       # optional: OPENAI_API_KEY for model drafts; SIM_ORIGIN and SIM_KEY only matter with --live
```

Without `OPENAI_API_KEY` every model call falls back to a canned draft and the UI
labels it as such, nothing silently pretends to be the model.

**World discipline (live runs).** `POST /api/keys {teamName}` creates *or joins* a
world, so team names are join codes. The demo runner mints an unguessable
`discharge-<hex>` world by default. Never develop against the team world in `.env`;
never commit `.env`. The local stand-in follows the same rule: the same team name
rejoins the same world for as long as the server runs.

## Run the demo

```bash
npm run demo                              # local stand-in started in-process, UI on http://localhost:4600
npm run demo -- --approve --clear-holds   # headless: auto-approve the plan and simulate the clinician (finishes in about a second)
npm run demo:detect                       # read-only: the seven red items with evidence, no actions
npm run demo -- --ward                    # also track the two seeded inpatients (SIM-000007/8)
npm run demo -- --sim-port 4680           # pin the embedded stand-in's port (default: any free port)
npm run demo:live                         # a real simulator at SIM_ORIGIN (.env), new random world
npm run demo:live -- --world discharge-<hex>   # a specific world (re-runs are safe: settled items stay settled)
```

What happens (`scripts/demo-discharge.ts`):

1. **Setup** admits Amira Khan (SIM-000001) to AMU bed 12 and Eleanor Chen (SIM-000006) to
   AMU bed 1 by walking the attendance stage machine (assign → assess → refer → admit).
2. **Detect** builds the checklist per patient: rule-based readers over the sim views plus
   a model pass over the record's free text; every quote is located in the record
   before it is shown.
3. **Approve**, the runner waits for *Approve plan* in the UI (staff approval of the
   operational plan). Clinical holds and external decisions are never approvable.
4. **Resolve → advance 121 sim-minutes → verify**, up to three rounds. Each verifier
   re-reads only the resource its resolver created (the seeded world contains an old
   `sent` summary, old visits and tasks that would fool a lazy check).
5. **Clinical hold**, the runner waits for *Confirm reviewed* in the UI; that is the
   only way a hold clears, and it is recorded in the audit trail.
6. **Discharge** whoever is fully green; Eleanor stays blocked on the funding decision
   with a prepared escalation handover (the "knows when to stop" beat).

Every simulator request lands in the UI's trace (method, payload, idempotency key,
response), that is the compliance record shown to judges. Board snapshots are written
to `fallback-board.json` after each phase.

An embedded stand-in world dies with the process, so `npm run demo` starts fresh
every time. For a world that persists across runs (safe re-runs, several scripts
sharing one world, poking the API with curl), run the stand-in on its own:

```bash
npm run sim:local                         # http://127.0.0.1:4680 (--port, --host 0.0.0.0, --arrivals 6, --verbose)
SIM_ORIGIN=http://127.0.0.1:4680 npm run demo:live -- --world my-demo    # the usual re-run semantics apply
curl -X POST http://127.0.0.1:4680/api/keys -H 'content-type: application/json' -d '{"teamName":"my-demo"}'
```

### The UI (`src/ui/server.ts`)

One page served by `node:http` on `localhost:4600`, polling `/state`:

- **Mode strip.** Says whether the run used the shared simulator, the local stand-in
  (and at which origin), or a saved snapshot.
- **Left, the work.** KPI tiles (click for detail), a card per patient with the
  barrier dependency graph, click any task for its story: record evidence, plan and
  approval, every call the agent made to the owning service, drafting provenance
  (model vs fallback), independent verification, escalation.
- **Right rail.** Open items per service and the live wire trace.
- **Receipt.** Each patient card downloads a consolidated Markdown discharge
  coordination record (`GET /receipt?patient=…`).

### The second screen: the whole ward (`scripts/flow-sim.ts`)

For a second laptop at the stall. A ward running unattended for as long as you leave
it: every tick advances the clock, ingests the new A&E arrivals, and moves every
person one station along with real actions, assign and assess in A&E, home from A&E
or refer to the take, admit when a ward bed is free, the discharge checklist through
the same resolvers and verifiers as the ward-round demo, discharge when everything is
verified. By default it runs on an in-process stand-in (`src/flow/offline.ts`, the
verified timings, never stalls); `--live` joins a throwaway world in a simulator at
`SIM_ORIGIN` instead.

```bash
npm run flow                              # local stand-in, screen on http://localhost:4700
npm run flow -- --step 30 --beds 12       # sim-minutes per tick, ward size (defaults)
npm run flow -- --stay 60-240             # assumed treatment stay before fit, sim-minutes (default 60-180)
npm run flow -- --pause-ms 500            # real time between ticks (default 2500)
npm run flow:live                         # a simulator at SIM_ORIGIN (--llm lets the model draft the letters)
npm run flow:replay                       # no simulator: show the last flow-state.json (--replay-file path, --port 4701)
```

The screen shows two journeys with the same arrivals: **With Homeward** (the live
lane) and **Today's ward** (the illustrative manual-working model in
`src/story/baseline.ts`, same beds, so it fills and people queue). Counters: arrivals,
beds occupied, waiting for a bed vs the model, home, median door-to-home, and bed-hours
saved (the manual ward's bed-hours minus Homeward's, over the same arrivals and beds).
The page states what is real and what is assumed: nobody in the simulator gets better
on their own, so treatment before "medically fit" is a seeded 1–3 h stay; acuity 1–2
are admitted and 25% of acuity 3; the ward has 12 beds. People both lanes have
finished with are folded into the counters after six sim-hours, so a screen left
running all day stays small. Every tick is written to `flow-state.json` for `--replay`.

### Snapshot fallback

```bash
npm run fallback                              # serve fallback-board.json with no simulator at all
node scripts/serve-fallback.ts path/to.json   # any saved snapshot
```

Approve / clear-hold / escalate still work, they mutate the local copy, so the whole
flow can be walked through from a recording. The page says it is a snapshot.

## Checks

```bash
npm test            # unit, contract, stand-in and invariant tests; mocked fetch / fake sim, no network or key needed
npm run evals       # the same suite; engine invariants live in test/invariants.test.ts
npm run typecheck
npm run ui:smoke    # renders the ward page in headless Chromium and fails on any page error (skips when no browser is installed)
```

The invariants are the promises the demo makes: verifiers trust only resolver-created
resources, re-runs never re-resolve settled items, the loop never acts before approval,
a draft-only summary is never sent, holds and external decisions have no resolver, and
nobody is discharged with a hold or blocker open. `test/local-sim.test.ts` drives the
complete demo through the real client over HTTP against the stand-in and asserts every
one of those outcomes.

## Layout

```
discharge-orchestrator-brief.md   the brief: mission, verified API mechanics, checklist, milestones
scripts/demo-discharge.ts         the demo runner (flags above)
scripts/local-sim.ts              the simulator stand-in as a standalone server
scripts/serve-fallback.ts         offline UI from a snapshot
scripts/flow-sim.ts               the second screen: a whole ward running unattended
scripts/ui-smoke.ts               headless-browser check of the ward page
scripts/quickstart.ts             handbook quickstart against a team world (live)
scripts/capture.ts                record read-only responses into fixtures/ (live)
src/orchestrator/model.ts         ChecklistItem / PatientRow / BoardState, the meeting point of all workstreams
src/orchestrator/detect.ts        rule-based readers + model free-text pass → items with quoted evidence
src/orchestrator/llm.ts           the model boundary (ADK + OpenAI, Zod-typed, honest fallbacks)
src/orchestrator/resolve.ts       one resolver per item type; acts in the owning service
src/orchestrator/verify.ts        re-reads resolver-created resources only
src/orchestrator/run.ts           detect → resolve → advance → verify loop, approval, holds, escalation
src/orchestrator/world.ts         world join, admission stage machine, discharge
src/story/baseline.ts             the illustrative manual-ward model (stated parameters, seeded RNG)
src/story/story.ts                two-lane timelines + counters derived from the board
src/flow/engine.ts                the whole-ward flow simulation (ingest arrivals, move people, model lane)
src/flow/offline.ts               the flow screen's in-process stand-in
src/flow/ui.ts                    the second screen
src/ui/server.ts                  the ward-round page + tiny HTTP API
src/sim/                          the simulator client (below)
src/sim/local/                    the simulator stand-in: world.ts (state + API semantics), seed.ts (the demo world), api.ts (keys, auth, routing), server.ts (node:http)
test/                             unit, UI, baseline-model, stand-in and invariant tests
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
`trace` callback, the UI's wire trace. `advanceClock` sends jumps larger than the
simulator's 10080-minute cap as several capped calls rather than truncating.

`src/orchestrator/trace.ts` annotates each trace record with a plain-language headline
and outcome ("Dispensed the prescription" / "Prescription r-3 · now dispensed · v3") so
the ward list reads as sentences, with the raw exchange behind a "Show request" drop-down.

`node scripts/quickstart.ts --create-team "Name"` reproduces the handbook quickstart and
`node scripts/capture.ts` records read-only responses (keys redacted) into `fixtures/`;
both probe the simulator once and stop with a clear message when it does not answer.

## Tests

```bash
npm test          # fake simulator and local stand-in, no network or key needed
npm run typecheck # needs `npm install` first for typescript
```

The suite runs offline: detection (`detect.test.ts`), resolvers (`resolve.test.ts`),
verifiers (`verify.test.ts`), the run loop (`run.test.ts`), the ward page routes
(`ui-server.test.ts`), the flow engine over a 200-tick run (`flow.test.ts`), engine
invariants, the stand-in's API semantics and the complete demo through it
(`local-sim.test.ts`), and a contract check of every action type and enum the code
sends against a captured copy of the simulator's OpenAPI enums
(`test/fixtures/openapi-enums.json`). GitHub Actions runs typecheck and the suite on
every push and pull request (`.github/workflows/ci.yml`).

## Still to verify against the live API

The response types in `src/sim/types.ts` are loose on purpose. Only the quickstart
shapes are confirmed. The stand-in encodes what the brief verified on 12 Sep 2026; if a
simulator instance appears again, download `/api/openapi.json` with a working key,
tighten the types for the action bodies, the clock change body and the workspace
responses, and check the stand-in against them (`src/sim/local/world.ts` is written to
be compared, one endpoint per method).
