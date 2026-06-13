// Mock scenarios fed to the webview harness. Each one is the set of postMessage
// payloads the extension would normally send, hand-built so a scene + HUD render
// deterministically for screenshots. Add a scenario here and it gets captured.
//
// Shapes mirror the real messages:
//  - state: { agents, rooms, boards, selectedId? }
//  - prs:   { crew, review }
//  - usage: { fiveHour?: {pct, resetsAt?}, sevenDay?: {pct, resetsAt?} }
//  - config:{ eco }

export interface Scenario {
  name: string;
  /** Open the agent side-panel on this agent id after state loads. */
  selectAgent?: string;
  config?: { eco?: boolean };
  state: { agents: any[]; rooms: any[]; boards: Record<string, any>; selectedId?: string };
  prs?: { crew: any[]; review: any[] };
  usage?: { fiveHour?: { pct: number; resetsAt?: number }; sevenDay?: { pct: number; resetsAt?: number } };
}

const board = (over: Partial<Record<string, any>>) => ({
  branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0,
  committedAdd: 0, committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0,
  commits: [], prReady: true, ...over,
});

export const SCENARIOS: Scenario[] = [
  {
    // a full tower: mixed agent states so the telemetry counts (run/wait/err/crew)
    // are all non-zero, both usage meters mid-range, a PR on the board
    name: "busy",
    config: { eco: false },
    usage: { fiveHour: { pct: 62 }, sevenDay: { pct: 41 } },
    state: {
      agents: [
        { id: "a1", name: "Atlas", state: "active", repo: "DevTower", model: "opus-4.8", worktree: "/repo", branch: "main", skills: ["code-review"], contextTokens: 84_000, elapsed: "12m" },
        { id: "a2", name: "Boris", state: "active", repo: "DevTower", model: "sonnet-4.6", worktree: "/wt/feat", branch: "feat/streaming", skills: [], contextTokens: 150_000, elapsed: "4m" },
        { id: "a3", name: "Cleo", state: "waiting", repo: "DevTower", model: "opus-4.8", worktree: "/wt/fix", branch: "fix/race", skills: ["security-review"], contextTokens: 33_000, elapsed: "27m", question: "Run the destructive migration?" },
        { id: "a4", name: "Dot", state: "error", repo: "DevTower", model: "haiku-4.5", worktree: "/wt/docs", branch: "docs/readme", skills: [], contextTokens: 9_000, elapsed: "1m" },
      ],
      rooms: [
        { name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [
          { path: "/repo", branch: "main" },
          { path: "/wt/feat", branch: "feat/streaming" },
          { path: "/wt/fix", branch: "fix/race" },
          { path: "/wt/docs", branch: "docs/readme" },
        ] },
      ],
      boards: {
        "/repo": board({ branch: "main", commits: [{ sha: "a1", subject: "Init" }] }),
        "/wt/feat": board({ branch: "feat/streaming", modified: 3, unstagedAdd: 40, unstagedDel: 6, ahead: 2, unpushed: 2,
          pr: { number: 318, title: "SSE streaming for /v1/messages", url: "https://github.com/acme/x/pull/318", draft: true, checks: "pending", checksPass: 3, checksFailed: 0, checksRunning: 2, checksTotal: 5, review: "required", approvals: 0, changesRequested: 0, reviewersPending: 2, comments: 0 } }),
        "/wt/fix": board({ branch: "fix/race", staged: 1, stagedAdd: 12, stagedDel: 3, behind: 1 }),
        "/wt/docs": board({ branch: "docs/readme", modified: 1, unstagedAdd: 5, unstagedDel: 1 }),
      },
    },
    prs: {
      crew: [
        { id: "DevTower#318", number: 318, title: "SSE streaming for /v1/messages", repo: "DevTower", branch: "feat/streaming", url: "https://github.com/acme/x/pull/318", isDraft: true, checks: "pending", checksPass: 3, checksFailed: 0, checksRunning: 2, checksTotal: 5, review: "required", approvals: 0, changesRequested: 0, reviewersPending: 2, comments: 0, author: "you", agentId: "a2" },
      ],
      review: [
        { id: "acme/infra#87", number: 87, title: "Terraform: split staging state", repo: "acme/infra", branch: "infra/split", url: "https://github.com/acme/infra/pull/87", isDraft: false, checks: "none", checksPass: 0, checksFailed: 0, checksRunning: 0, checksTotal: 0, review: "required", approvals: 0, changesRequested: 0, reviewersPending: 1, comments: 0, author: "mrivera" },
      ],
    },
  },
  {
    // a quiet tower: one active agent, low usage, no PRs. Good baseline for HUD
    // before/after where the busy scene is visually noisy.
    name: "calm",
    config: { eco: false },
    usage: { fiveHour: { pct: 18 }, sevenDay: { pct: 9 } },
    state: {
      agents: [
        { id: "a1", name: "Atlas", state: "active", repo: "DevTower", model: "opus-4.8", worktree: "/repo", branch: "main", skills: [], contextTokens: 22_000, elapsed: "3m" },
      ],
      rooms: [
        { name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "main" }] },
      ],
      boards: { "/repo": board({ branch: "main", modified: 2, unstagedAdd: 18, unstagedDel: 4 }) },
    },
    prs: { crew: [], review: [] },
  },
  {
    // near-limit usage so the meters hit warn/crit colors
    name: "usage-critical",
    config: { eco: false },
    usage: { fiveHour: { pct: 93 }, sevenDay: { pct: 78 } },
    state: {
      agents: [
        { id: "a1", name: "Atlas", state: "active", repo: "DevTower", model: "opus-4.8", worktree: "/repo", branch: "main", skills: [], contextTokens: 190_000, elapsed: "58m" },
        { id: "a2", name: "Boris", state: "waiting", repo: "DevTower", model: "opus-4.8", worktree: "/wt/x", branch: "feat/x", skills: [], contextTokens: 120_000, elapsed: "40m" },
      ],
      rooms: [
        { name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "main" }, { path: "/wt/x", branch: "feat/x" }] },
      ],
      boards: {
        "/repo": board({ branch: "main" }),
        "/wt/x": board({ branch: "feat/x", modified: 5, unstagedAdd: 88, unstagedDel: 31, ahead: 4, unpushed: 4 }),
      },
    },
    prs: { crew: [], review: [] },
  },
];
