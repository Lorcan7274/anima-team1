# anima-team1

Client code for the [NHS-SIM](https://sim.animahacks.com/docs/) synthetic healthcare simulator.
It is plain TypeScript with no runtime dependencies. Node 22.18 or newer runs it directly.

## Setup

```bash
cp .env.example .env   # then paste your team key into SIM_KEY
export $(grep -v '^#' .env | xargs)
```

`SIM_ORIGIN` defaults to `https://sim.animahacks.com`. Point it at `http://localhost:8080` for a local instance.

## Run the quickstart

Reads patient `SIM-000001`, creates a GP task, and reads it back from the GP site view:

```bash
node scripts/quickstart.ts
node scripts/quickstart.ts --create-team "Example builders"   # also creates or joins a team
node scripts/quickstart.ts --patient SIM-000002 --title "Review bloods" --idempotency-key bloods-1
```

## Use the client

```ts
import { SimClient } from './src/sim/index.ts'

const sim = SimClient.fromEnv()

const patients = await sim.searchPatients('gp', 'SIM-000001')
const task = await sim.createTask('gp', 'SIM-000001', 'Check discharge follow-up', 'first-gp-task')
const view = await sim.siteView('gp')
const clock = await sim.clock()
const eps = await sim.adapter('eps-tracker', { patientId: 'SIM-000001' })
const fhirPatient = await sim.fhir.readPatient('SIM-000001')
```

Every method maps to one endpoint in the API explorer:

| Area | Methods |
| --- | --- |
| Discovery | `health()`, `catalogue()`, `openapi()` |
| Team | `createTeam(name)`, `team()`, `createBrowserSession()` |
| Service workspaces | `siteView(site)`, `searchPatients(site, q)`, `siteAction(site, action, key)`, `createTask(...)`, `siteAppointments(site)` |
| GP, hospital, pharmacy, messaging | `gpDocuments()`, `hospitalAttendances()`, `hospitalDocuments()`, `pharmacyWorkspace()`, `gpMessagingWorkspace()`, `patientMessagingWorkspace()` |
| Simulation time | `clock()`, `changeClock(change)` |
| NHS-shaped adapters | `adapter(name)`, `adapterAction(name, action, key)` |
| FHIR read-only | `fhir.searchPatients()`, `fhir.readPatient(id)`, `fhir.searchOrganizations()`, `fhir.readOrganization(id)` |
| Operator (separate token) | `OperatorClient` with `worlds()`, `teams()`, `snapshot()`, `setIncident()`, and more |

Sites are `gp`, `hospital`, `pharmacy`, and `patient`. Failed calls throw `SimApiError` with the HTTP status and parsed body.

Mutating calls accept an idempotency key. Repeating a request with the same key and payload returns the original result, which makes retries safe.

## Tests

```bash
npm test          # mocked fetch, no network or key needed
npm run typecheck # needs `npm install` first for typescript
```

## Still to verify against the live API

The response types in `src/sim/types.ts` are loose on purpose. Only the quickstart shapes are confirmed. Download `/api/openapi.json` with a working key and tighten the types for the action bodies, the clock change body, and the workspace responses.

## Capture live responses

With `SIM_KEY` set, this records read-only responses and the OpenAPI document into `fixtures/`:

```bash
node scripts/capture.ts
git add fixtures && git commit -m "Capture simulator fixtures" && git push
```

Keys and tokens are redacted before writing. The fixtures are the basis for tightening the types.
