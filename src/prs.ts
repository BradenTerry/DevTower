import { execFile } from "child_process";
import * as vscode from "vscode";
import { DevTowerStore } from "./store";
import { isRepo, resolveCwd } from "./git";
import { getGithubToken } from "./github";

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
  /** GitHub Actions / check-run counts behind the rollup */
  checksPass: number;
  checksFailed: number;
  checksRunning: number;
  checksTotal: number;
  /** review decision */
  review: "approved" | "changes" | "required" | "none";
  /** distinct reviewers who approved / requested changes, plus still-pending
   *  requested reviewers (the denominator for "N of M approved") */
  approvals: number;
  changesRequested: number;
  reviewersPending: number;
  comments: number; // discussion comments (issue + review "commented" submissions)
  author?: string;
  agentId?: string;
  updatedAt?: string;
}

// Run gh with DevTower's PAT forced via GH_TOKEN, so gh uses it instead of any
// `gh auth login` keyring credential (GH_TOKEN takes precedence). GH_PROMPT_DISABLED
// keeps gh from ever blocking on a TTY.
function runGh(cwd: string | undefined, args: string[], token: string): Promise<string | null> {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: "1" };
  return new Promise((resolve) => {
    execFile(
      "gh",
      args,
      { cwd, timeout: 20000, maxBuffer: 8 * 1024 * 1024, env },
      (err, stdout) => resolve(err ? null : stdout)
    );
  });
}

/** A conditional `gh api` GET with response headers, used for ETag polling. A
 *  304 (Not Modified) does NOT count against the GitHub rate limit, so re-polling
 *  an unchanged PR is free. `{owner}/{repo}` in `apiPath` is filled by gh from the
 *  cwd's git remote. Returns the raw `--include` output (headers + body), or null
 *  on a transport error. */
function ghApiInclude(cwd: string, apiPath: string, token: string, etag?: string): Promise<string | null> {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: "1" };
  const args = ["api", apiPath, "--include"];
  if (etag) args.push("-H", `If-None-Match: ${etag}`);
  return new Promise((resolve) => {
    execFile("gh", args, { cwd, timeout: 20000, maxBuffer: 8 * 1024 * 1024, env },
      // gh exits 0 for 200/304; on a 4xx/5xx err is set but stdout still holds the
      // response. Treat "no output at all" as a transport failure.
      (err, stdout) => resolve(err && !stdout ? null : (stdout || "")));
  });
}

/** HTTP status code from a `gh api --include` response, or 0 if unparseable. */
export function httpStatus(resp: string): number {
  const m = /^HTTP\/[\d.]+\s+(\d+)/m.exec(resp);
  return m ? parseInt(m[1], 10) : 0;
}

/** The ETag header from a `gh api --include` response, or undefined. */
export function etagOf(resp: string): string | undefined {
  const m = /^etag:\s*(.+?)\s*$/im.exec(resp);
  return m ? m[1] : undefined;
}

const CHECK_OK = ["SUCCESS", "NEUTRAL", "SKIPPED"];
const CHECK_BAD = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"];

export function rollupChecks(rollup: any[]): PrInfo["checks"] {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const c of rollup) {
    const s = String(c.conclusion ?? c.state ?? "").toUpperCase();
    if (CHECK_BAD.includes(s)) return "fail";
    if (!CHECK_OK.includes(s)) pending = true;
  }
  return pending ? "pending" : "pass";
}

/** Break the rollup into passed / failed / still-running counts. A check run is
 *  "running" when it hasn't concluded yet (queued / in_progress / pending). */
export function checkCounts(rollup: any[]): { pass: number; fail: number; running: number; total: number } {
  if (!Array.isArray(rollup)) return { pass: 0, fail: 0, running: 0, total: 0 };
  let pass = 0, fail = 0, running = 0;
  for (const c of rollup) {
    const concl = String(c.conclusion ?? c.state ?? "").toUpperCase();
    if (CHECK_OK.includes(concl)) pass++;
    else if (CHECK_BAD.includes(concl)) fail++;
    else running++; // no conclusion yet → queued / in progress / pending
  }
  return { pass, fail, running, total: rollup.length };
}

/** Tally the LATEST decision per reviewer (approve / changes), plus how many
 *  requested reviewers haven't weighed in yet. */
export function reviewCounts(
  reviews: any[],
  reviewRequests: any[]
): { approvals: number; changesRequested: number; pending: number; commented: number } {
  const latest = new Map<string, string>(); // login → latest decision state
  let commented = 0;
  for (const r of Array.isArray(reviews) ? reviews : []) {
    const login = r.author?.login;
    const state = String(r.state ?? "").toUpperCase();
    if (state === "COMMENTED") commented++;
    if (!login || !["APPROVED", "CHANGES_REQUESTED"].includes(state)) continue;
    latest.set(login, state); // reviews are chronological → last wins
  }
  let approvals = 0, changesRequested = 0;
  for (const s of latest.values()) {
    if (s === "APPROVED") approvals++;
    else if (s === "CHANGES_REQUESTED") changesRequested++;
  }
  const pending = Array.isArray(reviewRequests) ? reviewRequests.length : 0;
  return { approvals, changesRequested, pending, commented };
}

export function mapDecision(d: string | undefined): PrInfo["review"] {
  switch ((d ?? "").toUpperCase()) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes";
    case "REVIEW_REQUIRED": return "required";
    default: return "none";
  }
}

/**
 * Tracks two PR sets via the gh CLI (using DevTower's GitHub token):
 *  - crew:   open PRs for each agent's branch (run in that agent's worktree)
 *  - review: open PRs where the user's review is requested (any repo)
 * With no token the sets are empty and the UI shows a disconnected state. There
 * is no mock data.
 */
export class PrService {
  private crew: PrInfo[] = [];
  private review: PrInfo[] = [];
  private _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing = false;
  private fetched = false; // has at least one PR poll completed?
  private lastSig = ""; // signature of the last emitted PR set, to skip no-op redraws
  private lastFetchAt = 0; // throttle floor: never burst the GitHub API
  /** Room branches to look up PRs for even when no agent is on them — the main
   *  building's checkout and any worktree rooms. Fed by ConsolePanel each refresh
   *  so a branch+PR created outside DevTower (e.g. from the CLI) still surfaces. */
  private extraTargets: { cwd: string; repo: string; branch: string }[] = [];
  private extraSig = "";
  private signInPrompted = false; // only nudge the user to connect GitHub once
  private connected = false; // is a GitHub token present (drives the disconnected UI)
  /** Per-branch ETag cache: a settled PR's last fetch + its PR-resource ETag, so
   *  the next poll can short-circuit with a free 304 when nothing changed. */
  private prCache = new Map<string, { etag: string; info: PrInfo }>();

  constructor(private store: DevTowerStore) {}

  /** Whether DevTower currently has a GitHub token. False => the webview shows a
   *  disconnected placeholder instead of (now nonexistent) mock data. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Register the room checkouts (cwd + repo label + current branch) whose PRs
   *  should be tracked alongside the agents'. When the set changes, kick a prompt
   *  refresh so a freshly opened PR appears without waiting for the next poll. */
  setExtraTargets(targets: { cwd: string; repo: string; branch: string }[]): void {
    const sig = JSON.stringify(targets.map((t) => `${t.cwd}¦${t.branch}`).sort());
    if (sig === this.extraSig) return;
    this.extraSig = sig;
    this.extraTargets = targets;
    void this.refresh();
  }

  getCrew(): PrInfo[] {
    return this.crew;
  }
  getReview(): PrInfo[] {
    return this.review;
  }
  /** True once the first PR fetch has finished (success or not), so the UI can
   *  show a spinner only while the very first lookup is still in flight. */
  hasFetched(): boolean {
    return this.fetched;
  }

  /** Adaptive polling: while any matched PR has a check still running, poll every
   *  ~10s so a live build updates reasonably quickly; otherwise back off to ~60s.
   *  (Kept conservative — each poll is N gh API calls, and bursts trip GitHub's
   *  secondary rate limit.) */
  start(delayMs = 4_000): void {
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    await this.refresh();
    const running = [...this.crew, ...this.review].some((p) => p.checksRunning > 0);
    this.timer = setTimeout(() => void this.tick(), running ? 10_000 : 60_000);
  }

  async refresh(force = false): Promise<void> {
    if (this.refreshing) return;
    if (!force && Date.now() - this.lastFetchAt < 3_000) return; // floor: never burst the API
    this.refreshing = true;
    this.lastFetchAt = Date.now();
    try {
      // DevTower's GitHub PAT (from the settings page). Absent until the user adds
      // one. Never falls back to the gh CLI login, and there is no mock data.
      const token = await getGithubToken();
      if (!token) {
        // not connected: nudge once, clear any stale PRs so the UI shows the
        // disconnected state rather than leftover data
        if (!this.signInPrompted) { this.signInPrompted = true; void this.promptSignIn(); }
        this.connected = false;
        this.crew = [];
        this.review = [];
        this.fetched = true;
        this.lastSig = this.signature(); // record so a later reconnect is detected
        this._onChange.fire(); // always re-emit so the disconnected state shows
        return;
      }
      this.connected = true;
      const [crew, review] = await Promise.all([this.fetchCrew(token), this.fetchReview(token)]);
      // keep prior data when a fetch FAILED (auth / rate limit) so the PR doesn't
      // vanish on a transient error
      this.crew = (!crew.ok && crew.prs.length === 0 && this.crew.length) ? this.crew : crew.prs;
      this.review = (!review.ok && review.prs.length === 0 && this.review.length) ? this.review : review.prs;
      const firstFetch = !this.fetched;
      this.fetched = true; // set before firing so refreshState reads it live
      // only repaint when the PR data actually changed — otherwise every poll /
      // git event flashes the PR panel even when nothing moved
      const sig = this.signature();
      if (force || firstFetch || sig !== this.lastSig) {
        this.lastSig = sig;
        this._onChange.fire();
      }
    } finally {
      this.refreshing = false;
    }
  }

  /** Re-poll now that a token may have been added/changed (called from the
   *  settings page after a save). Bypasses the throttle floor. */
  async reauth(): Promise<void> {
    this.signInPrompted = true;
    this.lastFetchAt = 0;
    await this.refresh(true); // auth just changed → always repaint, even if PRs match
  }

  /** One-time, dismissible nudge when no token is set yet, pointing at the
   *  settings page where the user adds one. */
  private async promptSignIn(): Promise<void> {
    const pick = await vscode.window.showInformationMessage(
      "DevTower needs a GitHub token to show PRs and checks. Add one in DevTower settings.",
      "Open settings"
    );
    if (pick === "Open settings") await vscode.commands.executeCommand("devtower.openSettings");
  }

  /** Stable fingerprint of the display-relevant PR fields, sorted by id so a
   *  reordered fetch doesn't read as a change. */
  private signature(): string {
    const key = (p: PrInfo) =>
      [p.id, p.title, p.isDraft, p.checks, p.checksPass, p.checksFailed, p.checksRunning,
        p.checksTotal, p.review, p.approvals, p.changesRequested, p.reviewersPending, p.comments].join("¦");
    // include `connected` so a disconnected↔connected flip repaints even when the
    // PR lists are identical (e.g. adding a token while you have zero open PRs)
    return JSON.stringify([this.connected, this.crew.map(key).sort(), this.review.map(key).sort()]);
  }

  private async fetchCrew(token: string): Promise<{ prs: PrInfo[]; ok: boolean }> {
    const out: PrInfo[] = [];
    const seen = new Set<string>();
    const queried = new Set<string>(); // repo+branch already asked, skip duplicate gh calls
    let ok = true;
    // agents' branches (run in each agent's worktree) ...
    for (const agent of this.store.list()) {
      const cwd = resolveCwd(agent);
      if (!cwd) continue;
      if (!(await this.queryHead(cwd, agent.repo, agent.branch, out, seen, queried, token, agent.id))) ok = false;
    }
    // ... plus the room checkouts (main building + worktree rooms) so a PR opened
    // outside any DevTower agent still shows on that building's board
    for (const t of this.extraTargets) {
      if (!t.branch) continue;
      if (!(await this.queryHead(t.cwd, t.repo, t.branch, out, seen, queried, token))) ok = false;
    }
    return { prs: out, ok };
  }

  /** Look up the single open PR whose head is `branch` in `cwd`, appending it to
   *  `out`. Returns false only when gh itself errored (auth / rate limit), so the
   *  caller can preserve prior data instead of blanking the panel. */
  private async queryHead(
    cwd: string, repo: string, branch: string,
    out: PrInfo[], seen: Set<string>, queried: Set<string>, token: string, agentId?: string
  ): Promise<boolean> {
    const qkey = `${repo} ${branch}`;
    if (queried.has(qkey)) return true;
    queried.add(qkey);
    if (!(await isRepo(cwd))) return true;

    // Fast path: if we have a SETTLED PR cached for this branch, ask GitHub "has
    // PR #N changed?" with its ETag. A 304 is free (no rate-limit cost), so an
    // unchanged PR re-uses the cached data without the expensive GraphQL fetch.
    // (We only do this when checks aren't running — an active build changes every
    // poll anyway, and a check completing doesn't bump the PR's ETag.)
    const cached = this.prCache.get(qkey);
    let freshEtag: string | undefined;
    if (cached && cached.info.checksRunning === 0) {
      const resp = await ghApiInclude(cwd, `repos/{owner}/{repo}/pulls/${cached.info.number}`, token, cached.etag);
      if (resp !== null) {
        const status = httpStatus(resp);
        if (status === 304) {
          if (!seen.has(cached.info.id)) { seen.add(cached.info.id); out.push({ ...cached.info, agentId }); }
          return true; // unchanged — served for free
        }
        if (status === 200) freshEtag = etagOf(resp); // changed; reuse this ETag below
      }
    }

    const raw = await runGh(cwd, [
      "pr", "list", "--head", branch, "--state", "open", "--limit", "1",
      "--json", "number,title,url,isDraft,reviewDecision,statusCheckRollup,headRefName,author,reviews,reviewRequests,comments",
    ], token);
    if (raw === null) return false; // gh errored (auth / rate limit)
    let matched = false;
    try {
      for (const p of JSON.parse(raw)) {
        const id = `${repo}#${p.number}`;
        if (seen.has(id)) continue;
        seen.add(id);
        matched = true;
        const cc = checkCounts(p.statusCheckRollup);
        const rc = reviewCounts(p.reviews, p.reviewRequests);
        const comments = (Array.isArray(p.comments) ? p.comments.length : 0) + rc.commented;
        const info: PrInfo = {
          id,
          number: p.number,
          title: p.title,
          repo,
          branch: p.headRefName ?? branch,
          url: p.url,
          isDraft: !!p.isDraft,
          checks: rollupChecks(p.statusCheckRollup),
          checksPass: cc.pass,
          checksFailed: cc.fail,
          checksRunning: cc.running,
          checksTotal: cc.total,
          review: mapDecision(p.reviewDecision),
          approvals: rc.approvals,
          changesRequested: rc.changesRequested,
          reviewersPending: rc.pending,
          comments,
          author: p.author?.login,
          agentId,
        };
        out.push(info);
        // cache a SETTLED PR with its current ETag so the next poll 304s for free.
        // Reuse the ETag from the conditional 200 above when it's the same PR;
        // otherwise one extra cheap REST call fetches it (paid once per change).
        if (info.checksRunning === 0) {
          const etag = freshEtag && info.number === cached?.info.number
            ? freshEtag
            : etagOf((await ghApiInclude(cwd, `repos/{owner}/{repo}/pulls/${info.number}`, token)) ?? "");
          if (etag) this.prCache.set(qkey, { etag, info });
          else this.prCache.delete(qkey);
        } else {
          this.prCache.delete(qkey); // checks running → data moves every poll
        }
      }
    } catch {
      /* skip malformed */
    }
    if (!matched) this.prCache.delete(qkey); // no open PR on this branch anymore
    return true;
  }

  private async fetchReview(token: string): Promise<{ prs: PrInfo[]; ok: boolean }> {
    const raw = await runGh(undefined, [
      "search", "prs", "--review-requested=@me", "--state", "open", "--limit", "20",
      "--json", "number,title,url,repository,isDraft,author,updatedAt",
    ], token);
    if (raw === null) return { prs: [], ok: false };
    try {
      const prs = (JSON.parse(raw) as any[]).map((p) => ({
        id: `${p.repository?.nameWithOwner ?? "?"}#${p.number}`,
        number: p.number,
        title: p.title,
        repo: p.repository?.nameWithOwner ?? "unknown",
        url: p.url,
        isDraft: !!p.isDraft,
        checks: "none" as const, // search API has no rollup; shown as neutral
        checksPass: 0,
        checksFailed: 0,
        checksRunning: 0,
        checksTotal: 0,
        review: "required" as const,
        approvals: 0,
        changesRequested: 0,
        reviewersPending: 0,
        comments: 0,
        author: p.author?.login,
        updatedAt: p.updatedAt,
      }));
      return { prs, ok: true };
    } catch {
      return { prs: [], ok: false };
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this._onChange.dispose();
  }
}
