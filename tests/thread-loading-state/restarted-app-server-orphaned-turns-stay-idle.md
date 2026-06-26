### Restarted app-server orphaned turns stay idle

#### Prerequisites
- App is running from this repository.
- A Codex session JSONL exists with a `task_started` event and no matching `task_complete`, from a turn that was active before the app-server restarted.
- The restarted app-server has no current stream events for that old turn.

#### Steps
1. Restart the app-server while a test turn is still writing, or use an isolated `CODEX_HOME` fixture with an unfinished session JSONL.
2. Open the app and confirm the sidebar row for that thread is not marked in progress.
3. Click the thread to load its message history through `/codex-api/thread-turn-page`.
4. Inspect the response JSON and confirm `result.thread.status.type` is `idle`.
5. Confirm the final parsed turn status is `interrupted`, not `inProgress`.
6. Confirm the composer does not switch to in-progress stop/steer controls for that thread.
7. Start a new active turn and confirm current-process stream events still mark that new turn in progress.

#### Expected Results
- Persisted incomplete session logs are displayed as orphaned/interrupted history after restart.
- Clicking an orphaned thread does not flip the thread into an in-progress state.
- Stop and steer controls are only shown when the restarted app-server has live stream evidence for the active turn.
- Current active turns still show in-progress state while live stream events are present.

#### Rollback/Cleanup
- Remove any isolated `CODEX_HOME` fixture used for the test.
- If a real test turn was interrupted only for this check, archive or delete the resulting test thread.
