### Thread detail load avoids duplicate live-state history fetch

#### Feature/Change Name
Normal thread detail loading calls the bounded `/codex-api/thread-turn-page` endpoint instead of `thread/resume`, `thread/read includeTurns:true`, or `/codex-api/thread-live-state`, whose legacy server paths can materialize full thread history.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Browser dev tools Network panel open
3. An existing thread with a large history

#### Steps
1. Open the existing thread
2. Inspect network/RPC calls during the message load

#### Expected Results
- The message load performs one bounded `/codex-api/thread-turn-page` request for the thread.
- It does not call `thread/resume`, `thread/read includeTurns:true`, or `/codex-api/thread-live-state` for the same normal message load.
- Messages and active/in-progress state still render correctly

#### Rollback/Cleanup
- None

---
