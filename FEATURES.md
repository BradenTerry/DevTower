# DevTower — Feature Tracker

Capability map, independent of the current visual theme. The **data contracts** (webview messages, state feed schema, git/gh integration) are the stable core; the 3D scene and HUD are a **presentation layer** that can be re-themed without touching them.

## Architecture split (what survives a re-theme)

| Layer | Files | Re-theme impact |
|---|---|---|
| Data core: store, state feed, git, PRs, terminals, sessions, diff provider | `src/store.ts`, `src/git.ts`, `src/prs.ts`, `src/terminals.ts`, `src/session.ts`, `src/diffProvider.ts`, `src/changesView.ts` | none |
| Bridge: webview messages (`state`, `session`, `changes`, `prs` / `select`, `send`, `action`, `request*`) | `src/consolePanel.ts` | none (contract is theme-agnostic) |
| Presentation: 3D scene + HUD | `src/webview/crew.ts`, `media/console.{js,css}` | replaced/reskinned |

## Implemented

| Feature | Status | Notes |
|---|---|---|
| Agent state (active / waiting / complete / error / idle) | ✅ | Generic `state.jsonl` watcher + manual UI transitions |
| Claude Code hooks emitter | ✅ | `media/devtower-notify.js` (installer/reader in `src/hooks.ts`); maps hook events → states |
| Mock seed data | ✅ | Auto-seeds for trying the UI when no real sessions are found |
| Pixel crew scene: per-agent sprite devs, deterministic persona | ✅ | Hair/shirt/cap/glasses/headphones from id hash; blink |
| State-driven animation (sit-and-type, raise hand, cheer, slump, idle) | ✅ | Typing taps, monitor flicker, confetti, smoke, coffee sips |
| Repo grouping: office rooms; join = walk in via door, leave = walk out | ✅ | Construction animation on repo add |
| Whiteboard collaboration (2+ active agents in a room huddle) | ✅ | Lead draws, others gesture; scribbles accumulate then wipe |
| Tower building: worktrees stack upward into floors | ✅ | rooms share floors/ceilings (one contiguous tower); a ghost slot on top stacks the next worktree, a reserve slot adds another repo as its own tower; ragged-skyline roofs |
| Remove a reserved room (✕ button + modal confirm) | ✅ | Reservation only — directory and agents untouched |
| Reserve a cell: click a ghost slot → native folder picker binds a directory | ✅ | Persisted globally (`devtower.reservedRooms`, with column); vacant rooms sit dark |
| "+ DEV" button on rooms: spawn an agent there | ✅ | QuickPick: create git worktree (`git worktree add` under `.claude/worktrees/<slug>` + `devtower/<slug>` branch, a Claude-style three-word slug like `swift-gliding-heron`, collision-checked) or run in the project base directory; then launches `devtower.claudeCommand` in its terminal |
| Live Claude CLI session discovery | ✅ | Scans `~/.claude/projects/*/*.jsonl`; cwd/model/last-role parsed from transcript head+tail; active <2m, assistant-last → waiting; chat panel renders the real transcript; 30s poll; mock data only seeds when nothing real is found |
| Phantom-session filter: only sessions with a running `claude` process | ✅ | `ps`+`lsof` cwd match; closed-but-recent sessions hidden unless `devtower.showRecentSessions` (then shown idle as "(recent)"); 15-min freshness fallback where process check unavailable |
| Terminal-first chat: native terminal auto-attaches `claude --resume <session>` | ✅ | The terminal IS the conversation; custom chat panel removed |
| Agent stats card: context-window % bar (+ token count), model, branch, changes | ✅ | Usage parsed from transcript tail; 1M-context inferred when >200k |
| Sub-agent badge: bot glyph + in-flight count beside the dev | ✅ | Counts Task/Agent tool calls from the full transcript; foreground sub-agents close on their `tool_result`, background (`run_in_background`) ones track by `agentId` from the launch ack and close on a completed `<task-notification>` |
| Departure sequence: walk to building edge → fire-escape ladder to ground → away | ✅ | Ladder drawn under climber; hand-over-hand climb pose |
| Deferred demolition: empty rooms deconstruct only after the leaver exits | ✅ | Reverse construction with dust; cell stays occupied until done |
| Camera: click agent → zoom to them; new dev → camera follows; overview pan preserved across re-layouts | ✅ | Startup lag fixes: debounced resize, staggered construction, font-ready repaint, deferred PR polling |
| Selection: click character → agent panel | ✅ | Amber ring marks selection |
| Camera: scroll zoom; click island → zoom to its crew; click away → overview | ✅ | Glide animation; focus survives re-layout |
| Camera: click-drag to pan across the archipelago | ✅ | Pixel-accurate at look-at plane; clamped to layout span; drag ≠ click |
| Arrivals/departures feed + state-transition toasts | ✅ | joined / left / needs input / error / finished |
| Agent panel: chat view (full conversation) | ✅ | Operator/Agent/Tool/Result message kinds |
| Continue session: composer + state-aware quick actions | ✅ | Waiting → inline question callout with Approve / Request changes |
| Live "now" strip (what the agent is doing/asking) | ✅ | From task/question fields |
| Changes tab: per-worktree file list with +/− counts | ✅ | Real `git status --porcelain` + numstat |
| Stage / unstage per file + stage all / unstage all | ✅ | In-panel and in native Changes tree |
| Native diff editor (HEAD ↔ working tree), opens beside console | ✅ | Virtual content provider; worktree-scoped, never workspace cwd |
| Per-agent native terminal rooted in its worktree | ✅ | `devtower.launchCommand` to attach a real session |
| PR board: worktree PRs (checks + review status) | ✅ | `gh pr list --head <branch>` per worktree; 2-min poll |
| PR board: PRs requesting my review | ✅ | `gh search prs --review-requested=@me`; badge count in HUD |
| PR chip on agent panel + View PR link | ✅ | Opens the worktree's existing PR; no create-PR button (prompt the agent to open the PR how you want it) |
| File viewer: drag-to-move + right-click delete | ✅ | *Selected Directory* tree: `TreeDragAndDropController` renames within the worktree; `devtower.deleteFile` removes to Trash; each confirms once with a "don't ask again" opt-out (`devtower.confirmFileMove` / `devtower.confirmFileDelete` in globalState; reset via `devtower.resetFilePrompts`) |
| Review Dispatch modal: skills + instructions + effort + agent md, save defaults | ✅ | Glass modal from a PR row or the billboard; `devtower.reviewSkills` / `devtower.reviewDefaults`; agent md auto-discovered from `.claude/agents` and applied via `--append-system-prompt` |
| Review in an isolated worktree | ✅ | `worktreeForPr` adds a detached worktree under `.claude/worktrees`, `gh pr checkout` brings the PR branch in; main checkout untouched; registered as its own room |
| Central "PRs to review" billboard | ✅ | Standalone signboard left of the campus listing review-requested (@me) PRs; click a row → dispatch modal; bounds extend so the overview frames it |
| Diegetic review: reviewer pose (magnifier + printout) + verdict stamp | ✅ | `reviewOf` tags the agent; verdict derived from polled PR decision flips an APPROVED/CHANGES badge over the dev |
| Light/dark theme toggle | ✅ | Token-driven; presentation-only |

## Partial / mock-backed (works in UI, needs real backing)

| Feature | Gap | What real support needs |
|---|---|---|
| Chat content for real agents | Mock agents use seeded sessions | Hook emitter to include `transcript_path`; `session.ts` already parses Claude Code transcript JSONL |
| Sending input to a real agent process | Terminal echo unless a process is attached | Set `devtower.launchCommand` (e.g. resume CLI session) so composer text reaches stdin; or wire a control API |
| Approve / interrupt semantics | UI state flips locally | Map to real runner controls (e.g. Claude Code permission response / SIGINT) |
| Changes for mock agents | Read-only seeded list | Real worktree path on disk → live automatically |
| PR data without `gh` | Falls back to mock PRs | `gh` CLI installed + authed; works per-worktree remote |
| Review-requested PR checks | Neutral (API gap) | `gh search` lacks rollup; would need per-PR `gh pr view` follow-up calls |
| Elapsed/timing display | Static strings from feed | Emitter could send timestamps; UI compute live elapsed |

## Not yet implemented (candidates)

| Feature | Needs |
|---|---|
| Billboard visual pass: placement/scale/legibility tuning in the running app | Canvas iteration — billboard geometry is in `crew.ts` (`billboardGeom`/`drawReviewBillboard`) but unverified against the live scene |
| Merge/close PR from the board | `gh pr merge` + confirmation UX |
| PR event toasts (checks went red, review approved) | Diff PR snapshots between polls → feed |
| Commit + push from Changes tab | Commit message input + `git commit/push`; sits next to stage/unstage |
| Quick-jump roster / minimap for large towers | HUD strip of avatar chips |
| Camera orbit (rotate around the scene) | Extend drag handler with a modifier/right-button orbit |
| Multi-select / bulk agent actions (pause all in repo) | Selection model extension |
| Discard file changes | `git checkout -- <file>` + confirm |
| Agent-to-agent handoff visualization (walking between islands) | Animation + state semantics |
| Sound cues (agent needs input) | Optional, off by default |

## Theme notes

Current theme: **pixel dev office floor** (Canvas2D, no WebGL — replaced the 3D floating-islands renderer). Each repo is a cutaway room: tinted walls, window with dusk sky, whiteboard, desks/monitors, plant + hash-picked decor (watercooler / blinking server rack / poster), ceiling lamp glow, door. Bundle dropped ~510KB → ~16KB; animation runs on a fixed 10fps pixel tick (6fps eco) with renders only on ticks/camera motion — idle cost near zero by construction.

Theme-specific features added with the swap:
- **Room construction animation** when a repo joins: floor tiles in, walls rise, furniture pops with dust, nameplate last.
- **Whiteboard huddle**: 2+ active agents in one room gather at the whiteboard; marker scribbles accumulate; board wipes when the huddle ends.
- Desk life: typing taps + monitor flicker, coffee steam, idle sips, confetti on complete, smoke on error.

Alternative pixel themes considered: space station, guild tavern, city street. A re-theme replaces the `drawRoom*`/`drawToon` painters in `crew.ts` and nothing else; the `PixelCrew` API, picking, camera, and all data flows carry over.
