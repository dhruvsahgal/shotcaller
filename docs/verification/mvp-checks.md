# ShotCaller MVP verification

Verified locally on 2026-10-28. Production activation is still pending.

## What passed

- `npm test`: 8 tests passed. Covers numeric validation and weighted percentages, immutable storage and restart, historical import idempotency, parser identity and coverage failures, transaction deduplication, private API access, and every decision task.
- `npm run test:browser`: 2 Chromium tests passed. Controlled league pages cover ten rosters, settings, displayed matchup, team statistics, availability and transaction pagination. The dashboard test covers desktop/mobile rendering, historical labels, the canonical prompt, disabled unconfigured decisions, and out-of-order evidence responses.
- A malformed login-state file failed cleanly and the Chromium process exited after cleanup.
- Local server restart retained both historical import IDs, kept the live pointer empty, and preserved the prompt fingerprint. No historical data was promoted to a live capture.
- Provider-boundary scan found only `app/decisions.mjs` sends model requests. API and CLI decision entry points both delegate to it. Tests inspect the serialized request for all five task types and verify missing/empty prompt prevents any provider call; provider failure creates no decision record.
- JavaScript/configuration syntax, shell entrypoint syntax and `git diff --check` passed.

Canonical prompt SHA-256:

`2c9710319332a0dd0734ef15af1cf22e6edb2f4a3ccb3131449b27908f74f3d8`

## Implementation coverage

| Unit | Delivered | Evidence |
|---|---|---|
| U1 | Immutable JSON store, Markdown briefs, numeric contracts | Store and schema tests; restart check |
| U2 | Read-only Yahoo collector and separate login helper | Parser and controlled Chromium tests |
| U3 | Category comparisons, observed market activity, mandatory prompt gateway | Analysis and outgoing-request tests |
| U4 | Private API and responsive dashboard | HTTP authentication/failure tests; desktop/mobile tests |
| U5 | CLI, container/volume configuration and operating guide | Local import/start/restart; configuration checks |

Requirements R1-R8 are implemented within the plan's local-MVP boundary. The collector preserves displayed periods rather than asserting that different pages cover the same interval. It captures the displayed matchup, not every possible pairing. Manager activity is observed history, not a claim about private intentions.

## Review and corrections

Review ran sequentially in the main session under the user's tool-mapping instructions. It is not an independent or cross-model review. The checks covered correctness, project rules, authentication/secrets, failure handling, API/CLI parity, tests, storage publication and asynchronous UI behavior.

Corrections made during verification:

1. Browser tests now use self-contained fixtures instead of depending on untracked private imports. Fresh installs can start without historical files.
2. Unexpected statistics/history tables, mismatched roster URLs and missing team coverage now produce partial captures. Explicit empty availability/history results remain distinguishable from parser failure. The regression test first failed against the old parser, then passed after the correction.
3. A delayed evidence response can no longer overwrite the user's more recent selection. The browser test forces this response ordering.
4. Browser initialization failure closes the browser. A corrupt local login-state smoke test verified process exit.
5. Provider error coverage verifies that failed responses never create successful decision records.

The final simplification pass found no further removal worth making. No additional abstraction, database or framework was introduced. The parser regression test was added for a concrete defect; the final simplification pass did not weaken proof tests. No unresolved local code finding remains from this review.

## Not yet verified

| Integration | Actual result | Next check |
|---|---|---|
| Authenticated Yahoo/headless | Capture attempted; no collector login state. Mac locked during integrated-browser inspection. | Run `npm run login`, sign in, then inspect a full live capture and pagination. |
| Live model provider | Model/key not configured; only mocked outgoing requests tested. | Set model/key and request one sourced decision. |
| Docker image | Docker unavailable locally. | Build the supplied image before relying on deployment. |
| Railway | Configuration supplied; no service deployed or charged by this work. | Deploy one service/volume, capture twice, restart and verify persistence. |
| Long-history load | No sustained load or large-history benchmark. | Check memory and response time as retained capture history grows. |

The host-integrated browser review stopped at its preflight because the Mac was locked; no native-browser route was claimed as tested. Automated Chromium tests above are separate application tests using controlled pages, not a production Yahoo or native-browser pass.

The application assumes one server/collector writer per volume. Do not run CLI capture concurrently with the server or scale to multiple replicas. Transaction deduplication recognizes identical visible entries; Yahoo formatting or relative-date changes still need live validation. Original private documents, snapshots and the HTML concept remain untracked and unchanged. No Git remote was configured, so this delivery uses local commits without a push, PR or CI claim.
