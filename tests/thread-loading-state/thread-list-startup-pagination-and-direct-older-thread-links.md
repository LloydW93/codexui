### Thread list startup pagination and direct older-thread links

#### Feature/Change Name
Thread loading uses a bounded initial list page, loads older sidebar pages only on demand, keeps sidebar row rendering bounded, and direct thread URLs are not rejected just because the thread is outside the first page.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev --host 127.0.0.1 --port 4173`)
2. Browser dev tools Network panel open
3. More than 50 existing threads, including a valid older thread outside the first updated page
4. At least one project, chat section, or chronological list has enough rows to show `Show more`
5. A thread with more than 10 turns is available
6. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, open the app home route.
2. Inspect the first `thread/list` RPC request and confirm no additional `thread/list` requests appear while the app is left idle.
3. Scroll to the bottom of the sidebar and click `Load older threads`.
4. Confirm exactly one additional `thread/list` page request is made for that click and older sidebar rows are appended.
5. In Projects, Chronological list, Chats, and sidebar search where enough rows exist, click `Show more` and confirm rows reveal in bounded batches instead of rendering the entire history at once.
6. Open a thread with more than 10 turns and confirm the newest messages render first with the older-message control available.
7. Open `/thread/<older-thread-id>` directly for a valid thread outside the first page.
8. Switch to dark theme and repeat the sidebar controls from steps 3-5.

#### Expected Results
- The first `thread/list` request uses the bounded initial limit.
- Later thread pages are not loaded automatically in the background.
- `Load older threads` fetches one next-cursor page per click and shows a disabled/loading state while the request is in flight.
- Sidebar row rendering remains bounded for project groups, chronological view, chats, and search results.
- Switching across several threads does not keep every older thread body resident in the frontend message state.
- Long thread bodies open on the newest page and older turns load only through the conversation's older-message control.
- The direct older thread URL stays on the thread route and loads messages instead of redirecting home.
- Sidebar controls remain readable in light and dark themes.

#### Rollback/Cleanup
- Clear any sidebar search text and reset any manually expanded sidebar sections if needed.

---
