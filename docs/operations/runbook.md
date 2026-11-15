# ShotCaller operating runbook

This runbook covers one Railway service, one private persistent volume and persistent boxes.dev collector/executor threads. Code tests validate contracts; they do not prove Yahoo login continuity, private backup recovery, boxes.dev isolation or the user's actual billing allowance.

## Safe baseline

Keep these settings until their external gates have receipts:

- `COLLECTOR_GATES_VERIFIED=false`, `FULL_LEAGUE_COLLECTOR_GATES_VERIFIED=false`, and the collector schedule paused.
- `ACTION_MODE=shadow`, `ACTION_GATES_VERIFIED=false`, `ACTION_ENABLED_CLASSES=` and the stop switch active.
- a finite `MODEL_CALL_BUDGET`; record the boxes.dev allowance separately from provider usage.
- one Railway replica with `/data` mounted to the persistent volume.

`GET /health` proves only that the process answers. The authenticated Operations view and `GET /api/operations` show archive bytes, optional quota percentage, model-call reservations, reported tokens, collector state and credential version.

## Backup and isolated restore drill

1. Pause the collector and keep live actions disabled. Wait for any accepted collector run to reach a verified ingest receipt or reconcile it after inspecting boxes.dev and Yahoo.
2. Request `POST /api/operations/backup-manifest` with `APP_TOKEN` and save the returned manifest in encrypted private storage. Do not commit or paste it into an LLM prompt.
3. Take a private Railway volume backup using the provider's current volume procedure. Record the time, service revision, volume size and manifest hash.
4. Restore into an isolated service or local directory. Never test by overwriting `/data`.
5. Run `verifyArchive(restoredPath, manifest)` from `app/health.mjs`. Verify latest capture/forecast pointers, observation indexes, reports, decisions and action records render in the isolated app.
6. Record result, duration and discrepancies. Do not enable recurring work until one real restore succeeds.

Normalized observations, forecasts, decisions, actions, outcomes, indexes and their links are permanent. Screenshots can dominate storage. Review screenshot retention manually after a verified backup; retain every referenced screenshot needed to audit a decision or correction. ShotCaller reports screenshot bytes but does not delete evidence automatically.

## Missing collector receipt

An accepted run with no verified artifact receipt blocks a replacement run. Check the standing boxes.dev thread, Yahoo transaction/roster state and Railway attempts. If artifacts exist, finish ingest/readback. If the attempt is confirmed absent or abandoned, call `POST /api/collector/reconcile` with the run ID, `outcome` of `failed` or `cancelled`, and a concrete reason. Preserve the timeout and reconciliation records. Never relaunch merely because 15 minutes elapsed.

The collector's bounded task is ten minutes and its Railway receipt deadline is fifteen minutes. A stalled run cannot create unlimited replacement boxes. Configure boxes.dev's own automation/runtime cap as a second boundary and verify actual sleep behavior during the pilot.

## Credential rotation

Generate a new high-entropy collector token on a trusted machine. Submit it to `POST /api/operations/collector-token` using `APP_TOKEN`, update only the isolated upload broker, then prove the old token returns 401 and the new token can request a scoped capability. Dashboard access must remain unchanged. Rotate `APP_TOKEN`, approval, executor, signing and boxes.dev credentials through their owning systems; do not reuse one token across principals.

## Provider budget and outages

Every decision call reserves one durable call before reaching the provider. Success and failure both count because a failed response may still be billable. There is no automatic provider retry. At the cap, ShotCaller stops before the network call and retains the last usable evidence and decisions. Review the ledger and provider invoice together before changing the budget. A budget change is an operator decision, not an automatic reset.

## Updates and rollback

Update browser and model dependencies on a branch. Run unit and synthetic browser tests, build the container, then deploy to a staging or isolated service using copied non-production fixtures. For Playwright/browser updates, repeat login, collection accuracy, request-guard and sleep/wake checks. For model/provider changes, inspect the actual outgoing master prompt, response audit fields and budget accounting.

Rollback in stages:

1. Pause collection and activate the action stop switch.
2. Set actions to shadow, clear enabled classes and remove executor access.
3. Disable model-backed jobs while retaining deterministic forecasts and archived evidence.
4. Redeploy the last verified image without changing the volume.
5. If archive integrity is suspect, mount an isolated verified backup and compare manifests before any restore decision.

Record the reason, timestamps, image revisions, affected logical runs and verification result. A rollback never deletes observations or rewrites action outcomes.

## Promotion evidence still required

Before unattended operation, retain receipts for live Yahoo Test A, sleep/wake session continuity, enforced mutation denial, isolated broker upload, connected Railway readback, a private restore drill, measured box-hours/model usage and a rollback to advice-only mode. Until then, dashboard labels and documentation must describe those gates as unverified.
