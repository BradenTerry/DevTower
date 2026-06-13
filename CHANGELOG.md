# Changelog

All notable changes to the DevTower extension are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).
DevTower is published on the VS Code Marketplace (flagged as a Preview). Older releases
are listed at [GitHub Releases](https://github.com/BradenTerry/DevTower/releases).

## [Unreleased]

### Changed

- PR status polling now uses **ETag conditional requests** for settled PRs: an unchanged PR is
  re-checked with `If-None-Match` and GitHub answers `304 Not Modified`, which does not count
  against the API rate limit. Active builds (checks running) still fetch in full each poll.

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
