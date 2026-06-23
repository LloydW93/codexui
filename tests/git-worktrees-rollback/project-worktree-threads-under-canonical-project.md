### Project worktree threads under canonical project

#### Feature/Change Name
Worktree sessions remain visible under their matching canonical workspace-root project, including already-saved Codex worktree roots.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Codex global workspace roots include a base checkout such as `/home/lloyd/ws/fl2`
3. Codex global workspace roots also include one or more existing Codex worktree roots for the same project, such as `/home/lloyd/.codex/worktrees/<id>/fl2`
4. Thread history contains at least one session for the base checkout and one session marked as a worktree for the matching project leaf
5. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, open the sidebar Projects section.
2. Scroll to the base project, such as `fl2`.
3. Confirm the project includes the main-root thread and worktree-session threads, even when the worktree cwd is also present in saved workspace roots.
4. Confirm worktree rows still show the worktree icon.
5. Confirm there are no extra top-level `fl2` rows for saved roots under `~/.codex/worktrees/<id>/fl2`.
6. Confirm a non-worktree session from an unrelated same-leaf folder is not grouped into this project.
7. Hover any shortened path-like duplicate project title from genuinely distinct same-leaf base roots and confirm the tooltip shows the full project path, not only the friendly label.
8. Switch to dark theme and repeat steps 1-7.

#### Expected Results
- Worktree sessions with the same leaf folder name are not split into separate top-level project groups.
- Already-saved Codex worktree roots under `~/.codex/worktrees/` do not create their own top-level project rows when a matching base root exists.
- Non-worktree sessions with an unrelated same-leaf cwd remain separate and do not get grouped by folder name alone.
- The canonical base-checkout project, such as `fl2`, shows both main-root and worktree-session threads.
- The canonical base-checkout project shows worktree sessions even when the base checkout itself has no recent thread rows.
- Path-like project tooltips expose the full project path.
- Project rows and worktree icons remain readable in light and dark themes.

#### Rollback/Cleanup
- None.

---
