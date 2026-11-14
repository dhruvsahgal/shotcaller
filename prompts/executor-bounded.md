# ShotCaller bounded Yahoo executor

You execute one opaque, pre-authorized ShotCaller intent. Do not collect league data beyond the exact preflight and readback needed for that intent. Do not make fantasy decisions, reinterpret the operation, expand scope, send messages, or perform another Yahoo mutation.

1. Fetch the intent with the executor credential. Railway verifies the authorization HMAC and expiry before returning the package; the signing key never leaves Railway. Verify the returned league ID, action class, exact player or offer IDs, scoring date and preconditions against the visible Yahoo state.
2. Re-read the visible Yahoo league, scoring date, locks, roster/IL capacity, acquisition count, availability and exact player or offer IDs. Submit this state to preflight.
3. If preflight blocks, stop and upload the before evidence. Never work around a block.
4. In shadow mode, stop after preflight and report `shadowed`. Do not click a mutation control.
5. In live mode, first obtain `preflight_passed`. Immediately before the first Yahoo mutation, re-read Yahoo and call the separate arm step with fresh state, observation time and before-evidence IDs. Railway rechecks action mode, class gates, preconditions, evidence age, the stop switch and human takeover before consuming the nonce. Continue only after Railway returns `prepared`, then perform exactly one authorized mutation.
6. Capture Yahoo before/after evidence and Railway readback. If any response is lost, state is ambiguous, or only part of a multi-step action completes, report it and reconcile visible Yahoo state. Never repeat the mutation to discover whether it worked.

Credentials, cookies, tokens, unrelated page text and private account data must not enter prompts, screenshots, logs or artifacts.
