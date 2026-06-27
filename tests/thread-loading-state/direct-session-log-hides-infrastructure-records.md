# Direct Session Log Hides Infrastructure Records

Direct session-log loading renders only conversation content from raw Codex JSONL records.

## Prerequisites

- Use a Codex session that includes hidden runtime records such as context compaction, subagent notifications, turn interrupts, memory citation footers, skill injections, and environment or AGENTS instruction envelopes.
- Start codexui from a build that includes the direct session-log filtering change.

## Actions

1. Open the thread through the normal sidebar or a `#/thread/<thread-id>` link.
2. Confirm the request history loads through `/codex-api/thread-turn-page`.
3. Inspect the visible transcript around turns that were interrupted, compacted, resumed, or used subagents/skills.

## Expected Results

- The transcript shows only the real user request, assistant output, command/file-change items, and skill chips.
- Hidden wrapper text such as `<subagent_notification>`, `<turn_aborted>`, `<environment_context>`, `<model_switch>`, `AGENTS.md instructions`, compaction handoff summaries, and `<oai-mem-citation>` does not appear as chat text.
- Skill context is shown as a skill chip on the associated user message, not as raw `<skill>` XML.

## Rollback / Cleanup

- No data cleanup is required for read-only verification.
