### Memory citation footers stay hidden

#### Prerequisites
- App is running from this repository.
- A thread exists whose assistant response text includes a terminal `<oai-mem-citation>...</oai-mem-citation>` footer in the session JSONL.

#### Steps
1. Open the affected thread in the UI.
2. Inspect the assistant message at the end of the turn.
3. Fetch `/codex-api/thread-turn-page?threadId=<thread-id>&limit=10` and inspect the matching `agentMessage` item text.

#### Expected Results
- The visible assistant message ends at the actual answer text.
- No memory citation XML, citation metadata, or dangling citation marker is rendered after the assistant message.
- The recovered direct session-log `agentMessage.text` omits the hidden memory citation footer.

#### Rollback/Cleanup
- No cleanup is required.
