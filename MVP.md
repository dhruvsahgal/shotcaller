# ShotCaller MVP

One Node application, a private dashboard, and a file volume. Chromium runs only while collecting. No database server, scheduled jobs or model spending is enabled by default.

## Run locally

Requires Node 20.19+.

```sh
npm ci
npx playwright install chromium
cp .env.example .env
```

Set `APP_TOKEN` to a random secret of at least 24 characters (for example, generate one with `openssl rand -hex 24`). Keep `.env` private. Then:

```sh
npm start
```

Open `http://127.0.0.1:3030` and enter the token. The dashboard can start empty. To import historical records already present on this computer, use `npm run shotcaller -- import <file.json>`. Those private source files are not bundled with the app. Imports retain original capture dates, including unknown dates. A cumulative Team Log does not establish current ownership.

## Yahoo authentication and refresh

```sh
npm run login
```

Sign in yourself in the separate Chromium window and press Enter in the terminal once the league is visible. This does not read Safari cookies. Private login state is saved to `.runtime/auth/yahoo.json`. A new headless context uses that state. It is an impersonation credential: do not commit, paste into chat, put in an LLM request, or serve it publicly.

Use **Refresh Yahoo** in the dashboard. Alternatively, with the server stopped, run `npm run shotcaller -- capture`. A failed or partial capture stays visible and never replaces the last full one. Yahoo may require fresh login, block headless access, or change its markup. Controlled browser tests do not prove production Yahoo compatibility.

If you already have a signed-in remote Chromium service, set the private `BROWSER_CDP_URL` to its CDP endpoint. This is not a Playwright-native websocket endpoint. The collector opens its own tab in the existing context and closes that tab afterward. Keep other users out of that browser context.

The capture includes settings, league overview, team statistics, the displayed matchup, all discovered rosters, free agents, waivers and transactions. It records displayed periods; it does not assert that all pages cover the same day. The matchup page may show only the currently selected matchup; raw evidence preserves that limitation. Pagination has a configurable ceiling (`MAX_PAGES`, default 40 per listing); reaching it makes the capture partial. Counts and timestamps are evidence, not predicted playing time or startable games.

## Mandatory decision gateway

Open **Setup** to save your model name, API key and HTTPS chat-completions endpoint. Alternatively, set `LLM_MODEL`, `LLM_API_KEY` and `LLM_ENDPOINT` on the server. Values saved in Setup take precedence over environment defaults and survive restarts on the volume. No key or model is bundled. Request a brief in the dashboard; each call may incur the provider's fees. Saving settings makes no provider request.

Every decision task—including follow-up, opponent modeling, valuation and research synthesis—passes through `app/decisions.mjs`. The adapter reloads `prompts/shotcaller-system.md` on every request, sends its exact bytes as the first system message, and fails before the provider call if it is missing or empty. Source pages and prior answers enter as untrusted JSON data. Models receive no Yahoo mutation tools. A separate bounded executor API can persist signed action intents and shadow preflights; it is isolated from the decision provider and collector.

Each proposed decision saves the task, question, requested/served model, prompt hash, evidence IDs, input hash, prior decision ID, timestamp, usage reservation, reported usage and answer as JSON, with a Markdown brief alongside it. It is never recorded as an executed transaction. Credentials are excluded. `MODEL_CALL_BUDGET` bounds attempted calls, including provider failures that may still incur cost; reservations survive restart and the adapter never retries a failed provider call automatically.

## API and agent access

Except `/health` and static UI files, requests require `Authorization: Bearer <APP_TOKEN>`.

| Route | Action |
|---|---|
| `GET /api/state` | Capture history, freshness, analysis, prompt and decision journal |
| `GET /api/snapshots/:id` | A full immutable evidence record |
| `POST /api/refresh` | Start one refresh; poll state for completion |
| `POST /api/decisions` | Request advice via the shared prompt gateway |
| `GET /api/setup` | Connection status and non-secret settings |
| `POST /api/setup` | Save league/model/CDP settings privately |
| `POST /api/setup/yahoo` | Upload Yahoo-only Playwright browser state |
| `POST /api/import` | Import a sourced historical snapshot, idempotently |
| `GET/POST /api/actions` | Inspect or create immutable action proposals; creation does not authorize execution |
| `POST /api/actions/:id/authorize` | Sign one exact intent using the dedicated manager approval credential |
| `GET/POST /api/executor/actions/:id/*` | Executor-only fetch, preflight, arm and readback routes |

A decision body uses `task`, `question`, `snapshot_ids` (1–4 IDs), and `previous_id` when task is `followup`. Allowed tasks: `recommendation`, `opponent_model`, `valuation`, `research_synthesis`, `followup`. The CLI accepts the same JSON with `npm run shotcaller -- decide request.json`. API and CLI share the same decision adapter.

## Railway

1. Create a dedicated ShotCaller service from this repository or upload this directory with Railway CLI. Existing unrelated services should not be modified.
2. Attach **one persistent volume at `/data`**. Keep one replica. Do not run a second collector process against the same volume.
3. Set `APP_TOKEN` to a random secret of at least 24 characters. Optionally set `YAHOO_LEAGUE_ID` and `EXPECTED_TEAMS`; otherwise configure them in Setup before importing evidence. The example league ID `12345` is a placeholder. Container defaults already set `DATA_DIR=/data` and `HOST=0.0.0.0`. Railway supplies `PORT`.
4. Generate a Railway HTTPS domain. Open it, enter your access token, and choose **Setup**. Save the league and model settings. Upload the login helper's `.runtime/auth/yahoo.json`, or save a private CDP connection for an already-authenticated remote browser. The upload route requires your app token, validates Yahoo-only origins, and never returns credentials. Cloud IP changes may require a fresh Yahoo sign-in.
5. Refresh twice, inspect roster and pagination coverage, restart the service, and verify both snapshots remain. Only then treat collection as operational.
6. Leave model configuration unset to use the evidence dashboard without LLM charges. Browser capture runs only when requested; no separate browser service is needed when the container's Chromium can use your saved session.

The image uses matching Playwright package/browser versions. The app runs as the unprivileged `pwuser`; its entrypoint owns only `/data`. Chromium sandbox support depends on the hosting runtime. Use the existing remote browser if local Chromium cannot launch under Railway constraints. No deployment or cloud persistence claim follows from a local test pass.

## Data, backup and restore

```
/data/
  auth/yahoo.json                 # secret, excluded from evidence and exports
  settings.json                  # private model key / optional CDP connection
  snapshots/<id>/snapshot.json   # immutable source + normalized data
  decisions/<id>/snapshot.json   # proposed decision audit
  decisions/<id>/brief.md        # readable reasoning
  latest.json                   # last complete capture pointer
  refresh.json                  # last collection state
```

Enable Railway volume backups. For a portable evidence backup, stop collection and copy `snapshots/`, `decisions/` and `latest.json` together into private backup storage; exclude `auth/` and `settings.json` when sharing. Restore those directories to the same volume layout with collection stopped. Preserve file permissions. Test restore on a separate local data directory before replacing live data. Do not edit immutable snapshot files: import corrected evidence as a new record instead.

## Verification and limits

```sh
npm test
npm run test:browser
```

These cover weighted percentages, missing data, storage/restart/idempotent import, actual outgoing model payloads for every decision task, API auth, controlled Chromium collection/pagination, and desktop/mobile UI. Browser tests save screenshots under ignored `test-results/`.

Browser tests use self-contained synthetic fixtures. The user's historical `data/snapshots/` records remain separate from the deployed application image. Actual Yahoo collection, a paid model response, Docker image build and Railway restart need their own observed verification. See `docs/verification/` for what was actually run.

### Restricted collector pilot

The app now has a paused cloud-collector control panel and a separate, capability-scoped upload API. A single roster capture can be uploaded as a bounded manifest plus hashed source artifacts, reconciled, and read back from the volume. Runs and attempts survive restart; overlapping attempts cannot publish a second logical dataset. Schedule slots are 06:00/18:00 Singapore with latest-slot catch-up. Live dispatch targets one existing boxes.dev thread and stays gated by default. See [the pilot protocol](docs/operations/boxes-collector.md#railway-ingest-and-schedule-u4).

This does not establish a connected autonomous broker, proven Yahoo mutation guard or full-league pilot. Keep `COLLECTOR_GATES_VERIFIED=false` and the schedule paused until those external checks and a private Railway restore test have receipts.

### Controlled action pilot

Action execution starts in shadow mode with the stop switch active. `APPROVAL_TOKEN`, `EXECUTOR_TOKEN` and `ACTION_SIGNING_KEY` must be distinct private Railway secrets. The collector never receives them. Each proposed lineup, IL, add/drop or trade-response action binds exact IDs, scoring date, expiry, preconditions and a single-use nonce. A separate arm call rechecks stop/takeover and consumes the nonce immediately before any live interaction. Ambiguous or partial outcomes require reconciliation and cannot be blindly retried.

Keep `ACTION_MODE=shadow`, `ACTION_GATES_VERIFIED=false` and `ACTION_ENABLED_CLASSES` empty until the per-class boxes.dev shadow and failure matrix in [the operations guide](docs/operations/boxes-collector.md#separate-bounded-executor) has recorded evidence. No action class is live in this repository or by virtue of a passing local test.

### Recovery and cost controls

`GET /api/operations` reports archive size, optional quota percentage, model reservations and unresolved collector work. `POST /api/operations/backup-manifest` creates a private hash manifest for an isolated restore drill. `POST /api/operations/collector-token` rotates the collector broker credential without changing `APP_TOKEN`; only the digest is persisted. A timed-out collector remains reconciliation-required and blocks replacement dispatch until `POST /api/collector/reconcile` records the verified outcome.

These endpoints do not copy or encrypt the volume. Follow [the operating runbook](docs/operations/runbook.md), keep backup contents private, and record an actual Railway restore plus rollback drill before calling the system production-ready.
