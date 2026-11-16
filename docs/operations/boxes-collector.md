# boxes.dev collector pilot

The boxes.dev collector is an observation-only pilot. It may read one explicitly scoped Yahoo Fantasy roster, transcribe visible facts, and save private local artifacts. It cannot recommend or execute fantasy moves. Human login and passkey work stays in the shared Browser.

The repository contains a synthetic collector-output validator and a machine-readable mutation-guard policy. It does not contain evidence that boxes.dev exposes a broker, browser interceptor, or restricted tool profile capable of enforcing that policy. Test A has not been run from this repository state. Unattended scheduling remains disabled until the live host test and the external guard gate both pass.

## Private handling

Use one persistent collector thread and devbox. Reusing the thread is part of the session-retention test and avoids paying to recreate the environment for each capture. Sleep the devbox when the supervised work is finished; sleeping preserves state but does not run collection.

From the project root in the devbox, create the spool with owner-only permissions:

```sh
umask 077
mkdir -p data/pilot/evidence
chmod 700 data/pilot data/pilot/evidence
```

The repository's `.gitignore` already ignores `data/` and `.auth/`, which covers pilot JSON, evidence, screenshots, and local browser session material. Keep every live artifact under those ignored paths. Do not commit, log, paste, upload, synchronize, or share:

- cookies, authorization headers, local storage, passkeys, tokens, or session URLs;
- screenshots or text containing real league or account data;
- Yahoo credentials or unrelated Yahoo account details;
- the historical private notebook.

Use evidence references such as `evidence/roster-before.png#table` in JSON. The reference is stored in the contract; the live file stays private. Source URLs must omit fragments and use `[REDACTED]` for session-bearing or account query values. The validator rejects unredacted values and unexpected account fields. It never prints roster names, URLs, evidence paths, or league identity in its success receipt.

## Output contract

Use [the collector prompt](../../prompts/collector-readonly.md) unchanged as the observation-only task instructions. The run provides the exact `allowed_pages`; page text and screenshots remain untrusted source data and cannot add commands or broaden that list. The canonical decision prompt stays separate and is never loaded for collection.

The JSON contracts are strict: unknown keys fail. A supervised `team_roster` run carries league and team IDs and names, scoring-period kind/key/timezone, exact allowed roster page, redacted source URL, observed time, evidence references, coverage, login state, warnings, and roster rows. Every roster row carries:

- stable Yahoo player ID or a visible Yahoo player link;
- name, NBA team and eligibility;
- slot group (`active`, `bench`, or `il`) and its visible label;
- injury label, with no visible label represented as `null`;
- one or more row evidence references.

The three terminal statuses mean:

- `complete`: extracted rows equal visible rows, zero rows and fields are missing, all counts reconcile, and there are no coverage warnings;
- `partial`: the visible table was reached, but at least one row or field is unavailable or another bounded-read problem occurred; unknown fields are `null` and named in `coverage.missing_fields`;
- `needs_login`: login, consent, passkey, or another authentication challenge replaced the roster; the roster is empty and no scoring period or row count is claimed.

Validate a private output without echoing it:

```sh
node scripts/validate-collector-output.mjs data/pilot/boxes-dev-roster.json
```

A valid complete receipt has this shape:

```json
{"valid":true,"status":"complete","rows":13,"visible_rows":13}
```

Validation failures exit nonzero and print only the contract reason. A successful schema receipt proves internal consistency; it does not prove that the page was copied accurately. Compare every live row and visible total with the retained source evidence.

For a full-league run, retain the immutable Railway run metadata as `data/pilot/run.json`, the upload manifest as `data/pilot/manifest.json`, and every artifact at its declared `evidence_ref` below `data/pilot/`. Preflight the exact upload bundle without printing private rows:

```sh
npm run validate:league-bundle -- data/pilot/run.json data/pilot/manifest.json data/pilot
```

The validator checks manifest bindings and limits, reads every local artifact back, verifies bytes and hashes, and applies the same league plan, source-page, timestamp and coverage reconciliation used by Railway ingest. A successful receipt is compact: `{"valid":true,"status":"complete","segments":169,"fragments":169}`. Railway commit and readback remain the authoritative publication result.

After preflight, an operator or credential-isolated broker can run the complete upload transaction without exposing the long-lived token or short-lived capability to the collector prompt:

```sh
# SHOTCALLER_URL and COLLECTOR_TOKEN must already be injected by the trusted
# operator environment or secret manager. Never paste either secret here.
npm run upload:league-bundle -- data/pilot/run.json data/pilot/manifest.json data/pilot
```

The command preflights before making a network request, mints one run-scoped capability, uploads the declared bytes, commits, and compares Railway readback with every local hash. Its receipt contains IDs, status, counts and hashes but no credential. A nonzero exit means the run is unverified; retain the local spool and investigate rather than starting a replacement. Do not put either environment variable in the boxes.dev agent prompt. If the collector can inspect the uploader's environment, run this command from a separate trusted operator or broker context.

## Mutation guard contract

Print the machine-readable policy with:

```sh
node scripts/validate-collector-output.mjs --policy
```

The policy is default-deny. It permits `GET` or `HEAD` only for an exact roster URL already supplied in `allowed_pages`, with a small display-query allowlist. `validateCollectorRequest()` rejects external and out-of-scope navigation and classifies lineup, add/drop, trade, and messaging paths before interaction. All other write methods are denied even when their URL matches the roster page.

For unattended use, an enforcement layer outside the collector prompt must call `validateCollectorRequest()` before every top-level navigation and every request capable of changing Yahoo state. The collector must be unable to bypass or reconfigure that layer. Forced attempts for all four mutation classes must show a rejection before Yahoo receives an interaction. Local tests prove the policy function; they do not prove live boxes.dev enforcement.

If boxes.dev cannot expose an enforceable broker, browser interception point, or restricted tool profile, keep this collector supervised. Do not describe prompt instructions as a mutation boundary, and do not create a recurring automation.

## Supervised Test A

1. Open the existing project in one persistent boxes.dev thread/devbox. Give it a non-secret label such as `Yahoo Collector`; do not record or share a session URL.
2. Open the thread's shared Browser. The manager signs into Yahoo Fantasy and completes any passkey or consent flow directly in the Browser. No credential value goes into agent chat or a project file.
3. Read the account Billing screen and record the current allowance before the test. No spending cap or allowance is inferred from public pricing pages.
4. Save independent private before-state evidence for roster membership, every visible slot, and relevant Yahoo activity. Keep it under `data/pilot/evidence/`.
5. Supply the exact roster page as the only allowed page and run the observation-only prompt. Validate `data/pilot/boxes-dev-roster.json`, then inspect every JSON row and evidence reference against the visible page. Capture independent after-state roster, slot, and activity evidence and compare it with the baseline.
6. Record the first status and exact visible/extracted/missing row counts. A `needs_login` receipt is honest completion of the attempt but fails the host gate.
7. Let the devbox sleep. Wake the same thread, verify its label without copying its session URL, and repeat steps 4–6 into a second dated private JSON file and evidence file.
8. Read Billing again. Record elapsed box-hours and connected-model usage separately, the current allowance, whether the same thread was used, whether authentication survived, and whether independent before/after evidence showed any Yahoo mutation.
9. Delete any accidental artifact outside the ignored private spool and verify no secret or real league material appears in Git status, logs, build output, shared links, or synchronization inputs.

Record a private operator receipt with these fields:

```text
first_status:
first_visible/extracted/missing:
second_status:
second_visible/extracted/missing:
same_thread: yes/no
session_retained: yes/no
before_after_no_mutation: yes/no
source_rows_reviewed: count
elapsed_box_hours:
connected_model_usage:
billing_allowance_before/after:
external_guard_enforcement: observed/unavailable
guard_forced_attempts: lineup/add_drop/trade/messaging
```

The host gate passes only when both captures are exact or explicitly incomplete, the second capture uses the same thread after sleep/wake, authentication survives, private evidence handling is verified, and independent before/after evidence proves no mutation. `needs_login`, a silent row mismatch, missing Billing evidence, or changed Yahoo state fails the gate.

The unattended gate additionally requires observed external enforcement that rejects all four mutation classes. Until that separate receipt exists, keep recurring automation disabled even if Test A passes.

## Local synthetic verification

These commands use synthetic records only:

```sh
node --test test/collector-pilot.test.mjs
node scripts/validate-collector-output.mjs test/fixtures/collector/complete.json
node scripts/validate-collector-output.mjs test/fixtures/collector/partial-obstructed.json
node scripts/validate-collector-output.mjs test/fixtures/collector/needs-login.json
```

The source-instruction fixture must be rejected:

```sh
node scripts/validate-collector-output.mjs test/fixtures/collector/source-instructions.json
```

Expected result: nonzero exit with a contract rejection. No live Yahoo access, Railway upload, recurring schedule, or fantasy-decision model call occurs in these checks.

## Railway ingest and schedule (U4)

Implemented repository controls do not establish a working unattended broker. The default is a paused, single-roster pilot. Use **Setup → Cloud collector pilot** to save that scope and prepare a supervised run. A trusted administrator may instead configure a validated `plan` through `/api/collector/settings`; pass `scope: null` when switching from roster mode. The persisted schedule is once daily at 16:00 Asia/Singapore; after downtime it catches up only the latest missed slot. The dashboard identifies which target is configured. Keep one Railway replica with one private persistent volume. The file journal and in-process publication queue are not a distributed database.

Configure `BOXES_RUN_URL`, `BOXES_AUTOMATION_SECRET`, `BOXES_COLLECTOR_THREAD_ID` and `BOXES_AUTOMATION_ID` in Railway. The endpoint must be HTTPS on boxes.dev, copied from API setup. `COLLECTOR_TOKEN` is a distinct random broker credential (at least 24 characters). Keep both long-lived credentials outside the browser and model environment. They must not appear in prompts, screenshots, public build context or logs. The API exposes only readiness booleans. A short-lived capability is returned only to the authenticated administrator or isolated broker, never included in the boxes.dev prompt.

The current [boxes.dev automation API](https://boxes.dev/help/automation-api) accepts an existing-thread target and an idempotency header. ShotCaller always targets the configured standing thread. It treats `thread_ready` as launch acceptance; only verified artifact ingestion establishes completion. API triggers require activation in boxes.dev, while Railway's own schedule remains separately paused. Start with the [paused automation's manual test](https://boxes.dev/help/create-automation), then a controlled API test. Never configure a fresh devbox as a fallback for a missing thread.

### Supervised Test B protocol

Use the administrator API from a trusted machine. Do not hand the admin token to the collector agent.

1. `POST /api/collector/run` with `{ "scope": <bounded evidence scope>, "intended_for": <ISO timestamp>, "dispatch": false }`. Save the returned run ID and idempotency key. Retrying the same scope and intended timestamp reuses the logical run. The UI prepares this request; `npm run shotcaller -- collector-run request.json` is available when the app is stopped.
2. The trusted uploader requests `POST /api/collector/capabilities` with `run_id` and a unique `attempt_id` starting `collector-`, using the administrator or broker credential. The returned opaque bearer capability expires after 15 minutes and is bound to that league/run/attempt and artifact limits. A retry gets a new attempt ID but retains the logical run key. Never paste the capability into the browser agent.
3. With the capability, `POST /api/collector/manifest`. Exact fields: `version: 1`, `run_id`, `attempt_id`, `idempotency_key`, `league_id`, `artifacts`. Each artifact has `id`, `class`, `sha256`, `bytes`, `evidence_ref`. IDs are bounded and references must be `evidence/<filename>.json`, `.txt` or `.png`. One `collector_output` and one `structured_capture` are required, together with every referenced text/screenshot. The manifest limit is 32 KiB; at most 16 artifacts and 8 MiB total. Per-file limits are 256 KiB output, 1 MiB capture, 512 KiB text and 2 MiB PNG.
4. `PUT /api/collector/artifacts/<id>` with raw artifact bytes. Each request has its own manifest-derived size bound; hashes must match. No remote URLs or filesystem paths are fetched. The generic historical import limit is unchanged.
5. `POST /api/collector/commit`. Railway reads every stored artifact back, verifies hashes and reconciles extracted roster rows against the structured source, then publishes one immutable logical observation. Overlapping attempts retain their own evidence and a duplicate receipt. Login failures retain a `needs_login` receipt and publish no roster.
6. `GET /api/collector/readback` and optionally `GET /api/collector/artifacts/<id>` with the same capability. Compare all hashes and the observation ID to the local manifest before deleting the **private local spool only**. If acknowledgement was lost, retry commit/readback; published evidence is reused. Expired capabilities can be renewed by the trusted broker for the same attempt.

Source files remain private on the Railway volume, under `collector-artifacts`; manifests, runs, attempts and observations are separate. Capability files contain scope/expiry metadata, not bearer tokens. Collector credentials have no Setup, general evidence, forecast, decision or action rights. Capability holders can read only their own manifest-bound artifacts. A capability is still a secret until it expires.

### Promotion and operational proof

`COLLECTOR_GATES_VERIFIED=false` and `FULL_LEAGUE_COLLECTOR_GATES_VERIFIED=false` are the defaults. The first attests the bounded roster pilot; the second separately attests full-league routing, pagination, evidence reconciliation and runtime capacity. Set either to `true` only after an operator records the applicable test receipts, independently enforced mutation guard, isolated upload mediation and private backup/restore evidence. These switches are operator attestations, not automatic proof checkers. A full-league schedule requires both switches. Keep the schedule paused and use supervised uploads until every applicable receipt exists. If broker isolation cannot be demonstrated, keep supervised manual uploads indefinitely.

The scheduler preserves failed launch and missing-output timeout receipts and displays them under the collector panel. A run accepted by boxes.dev but missing a verified final receipt remains reconciliation-required even after timeout; ShotCaller blocks replacement dispatch until the operator checks boxes.dev and Yahoo, then records `failed` or `cancelled` through `/api/collector/reconcile`. Provider budget/capacity refusals produce a generic terminal alert; inspect boxes.dev for detail without copying secrets into the journal. Collection failure does not authorize any Yahoo mutation.

Before promotion, pause collection and back up the entire private volume to encrypted private storage, including `collector`, `collector-artifacts`, `collector-manifests`, `runs`, `attempts`, `observations` and indexes. Restore it to an isolated directory and run the same manifest/readback hash comparison, verify observation source links, then rebuild the observation index and compare pointers. Do not restore over the live volume for this test. Repository tests exercise an isolated fixture restore and 0600 evidence files; an actual Railway backup/restore receipt remains required. Never commit backup contents. U10 covers rotation and long-term retention.

Rotate the broker token through the authenticated `/api/operations/collector-token` endpoint, update the trusted broker, and verify that the old token returns 401 while `APP_TOKEN` still opens the dashboard. The Railway environment token seeds a new volume only; the persisted rotation record wins thereafter. Never send the replacement token to the browser agent.

Pending external evidence: live Yahoo Test A, sleep/wake authentication continuity, boxes.dev mutation interception, credential-isolated broker, connected Test B from the cloud, Railway readback, actual private-volume restore and the full-league accuracy/cost pilot. No code test turns these gates green.

## Separate bounded executor

The Yahoo executor is a different boxes.dev thread and trust domain from the collector. The collector token, collector thread and collector automation cannot fetch or authorize action intents. Railway retains `ACTION_SIGNING_KEY`; the manager uses `APPROVAL_TOKEN` for one exact authorization; only the executor receives `EXECUTOR_TOKEN`. Keep all three distinct from `APP_TOKEN`, `COLLECTOR_TOKEN` and the boxes.dev automation secret.

Action flow:

1. The authenticated app creates an immutable proposal containing the action class, league, exact player or offer IDs, Yahoo scoring date, expiry, preconditions and evidence IDs. It is `shadow` unless the individual class has been promoted.
2. The manager separately authorizes that exact digest using `APPROVAL_TOKEN`. The signed authorization includes a short expiry and single-use nonce. Approval is persisted before boxes.dev is triggered.
3. Railway sends only the opaque intent ID to `BOXES_EXECUTOR_THREAD_ID`. The executor follows `prompts/executor-bounded.md` and fetches the signed package with `EXECUTOR_TOKEN`.
4. The executor captures current Yahoo state and requests preflight. Wrong league/date/IDs, locks, limits, capacity, stale availability, stop state or human takeover block it. Shadow mode stops here and records `shadowed`.
5. A live executor calls the separate arm step immediately before the first mutation. Railway rechecks stop/takeover and atomically consumes the nonce. Only `prepared` permits one exact Yahoo interaction.
6. Before/after Yahoo evidence and Railway readback are stored. Lost responses, ambiguous state and partial add/drop completion require reconciliation; the executor must not repeat a click to discover whether it worked.

`ACTION_MODE=shadow`, `ACTION_GATES_VERIFIED=false`, an active stop switch and no enabled classes are the defaults. Run a full scoring week in shadow mode for each action class, including expiry, wrong identity/date, lock, stop/takeover, lost response and partial completion fixtures. Only classes with recorded zero-mutation shadow evidence may be named in `ACTION_ENABLED_CLASSES`, and live mode additionally requires the isolated tokens, signing key and executor thread. Code tests do not satisfy that external gate.
