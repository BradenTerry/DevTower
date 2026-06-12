import { execFile } from "child_process";
import * as vscode from "vscode";
import { FleetStore } from "./fleet";
import { isRepo, resolveCwd } from "./git";

export interface PrInfo {
  id: string; // "<repo>#<number>"
  number: number;
  title: string;
  repo: string;
  branch?: string;
  url: string;
  isDraft: boolean;
  /** rolled-up CI status */
  checks: "pass" | "fail" | "pending" | "none";
  /** review decision */
  review: "approved" | "changes" | "required" | "none";
  author?: string;
  agentId?: string;
  updatedAt?: string;
}

function runGh(cwd: string | undefined, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      args,
      { cwd, timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout)
    );
  });
}

function rollupChecks(rollup: any[]): PrInfo["checks"] {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const c of rollup) {
    const s = String(c.conclusion ?? c.state ?? "").toUpperCase();
    if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(s)) return "fail";
    if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(s)) pending = true;
  }
  return pending ? "pending" : "pass";
}

function mapDecision(d: string | undefined): PrInfo["review"] {
  switch ((d ?? "").toUpperCase()) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes";
    case "REVIEW_REQUIRED": return "required";
    default: return "none";
  }
}

/**
 * Tracks two PR sets via the gh CLI:
 *  - fleet:  open PRs for each agent's branch (run in that agent's worktree)
 *  - review: open PRs where the user's review is requested (any repo)
 * Falls back to seeded mock PRs when gh/data is unavailable and mock mode is on.
 */
export class PrService {
  private fleet: PrInfo[] = [];
  private review: PrInfo[] = [];
  private _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing = false;

  constructor(private store: FleetStore) {}

  getFleet(): PrInfo[] {
    return this.fleet;
  }
  getReview(): PrInfo[] {
    return this.review;
  }

  start(intervalMs = 120_000, delayMs = 0): void {
    setTimeout(() => void this.refresh(), delayMs);
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const [fleet, review] = await Promise.all([this.fetchFleet(), this.fetchReview()]);
      const mock = vscode.workspace.getConfiguration("fleet").get<boolean>("useMockData", true);
      this.fleet = fleet.length || !mock ? fleet : MOCK_FLEET_PRS;
      this.review = review.length || !mock ? review : MOCK_REVIEW_PRS;
      this._onChange.fire();
    } finally {
      this.refreshing = false;
    }
  }

  private async fetchFleet(): Promise<PrInfo[]> {
    const out: PrInfo[] = [];
    const seen = new Set<string>();
    for (const agent of this.store.list()) {
      const cwd = resolveCwd(agent);
      if (!cwd || !(await isRepo(cwd))) continue;
      const raw = await runGh(cwd, [
        "pr", "list", "--head", agent.branch, "--state", "open", "--limit", "1",
        "--json", "number,title,url,isDraft,reviewDecision,statusCheckRollup,headRefName,author",
      ]);
      if (!raw) continue;
      try {
        for (const p of JSON.parse(raw)) {
          const id = `${agent.repo}#${p.number}`;
          if (seen.has(id)) continue;
          seen.add(id);
          out.push({
            id,
            number: p.number,
            title: p.title,
            repo: agent.repo,
            branch: p.headRefName ?? agent.branch,
            url: p.url,
            isDraft: !!p.isDraft,
            checks: rollupChecks(p.statusCheckRollup),
            review: mapDecision(p.reviewDecision),
            author: p.author?.login,
            agentId: agent.id,
          });
        }
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }

  private async fetchReview(): Promise<PrInfo[]> {
    const raw = await runGh(undefined, [
      "search", "prs", "--review-requested=@me", "--state", "open", "--limit", "20",
      "--json", "number,title,url,repository,isDraft,author,updatedAt",
    ]);
    if (!raw) return [];
    try {
      return (JSON.parse(raw) as any[]).map((p) => ({
        id: `${p.repository?.nameWithOwner ?? "?"}#${p.number}`,
        number: p.number,
        title: p.title,
        repo: p.repository?.nameWithOwner ?? "unknown",
        url: p.url,
        isDraft: !!p.isDraft,
        checks: "none" as const, // search API has no rollup; shown as neutral
        review: "required" as const,
        author: p.author?.login,
        updatedAt: p.updatedAt,
      }));
    } catch {
      return [];
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this._onChange.dispose();
  }
}

/* ============ MOCK PRS (UI preview without gh) ============ */
const MOCK_FLEET_PRS: PrInfo[] = [
  {
    id: "atlas-web#142", number: 142,
    title: "Agent cockpit: tree + diff panel",
    repo: "atlas-web", branch: "feat/agent-cockpit",
    url: "https://github.com/acme/atlas-web/pull/142",
    isDraft: false, checks: "pass", review: "approved", author: "you", agentId: "a3",
  },
  {
    id: "atlas-api#318", number: 318,
    title: "SSE streaming for /v1/messages",
    repo: "atlas-api", branch: "feat/streaming-sse",
    url: "https://github.com/acme/atlas-api/pull/318",
    isDraft: true, checks: "pending", review: "required", author: "you", agentId: "a1",
  },
  {
    id: "atlas-api#316", number: 316,
    title: "Fix refresh-token rotation race",
    repo: "atlas-api", branch: "fix/auth-refresh-race",
    url: "https://github.com/acme/atlas-api/pull/316",
    isDraft: false, checks: "fail", review: "changes", author: "you", agentId: "a2",
  },
];

const MOCK_REVIEW_PRS: PrInfo[] = [
  {
    id: "acme/atlas-api#311", number: 311,
    title: "Rate limiter cleanup + sliding window",
    repo: "acme/atlas-api",
    url: "https://github.com/acme/atlas-api/pull/311",
    isDraft: false, checks: "none", review: "required", author: "jchen", updatedAt: "2026-06-10T18:22:00Z",
  },
  {
    id: "acme/infra#87", number: 87,
    title: "Terraform: split staging state",
    repo: "acme/infra",
    url: "https://github.com/acme/infra/pull/87",
    isDraft: false, checks: "none", review: "required", author: "mrivera", updatedAt: "2026-06-11T09:10:00Z",
  },
];
