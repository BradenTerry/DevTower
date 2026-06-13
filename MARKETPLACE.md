![DevTower](media/banner.png)

# DevTower

**A pixel office tower for your coding agents.** DevTower turns your repos into a tiny 2D office campus inside VS Code: each repo is a cutaway room, and every live Claude Code session is a pixel dev working at a desk. Spawn new agents into git worktrees, watch them type, see when one needs you, open diffs in the native editor, and review pull requests - all from one playful, low-overhead scene.

![An agent at its desk: as it edits the working tree, the change streams up the network cable to the room's board and the UNSTAGED column updates live.](media/agent-stream.gif)

> **Early Preview.** DevTower is on the VS Code Marketplace, flagged as a Preview while features settle. Install it, kick the tires, and [file issues](https://github.com/BradenTerry/DevTower/issues) - feedback shapes future releases.

![Inside a room: the cutaway board shows the worktree's branch, unstaged / staged / commit counts with line stats, a synced indicator, and the PR cell (#142 with its checks and review status); the agent works at their desk.](media/room.png)

## Why DevTower

Running several Claude Code sessions across worktrees gets hard to track in a flat terminal list. DevTower gives the fleet a *place*: you can see at a glance who is active, who is blocked waiting on you, who finished, and who errored - then click in to act.

## What you get

- **A living campus.** Each repo is an office room; rooms share walls into one contiguous building. Click a ghost slot to stack the next worktree on top, or reserve another repo as its own tower. New repos animate themselves into existence.
- **Pixel devs per agent.** One sprite per session with a deterministic look. Animation follows state: active types, **waiting raises a hand**, complete cheers, error slumps, idle breathes. Crowded rooms huddle at the whiteboard.
- **Auto-discovered Claude sessions.** Live Claude Code CLI sessions are found from `~/.claude/projects` and placed in the tower automatically - no setup. A phantom-session filter keeps only sessions whose process is actually running.
- **Spawn a dev into a worktree.** Reserve an empty cell, pick a folder, hit **+ DEV**: DevTower creates a git worktree and a fresh branch (or runs in the project dir) and launches Claude in a native terminal rooted there.
- **Native diffs and terminals.** Click a changed file for the real VS Code diff (HEAD <-> working tree). Each agent gets a native integrated terminal in its worktree - the terminal *is* the conversation.
- **Changes view.** The selected agent's files split into Staged / Changes with inline stage, unstage, stage-all, and unstage-all, backed by real `git`.
- **Pull requests in-scene.** A PR board shows per-worktree PRs with checks and review status, a standalone billboard lists PRs requesting your review, and a **Review Dispatch** modal spawns a reviewer agent in an isolated worktree with the skills, effort, and instructions you choose.

## Getting started

1. Install DevTower.
2. Open a folder that has (or will have) Claude Code sessions.
3. The **DevTower** console opens automatically. Re-open it any time from the **◆ DevTower** activity-bar icon (`⤢`) or Command Palette -> **DevTower: Open Tower**.
4. No live sessions yet? Set `devtower.useMockData` to `true` to seed a demo fleet and explore the whole loop.

## Requirements and what it accesses

DevTower drives your existing command-line tools and makes **no network calls of its own** (git and gh do their own).

| Tool | Required? | Used for |
|---|---|---|
| **VS Code** 1.85+ | required | host |
| **git** | required | the Changes view, native diffs, `git worktree add`, and per-room push / pull / fetch |
| **Claude Code CLI** (`claude`) | required for live agents | spawning and resuming sessions in terminals; discovering sessions from `~/.claude/projects` |
| **GitHub CLI** (`gh`, authenticated) | optional | the PR board, review-requested billboard, review dispatch, and create / view PR. Without `gh`, PR features fall back to mock data |
| **ps** / **lsof** (macOS / Linux) | optional | showing only sessions whose `claude` process is still running. Unavailable on Windows (a freshness fallback is used instead) |

**What it reads and writes:**

- Reads `~/.claude/projects/*/*.jsonl` transcripts to discover sessions and show each agent's model, branch, token usage, and last activity.
- Reads and writes the state feed file (`devtower.stateFile`, default `.devtower/state.jsonl`).
- Reads working-tree files and `git show HEAD:<file>` to render diffs.
- Creates git worktrees (PR reviews go under `.claude/worktrees`) and runs `git` / `gh` / `ps` / `lsof`.
- Spawns one VS Code integrated terminal per agent.

> On macOS, launch VS Code from a terminal so the extension host inherits your shell `PATH`; otherwise `claude` and `gh` may not be found.

<!--
More screenshots: drop captures into media/ and uncomment.
![The DevTower campus with live agents](media/screenshot-campus.png)
![Agent panel: context bar, model, branch, quick actions](media/screenshot-agent.png)
![PR board and Review Dispatch](media/screenshot-prs.png)
-->

## Settings

| Setting | Default | What it does |
|---|---|---|
| `devtower.stateFile` | `.devtower/state.jsonl` | Append-only JSONL feed agents write state events to. |
| `devtower.useMockData` | `false` | Seed simulated agents when no live sessions are found. |
| `devtower.discoverClaudeSessions` | `true` | Scan `~/.claude/projects` for live Claude Code sessions. |
| `devtower.pollIntervalMs` | `8000` | How often to rescan for live sessions. |
| `devtower.sessionMaxAgeHours` | `24` | How far back to scan transcripts for sessions. |
| `devtower.showRecentSessions` | `false` | Also show recent sessions with no running process (as idle rooms). |
| `devtower.efficiencyMode` | `false` | Reduce animation work to save CPU (also the ⚡ button in the tower). |
| `devtower.claudeCommand` | `claude` | Command launched in a new agent's terminal. |
| `devtower.launchCommand` | `` | Overrides `claudeCommand`; placeholders `${worktree}`, `${branch}`, `${id}`. |
| `devtower.reviewSkills` | code-review, security-review, review, simplify, verify | Skills offered as chips in the Review Dispatch card. |
| `devtower.reviewDefaults` | `{}` | Saved skills / effort / instructions for the Review Dispatch card. |

## Issues and support

Open an issue at [github.com/BradenTerry/DevTower/issues](https://github.com/BradenTerry/DevTower/issues).

## License

[MIT](https://github.com/BradenTerry/DevTower/blob/main/LICENSE)
