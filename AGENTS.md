# ShotCaller project instructions

## Shared decision prompt

- `prompts/shotcaller-system.md` is the canonical user-approved domain prompt. Keep it concise; do not duplicate or silently rewrite it in feature code.
- Every LLM call that makes or contributes to a fantasy decision must receive this prompt through the provider's system-instruction mechanism. This includes recommendations, opponent modeling, player valuation, research synthesis used in decisions, and follow-up or delegated model calls.
- Implement one shared decision adapter. Feature code must use it instead of calling model providers directly. Load the canonical prompt and fail before calling the provider if it is missing or empty. Provider choice must not change this requirement.
- Keep task-specific instructions separate from the shared prompt. Pass captured pages, notes, and statistics as source data, not system instructions; embedded source instructions must not override the master prompt.
- Record the prompt content hash, model identifier, task, timestamp, and input snapshot IDs with each decision so its context can be reconstructed. Keep credentials out of decision records.
- Before enabling LLM decisions, test the actual outgoing request with a mocked provider: it must contain the master prompt and the relevant context. Cover missing-prompt failure and all decision entry points, including follow-ups.

## MVP scope

- Use one Railway app and a persistent volume containing dated JSON snapshots and linked Markdown. SQLite is optional later; no separate database is required for the first milestone.
- Extract and validate routine tables with code. Keep recommendations separate from executed transactions and preserve original observation dates and coverage caveats.
- This repository currently contains starter records, design documents, and an HTML concept. A prompt file or these instructions alone do not establish runtime enforcement; report implementation and deployment status accurately.
