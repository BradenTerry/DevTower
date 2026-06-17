# Event-driven cutover

Goal: stop DevTower's background polling (the Windows CPU drain) and drive
everything from events (Claude hooks + git file-watchers), with manual Refresh as
the fallback.

## Follow-up: process scan removed entirely (liveness is hook-only)

The original cutover removed the *timer*, but `refresh()` still spawned
`ps`/`lsof`/PowerShell-WMI via `liveCwdCounts()` on every event to learn which
sessions were running. That is now gone. Liveness is read purely from the
SessionStart/SessionEnd hooks:

- **`SessionStart` now drops a `started/<uuid>.json` marker for EVERY source**
  (startup/resume/clear/compact), not just clear/resume. The `started` dir is the
  live-session registry that replaces the process scan (`media/devtower-session.js`).
- **`SessionEnd` deletes the session's `started` marker** (and drops the `ended`
  marker as before), so the registry reflects an exit immediately
  (`media/devtower-session-end.js`).
- **`ClaudeDiscovery.hookLiveCounts()`** (the default when no `liveCounts` is
  injected) builds the `LiveCounts` from `readStartMarkers` + `readEndMarkers`,
  superseding /clear & resume-picker predecessors by launch id. No `execFile`,
  no `ps`/`lsof`/`powershell` — `parseLiveSessionIds`/`liveCwdCounts`/
  `liveClaudeCountWindows` are deleted.

**Tradeoff (intended):** a session whose `SessionEnd` never fires (a crash /
`kill -9`, which the hook can't catch) lingers until its transcript drops out of
the `sessionMaxAgeHours` scan window. And a session that started *before* the
hooks were installed is not discovered (it left no `started` marker) — enabling
the SessionStart hook is now required for a dev to appear.

## Done (this branch: `devtower/event-driven-cutover`)

All five steps are implemented; `npm run typecheck` + `npm test` (213) +
`npm run build` are green. **Still needs a real-VS-Code pass** (the vitest env
mocks `vscode`, so fs.watch, the git API, and hook firing can't be exercised in
tests) — run the "How to validate" checklist in a debug host (F5) or the
prerelease before release. There is now **no git/process poll left**: every board
and discovery update is event-driven, with manual Refresh as the only fallback.

- **Step 1 — edit-watcher (`consolePanel.ts`).** `watchEditMarkers()` watches
  `EDITED_DIR`; `onEditMarker()` (debounced) → `refreshWorktrees(cwds)` recomputes
  only the rooms whose checkout matches an edited cwd, via the new shared
  `buildBoard()` helper (also used by `refreshState`).
- **Step 2 — 6s git poll removed.** `statsTimer` is gone. Boards update from the
  repo change events (Step 5), the save handler (in-editor saves), the Step 1
  edit-watcher (agent edits), and manual Refresh.
- **Step 3 — discovery auto-poll removed (`claude.ts`).** `schedule()`/`nextDelay()`
  and the `setTimeout` loop are gone. `start()` now calls `watchMarkers()`, which
  watches `{waiting,active,ended,edited,succession,resume}` → debounced
  `poll()`→`refresh()`. `setVisible(true)` still refreshes once on foreground.
  `refresh()` itself is unchanged, so all 35 discovery tests pass as-is. Kills the
  idle `ps`/`lsof`/PowerShell-WMI + transcript-scan cost.
- **Step 4 — `devtower.pollIntervalMs` removed** from `package.json`;
  `extension.ts` calls `discovery.start()` with no interval. No Settings UI
  referenced it.
- **Step 5 — `vscode.git` is the board change source (`consolePanel.ts`).**
  `syncGitRepos()` subscribes to each tracked repo's `state.onDidChange` (resolved
  via `ensureGitApi()`), replacing the raw `.git` fs-watcher + full fan-out.
  `onRepoChange(dir)` → `scheduleRepoRefresh(dir)` coalesces and refreshes ONLY the
  changed repo's room(s) (`refreshWorktrees`), not every worktree. A repo the API
  won't open (the out-of-workspace-worktree open question) falls back to an
  fs.watch on its `.git` (`watchGitDirFallback`) — still event-driven, still
  scoped. The periodic 180s `git fetch` poll (`fetchTimer`) is removed; a one-shot
  fetch on open + the per-room COMMITS `↻` button + VS Code's own `git.autofetch`
  cover behind/ahead. `branchSummary` still supplies the board's +/- churn,
  fork-point counts, base name, and commits (the git API can't).

Requires the **SessionStart/SessionEnd/UserPromptSubmit/PostToolUse hooks
installed** (Settings → Hooks) to be fully event-driven; without them, fall back
to manual Refresh. External (non-launched, non-hooked) sessions surface on manual
Refresh only — intended (a "scan external sessions" button is future work).

## Still open

- **Validate the out-of-workspace-worktree case in a real VS Code:** confirm the
  git API's `openRepository` + `state.onDidChange` actually fire for a worktree
  outside the workspace. If it doesn't, the `watchGitDirFallback` path covers it —
  verify the fallback engages (a stage/commit in such a worktree updates its board).
- Real-VS-Code validation of the whole event path (checklist below).

## Status (prerequisites, already shipped on `main`)

| Version | What |
| --- | --- |
| v2.1.0 | Render perf: viewport culling, graphics-quality presets, perf overlay |
| v2.2.0 | External-call diagnostics + manual `⟳` refresh |
| v2.3.0 | Hooks: PostToolUse beam attribution + UserPromptSubmit; hooks named by Claude event |
| (on main, unreleased) | Mini-view first-click fix |

These three things now exist and unblock the cutover:
- **Diagnostics** to measure: Settings → Debug → External calls, the
  `DevTower: Show External Call Stats` command, and `exec.*` lines in `debug.log`.
  (`src/debugLog.ts`: `recordExec`, `execStatsSnapshot`.)
- **Hooks** as the event source. Markers land under
  `~/.claude/devtower/{waiting,active,edited,ended,succession,resume}/<session>.json`.
  Readers in `src/hooks.ts` (`readWaitingMarkers`, `readActiveMarkers`,
  `readEditMarkers`, `readEndMarkers`, …). Hook scripts in `media/devtower-*.js`.
  Installed hooks: Notification, SessionStart, SessionEnd, UserPromptSubmit,
  PostToolUse (Settings → Hooks).
- **Manual refresh**: `ConsolePanel.refreshAll()` + the `devtower.refresh` command
  + the `⟳` HUD button (posts `{type:"refresh"}`).

## What currently polls (the targets to remove)

1. **6s git stats poll** — `src/consolePanel.ts`, `statsTimer` (`setInterval(... , 6_000)`,
   search `this.statsTimer`). Calls `refreshState()`, which loops **every** worktree
   and runs `branchSummary` (~8-12 `git` spawns each) + `isRepo` + `currentBranch`.
   This is the per-worktree git spawn storm.
2. **Discovery poll** — `src/claude.ts`, `start()/poll()/schedule()` (default 8s,
   set in `src/extension.ts` `discovery.start(cfg.get("pollIntervalMs", 8000))`).
   Each tick spawns `ps`/`lsof` (mac/linux) or **PowerShell `Get-CimInstance
   Win32_Process`** (Windows — the worst offender) via `liveCwdCounts()`, plus a
   full `~/.claude/projects` transcript scan in `refresh()`/`scan()`.

## What already fires on events (build on these)

- `.git` fs-watchers: `syncGitWatchers()` / `gitWatchers` in `consolePanel.ts`
  watch each repo's `.git` dir → `onGitChange()` (debounced 300ms) → `refreshState()`.
  Catches stage / commit / push instantly. The 6s poll's only unique job is
  catching the agent's **working-tree edits** (which don't touch `.git`).
- `onDidSaveTextDocument` → `onGitChange()` (catches in-editor saves).

## The cutover, in safe order (design reference — implemented, see "Done" above)

### Step 1 — PostToolUse edit → refresh that one worktree's board (DONE)
Make an agent's edit update its board event-driven, scoped to just that worktree
(not the full fan-out).
- Add an `fs.watch(EDITED_DIR, …)` in `consolePanel.ts` (mirror `syncGitWatchers`;
  `mkdirSync` the dir first so the watch doesn't throw when no marker exists yet).
  `EDITED_DIR` + `readEditMarkers` are exported from `src/hooks.ts`.
- On change (debounced): `readEditMarkers()` → fresh `cwd`s → refresh **only** the
  matching worktree rooms.
- Extract a `private buildBoard(sum, branch, pr)` helper from the board object
  inside `refreshState()` (around the `boards.set(roomKey, { branch, modified, … })`
  block) and reuse it in a new `refreshEditedWorktrees(cwds)`. Types:
  `BranchSummary` (`src/git.ts`), `PrInfo` (`src/prs.ts`, already imported),
  `BoardData` (used by `emptyBoard` in consolePanel). `isRepo`/`branchSummary`/
  `currentBranch`/`canonicalDir` are imported from `./git`.
- Map `cwd → roomKey` via `this.roomGitPaths` (roomKey → git path); a marker cwd is
  the worktree root. After updating `this.boardsByPath`/`this.branchByPath`, reset
  `this.lastWtSignature = ""` and call `postState()`.
- Keep the 6s poll for now; this just proves the event path. Validate: an agent
  edit updates its board faster than the 6s tick.

### Step 2 — drop the 6s git poll (DONE)
Remove `statsTimer` (the `setInterval(…, 6_000)`). Rely on `.git` watchers +
`onDidSaveTextDocument` + the Step 1 edit-watcher + manual Refresh. Validate: edits/
stages/commits all still reflect; External Calls shows `git` flat at idle.

### Step 3 — drop the discovery auto-poll (DONE)
Stop `discovery.start()` auto-scheduling (`src/extension.ts` ~line 51, and
`schedule()`/`poll()` in `claude.ts`). Drive state from the marker dirs instead:
- Watch `~/.claude/devtower/{waiting,active,ended,edited}` → on change, run a
  discovery refresh so waiting/active/idle/ended update from hooks.
- Launched devs are already tracked via `TerminalManager`; "scan external
  sessions" becomes a manual button (later — user said external sessions don't
  matter for now).
- **Riskiest part.** The binding in `claude.ts` (~1580 lines) and
  `test/claude.discovery.test.ts` (~50KB, 35 tests) assume the scan; update tests.
- Kills the Windows PowerShell-WMI + transcript-scan cost.

### Step 4 — remove the poll settings (DONE)
`package.json`: `devtower.pollIntervalMs` (and any other poll-interval keys) —
remove or repurpose. Remove any poll controls from the Settings UI. (`efficiencyMode`/
`performanceMode` are already deprecated in favor of `graphicsQuality`.)

### Step 5 — vscode.git as the change source (DONE)
`vscode.extensions.getExtension('vscode.git').exports.getAPI(1)` →
`api.openRepository(worktree)` → `repo.state.onDidChange`. Catches working-tree +
index changes efficiently. **Validate `openRepository` fires events for
out-of-workspace worktrees** — that's the open question.

## How to validate (must be a real VS Code)

The vitest env mocks `vscode`, so hook firing and vscode.git events can't be
exercised in tests. Use a debug host (F5) or install the prerelease, then:
1. Settings → Hooks → enable **PostToolUse** and **UserPromptSubmit** (writes them
   to `~/.claude/settings.json`).
2. Settings → Debug → enable **Performance overlay** and open **External calls**;
   hit **Reset**.
3. Run a couple of agents; edit files. Confirm boards update event-driven and the
   `git` / `ps` / `powershell` counts drop toward zero at idle after each poll is
   removed.

## Loose ends

- **v2.4.0 prerelease** to ship the mini-view fix (on `main`, not yet released).
- Enable the new hooks on your machine so beam attribution / active-on-prompt fire.

## Conventions (for the next session)

- Work on a branch off `main`; PR; CI runs typecheck + test + build on
  Linux/macOS/Windows; merge via PR (branch protection). Do **not** commit to
  `main` directly.
- `npm run typecheck && npm test` before handing back. `npm run build` to refresh
  the bundle for the debug host.
- Prerelease: `release` skill, or `gh workflow run release.yml -f version=X.Y.Z -f
  prerelease=true` (version = next above the latest tag; check `git tag --sort=-v:refname`).
- UI changes: before/after media in the PR **description** (drag-drop to GitHub,
  not committed); screenshots harness is `node screenshots/*.js` (gitignored
  output under `screenshots/out/`).
- End commits with the `Co-Authored-By: Claude …` trailer.
