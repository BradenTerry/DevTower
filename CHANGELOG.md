# Changelog

All notable changes to the DevTower extension are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).
DevTower is published on the VS Code Marketplace (flagged as a Preview). Older releases
are listed at [GitHub Releases](https://github.com/BradenTerry/DevTower/releases).

## [Unreleased]

## [0.5.0] - 2026-06-13

### Added

- **Selected Directory view.** A file tree in the DevTower activity-bar container that browses the
  selected room's entire worktree, not just changed files. Clicking a file opens it in a normal,
  editable editor (preview tab, so paging through files reuses one tab like the built-in Explorer).

### Changed

- **Changes tree follows the focused worktree.** The Changes view now tracks the focused room's
  worktree (or the selected agent as a fallback). Rapid agent-state events are debounced so the tree
  no longer freezes on a spinner during a busy session.
- **`USE DIR`** loads the room's worktree into the DevTower tab (Selected Directory + Changes) and
  reveals it, instead of mirroring it into the Source Control panel.
- Diffs open as preview tabs in the active group, so switching files replaces the tab instead of
  stacking new ones.

### Removed

- **Source Control mirror.** The `devtower` SCM provider and its stage/unstage/refresh commands are
  gone, replaced by the Selected Directory view.

### Fixed

- `openSettings` on a freshly created console panel is deferred until the webview is ready, so the
  request is no longer dropped.
- The General settings pane no longer flickers when caps update (only the GitHub pane re-renders).

## [0.4.0] - 2026-06-13

### Added

- **External-agent indicator.** Claude sessions running outside DevTower (e.g. one you started in
  your own terminal) now render **ghosted** - translucent, desaturated persona, dimmed name with a
  dashed underline - so they read as "not one of ours" at a glance.
- **Debug log.** A new `devtower.debugLog` setting (off by default, toggled live) writes a structured
  JSONL event log of agent discovery, session binding, the external/internal classification,
  terminals, and scene events to a "DevTower Debug" output channel and `.devtower/debug.log`. For
  diagnosing agent issues.

### Changed

- **Deterministic agent-session binding.** Adding a dev launches Claude with an explicit
  `--session-id`, so each placeholder binds to exactly the session it started. Several devs can share
  one worktree (one `+ DEV` per dev) and each binds to its own session regardless of the order you
  prompt them, with no cross-wired terminals or duplicate agents.
- **HUD.** Removed the `DEVTOWER` brand block; moved the 5h / weekly plan-usage meters from the top
  bar to the bottom-right.
- **Settings.** The **General** tab is now first and selected by default.

### Fixed

- **`/clear` desk swap.** The shred restart no longer re-keys an **external** agent's toon, which had
  dragged an unrelated agent through the shred trip and swapped desks with the new dev.
- A live external agent sharing a worktree with a freshly added dev is no longer culled when the dev
  is added.

## [0.3.1] - 2026-06-13

### Changed

- PR status polling now uses **ETag conditional requests** for settled PRs: an unchanged PR is
  re-checked with `If-None-Match` and GitHub answers `304 Not Modified`, which does not count
  against the API rate limit. Active builds (checks running) still fetch in full each poll.

### Fixed

- **Board label contrast.** The cell headings (UNSTAGED / STAGED / COMMITS / PR) and secondary
  labels ("no open PR", "no checks", repo names, "nothing awaiting you") were drawn at low alpha and
  read as dim gray on the dark board. They now use opaque palette colors that clear WCAG AA (>= 4.5:1)
  against the board background, enforced by a contrast unit test.

## [0.3.0] - 2026-06-13

### Added

- **GitHub access via a Personal Access Token**, set in a new tabbed **Settings** page (the ⚙ gear,
  top right). The token is stored in VS Code SecretStorage (OS keychain), probed for the account and
  granted scopes, and lights up only the features it can serve. The page offers pre-filled
  create-token links for fine-grained (name + permissions) and classic tokens.
- A **disconnected** placeholder in the PR billboard and board PR cells when no GitHub token is set.
- **Pointer cursor and hover highlights** on canvas controls (`+ DEV`, a room's close, the COMMITS
  push/pull/refresh buttons, the billboard refresh, and the open-in-GitHub arrows).
- **Windows live-session detection** now counts running `claude` processes via WMI
  (`Get-CimInstance Win32_Process`) and caps shown sessions to that many, instead of relying only on
  an mtime-freshness window.

### Changed

- PRs are discovered for **each room's branch** (the main building and worktree rooms), not just
  branches that have an agent, so a PR opened outside DevTower (e.g. from the CLI) still appears.

### Fixed

- The committed line stat showed **+0/-0** on branches whose base ref had diverged but shared HEAD's
  tree (two-dot vs three-dot `git diff` range).
- The efficiency-mode HUD button had no visible toggle state, so it read as broken.
- The agent panel rebuilt (flashed) on every poll even when nothing changed.

### Removed

- **All mock data** — mock agents, mock PRs, and the `devtower.useMockData` setting. With no token,
  PR areas show the disconnected state.

## [0.2.0] - 2026-06-13

### Fixed

- Adding a dev and immediately prompting it no longer churns the agent out and back in as a
  separate session. Session adoption now waits for the freshly launched Claude session instead
  of binding to a stale transcript already sitting in the same worktree.

### Changed

- Reserved rooms and worktree assignments persist **globally**, so your campus is the same
  regardless of which folder VS Code is opened at (migrated from per-workspace storage; existing
  reservations carry over on first read).

### Removed

- Dropped the unimplemented "dig down / basement" and "expand sideways" language from the docs
  and UI copy. Worktrees stack upward into a tower; reserving another repo adds its own tower.

## [0.1.0] - 2026-06-13

First public preview.

### Added

- **Pixel office campus** (Canvas2D): each repo is a cutaway room; rooms share walls into one
  contiguous tower; worktrees stack upward into floors and reserving another repo adds its own
  tower. Room construction and deconstruction animations on join/leave.
- **Pixel devs per agent** with a deterministic persona and state-driven animation (active,
  waiting, complete, error, idle), whiteboard huddles, and arrival/departure walk sequences.
- **Live Claude Code session discovery** from `~/.claude/projects`, with a phantom-session filter
  that keeps only sessions whose `claude` process is still running.
- **Spawn a dev into a room**: create a git worktree (+ `fleet/<name>-<n>` branch) or run in the
  project dir, then launch `devtower.claudeCommand` in a native terminal rooted there.
- **Agent panel**: context-window % bar with token count, model, branch, changed-file counts, a
  live "now" strip, and state-aware quick actions (Approve / Request changes when waiting).
- **Changes view** (native tree): staged / unstaged split with inline stage, unstage, stage-all,
  unstage-all, backed by real `git status --porcelain` + numstat.
- **Native diff editor** (HEAD <-> working tree) scoped to each agent's worktree, opening beside
  the console.
- **Per-agent native terminal** rooted in its worktree, with `devtower.launchCommand` to attach a
  real session.
- **PR board** of per-worktree pull requests (checks + review status) via `gh`, a standalone
  "PRs to review" billboard for review-requested PRs, and a **Review Dispatch** modal that spawns a
  reviewer agent in an isolated worktree with selectable skills, effort, and instructions.
- **Open in GitHub** buttons on PR rows and the room PR cell.
- **Per-room git sync** (push / pull / fetch) and per-session skill tracking.
- **Generic state feed** (`devtower.stateFile`) and a Claude Code hooks emitter
  (`hooks/devtower-emit.mjs`) that maps lifecycle hooks to agent states.
- **Mock data mode** (`devtower.useMockData`) to explore the full loop without a live runner.
- Camera: click-to-zoom on agents and rooms, scroll zoom, click-drag pan, overview framing.
- Light / dark theme and an efficiency mode to reduce animation CPU.

### Release infrastructure

- Tag-driven release pipeline (`.github/workflows/release.yml`) that builds, packages, and
  publishes to the VS Code Marketplace.
