# Scheduled full-league collection

Work only in the ShotCaller repository. Pull the current default branch with a fast-forward update, then request the immutable collection contract:

```sh
npm run prepare:league-run -- data/pilot/run.json
```

Read `data/pilot/run.json` and follow `prompts/collector-readonly.md` for that exact run and its exact `allowed_pages`. Capture every required segment or record its coverage gap. Never change Yahoo state.

Use the deterministic DOM collector against the signed-in shared Browser. Do not summarize accessibility text or hand-author fragments:

```sh
npm run capture:boxes-league -- data/pilot/run.json data/pilot
```

The command discovers the localhost-only shared Browser endpoint, enforces every allowed-page navigation, preserves complete visible table cells and links as private evidence, and writes the structured bundle and manifest. If it cannot produce usable normalized rows, stop; do not replace it with truncated text or empty fabricated fragments.

After writing the bundle and manifest, run:

```sh
npm run validate:league-bundle -- data/pilot/run.json data/pilot/manifest.json data/pilot
npm run upload:league-bundle -- data/pilot/run.json data/pilot/manifest.json data/pilot
```

Run the uploader only after validation succeeds and only once. It reads credentials from the trusted environment. Never inspect, print, copy, log, or save credential values. Finish with the compact Railway readback receipt, coverage gaps, and local evidence paths. A failed request, validation, upload, or readback is incomplete; do not claim success or broaden scope.
