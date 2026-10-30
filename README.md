# ShotCaller

A private fantasy basketball intelligence app: capture league evidence, compare teams, track waiver movements and request sourced decision briefs.

One Railway service. One persistent volume of JSON and Markdown. No database server. Chromium runs on demand, and model calls happen only when you request a brief.

## Deploy on Railway

1. Create a service from **`dhruvsahgal/shotcaller`**, branch **`main`**. Railway detects the Dockerfile.
2. Attach a persistent volume mounted at **`/data`**. Keep **one replica**.
3. Add **`APP_TOKEN`**: a random secret at least 24 characters long. You use this to unlock the dashboard. Generate one locally with `openssl rand -hex 24`.
4. Deploy, then generate a public HTTPS domain. The health endpoint is `/health`; the app listens on Railway's `PORT`.
5. Open the app, enter your token, and go to **Setup**. Set your league ID and team count, connect your model, and upload your Yahoo browser session.

The container already sets `HOST=0.0.0.0` and `DATA_DIR=/data`. Do not point storage at an ephemeral directory. No model key, Yahoo login or private league data is included in this repository.

## Connect Yahoo

Yahoo login requires a real browser session. On your computer:

```sh
npm ci
npx playwright install chromium
cp .env.example .env
```

Set `YAHOO_LEAGUE_ID` in `.env`, then run:

```sh
npm run login
```

Sign in directly to Yahoo in the browser window. Return to the terminal and press Enter after your league appears. Upload the generated **`.runtime/auth/yahoo.json`** using the app's **Setup → Connect Yahoo** form. The file grants access to your Yahoo session; keep it private.

An existing authenticated remote Chromium connection can also be saved in Setup. Safari login does not automatically transfer to the cloud. Yahoo can reject a transferred session or require renewed authentication; a saved session is not proof of a successful capture.

## What is included

- Cyberpunk dashboard with Evidence, League, Market, Decisions, Setup and System views.
- Read-only Yahoo collection for league settings, team rosters, statistics, the displayed matchup, available players and transaction history.
- Immutable source snapshots, explicit partial-capture warnings and dated historical imports.
- Category comparisons and observed market activity, with no invented manager intentions.
- A single [master prompt](prompts/shotcaller-system.md) enforced for every model-assisted decision, including follow-ups, valuation and opponent analysis.
- Private configuration, token-protected APIs and a decision journal with evidence references and prompt fingerprints.

The app advises; it does not make Yahoo trades or roster changes. It does not automatically monitor the league. Historical imports are never presented as fresh captures.

## Local development

Requires Node 20.19+. Add an `APP_TOKEN` to `.env`, then:

```sh
npm start
npm test
npm run test:browser
```

Open `http://127.0.0.1:3030`. See [MVP.md](MVP.md) for the API, backups, operating limits and detailed configuration. Tests use synthetic fixtures. Live Yahoo access, model access and cloud persistence require separate verification after deployment.

## Consolidated overview and data storage

After connecting, **Overview** brings together dated matchup totals and trends, roster membership, lineup audits, waiver observations, transaction rows, recorded decisions, and the notebook archive. Each section links to its immutable source. Team Log statistics remain separate from roster ownership; historical league totals remain separate from current matchups. Uploading old evidence does not make it a new observation.

Structured JSON remains the source of truth on the existing Railway volume. Markdown holds reasoning and research. See [the data model](docs/data-model.md) and [future SQLite schema](schema/shotcaller.sql). SQLite is designed but **not enabled**; it can later index the existing archive on the same volume without another database service.

To synchronize local evidence into an authenticated running instance, set `SHOTCALLER_URL` and its `APP_TOKEN` in your shell, then run:

```sh
node scripts/sync-evidence.mjs /path/to/private/notebook
```

The script uploads JSON from `data/snapshots`, Markdown from `reports`, `knowledge`, and `sources`, the three root strategy/research/design documents if present, and PNG source screenshots. It does not read `.env` or browser authentication files. Exact duplicate imports reuse the same immutable record. Changed documents produce a new archive version. It stops on a failed upload; rerunning safely resumes via deduplication. Screenshot attachments are for inspection; decision requests must use their structured transcription or notes.

This is an explicit import, not a background sync. Some original chat material may still need transcription; coverage gaps stay visible in the overview. Keep the notebook, snapshots, reports and credentials out of this public repository.
