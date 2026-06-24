### Pinned threads remain visible during explicit pagination

#### Feature/Change Name
Pinned threads are no longer removed from the Pinned section while the sidebar has only loaded the initial thread-list page or while older pages are loaded explicitly.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. More than 50 total unarchived threads exist
3. At least one older thread outside the initial recent page is pinned
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, reload the app.
2. Immediately open the sidebar Pinned section.
3. Confirm pinned rows from older history remain in the Pinned section after the initial thread list appears.
4. Wait without interacting for at least 30 seconds and confirm no automatic background `thread/list` pagination removes or changes those pinned rows.
5. Click `Load older threads` until the full thread list has loaded.
6. Confirm the same pinned rows remain visible and can still be selected.
7. Switch to dark theme and repeat steps 1-6.

#### Expected Results
- Saved pinned thread IDs are preserved while only the initial thread-list page is loaded.
- Missing pinned IDs are pruned only after the full thread list has loaded.
- Older thread pages are loaded only through the explicit sidebar control.
- Pinned rows remain readable and selectable in both light and dark themes.

#### Rollback/Cleanup
- Unpin any disposable threads created only for this test.

---
