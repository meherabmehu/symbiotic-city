# Demo script — SYMBIOTIC CITY

**Target length:** 8–10 minutes for the submission cut. **Format:** screen
recording with voice-over, 1080p or better, browser at 1440×900 for the desktop
segments and a resized window for the mobile segment.

The eleven segments below total about 16 minutes if all are recorded. Two cuts are
honest options: the **submission cut** (segments 0–3, 5, 8, 9, 10 — roughly 9
minutes) keeps the thesis, one cascade, the honest failure and the two resilience
segments that carry the new argument; the **full walkthrough** records everything
and is linked separately. Do not describe a cut as complete if it omits segments 6
and 7, which are where the system admits its limits.

Every number in this script comes from the seeded dataset and is served by the
real API. Nothing is mocked, hard-coded for the camera, or faked in post. If the
recorded take disagrees with what the application shows, the application is right
and the script is wrong.

> **Status of this document:** the script and the recording checklist are
> complete, and every path in it was walked against a running backend and
> frontend. **No video has been uploaded** — S01 is *Not verified* until a
> recording exists at a public URL.

---

## Before you record

| Requirement | Why |
| --- | --- |
| Backend on `:8000` with `SEED_DEMO_DATA=1` | The script quotes the seeded counts |
| Frontend on `:3000` | `BACKEND_URL` must point at the backend |
| A fresh seed (remove the SQLite file, restart) | Audit-log and workflow counts drift between takes |
| Two browser profiles — normal + private | The script holds two roles at once |
| Zoom at 100%, bookmarks bar hidden | Keeps the UI readable at 1080p |
| Notifications muted | No personal data may appear in frame |

**Never in frame:** any password field with text visible, any `.env` file, any
terminal showing `DATABASE_URL` with credentials, any browser password-manager
popup. The seeded passwords are demo-only and published in this repository, but
the recording must not teach the pattern.

---

## 0 · Cold open — the premise (45 s)

**Screen:** the landing page at `/`.

**Say:** *"A city runs on dependencies. When the substation fails, the water pump
loses power, the hospital loses water, and the traffic system loses its signals —
in that order, within minutes. Symbiotic City is the command layer that models
that chain, quantifies who is affected, and produces a recovery plan the city can
actually execute."*

**Do:** point at the live-twin pill in the hero (`LIVE DIGITAL TWIN • SYNCED`),
then the four role cards. Do not scroll fast — the judge needs to read.

**Say:** *"Four roles, four different jobs: a Super Admin, a City Operator, a
Field Engineer and a City Analyst. Permissions are enforced server-side, and we
will prove that later."*

---

## 1 · Sign in and orient (60 s) — City Operator

**Do:** sign in as `operator@symbiotic.city`.

**Say:** *"The command deck is one request. Active incidents, plans waiting for
approval, today's task board, resource pressure and unread notifications."*

**Point at:** the KPI row (assets at risk, open incidents, tasks due, coverage),
then the incident feed, then the resource gauges.

**Say:** *"Every figure is computed by the backend from current database state.
There is no client-side arithmetic pretending to be analytics."*

> Checkpoint: quote the incident count on screen. The seeded set is 11.

---

## 2 · The digital twin (90 s) — City Operator

**Screen:** `/twin`.

**Say:** *"Twenty-three infrastructure assets across power, water, telecom,
health, transport and emergency services, joined by twenty-five typed dependency
edges."*

**Do, in this order:**

1. **Hover** an asset — the tooltip shows status, capacity and dependency count.
2. **Click** one — the side panel fills with details and the dependency list.
3. **Drag** to pan, **scroll** to zoom.
4. Toggle **Dependencies on/off** — the edge layer appears and disappears.
5. Type in **Filter twin assets** — the list narrows as you type.
6. Tab to the canvas and use the **arrow keys** — selection moves through the
   graph without a mouse. This is the accessibility claim, demonstrated.

**Say:** *"The layout is synthetic — normalised to a 0–100 grid, and labelled as
synthetic on screen. We are not pretending to have city GIS data. What is real is
the topology and the propagation."*

---

## 3 · Rehearse the cascade (120 s) — City Analyst

**Screen:** `/simulation`, signed in as `analyst@symbiotic.city`.

**Do:** choose a power asset, mode **Total failure**, threshold **0.35**,
max depth **6**, seed **42**. Press **Run simulation**.

**Say:** *"The engine walks the dependency graph forward. A dependent asset fails
when its supply deficit passes the threshold. The propagation rule is one minus
the product of survival terms, so two partially failing feeds do not add
linearly — which is why a redundant hospital survives a single bad feed."*

**Point at:** assets failed, affected population, maximum cascade depth, and the
impact overlay on the twin above.

**Say:** *"Runs are deterministic for a given seed and snapshot, and every run is
persisted, so a plan can be defended weeks later."*

---

## 4 · Optimise under real constraints (120 s) — A02

**Screen:** `/optimization`.

**Do:** build the demand set from the run, **Preview**, then **Solve & persist**.

**Say:** *"This is a facility-location model with a coverage guarantee. Coverage is
all-or-nothing: a demand is either served or it is not, because telling a hospital
it is 'mostly supplied' is worse than telling it the truth. Priority weights are
exponential, so one hospital outranks five shops."*

**Point at:** assignments, unserved demands, and the binding-constraints panel.

**Do:** run the **infeasible** variation.

**Say:** *"When demand exceeds capacity the planner does not fail silently, and it
does not return a plan that quietly drops the hardest case. It refuses, and it
explains: total demand exceeds total resource capacity. That is the difference
between a solver and a demo."*

> This is the A02 evidence. Emphasise *conflicting constraints* and
> *explainability*, not just "we call a solver".

---

## 5 · Approve, dispatch, repair (150 s) — the multi-step workflow (A07)

**Screen:** across two profiles.

**Do:**

1. As **operator**, open the plan and **Approve**. Capacity is reserved.
2. Switch to `engineer@symbiotic.city` → **My Assigned Tasks**. Accept a task,
   start it, complete it with a repair note.
3. Back as operator → **Dispatch board**. Verify the completed task.
4. Verifying the last open task records `repair_verified`, resolves the incident,
   and moves the workflow to `incident_resolved`.

**Say:** *"The incident cannot be resolved while any repair task is unverified.
That is a server-side invariant, not a UI hint."*

---

## 6 · Break it on purpose (150 s) — the honest part

This segment is the strongest A07 evidence. Do not skip it and do not fake it.

**Screen:** `/workflows/{id}`.

**Do:**

1. Create a critical incident as operator; **Start recovery**. The workflow runs
   `incident_created → validated → simulation → plan generated` and stops at
   `awaiting_approval`.
2. **Inject fault** at `resources_reserved`.
3. Approve the plan. Expect a `409` whose `details` report
   `{workflow_id, failure_step, compensated: true}`.
4. Open the workflow console: the failed step is recorded, the compensation event
   lists exactly what was released, and the plan is still **approved**.
5. Press **Retry**. The workflow resumes, reserves capacity, dispatches tasks.

**Say:** *"Each step runs inside a savepoint, so a mid-step failure discards only
its own partial writes. The failure record and the compensation record are written
outside that savepoint, which is why they survive the rollback. The operator's
approval is never silently erased. This is a ledger of what was rolled back, not
just a stack trace."*

> Controlled failure injection → compensation → recovery → retry, all visible on
> screen. This is the A07 claim, demonstrated end to end.

---

## 7 · Prove the boundary (60 s) — RBAC

**Do:** with the analyst session, navigate to `/admin/users`; then attempt
`POST /api/incidents`; then, as operator, attempt `POST /api/optimization/requests`.

**Say:** *"Three refusals. The admin screen answers 403 and the nav entry is not
rendered at all. Analysts read incidents but cannot create them. Operators approve
plans; analysts submit them. Every one of these is a deliberate design choice and
every one is covered by an automated test."*

---

## 8 · Where the city is fragile (60 s) — Resilience

**Do:** `/resilience` → **Exposure**. Point at the zone map, select the highest
zone, then read the drivers and the ranked assets. Note that the three hospitals
sit at the bottom of the ranking with a score of 0.

**Say:** *"This is measured, not asserted. The substation scores 84 because losing
it fails seventeen assets and takes the hospital, the telecom link and the water
pump with it. The hospitals score zero — they are the most important things in the
city and the least consequential to lose, because nothing depends on them. The
hand-assigned criticality number said the opposite."*

---

## 9 · Price the trade-off (75 s) — the hard question

**Do:** **Recovery trade-offs** → choose the run from segment 3 → **Build
frontier**. Point at the plan cards, then at the notes underneath. Then
**Investment plan**, budget 150,000, and read the "Not claimed" figure.

**Say:** *"Three plans, none dominated — twelve sites, ten, or eight. Which is right
depends on what the city is prepared to spend, so it is presented as a choice
rather than decided for you. Down here: every option was applied to the real graph
and the cascade re-run, so the benefit is measured. And the recommended package is
measured as a package — adding the individual benefits would have claimed 141,500
people protected when only 85,300 were ever at risk. The difference is reported,
not rounded away."*

---

## 10 · Close the loop (45 s)

**Do:** `/analytics` → recovery performance and resource utilisation → **Export
CSV**. Then, as admin, `/admin/audit`.

**Say:** *"Every action in this video — the login, the run, the approval, the
fault, the retry, the export — is in the audit log with actor, target, timestamp
and result."*

**End card:** repository URL, live URL (only if it is deployed and verified), and
the one-sentence thesis.

---

## Recording checklist

Tick every line before uploading.

- [ ] Fresh database, seeded once, backend log shows a single seed
- [ ] Backend and frontend started from a clean shell; no `.env` visible
- [ ] Screen at 1440×900 or larger; browser zoom 100%
- [ ] Notification popups disabled; no personal browser tabs in the tab strip
- [ ] No password visible at any point, including the login field before submit
- [ ] No terminal showing database credentials or tokens
- [ ] Every number spoken aloud matches the screen
- [ ] The injected-fault segment shows the `409`, the compensation, and the retry
- [ ] The RBAC segment shows the actual refusal, not a description of one
- [ ] Audio is intelligible; no keyboard clatter over the voice-over
- [ ] Length between 8 and 10 minutes
- [ ] Video is public or unlisted-but-link-accessible (not private)
- [ ] Link added to `README.md` and `docs/SUBMISSION.md`

## Failure modes during a take

| Symptom | Cause | Recovery |
| --- | --- | --- |
| Dashboard shows zeros | Backend not up, or seed never ran | Restart backend with `SEED_DEMO_DATA=1` |
| No tasks after approval | No workflow was started for that incident | Start recovery on the incident first |
| Approve returns `409` with no compensation | The plan is genuinely infeasible | Read the explanation panel — this is correct behaviour |
| Fault never fires | Faults scheduled after approval | Inject before approving |
| Twin is blank | Container measured zero width | Reload; the canvas paints on the first real measurement |
