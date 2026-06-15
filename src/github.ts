import * as vscode from "vscode";

// DevTower talks to GitHub with a Personal Access Token the user provides in the
// settings page. The token is kept in VS Code SecretStorage and fed to gh via
// GH_TOKEN (it takes precedence over any `gh auth login`). We probe the token
// once to learn the account + granted scopes, cache that, and use it to light up
// only the features the token can actually serve.
const PAT_KEY = "devtower.githubPat";

// What a token's scopes let DevTower do. Surfaced in the settings page so the
// user can see why a scope matters and which feature each unlocks.
export interface GithubFeature {
  key: "prs" | "checks" | "reviewRequests";
  label: string;
  enabled: boolean;
  scope: string; // the scope (or fine-grained permission) it needs
  why: string;
}

export interface GithubCapabilities {
  connected: boolean;
  login?: string;
  tokenType?: "classic" | "fine-grained" | "unknown";
  scopes?: string[]; // classic-PAT scopes (X-OAuth-Scopes); empty for fine-grained
  features: GithubFeature[];
  error?: string; // populated when the probe failed (bad/expired token, offline)
  checkedAt?: number;
}

// Why each scope is requested, shown verbatim in the settings UI.
export const SCOPE_HELP: { scope: string; why: string }[] = [
  { scope: "repo", why: "Read pull requests and CI checks on your PRIVATE repositories. Public-only? You can skip this, but private PRs will not appear." },
  { scope: "read:org", why: "Resolve review requests assigned to you inside organizations." },
];

let ctx: vscode.ExtensionContext | undefined;
let caps: GithubCapabilities | undefined; // cached probe result

export function initGithubAuth(context: vscode.ExtensionContext): void {
  ctx = context;
  context.subscriptions.push(
    context.secrets.onDidChange((e) => { if (e.key === PAT_KEY) caps = undefined; })
  );
}

/** The stored PAT, or undefined if the user has not set one yet. */
export function getGithubToken(): Promise<string | undefined> {
  return Promise.resolve(ctx?.secrets.get(PAT_KEY)) as Promise<string | undefined>;
}

/** Save (or replace) the PAT and re-probe its capabilities. */
export async function setGithubToken(token: string): Promise<GithubCapabilities> {
  const t = token.trim();
  if (!ctx) return { connected: false, features: buildFeatures([]), error: "extension not ready" };
  if (!t) { await ctx.secrets.delete(PAT_KEY); caps = undefined; return capabilities(); }
  await ctx.secrets.store(PAT_KEY, t);
  caps = await probe(t);
  return caps;
}

/** Forget the PAT. */
export async function clearGithubToken(): Promise<void> {
  await ctx?.secrets.delete(PAT_KEY);
  caps = undefined;
}

/** Current capabilities. Probes once (and caches) when a token exists but we have
 *  not checked it yet; returns a disconnected result when no token is set. */
export async function capabilities(force = false): Promise<GithubCapabilities> {
  if (caps && !force) return caps;
  const token = await getGithubToken();
  if (!token) { caps = { connected: false, features: buildFeatures([]) }; return caps; }
  caps = await probe(token);
  return caps;
}

/** Ask GitHub who the token belongs to and which scopes it carries. Classic PATs
 *  report scopes in the X-OAuth-Scopes header; fine-grained PATs do not, so we
 *  treat an authenticated fine-grained token as "trust it, verify at call time". */
async function probe(token: string): Promise<GithubCapabilities> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "DevTower",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const msg = res.status === 401 ? "Token rejected (invalid or expired)." : `GitHub returned ${res.status}.`;
      return { connected: false, features: buildFeatures([]), error: msg, checkedAt: Date.now() };
    }
    const login = ((await res.json()) as any)?.login as string | undefined;
    const header = res.headers.get("x-oauth-scopes");
    // header present (even if empty) => classic PAT; absent => fine-grained
    const fineGrained = header === null;
    const scopes = (header ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return {
      connected: true,
      login,
      tokenType: fineGrained ? "fine-grained" : "classic",
      scopes,
      features: buildFeatures(scopes, fineGrained),
      checkedAt: Date.now(),
    };
  } catch (e) {
    return { connected: false, features: buildFeatures([]), error: `Could not reach GitHub: ${String(e).slice(0, 120)}`, checkedAt: Date.now() };
  }
}

/** Map detected scopes to the DevTower features they unlock. A fine-grained token
 *  can't be introspected here, so we optimistically enable and let the live call
 *  be the real gate. */
function buildFeatures(scopes: string[], fineGrained = false): GithubFeature[] {
  const has = (s: string) => fineGrained || scopes.includes(s);
  const hasRepo = has("repo");
  return [
    { key: "prs", label: "Pull requests", enabled: true, scope: "repo / public", why: "List your open PRs and their state. Public PRs work with any token; private PRs need repo." },
    { key: "checks", label: "CI checks", enabled: hasRepo, scope: "repo", why: "Read the status-check rollup (pass/fail/running) on your PRs." },
    { key: "reviewRequests", label: "Reviews requested of you", enabled: hasRepo || has("read:org"), scope: "read:org", why: "Find PRs across orgs that request your review." },
  ];
}
