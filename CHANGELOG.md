# Changelog

All notable changes to the DevTower extension are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).
DevTower is published on the VS Code Marketplace (flagged as a Preview). Older releases
are listed at [GitHub Releases](https://github.com/BradenTerry/DevTower/releases).

## [Unreleased]

## [0.1.0] - 2026-06-13

First public preview.

### Added

- **Pixel office campus** (Canvas2D): each repo is a cutaway room; rooms share walls into one
  contiguous building with ghost slots to build up, dig down, and expand sideways. Room
  construction and deconstruction animations on join/leave.
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
