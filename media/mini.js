/* DevTower mini view — a compact, DOM-table popout of the tower.
   Drill: Projects → Worktrees → Agents, plus a nested PR detail. Fed by the
   ConsolePanel (same agents/rooms/boards/PRs data); no polling of its own. */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  const basename = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(p || "");

  const STATE_LABEL = { active: "Active", waiting: "Awaiting", complete: "Complete", error: "Error", idle: "Idle" };
  const STATE_KEYS = ["active", "waiting", "complete", "error", "idle"];
  const REVIEW_LABEL = { approved: "Approved", changes: "Changes requested", required: "Review required", none: "No review" };
  // overall CI/check status → the same colors as the check dots (chk-*)
  const CHECK_COLOR = { pass: "var(--active)", fail: "var(--error)", pending: "var(--waiting)", none: "var(--idle)" };
  // GitHub merged-purple, matching the tower's "✓ MERGED" badge in crew.ts
  const MERGED_COLOR = "#c9a6ff";
  const checkColor = (pr) => (pr && pr.merged ? MERGED_COLOR : CHECK_COLOR[pr && pr.checks] || "var(--idle)");
  const mergedTag = (pr) => (pr && pr.merged ? `<span class="merged">✓ merged</span>` : "");

  /* ---------- live state from the host ---------- */
  let agents = [], rooms = [], boards = {}, usedDir = null, selectedId = null;
  let prConnected = false;
  /** Whether the tower UI is open (it may be hidden behind this tab — View reveals
   *  it). Gates the agent "View" action: disabled only when no tower exists. */
  let towerOpen = true;
  /** Top-level tab: "projects" (the drill view) | "agents" (flat all-agents). */
  let tab = "projects";
  /** Drill position. level is derived from which fields are set. */
  let nav = { project: null, worktree: null, pr: null };

  function level() {
    if (nav.pr) return "pr";
    if (nav.worktree) return "agents";
    if (nav.project) return "worktrees";
    return "projects";
  }

  /* ---------- color helpers ---------- */
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const hueOf = (s) => hash(String(s || "")) % 360;

  function contextPct(a) {
    if (!a || !a.contextTokens) return null;
    const m = (a.model || "").toLowerCase();
    const oneM = /1m/.test(m) || /(opus|sonnet)[ -]4/.test(m) || a.contextTokens > 200000;
    const limit = oneM ? 1000000 : 200000;
    return Math.min(100, Math.round((a.contextTokens / limit) * 100));
  }
  const ctxColor = (p) => (p === null ? "var(--idle)" : p < 60 ? "var(--active)" : p < 85 ? "var(--waiting)" : "var(--error)");
  const shortModel = (m) => String(m || "—").replace(/^claude-/, "").replace(/-\d{8}$/, "");

  /* ---------- data derivation ---------- */
  // Build the project list from BOTH reserved rooms and live agents, so an agent
  // running in an unreserved checkout still shows up (matches the tower).
  // Projects are the reserved rooms ONLY — exactly like the tower's islands.
  // Worktrees are each room's checkouts (main + assigned); agents attach to a
  // worktree by path. We never make a project out of an agent, so worktrees
  // never leak into the project list.
  function buildProjects() {
    return rooms
      .map((r) => ({
        name: r.name,
        path: r.path,
        worktrees: (r.worktrees || [])
          .filter((w) => w && w.path)
          .map((w) => ({ path: w.path, branch: w.branch || "", main: w.path === r.path })),
      }))
      .sort((x, y) => x.name.localeCompare(y.name));
  }

  const projectByName = (name) => buildProjects().find((p) => p.name === name);
  const agentsInWorktree = (path) => agents.filter((a) => (a.worktree || "") === path);
  // count by worktree membership (not the repo string), so an agent shows under
  // its project regardless of how discovery labelled its repo
  const agentsInProject = (p) => {
    const paths = new Set(p.worktrees.map((w) => w.path));
    return agents.filter((a) => paths.has(a.worktree || ""));
  };
  const boardFor = (path) => boards[path];
  const wtLabel = (wt) => {
    const b = boardFor(wt.path);
    const branch = (b && b.branch) || wt.branch;
    return branch || (wt.main ? "main" : basename(wt.path));
  };

  function stateCounts(list) {
    const c = { active: 0, waiting: 0, complete: 0, error: 0, idle: 0 };
    for (const a of list) c[a.state] = (c[a.state] || 0) + 1;
    return c;
  }

  /* ---------- hover tooltip (200ms delay, custom — not the native title) ---------- */
  let tipEl = null, tipTimer = null;
  function ensureTip() {
    if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "tooltip"; document.body.appendChild(tipEl); }
    return tipEl;
  }
  function showTip(target, text) {
    if (!text) return;
    const el = ensureTip();
    el.textContent = text;
    el.classList.add("show");
    // measure, then place above the target and clamp to the viewport
    const r = target.getBoundingClientRect();
    const tr = el.getBoundingClientRect();
    let top = r.top - tr.height - 8;
    if (top < 6) top = r.bottom + 8; // flip below when there's no room above
    const left = Math.max(6, Math.min(r.left, window.innerWidth - tr.width - 6));
    el.style.left = left + "px";
    el.style.top = top + "px";
  }
  function hideTip() {
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    if (tipEl) tipEl.classList.remove("show");
  }
  function wireTips(root) {
    root.querySelectorAll("[data-tip]").forEach((el) => {
      el.addEventListener("mouseenter", () => {
        hideTip();
        tipTimer = setTimeout(() => showTip(el, el.dataset.tip), 200);
      });
      el.addEventListener("mouseleave", hideTip);
    });
  }

  /* ---------- shared cell renderers ---------- */
  function pip(state) { return `<i class="pip ${state}"></i>`; }

  // explicit per-status counts — run / wait / err — always shown so each row
  // reads the same way as the header telemetry. Zero counts dim rather than hide.
  function countsCell(list, stack) {
    const c = stateCounts(list);
    const seg = (k, label) => `<span class="seg${c[k] ? "" : " zero"}">${pip(k)}<b>${c[k]}</b><em>${label}</em></span>`;
    return `<span class="counts${stack ? " vstack" : ""}">${seg("active", "run")}${seg("waiting", "wait")}${seg("error", "err")}</span>`;
  }

  // Git cell split into three stacked sections (two horizontal dividers):
  //   Committed — committed line counts + ahead/behind/unpushed ("pending") commits
  //   Staged    — staged line counts + staged file count
  //   Unstaged  — working-tree line counts + modified file count
  function gitRow(label, add, del, extra) {
    const bits = [];
    if (add) bits.push(`<span class="add">+${add}</span>`);
    if (del) bits.push(`<span class="del">-${del}</span>`);
    if (extra) bits.push(extra);
    const vals = bits.length ? bits.join("") : `<span class="muted">—</span>`;
    return `<div class="grow"><span class="glabel">${label}</span><span class="gvals">${vals}</span></div>`;
  }
  function gitCell(b) {
    if (!b) return `<span class="git muted">—</span>`;
    if (b.missing) return `<span class="git"><span class="del">missing</span></span>`;
    const anything = (b.committedAdd || b.committedDel || b.stagedAdd || b.stagedDel ||
      b.unstagedAdd || b.unstagedDel || b.ahead || b.behind || b.unpushed || b.staged || b.modified);
    if (!anything) return `<span class="git"><span class="muted">clean</span></span>`;
    const pend = [];
    if (b.ahead) pend.push(`<span class="tag">↑${b.ahead}</span>`);
    if (b.behind) pend.push(`<span class="tag">↓${b.behind}</span>`);
    if (b.unpushed) pend.push(`<span class="tag muted">${b.unpushed} unpushed</span>`);
    const fileTag = (n) => (n ? `<span class="tag">${n} file${n === 1 ? "" : "s"}</span>` : "");
    return `<div class="gitstack">` +
      gitRow("Committed", b.committedAdd || 0, b.committedDel || 0, pend.join("")) +
      gitRow("Staged", b.stagedAdd || 0, b.stagedDel || 0, fileTag(b.staged || 0)) +
      gitRow("Unstaged", b.unstagedAdd || 0, b.unstagedDel || 0, fileTag(b.modified || 0)) +
      `</div>`;
  }

  function prBadge(b) {
    if (!b) return `<span class="git muted">—</span>`;
    if (!b.prReady) return `<span class="git muted">…</span>`;
    if (!b.pr) return `<span class="git muted">—</span>`;
    const pr = b.pr;
    const chk = pr.merged ? "chk-merged" : `chk-${pr.checks || "none"}`;
    return `<span class="prbadge" data-pr="${esc(b.__path)}">` +
      `<i class="dot ${chk}"></i><span class="num">#${pr.number}</span>` +
      (pr.merged ? mergedTag(pr) : pr.draft ? `<span class="draft">draft</span>` : "") +
      `</span>`;
  }

  /* ---------- level renderers ---------- */
  function renderProjects(view) {
    const projects = buildProjects();
    // toolbar: label + "+ Project" so a directory can be reserved without the tower
    const toolbar = `<div class="wt-toolbar">
      <div class="wt-meta"><span class="wt-label">Projects</span></div>
      <div class="actions"><button class="usebtn add" id="add-project" title="Pick a directory to add as a project">+ Project</button></div>
    </div>`;
    const wireToolbar = () => { const b = $("#add-project", view); if (b) b.addEventListener("click", () => vscode.postMessage({ type: "addProject" })); };
    if (!projects.length) {
      view.innerHTML = toolbar + `<div class="empty inline"><div class="big">No projects yet</div><div class="small">Add one with “+ Project” above, or reserve a directory in the tower.</div></div>`;
      wireToolbar();
      return;
    }
    const rowsHtml = projects.map((p) => {
      const list = agentsInProject(p);
      const prCount = p.worktrees.filter((w) => { const b = boardFor(w.path); return b && b.pr; }).length;
      return `<tr class="row" data-project="${esc(p.name)}">
        <td class="col-name"><div class="namecell"><span class="chip" style="--ac:hsl(${hueOf(p.name)} 55% 55%)"></span><div style="min-width:0"><div class="nm">${esc(p.name)}</div>${p.path ? `<div class="sub">${esc(p.path)}</div>` : ""}</div></div></td>
        <td class="num">${p.worktrees.length}</td>
        <td>${countsCell(list, true)}</td>
        <td class="num">${prCount ? `<span class="tag">${prCount} PR${prCount === 1 ? "" : "s"}</span>` : `<span class="git muted">—</span>`}</td>
        <td class="num"><div class="actions"><button class="iconbtn danger" data-rmproject="${esc(p.name)}" title="Remove ${esc(p.name)} from the tower">✕</button></div></td>
      </tr>`;
    }).join("");
    view.innerHTML = toolbar + `<table class="tbl"><thead><tr>
      <th class="col-name">Project</th><th class="num">Worktrees</th><th>Agents</th><th class="num">PRs</th><th class="num"></th>
    </tr></thead><tbody>${rowsHtml}</tbody></table>`;
    wireToolbar();
    view.querySelectorAll("tr.row").forEach((tr) => tr.addEventListener("click", () => { nav = { project: tr.dataset.project, worktree: null, pr: null }; render(); }));
    view.querySelectorAll("button[data-rmproject]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "removeProject", name: btn.dataset.rmproject }); }));
  }

  function renderWorktrees(view) {
    const p = projectByName(nav.project);
    if (!p) { nav = { project: null, worktree: null, pr: null }; return renderProjects(view); }
    // toolbar: project label + "+ Worktree" (create or assign a worktree here)
    const toolbar = `<div class="wt-toolbar">
      <div class="wt-meta"><span class="wt-label">${esc(p.name)}</span></div>
      <div class="actions">
        <button class="usebtn add" data-addwt="${esc(p.name)}" title="Create or assign a worktree for ${esc(p.name)}">+ Worktree</button>
      </div>
    </div>`;
    const wireToolbar = () => {
      view.querySelectorAll("button[data-addwt]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "addWorktree", island: btn.dataset.addwt }); }));
      view.querySelectorAll("button[data-rmproject]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "removeProject", name: btn.dataset.rmproject }); }));
    };
    if (!p.worktrees.length) {
      view.innerHTML = toolbar + `<div class="empty inline"><div class="big">No worktrees in ${esc(p.name)}</div><div class="small">Add one with “+ Worktree” above, or drop a dev into this project from the tower.</div></div>`;
      wireToolbar();
      return;
    }
    const rowsHtml = p.worktrees.map((w) => {
      const list = agentsInWorktree(w.path);
      const b = boardFor(w.path);
      if (b) b.__path = w.path;
      const isMounted = usedDir === w.path;
      const label = wtLabel(w);
      return `<tr class="row${isMounted ? " sel" : ""}" data-wt="${esc(w.path)}">
        <td class="col-name"><div class="namecell"><span class="chip" style="--ac:hsl(${hueOf(label)} 55% 55%)"></span><div style="min-width:0"><div class="nm">${esc(label)}${w.main ? ` <span class="sub" style="display:inline">· main</span>` : ""}</div><div class="sub">${esc(basename(w.path))}</div></div></div></td>
        <td>${countsCell(list, true)}</td>
        <td>${gitCell(b)}</td>
        <td>${prBadge(b)}</td>
        <td class="num"><div class="actions col">
          <button class="usebtn${isMounted ? " on" : ""}" data-use="${esc(w.path)}">${isMounted ? "Selected dir" : "Use dir"}</button>
          <button class="usebtn add" data-add="${esc(w.path)}" title="Add a dev to this worktree">+ Dev</button>
          ${w.main
            ? `<button class="iconbtn danger" data-rmproject="${esc(p.name)}" title="Unregister ${esc(p.name)} from DevTower (optionally delete its worktrees)">✕</button>`
            : `<button class="iconbtn danger" data-rmwt="${esc(w.path)}" title="Remove this worktree">✕</button>`}
        </div></td>
      </tr>`;
    }).join("");
    view.innerHTML = toolbar + `<table class="tbl"><thead><tr>
      <th class="col-name">Worktree</th><th>Agents</th><th>Git</th><th>PR</th><th class="num">Actions</th>
    </tr></thead><tbody>${rowsHtml}</tbody></table>`;
    wireToolbar();
    view.querySelectorAll("tr.row").forEach((tr) => tr.addEventListener("click", () => { nav = { project: nav.project, worktree: tr.dataset.wt, pr: null }; render(); }));
    view.querySelectorAll("button[data-use]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "useDir", room: btn.dataset.use }); }));
    view.querySelectorAll("button[data-add]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "addDev", island: nav.project, worktree: btn.dataset.add }); }));
    view.querySelectorAll("button[data-rmwt]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "removeWorktree", worktree: btn.dataset.rmwt, island: nav.project }); }));
    view.querySelectorAll(".prbadge[data-pr]").forEach((el) => el.addEventListener("click", (e) => { e.stopPropagation(); nav = { project: nav.project, worktree: nav.worktree, pr: el.dataset.pr }; render(); }));
  }

  // one agent row, shared by the per-worktree agents view and the all-agents view
  const AGENT_HEAD = `<tr><th class="col-name">Agent</th><th>State</th><th class="c-model">Model</th><th class="num c-ctx">Context</th><th class="num c-tasks">Tasks</th><th class="c-act"></th></tr>`;
  function agentRowHtml(a) {
    const pct = contextPct(a);
    const tasks = a.tasks && a.tasks.total ? `${a.tasks.done || 0}/${a.tasks.total}` : "";
    return `<tr class="${a.id === selectedId ? "sel" : ""}" data-agent="${esc(a.id)}">
      <td class="col-name"><div class="namecell"><span class="chip" style="--ac:hsl(${hueOf(a.id)} 55% 55%)"></span><div style="min-width:0"><div class="nm">${esc(a.name || a.id)}</div>${a.aiTitle ? `<div class="sub">${esc(a.aiTitle)}</div>` : ""}${a.task ? `<div class="task" data-tip="${esc(a.task)}">${esc(a.task)}</div>` : ""}</div></div></td>
      <td><span class="statecell">${pip(a.state)}<span class="slbl">${esc(STATE_LABEL[a.state] || a.state)}</span></span></td>
      <td class="c-model">${esc(shortModel(a.model))}</td>
      <td class="num c-ctx"><span class="ctx" style="color:${ctxColor(pct)}">${pct === null ? "—" : pct + "%"}</span></td>
      <td class="num c-tasks">${tasks ? `<span class="tag">${tasks}</span>` : `<span class="git muted">—</span>`}</td>
      <td class="c-act"><div class="actions col">
        <button class="usebtn" data-view="${esc(a.id)}"${towerOpen ? "" : " disabled"} title="${towerOpen
          ? "View this agent in the tower (selects + focuses it)"
          : "Open the tower (DevTower: Open Tower) to view this agent there"}">View</button>
        ${a.external ? "" : `<button class="usebtn chat" data-chat="${esc(a.id)}" title="Open this agent's chat (its Claude session) without moving the tower">Chat</button>
        <button class="iconbtn danger" data-rmagent="${esc(a.id)}" title="Send ${esc(a.name || a.id)} home (stop + remove)">✕</button>`}
      </div></td>
    </tr>`;
  }

  // worktree action buttons (+ Add agent / Use dir), shared by both agent views
  function wtActions(p, wt) {
    const mounted = usedDir === wt.path;
    return `<div class="actions">
      <button class="usebtn add" data-add="${esc(wt.path)}" data-island="${esc(p.name)}" title="Add a dev to this worktree">+ Add agent</button>
      <button class="usebtn${mounted ? " on" : ""}" data-use="${esc(wt.path)}">${mounted ? "Selected dir" : "Use dir"}</button>
    </div>`;
  }

  function wireAgentActions(view) {
    view.querySelectorAll("button[data-add]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "addDev", island: btn.dataset.island, worktree: btn.dataset.add }); }));
    view.querySelectorAll("button[data-use]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "useDir", room: btn.dataset.use }); }));
    view.querySelectorAll("button[data-view]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "select", id: btn.dataset.view }); }));
    view.querySelectorAll("button[data-chat]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "chat", id: btn.dataset.chat }); }));
    view.querySelectorAll("button[data-rmagent]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "removeAgent", id: btn.dataset.rmagent }); }));
    wireTips(view);
  }

  // PR summary card shown on the single-worktree view: number/title, CI + review,
  // comments, and a link that drills into the full PR detail (renderPr).
  function prBar(b) {
    if (!b) return "";
    if (!b.prReady) return `<div class="pr-bar muted"><span class="pr-bar-note">Checking for a pull request…</span></div>`;
    if (!b.pr) return `<div class="pr-bar muted"><span class="pr-bar-note">No pull request on this worktree.</span></div>`;
    const pr = b.pr;
    const chk = pr.merged ? "chk-merged" : `chk-${pr.checks || "none"}`;
    const review = pr.review || "none";
    const comments = pr.comments || 0;
    const sub = pr.merged
      ? `<span class="rev-merged">Merged</span>`
      : `<span class="rev-${review}">${esc(REVIEW_LABEL[review] || review)}</span> · ${comments} comment${comments === 1 ? "" : "s"}`;
    const badge = pr.merged
      ? `<span class="prbadge static"><i class="dot chk-merged"></i><span class="num">merged</span></span>`
      : `<span class="prbadge static"><i class="dot ${chk}"></i><span class="num">${pr.checksPass || 0}/${pr.checksTotal || 0}</span></span>`;
    return `<div class="pr-bar" data-pr="${esc(b.__path)}" title="Open PR #${pr.number} detail">
      <span class="chip" style="--ac:${checkColor(pr)}"></span>
      <div class="pr-bar-main">
        <div class="nm"><span class="pnum">#${pr.number}</span> ${esc(pr.title)}${pr.merged ? ` ${mergedTag(pr)}` : pr.draft ? ` <span class="draft">draft</span>` : ""}</div>
        <div class="sub">${sub}</div>
      </div>
      ${badge}
      <span class="pr-bar-link">View PR →</span>
    </div>`;
  }

  function renderAgents(view) {
    const p = projectByName(nav.project);
    if (!p) { nav = { project: null, worktree: null, pr: null }; return renderProjects(view); }
    const wt = p.worktrees.find((w) => w.path === nav.worktree);
    if (!wt) { nav = { project: nav.project, worktree: null, pr: null }; return renderWorktrees(view); }
    const list = agentsInWorktree(nav.worktree);
    const board = boardFor(nav.worktree);
    if (board) board.__path = nav.worktree;

    // toolbar above the table: the worktree's run/wait/err plus the two actions
    // for this checkout — add a dev here, or mount it as the selected directory
    const toolbar = `<div class="wt-toolbar">
      <div class="wt-meta"><span class="wt-label">${esc(wtLabel(wt))}</span>${countsCell(list)}</div>
      ${wtActions(p, wt)}
    </div>`;

    const body = list.length
      ? `<table class="tbl"><thead>${AGENT_HEAD}</thead><tbody>${list.map(agentRowHtml).join("")}</tbody></table>`
      : `<div class="empty inline"><div class="big">No agents in this worktree</div><div class="small">Add one with the “+ Add agent” button above.</div></div>`;
    view.innerHTML = toolbar + prBar(board) + body;
    wireAgentActions(view);
    view.querySelectorAll(".pr-bar[data-pr]").forEach((el) => el.addEventListener("click", () => { nav = { project: nav.project, worktree: nav.worktree, pr: el.dataset.pr }; render(); }));
  }

  // All-agents tab: every agent in one view, grouped by project → worktree so you
  // can still tell which checkout each one lives in.
  function renderAllAgents(view) {
    const groups = [];
    for (const p of buildProjects()) {
      for (const wt of p.worktrees) {
        const list = agentsInWorktree(wt.path);
        if (list.length) groups.push({ p, wt, list });
      }
    }
    if (!groups.length) {
      view.innerHTML = `<div class="empty"><div class="big">No agents running</div><div class="small">Spawn a dev in the tower (or with “+ Add agent”) and it’ll show up here.</div></div>`;
      return;
    }
    view.innerHTML = groups.map(({ p, wt, list }) => `<div class="agroup">
      <div class="agroup-head">
        <div class="agroup-title"><span class="ap">${esc(p.name)}</span><span class="gsep">/</span><span class="aw">${esc(wtLabel(wt))}</span></div>
        <div class="agroup-meta">${countsCell(list)}${wtActions(p, wt)}</div>
      </div>
      <table class="tbl"><thead>${AGENT_HEAD}</thead><tbody>${list.map(agentRowHtml).join("")}</tbody></table>
    </div>`).join("");
    wireAgentActions(view);
  }

  // All-PRs tab: every worktree that has an open PR, in one table. Clicking a row
  // drills into the same PR detail the projects tab uses.
  function renderAllPrs(view) {
    const rows = [];
    for (const p of buildProjects()) {
      for (const wt of p.worktrees) {
        const b = boardFor(wt.path);
        if (b && b.pr) { b.__path = wt.path; rows.push({ p, wt, b }); }
      }
    }
    if (!rows.length) {
      const hint = prConnected
        ? "No open pull requests on any worktree yet."
        : "Connect GitHub in the tower's settings to load pull requests.";
      view.innerHTML = `<div class="empty"><div class="big">No PRs</div><div class="small">${hint}</div></div>`;
      return;
    }
    // newest PRs first so the freshest work is at the top
    rows.sort((a, b) => (b.b.pr.number || 0) - (a.b.pr.number || 0));
    const rowsHtml = rows.map(({ p, wt, b }) => {
      const pr = b.pr;
      const chk = pr.merged ? "chk-merged" : `chk-${pr.checks || "none"}`;
      const review = pr.review || "none";
      const checksCell = pr.merged
        ? `<span class="prbadge static"><i class="dot chk-merged"></i><span class="num">merged</span></span>`
        : `<span class="prbadge static"><i class="dot ${chk}"></i><span class="num">${pr.checksPass || 0}/${pr.checksTotal || 0}</span></span>`;
      const reviewCell = pr.merged ? `<span class="rev-merged">Merged</span>` : `<span class="rev-${review}">${esc(REVIEW_LABEL[review] || review)}</span>`;
      return `<tr class="row" data-pr="${esc(wt.path)}" data-project="${esc(p.name)}">
        <td class="col-name"><div class="namecell"><span class="chip" style="--ac:${checkColor(pr)}" title="${pr.merged ? "Merged" : "CI " + esc(pr.checks || "none")}"></span><div style="min-width:0"><div class="nm"><span class="pnum">#${pr.number}</span> ${esc(pr.title)}${pr.merged ? ` ${mergedTag(pr)}` : pr.draft ? ` <span class="draft">draft</span>` : ""}</div><div class="sub">${esc(p.name)} · ${esc(wtLabel(wt))}</div></div></div></td>
        <td>${checksCell}</td>
        <td>${reviewCell}</td>
        <td class="num">${pr.comments || 0}</td>
      </tr>`;
    }).join("");
    view.innerHTML = `<table class="tbl"><thead><tr>
      <th class="col-name">Pull request</th><th>Checks</th><th>Review</th><th class="num">Comments</th>
    </tr></thead><tbody>${rowsHtml}</tbody></table>`;
    view.querySelectorAll("tr.row").forEach((tr) => tr.addEventListener("click", () => {
      tab = "projects";
      nav = { project: tr.dataset.project, worktree: tr.dataset.pr, pr: tr.dataset.pr };
      render();
    }));
  }

  function renderPr(view) {
    const b = boardFor(nav.pr);
    if (!b || !b.pr) { nav.pr = null; return render(); }
    const pr = b.pr;
    const checks = pr.checks || "none";
    const review = pr.review || "none";
    const reviewLabel = REVIEW_LABEL[review] || review;
    view.innerHTML = `<div class="pr-detail"><div class="pr-card">
      <h2><span class="pnum">#${pr.number}</span> <span>${esc(pr.title)}</span>${pr.merged ? ` ${mergedTag(pr)}` : ""}</h2>
      <div class="pr-sub">${esc(wtLabel({ path: nav.pr, branch: b.branch }))}${pr.merged ? " · merged" : pr.draft ? " · draft" : ""}</div>
      <div class="pr-grid">
        <div class="pr-stat"><div class="k">Checks</div><div class="v"><i class="dot chk-${checks}" style="width:9px;height:9px;border-radius:50%"></i>${checks === "none" ? "None" : checks[0].toUpperCase() + checks.slice(1)}</div></div>
        <div class="pr-stat"><div class="k">Check runs</div><div class="v">${pr.checksPass || 0}<small>/ ${pr.checksTotal || 0} passing</small></div><div class="subline"><b>${pr.checksFailed || 0}</b> failed · <b>${pr.checksRunning || 0}</b> running</div></div>
        <div class="pr-stat"><div class="k">Review</div><div class="v rev-${review}">${esc(reviewLabel)}</div></div>
        <div class="pr-stat"><div class="k">Reviewers</div><div class="v">${pr.approvals || 0}<small>approved</small></div><div class="subline"><b>${pr.changesRequested || 0}</b> changes · <b>${pr.reviewersPending || 0}</b> pending</div></div>
        <div class="pr-stat"><div class="k">Comments</div><div class="v">${pr.comments || 0}</div></div>
      </div>
      <button class="ghbtn" id="gh" data-url="${esc(pr.url)}">Open on GitHub ↗</button>
    </div></div>`;
    const gh = $("#gh");
    if (gh) gh.addEventListener("click", () => vscode.postMessage({ type: "openPr", url: gh.dataset.url }));
  }

  /* ---------- tabs + breadcrumbs + telemetry ---------- */
  function renderTabs() {
    const el = $("#tabs");
    if (el) el.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  }

  function renderCrumbs() {
    const el = $("#crumbs");
    if (tab !== "projects") { el.innerHTML = ""; return; } // the tab label says it all
    const crumbs = [];
    const lvl = level();
    crumbs.push({ label: "Projects", to: { project: null, worktree: null, pr: null }, here: lvl === "projects" });
    if (nav.project) crumbs.push({ label: nav.project, to: { project: nav.project, worktree: null, pr: null }, here: lvl === "worktrees" });
    if (nav.worktree) {
      const p = projectByName(nav.project);
      const w = p && p.worktrees.find((x) => x.path === nav.worktree);
      crumbs.push({ label: w ? wtLabel(w) : basename(nav.worktree), to: { project: nav.project, worktree: nav.worktree, pr: null }, here: lvl === "agents" });
    }
    if (nav.pr) { const b = boardFor(nav.pr); crumbs.push({ label: b && b.pr ? "PR #" + b.pr.number : "PR", to: null, here: true }); }
    el.innerHTML = crumbs.map((c, i) =>
      (i ? `<span class="crumb-sep">/</span>` : "") +
      `<span class="crumb${c.here ? " here" : ""}" data-i="${i}">${esc(c.label)}</span>`
    ).join("");
    el.querySelectorAll(".crumb").forEach((node) => {
      const c = crumbs[+node.dataset.i];
      if (c.to && !c.here) node.addEventListener("click", () => { nav = c.to; render(); });
    });
  }

  function renderTelemetry() {
    const c = stateCounts(agents);
    $("#t-active").textContent = c.active;
    $("#t-waiting").textContent = c.waiting;
    $("#t-error").textContent = c.error;
    $("#t-crew").textContent = agents.length;
  }

  // persistent "selected directory" indicator in the subbar — shown on every page
  // so you always know which worktree is mounted. Clicking it jumps to that worktree.
  function renderSelDir() {
    const el = $("#seldir");
    if (!el) return;
    if (!usedDir) {
      el.className = "seldir none";
      el.removeAttribute("data-wt");
      el.innerHTML = `<span class="seldir-label">Selected dir</span><span class="seldir-val muted">none</span>`;
      return;
    }
    let label = basename(usedDir), proj = "";
    for (const p of buildProjects()) {
      const w = p.worktrees.find((x) => x.path === usedDir);
      if (w) { label = wtLabel(w); proj = p.name; break; }
    }
    el.className = "seldir";
    el.dataset.wt = usedDir;
    el.title = `Selected directory: ${usedDir}`;
    el.innerHTML = `<span class="seldir-label">Selected dir</span>` +
      `<span class="seldir-val">${proj ? `<b>${esc(proj)}</b> · ` : ""}${esc(label)}</span>` +
      `<span class="seldir-path">${esc(usedDir)}</span>`;
  }

  /* ---------- main render ---------- */
  function render() {
    renderTabs();
    renderCrumbs();
    renderTelemetry();
    renderSelDir();
    const view = $("#view");
    if (tab === "agents") return renderAllAgents(view);
    if (tab === "prs") return renderAllPrs(view);
    const lvl = level();
    if (lvl === "pr") return renderPr(view);
    if (lvl === "agents") return renderAgents(view);
    if (lvl === "worktrees") return renderWorktrees(view);
    return renderProjects(view);
  }

  // After fresh data, drop into the nearest still-valid level so a removed
  // worktree/project never leaves a broken table.
  function reconcileNav() {
    if (nav.project && !projectByName(nav.project)) { nav = { project: null, worktree: null, pr: null }; return; }
    if (nav.worktree) {
      const p = projectByName(nav.project);
      if (!p || !p.worktrees.some((w) => w.path === nav.worktree)) { nav.worktree = null; nav.pr = null; return; }
    }
    if (nav.pr) { const b = boardFor(nav.pr); if (!b || !b.pr) nav.pr = null; }
  }

  // The host re-posts the SAME state/prs payload on any view-state change —
  // including the focus the webview gains from your very first click while it is
  // still unfocused (it opens with preserveFocus). That re-post rebuilds the
  // table via innerHTML, swapping out the <tr> your mousedown landed on, so the
  // mouseup never completes a click and the first click appears to do nothing.
  // Drop identical re-posts so a focus-only change never rebuilds the DOM mid-click.
  let lastStateJson = null, lastPrsJson = null;

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === "state") {
      const json = JSON.stringify(m);
      if (json === lastStateJson) return; // no real change (e.g. focus) — keep the DOM stable
      lastStateJson = json;
      agents = m.agents || [];
      rooms = m.rooms || [];
      boards = m.boards || {};
      usedDir = m.usedDir || null;
      selectedId = m.selectedId || null;
      // absent (e.g. in the screenshot harness) → treat the tower as available
      towerOpen = m.towerOpen !== false;
      reconcileNav();
      render();
    } else if (m.type === "prs") {
      const json = JSON.stringify(m);
      if (json === lastPrsJson) return; // identical re-post (focus change) — don't rebuild
      lastPrsJson = json;
      prConnected = !!m.connected;
      // PR specifics live on each board; this just keeps the connected flag fresh
      render();
    }
  });

  document.querySelectorAll("#tabs .tab").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; render(); }));
  // dismiss the task tooltip as soon as the table scrolls out from under it
  $("#view")?.addEventListener("scroll", hideTip, { passive: true });
  // click the selected-directory indicator to jump to that worktree's view
  $("#seldir")?.addEventListener("click", () => {
    const wt = $("#seldir")?.dataset.wt;
    if (!wt) return;
    const p = buildProjects().find((x) => x.worktrees.some((w) => w.path === wt));
    if (!p) return;
    tab = "projects";
    nav = { project: p.name, worktree: wt, pr: null };
    render();
  });

  render();
  vscode.postMessage({ type: "ready" });
})();
