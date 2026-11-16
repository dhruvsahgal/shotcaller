# Full-league collection and pilot

## Implementation status

The production run journal and restricted ingest endpoint now accept either the reviewed single-roster contract or a declared full-league collection plan. Full-league commit recomputes every segment and pagination chain, verifies source artifacts, publishes period-scoped observations and derives a league coverage observation. The browser adapter and credential-isolated upload broker have not passed a live cloud pilot, so recurring collection remains paused. The dashboard shows unknown coverage until dated, validated full-league evidence is actually saved.

Keep the existing live guard in [boxes-collector.md](boxes-collector.md). This ingest capability does not authorize Yahoo writes or prove recurring collection works. Before enabling expanded collection, review its source extractors, mutation-denying browser boundary, scoped upload transport, private-volume readback and restore procedure. Use synthetic fixtures while those gates remain open.

## Declare the collection before browsing

`createCoveragePlan` in `app/coverage.mjs` takes a league/season, explicit scoring period and timezone, ten team IDs, five distinct matchup pairs, seven consecutive Yahoo scoring dates, and a transaction window. It emits independent segments for:

| Dataset | Required segments per collection |
| --- | ---: |
| Team rosters | 10 |
| Matchup pairings | 5 |
| Team period statistics | 1, containing all 10 team rows |
| Player period statistics | 10 |
| Daily lineup views | 70: each team on each scoring date |
| Daily fantasy-counted contributions | 70, explicitly including dropped players |
| Available-player market | 2 independent paginated filters: FA and W |
| Transactions | 1 paginated overlapping window, with explicit event statuses |

A zero-row page requires source evidence of the empty result and terminal state. Missing access, a login screen, capacity exhaustion or an unvisited page is not an empty successful capture. Current membership cannot reconstruct earlier fantasy-counted contributions. Preserve original scoring date, active-start evidence and dropped-player rows; do not derive them by subtracting cumulative totals.

## Segment adapter contract

`collectDatasetSegment({segment, observe, fragments, limits})` is an injected adapter seam, not a Yahoo crawler. The cloud adapter must return a fragment containing:

- `id`, stable `collection_id`, `segment_id`, exact `scope` and `filters` copied from the declared segment and independently checked against the displayed page.
- `observed_at` as an exact offset-bearing instant, preserved `source.id` / SHA-256 `source.hash`, and nonempty `evidence_refs` pointing to the captured page/rows.
- `page_key` (`first` initially), `next_page_key`, and an explicitly observed `terminal` boolean. Never infer terminal from a missing next-link caused by loading or extraction failure.
- `status` (`complete`, `partial`, `unknown`), extracted `rows`, and `reported_total_rows` when the UI exposes it.

Rows use stable player/team IDs. Matchup and team-total rows carry statistics and exact expected team identities. Lineup rows carry slots. Earned-stat rows require `fantasy_counted: true`; the segment filter requires `include_dropped: true`. Market rows retain `availability: FA|W`. Transactions retain provider event keys and all visible legs.

`assessSegment` checks context, page chains, duplicate pages/rows, visible totals and required entities. `pendingSegments` resumes the next page of an incomplete segment; an identity/filter/date/run mismatch requires a fresh segment capture. `collectDatasetSegment` bounds page steps, elapsed time and cumulative estimated source tokens. It never silently recollects other datasets. Persist fragments before moving on. After a process timeout the caller must retain the previous saved checkpoint.

The restricted ingest endpoint uses `segmentObservation({id, segment, fragments, source_id})` after all uploaded bytes and hashes read back correctly. It saves one immutable observation per captured segment and one derived `league_coverage` observation. A repeated logical run reuses the same records and retains a separate attempt receipt.

The dashboard rebuilds and checks `league_coverage` from `data: {plan, fragments}`; it never trusts a supplied complete flag. Publish a new logical run after a later segment attempt, retaining the previous observation. Do not merge fragments from different collection IDs to claim a complete run.

## Market evidence

`rollingTransactionWindow` retains seven days by default and at least 24 hours of overlap with the previous scan. After downtime it widens the start to preserve the gap; bounds still apply and unresolved pages remain partial.

Both native and imported rows pass through `normalizeMarketObservation` and `reconcileMarket`. Explicit statuses distinguish confirmed actions, requests, rejected offers, cancellations and unknowns. Provider event IDs deduplicate overlapping scans while preserving every source observation. Same-player/date rows without provider keys stay separate, ambiguous observations. Conflicting facts under one provider key remain unresolved. Trades retain every leg and require explicit `legs_complete: true` before appearing in the trusted confirmed set.

`marketTransitions` compares only complete chronological snapshots with identical league, season, period and filters. FA-to-W is retained even when membership is unchanged. Such changes are observations, not proof of an executed add/drop. Legacy displays remain readable; the normalized evidence section is the source for status-aware analysis. Unknown historical dates are not replaced with upload dates.

## Seven-day audit before promotion

Before the first live run, save `createPilotAudit` output with all seven planned attempts (16:00 SGT for seven days), stable attempt IDs, explicit audit dates and a random seed chosen before collection. Its matrix has every dataset class on every day. Audit dates and Yahoo scoring dates are separate concepts; record the timezone in the operational run record.

For each attempt, retain the complete segment coverage result and source files. `selectAuditSamples` uses the preregistered seed to select up to three rows and one visible-total/page check per dataset for each run. Independently compare the selected rows and visible totals with the preserved source, including empty results. Record reviewer identity/time, sample seed, datasets checked, mismatches and `source_compared`; review every partial-to-complete transition separately. Do not substitute parser self-consistency for source comparison.

Record every attempt, including failed/missing ones, with outcome, runtime, token count, compute cost, login interventions and any access/capacity explanation. Unknown costs must remain unknown, not zero. `pilotReport` reports the matrix, every scheduled attempt, unscheduled attempts and failures. It returns `not_passed` for missing evidence, incomplete coverage, absent independent checks, unreviewed transitions or missing cost/access metrics. Any identity, period, statistic, coverage or status mismatch fails the audit and starts a new seven-day window after correction.

A synthetic `passed` report in tests validates only this reporting logic. Production promotion requires retained live source evidence and independent review; no runtime module enables collection or analysis because a fixture report passed.
