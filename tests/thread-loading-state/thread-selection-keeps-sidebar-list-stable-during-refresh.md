### Thread selection keeps sidebar list stable during refresh

#### Feature/Change Name
Selecting a thread does not briefly hide older/sidebar threads while thread list refreshes run after explicit pagination.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. More than one page of threads available in the sidebar
3. Use `Load older threads` to load at least one older page

#### Steps
1. Open the app and click `Load older threads` until older thread pages appear in the sidebar
2. Select a different thread
3. Watch the sidebar while the selected thread loads and any thread list refresh occurs
4. Repeat selection between recent and older threads

#### Expected Results
- The sidebar does not collapse to only the first page of recent threads
- Previously loaded older threads remain visible during refresh
- The selected thread stays highlighted and messages load normally
- Explicit pagination can still add newly loaded older threads without hiding existing ones

#### Rollback/Cleanup
- None

---
