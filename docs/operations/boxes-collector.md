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

The JSON contract is strict: unknown keys fail. Its fixed scope is one `team_roster`, with league and team IDs and names, scoring-period kind/key/timezone, exact allowed roster page, redacted source URL, observed time, evidence references, coverage, login state, warnings, and roster rows. Every roster row carries:

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
