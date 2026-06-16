/* DevTower console — pixel scene + glass HUD.
   The agent's NATIVE terminal (auto-attached `claude --resume`) is the chat;
   the panel is a compact stats card: context %, model, plus PR actions. */
(function () {
  const vscode = acquireVsCodeApi();
  // forward uncaught webview errors to the extension's always-on errors.log so a
  // blank/blacked-out scene can be diagnosed later. The early inline script in
  // the page buffers anything thrown before this point; flush it now.
  window.__dtSendError = (rec) => { try { vscode.postMessage({ type: "error", ...rec }); } catch (_) {} };
  if (Array.isArray(window.__dtErrors)) { for (const r of window.__dtErrors.splice(0)) window.__dtSendError(r); }
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const STATE_LABEL = { active: "Active", waiting: "Awaiting input", complete: "Complete", error: "Error", idle: "Idle" };
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

  let agents = [], selectedId = null, theme = "dark", panelOpen = false;
  let lastHostSel = null; // last selectedId the host posted, so we adopt a CHANGE (not every repeat)
  let panelSig = ""; // fingerprint of the open panel, so polls don't rebuild (flash) it
  let firstState = true;
  let prs = { crew: [], review: [] };
  const prevStates = new Map();
  const get = (id) => agents.find((a) => a.id === id);
  const repos = () => [...new Set(agents.map((a) => a.repo))];

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const hueOf = (id) => hash(id) % 360;

  /* ---------- 3D scene ---------- */
  function mountCrew() {
    if (!window.DevTowerCrew) return;
    window.DevTowerCrew.mount($("#crew-wrap"), $("#crew-canvas"));
    window.DevTowerCrew.onSelect((id) => selectAgent(id, true));
    // clicking off an agent (empty space or another room) closes its stat panel
    if (DevTowerCrew.onDeselect) DevTowerCrew.onDeselect(() => { if (panelOpen) closePanel(); });
    if (DevTowerCrew.onPickRoom) DevTowerCrew.onPickRoom((room) => vscode.postMessage({ type: "pickRoom", room }));
    if (DevTowerCrew.onUseDir) DevTowerCrew.onUseDir((room) => vscode.postMessage({ type: "useDir", room }));
    window.DevTowerCrew.onReserve((floor, col) => vscode.postMessage({ type: "reserveRoom", floor, col }));
    window.DevTowerCrew.onAddDev((island, worktree) => vscode.postMessage({ type: "addDev", island, worktree }));
    window.DevTowerCrew.onAddWorktree((island) => vscode.postMessage({ type: "addWorktree", island }));
    window.DevTowerCrew.onRemoveRoom((room) => vscode.postMessage({ type: "removeRoom", room }));
    window.DevTowerCrew.onRemoveWorktree((worktree, island) => vscode.postMessage({ type: "removeWorktree", worktree, island }));
    window.DevTowerCrew.onPush((room) => vscode.postMessage({ type: "pushBranch", room }));
    window.DevTowerCrew.onPull((room) => vscode.postMessage({ type: "pullBranch", room }));
    window.DevTowerCrew.onFetch((room) => vscode.postMessage({ type: "fetchBranch", room }));
    window.DevTowerCrew.onCd((id, target) =>
      vscode.postMessage({ type: "cdAgent", id, room: target.room, ghost: target.ghost })
    );
    window.DevTowerCrew.onOpenPr((url) => vscode.postMessage({ type: "action", act: "openPr", url }));
    if (DevTowerCrew.onDebug) DevTowerCrew.onDebug((event, data) => vscode.postMessage({ type: "debug", event, data }));
    window.DevTowerCrew.start();
  }

  function pushCrew() {
    if (!window.DevTowerCrew) return;
    window.DevTowerCrew.setAgents(agents.map((a) => ({ id: a.id, name: a.name, state: a.state, repo: a.repo, model: a.model, worktree: a.worktree, branch: a.branch, skills: a.skills, subagents: a.subagents, exploring: a.exploring, tasks: a.tasks, contextTokens: a.contextTokens, external: a.external, session: a.transcriptPath ? a.transcriptPath.replace(/\\/g, "/").split("/").pop().replace(/\.jsonl$/, "") : undefined, launchId: a.launchId, terminalPid: a.terminalPid, clearedSession: a.clearedSession, reviewOf: a.reviewOf, reviewVerdict: a.reviewVerdict })));
    window.DevTowerCrew.setSelected(selectedId);
  }

  function updateInsets() {
    if (!window.DevTowerCrew) return;
    window.DevTowerCrew.setInsets(0, panelOpen ? 392 : 0);
  }

  /* ---------- selection ---------- */
  // Clear any actionable "has a question" toast for this agent — whether the user
  // acted on the toast itself or just clicked the dev on the canvas/leaderboard,
  // the notification has served its purpose and shouldn't linger.
  function dismissAgentFeed(id) {
    const feed = $("#feed");
    if (!feed) return;
    feed.querySelectorAll('.feed-item.actionable[data-agent-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]').forEach((el) => {
      el.classList.add("expire");
      setTimeout(() => el.remove(), 600);
    });
  }

  function selectAgent(id, open) {
    dismissAgentFeed(id);
    selectedId = id;
    vscode.postMessage({ type: "select", id }); // reveals the agent's terminal
    if (window.DevTowerCrew) {
      window.DevTowerCrew.setSelected(id);
      // a direct canvas tap zooms via its own hit-test; selections that come
      // from elsewhere (the "View agent" toast, leaderboard, host) must request
      // the same tight dev zoom or the camera is left at whatever overview/tower
      // view it was on.
      if (open && window.DevTowerCrew.focusAgent) window.DevTowerCrew.focusAgent(id);
    }
    if (open) panelOpen = true;
    updateInsets();
    renderPanel();
  }

  // Closing the panel via its ✕ / Esc (not by clicking off the dev on the
  // canvas, which already retargets the camera): pull back from the tight dev
  // zoom to an overview of their room before tearing the panel down.
  function closePanelToRoom() {
    if (window.DevTowerCrew && window.DevTowerCrew.zoomOutToAgentRoom)
      window.DevTowerCrew.zoomOutToAgentRoom();
    closePanel();
  }

  function closePanel() {
    panelOpen = false;
    panelSig = ""; // force a fresh build (and re-wire) on the next open
    $("#panel").hidden = true;
    if (window.DevTowerCrew) window.DevTowerCrew.setSelected(undefined);
    selectedId = null;
    updateInsets();
  }

  /* ---------- telemetry ---------- */
  function renderTelemetry() {
    const c = (s) => agents.filter((a) => a.state === s).length;
    $("#t-active").textContent = c("active");
    $("#t-waiting").textContent = c("waiting");
    $("#t-error").textContent = c("error");
    $("#devtower-count").textContent = agents.length;
  }

  // The selected directory (the room a USE DIR click mounted), shown under the
  // telemetry pill. Long paths are truncated from the LEFT with a leading … so
  // the meaningful tail (the worktree folder) stays visible; full path on hover.
  function renderSelDir(dir) {
    const wrap = $("#seldir");
    const el = $("#seldir-path");
    if (!wrap || !el) return;
    if (!dir) { wrap.hidden = true; el.textContent = ""; wrap.removeAttribute("title"); return; }
    const MAX = 44;
    wrap.hidden = false;
    wrap.title = dir;
    el.textContent = dir.length > MAX ? "…" + dir.slice(dir.length - (MAX - 1)) : dir;
  }

  /* ---------- plan usage meters (5h / weekly) ---------- */
  function fmtReset(ts) {
    if (!ts) return "";
    const secs = ts - Math.floor(Date.now() / 1000);
    if (secs <= 0) return " · resetting";
    const h = Math.floor(secs / 3600);
    if (h >= 24) {
      const d = Math.floor(h / 24);
      return ` · resets in ${d}d ${h % 24}h`;
    }
    const m = Math.floor((secs % 3600) / 60);
    return h >= 1 ? ` · resets in ${h}h ${m}m` : ` · resets in ${m}m`;
  }
  // Compact form for the inline meter chip (no "resets in" prefix). Rolls into
  // days once the window is more than a day out (the weekly window) so it reads
  // "1d 2h" instead of "26h 11m".
  function fmtResetShort(ts) {
    if (!ts) return "";
    const secs = ts - Math.floor(Date.now() / 1000);
    if (secs <= 0) return "now";
    const h = Math.floor(secs / 3600);
    if (h >= 24) {
      const d = Math.floor(h / 24);
      return `${d}d ${h % 24}h`;
    }
    const m = Math.floor((secs % 3600) / 60);
    return h >= 1 ? `${h}h ${m}m` : `${m}m`;
  }
  function setMeter(sel, label, w) {
    const el = $(sel);
    if (!el) return;
    const has = w && typeof w.pct === "number";
    el.style.display = has ? "" : "none";
    if (!has) return;
    const pct = w.pct;
    el.querySelector(".ubar i").style.width = pct + "%";
    el.querySelector(".upct").textContent = pct + "%";
    const reset = fmtResetShort(w.resetsAt);
    const rEl = el.querySelector(".ureset");
    if (rEl) {
      rEl.textContent = reset ? `↻ ${reset}` : "";
      rEl.style.display = reset ? "" : "none";
    }
    el.classList.toggle("warn", pct >= 75 && pct < 90);
    el.classList.toggle("crit", pct >= 90);
    el.title = `Plan usage — ${label} window: ${pct}% used${fmtReset(w.resetsAt)}`;
  }
  function renderUsage(u) {
    const wrap = $("#usage");
    if (!wrap) return;
    const any = u && (u.fiveHour || u.sevenDay);
    wrap.hidden = !any;
    if (!any) return;
    setMeter("#u-5h", "5-hour", u.fiveHour);
    setMeter("#u-wk", "weekly", u.sevenDay);
  }

  /* ---------- arrivals / departures feed ---------- */
  // opts.agentId makes the toast actionable: a "View agent" button (zooms to the
  // dev and opens its panel) plus an "✕" to dismiss. Every toast — actionable or
  // not — fades out on its own after a few seconds; actionable ones linger a
  // little longer so there's time to click them. At most two actionable toasts
  // are shown at once; older ones are dropped so questions don't pile up.
  const ACTIONABLE_MAX = 2;
  function pushFeed(html, color, opts) {
    opts = opts || {};
    const feed = $("#feed");
    const el = document.createElement("div");
    el.className = "feed-item";
    el.style.setProperty("--c", color);
    if (opts.agentId) {
      el.classList.add("actionable");
      el.dataset.agentId = opts.agentId; // so selecting the agent elsewhere can dismiss it
      el.innerHTML =
        `<div class="feed-msg">${html}</div>` +
        `<div class="feed-actions">` +
          `<button class="fa-btn fa-view" type="button">View agent</button>` +
          `<button class="fa-btn fa-x" type="button" title="Dismiss" aria-label="Dismiss">✕</button>` +
        `</div>`;
      const remove = () => { el.classList.add("expire"); setTimeout(() => el.remove(), 600); };
      $(".fa-view", el).onclick = () => { selectAgent(opts.agentId, true); remove(); };
      $(".fa-x", el).onclick = remove;
      // cap the number of actionable toasts: drop the oldest so adding this one
      // leaves at most ACTIONABLE_MAX on screen.
      const live = feed.querySelectorAll(".feed-item.actionable");
      for (let i = 0; i <= live.length - ACTIONABLE_MAX; i++) live[i].remove();
    } else {
      el.innerHTML = html;
    }
    feed.appendChild(el);
    while (feed.children.length > 5) feed.removeChild(feed.firstChild);
    const life = opts.agentId ? 9000 : 6500; // actionable toasts stay up a touch longer
    setTimeout(() => el.classList.add("expire"), life);
    setTimeout(() => el.remove(), life + 800);
  }

  function diffCrew(next) {
    if (firstState) {
      next.forEach((a) => prevStates.set(a.id, a.state));
      firstState = false;
      return;
    }
    const nextIds = new Set(next.map((a) => a.id));
    for (const [id] of prevStates) {
      if (!nextIds.has(id)) {
        const old = agents.find((a) => a.id === id);
        pushFeed(`<span class="fi">◂</span><b>${esc(old?.name || id)}</b> left<span class="repo">${esc(old?.repo || "")}</span>`, "var(--idle)");
        prevStates.delete(id);
      }
    }
    for (const a of next) {
      const prev = prevStates.get(a.id);
      if (prev === undefined) {
        pushFeed(`<span class="fi">▸</span><b>${esc(a.name)}</b> joined<span class="repo">${esc(a.repo)}</span>`, "var(--active)");
      } else if (prev !== a.state) {
        if (a.state === "waiting") pushFeed(`<span class="fi">?</span><b>${esc(a.name)}</b> has a question<span class="repo">${esc(a.repo)}</span>`, "var(--waiting)", { agentId: a.id });
        else if (a.state === "error") pushFeed(`<span class="fi">✗</span><b>${esc(a.name)}</b> hit an error<span class="repo">${esc(a.repo)}</span>`, "var(--error)");
        else if (a.state === "complete") pushFeed(`<span class="fi">✓</span><b>${esc(a.name)}</b> finished<span class="repo">${esc(a.repo)}</span>`, "var(--complete)");
      }
      prevStates.set(a.id, a.state);
    }
  }

  /* ---------- settings overlay (tabbed: General / Hooks / GitHub) ---------- */
  let settings = null; // last { caps, scopeHelp } pushed by the extension
  let hooks = null; // last [{ id, label, description, installed }] pushed by the extension
  let settingsTab = "general"; // active left-rail tab
  const SETTINGS_TABS = [
    { id: "general", label: "General" },
    { id: "hooks", label: "Hooks" },
    { id: "github", label: "GitHub" },
    { id: "debug", label: "Debug" },
  ];
  function settingsOpen() { return !$("#settings").hidden; }
  function closeSettings() { const s = $("#settings"); s.hidden = true; s.innerHTML = ""; }
  function openSettings() {
    const s = $("#settings");
    s.hidden = false;
    renderSettings(); // render immediately (cached), then refresh from the host
    vscode.postMessage({ type: "getSettings" });
    vscode.postMessage({ type: "getHooks" });
  }

  /* ---------- token leaderboard modal ---------- */
  // a readable, full board of every agent ranked by context-window usage. It
  // replaced the cramped plaque that used to hang on the room wall. Clicking a
  // row zooms the camera onto that dev (and opens its stats panel).
  const fmtTokens = (n) =>
    !n ? "0"
      : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M"
      : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "k"
      : String(n);
  const modelLabel = (m) => (m || "—").replace(/^claude-/, "").replace(/-/g, " ");
  // compact status labels for the leaderboard's narrow Status column ("Awaiting
  // input" would overflow into Model); falls back to the shared STATE_LABEL.
  const LB_STATE_LABEL = { active: "Active", waiting: "Awaiting", complete: "Complete", error: "Error", idle: "Idle" };

  // coalesce bursty state updates (git/PR/usage polls all repost state) into one
  // repaint per frame, and skip the repaint entirely when nothing visible moved -
  // that, not the FLIP, is what made the open board churn on every poll
  let lbRaf = 0;
  let lbSig = "";
  let lbOrder = ""; // last painted rank order; FLIP only runs when this changes
  function scheduleLeaderboard() {
    if (lbRaf || !leaderboardOpen()) return;
    lbRaf = requestAnimationFrame(() => { lbRaf = 0; syncLeaderboard(); });
  }

  function leaderboardOpen() { return !$("#leaderboard").hidden; }
  function closeLeaderboard() {
    const s = $("#leaderboard");
    s.hidden = true; s.innerHTML = "";
    if (lbRaf) { cancelAnimationFrame(lbRaf); lbRaf = 0; }
    lbSig = "";
    lbOrder = "";
  }
  function openLeaderboard() {
    const s = $("#leaderboard");
    s.hidden = false;
    // build the chrome ONCE; the row list is patched in place on every poll so it
    // never flickers (rebuilding innerHTML each update tore down and re-created
    // every node, which flashed even when nothing actually moved)
    s.innerHTML = `
      <div class="lb-card">
        <button class="lb-close" id="lb-close" title="Close (Esc)">✕</button>
        <h2>Token leaderboard <span class="lb-count" id="lb-count"></span></h2>
        <div class="lb-sub">All crew ranked by context-window usage. Click an agent to zoom to them.</div>
        <div class="lb-head">
          <span class="lb-rank">#</span><span class="lb-dot"></span>
          <span class="lb-id">Agent</span><span class="lb-state">Status</span><span class="lb-model">Model</span>
          <span class="lb-bar">Context</span><span class="lb-pct"></span><span class="lb-tok">Tokens</span>
        </div>
        <div class="lb-list"></div>
      </div>`;
    $("#lb-close", s).onclick = closeLeaderboard;
    s.onclick = (e) => { if (e.target === s) closeLeaderboard(); }; // backdrop closes
    syncLeaderboard();
  }

  function makeLbRow(id) {
    const el = document.createElement("button");
    el.className = "lb-row";
    el.dataset.id = id;
    el.innerHTML =
      `<span class="lb-rank"></span><span class="lb-dot"></span>` +
      `<span class="lb-id"><b></b><small></small></span>` +
      `<span class="lb-state"><i></i><em></em></span><span class="lb-model"></span>` +
      `<span class="lb-bar"><i></i></span><span class="lb-pct"></span><span class="lb-tok"></span>`;
    el.onclick = () => { selectAgent(id, true); closeLeaderboard(); }; // zoom + open panel
    return el;
  }

  // briefly highlight a value cell when it changes; remove + reflow + re-add so a
  // rapid second change restarts the animation instead of being ignored
  function flashValue(el, dir) {
    el.classList.remove("up", "dn");
    void el.offsetWidth; // force reflow so the animation can re-trigger
    el.classList.add(dir);
  }

  // patch a row's cells in place (no teardown) so live token updates don't flash
  function paintLbRow(el, a, i) {
    const pct = contextOf(a); // 0..100, or null when no tokens yet
    const rank = el.querySelector(".lb-rank");
    rank.textContent = i + 1;
    rank.className = "lb-rank" + (i < 3 ? " m" + i : "");
    el.querySelector(".lb-dot").style.background = `hsl(${hueOf(a.id)} 45% 52%)`;
    el.querySelector(".lb-id b").textContent = a.name || "agent";
    el.querySelector(".lb-id small").textContent = a.repo || "";
    const stateEl = el.querySelector(".lb-state");
    stateEl.dataset.state = a.state || "idle";
    stateEl.querySelector("em").textContent = LB_STATE_LABEL[a.state] || a.state || "—";
    el.querySelector(".lb-model").textContent = modelLabel(a.model);
    const bar = el.querySelector(".lb-bar");
    bar.className = "lb-bar" + (pct == null ? "" : pct >= 80 ? " hot" : pct >= 60 ? " warm" : "");
    bar.querySelector("i").style.width = (pct == null ? 0 : pct) + "%";
    el.querySelector(".lb-pct").textContent = pct == null ? "—" : pct + "%";
    // tokens: flash the value when it changes (green up / red down), mirroring the
    // tower board's stat glow. The first paint of a row seeds the baseline silently.
    const tok = a.contextTokens ?? 0;
    const tokEl = el.querySelector(".lb-tok");
    tokEl.textContent = fmtTokens(tok);
    if (el.dataset.tok !== undefined) {
      const prev = Number(el.dataset.tok);
      if (tok > prev) flashValue(tokEl, "up");
      else if (tok < prev) flashValue(tokEl, "dn");
    }
    el.dataset.tok = tok;
    el.classList.toggle("sel", a.id === selectedId);
    el.title = "Zoom to " + (a.name || "agent");
  }

  function syncLeaderboard() {
    const s = $("#leaderboard");
    if (s.hidden) return;
    const list = $(".lb-list", s);
    if (!list) return;
    // every agent, biggest context first (zero-token devs sink to the bottom)
    const ranked = agents.slice().sort((x, y) => (y.contextTokens ?? 0) - (x.contextTokens ?? 0));

    // live crew count in the title (e.g. "12 agents")
    const countEl = $("#lb-count", s);
    if (countEl) countEl.textContent = ranked.length === 1 ? "1 agent" : ranked.length + " agents";

    // bail when nothing the board shows actually changed. Most state posts are
    // unrelated polls (git stats, PRs, usage) carrying identical token data;
    // repainting every row + remeasuring layout on those is what flashed.
    const sig = ranked
      .map((a) => `${a.id}:${a.contextTokens ?? 0}:${a.state || ""}:${a.model || ""}:${a.name || ""}:${a.repo || ""}:${a.id === selectedId ? 1 : 0}`)
      .join("|");
    if (sig === lbSig) return;
    lbSig = sig;

    if (!ranked.length) {
      if (!list.querySelector(".lb-empty")) list.innerHTML = `<div class="lb-empty">No agents yet.</div>`;
      return;
    }
    const empty = list.querySelector(".lb-empty");
    if (empty) empty.remove();

    // index the rows that already exist, keyed by agent id
    const existing = new Map();
    list.querySelectorAll(".lb-row").forEach((el) => existing.set(el.dataset.id, el));

    // fast path: ranks unchanged (the common case — tokens tick up without
    // reordering). Patch cells in place and skip the FLIP entirely; its forced
    // reflow + transform reset on every row is what still flickered on value-only
    // updates. Only reorders (new/gone agent, rank swap) need the slide.
    const order = ranked.map((a) => a.id).join(",");
    if (order === lbOrder && existing.size === ranked.length) {
      ranked.forEach((a, i) => paintLbRow(existing.get(a.id), a, i));
      return;
    }
    lbOrder = order;
    // FLIP "first": each surviving row's CURRENT on-screen y (a row still sliding
    // from a prior update reports its mid-animation position here, so an
    // interrupted slide continues from where it is instead of snapping/jittering)
    const firstTop = new Map();
    existing.forEach((el, id) => firstTop.set(id, el.getBoundingClientRect().top));

    // update + reappend in rank order (appendChild moves an existing node, so the
    // list ends up in the new order without ever being emptied)
    const seen = new Set();
    ranked.forEach((a, i) => {
      let el = existing.get(a.id);
      const isNew = !el;
      if (isNew) el = makeLbRow(a.id);
      paintLbRow(el, a, i);
      list.appendChild(el);
      if (isNew) el.classList.add("lb-enter"); // fade the freshly added row in
      seen.add(a.id);
    });
    // drop rows for agents that are gone
    existing.forEach((el, id) => { if (!seen.has(id)) el.remove(); });

    // FLIP "last": freeze every row to its settled layout (kill any in-flight
    // transform) before measuring, so the target y is the true final position
    const survivors = ranked.map((a) => existing.get(a.id)).filter(Boolean);
    survivors.forEach((el) => { el.style.transition = "none"; el.style.transform = "none"; });
    const lastTop = new Map();
    survivors.forEach((el) => lastTop.set(el.dataset.id, el.getBoundingClientRect().top));

    // invert (jump each moved row back to where it visually was) then release, so
    // a rank change slides smoothly even mid-flight from the previous update
    survivors.forEach((el) => {
      const dy = firstTop.get(el.dataset.id) - lastTop.get(el.dataset.id);
      if (!dy) return;
      el.style.transform = `translateY(${dy}px)`;
      el.getBoundingClientRect(); // force reflow so the jump is applied first
      el.style.transition = "transform .34s cubic-bezier(.2,.8,.3,1)";
      el.style.transform = "none";
    });
  }

  // ---- GitHub tab ----
  function githubPaneHTML() {
    const caps = settings?.caps;
    let status;
    if (!caps || !caps.connected) {
      status = caps?.error
        ? `<div class="s-status err"><b>Not connected.</b> ${esc(caps.error)}</div>`
        : `<div class="s-status idle">No token set. Add one below to show your PRs and checks.</div>`;
    } else {
      const feats = (caps.features || []).map((f) =>
        `<li class="${f.enabled ? "on" : "off"}" title="${esc(f.why)}">
           <span class="fmark">${f.enabled ? "✓" : "✕"}</span>
           <span class="flabel">${esc(f.label)}</span>
           <span class="fscope">${esc(f.scope)}</span>
         </li>`).join("");
      const scopeline = caps.tokenType === "fine-grained"
        ? "fine-grained token"
        : `scopes: ${caps.scopes && caps.scopes.length ? esc(caps.scopes.join(", ")) : "none"}`;
      status = `<div class="s-status ok">
          <div class="s-status-info">
            <b>Connected as ${esc(caps.login || "?")}</b>
            <span class="s-ttype">${esc(scopeline)}</span>
          </div>
          <button class="s-clear" id="s-clear" title="Remove this token">Remove</button>
        </div>
        <ul class="s-feats">${feats}</ul>`;
    }
    return `
      <h3>GitHub access</h3>
      <p class="s-desc">DevTower reads your pull requests and CI checks through the GitHub API using a
        Personal Access Token. The token is stored in VS Code SecretStorage, used only by the extension
        (never your terminals or git), and never displayed back.</p>
      ${status}
      <div class="s-why">
        <div class="s-why-title">Create a token — pick one type</div>

        <div class="s-tok">
          <div class="s-tok-h"><span class="s-tok-name">Fine-grained</span><span class="s-tok-tag rec">recommended · read-only</span></div>
          <p>Limited to the repositories you choose. The link below pre-fills the name and most permissions:</p>
          <ul class="s-perms">
            <li>Pull requests: <b>Read</b></li>
            <li>Contents: <b>Read</b></li>
            <li>Commit statuses: <b>Read</b></li>
            <li>Checks: <b>Read</b> <span class="dim">— set this one by hand</span></li>
            <li class="dim">Metadata: Read (added automatically)</li>
          </ul>
          <a class="s-link" data-url="https://github.com/settings/personal-access-tokens/new?name=DevTower&description=DevTower%20PR%20%26%20checks%20viewer&contents=read&pull_requests=read&statuses=read">Create fine-grained token (name + perms pre-filled) ↗</a>
          <div class="s-note">Pick the repos under "Repository access", and add Checks: Read manually (GitHub doesn't allow it in the link).</div>
        </div>

        <div class="s-tok">
          <div class="s-tok-h"><span class="s-tok-name">Classic</span><span class="s-tok-tag">simpler · spans all orgs</span></div>
          <p>Broader (read+write across your repos), but one token reaches every org. Scopes:</p>
          <ul class="s-perms">
            <li><code>repo</code> — private PRs and CI checks</li>
            <li><code>read:org</code> — review requests across orgs</li>
          </ul>
          <a class="s-link" data-url="https://github.com/settings/tokens/new?scopes=repo,read:org&description=DevTower">Create classic token (scopes pre-filled) ↗</a>
        </div>
      </div>
      <div class="s-field">
        <input type="password" id="s-token" placeholder="ghp_… or github_pat_…" autocomplete="off" spellcheck="false" />
        <button class="s-save" id="s-save">Save token</button>
      </div>`;
  }

  // ---- General tab ----
  function generalPaneHTML() {
    return `
      <h3>General</h3>
      <div class="s-row">
        <div class="s-row-t">
          <div class="s-row-name">Performance</div>
          <div class="s-row-sub">Animation frame rate while the tower is moving. It still parks when nothing animates.</div>
        </div>
        <div class="s-seg" id="s-perf" role="radiogroup" aria-label="Performance mode">
          ${PERF_MODES.map((p) => `
            <button class="s-seg-btn ${perf === p.id ? "on" : ""}" data-perf="${p.id}" role="radio" aria-checked="${perf === p.id}">
              <span class="s-seg-name">${p.name}</span><span class="s-seg-fps">${p.fps} fps</span>
            </button>`).join("")}
        </div>
      </div>
      <div class="s-row">
        <div class="s-row-t">
          <div class="s-row-name">Projects shown</div>
          <div class="s-row-sub">Show every project you've added, or only the ones added from this workspace. Add a project here to associate it with this workspace.</div>
        </div>
        <div class="s-seg" id="s-scope" role="radiogroup" aria-label="Projects shown">
          ${SCOPE_MODES.map((p) => `
            <button class="s-seg-btn ${projectScope === p.id ? "on" : ""}" data-scope="${p.id}" role="radio" aria-checked="${projectScope === p.id}">
              <span class="s-seg-name">${p.name}</span>
            </button>`).join("")}
        </div>
      </div>
      <div class="s-row">
        <div class="s-row-t">
          <div class="s-row-name">Book preference</div>
          <div class="s-row-sub">Where devs get a book for each skill. Physical: walk to the bookshelf. Ebook: read on their phone at the desk.</div>
        </div>
        <div class="s-seg" id="s-books" role="radiogroup" aria-label="Book preference">
          ${BOOK_MODES.map((b) => `
            <button class="s-seg-btn ${bookMode === b.id ? "on" : ""}" data-book="${b.id}" role="radio" aria-checked="${bookMode === b.id}">
              <span class="s-seg-name">${b.name}</span><span class="s-seg-fps">${b.sub}</span>
            </button>`).join("")}
        </div>
      </div>`;
  }

  // ---- Debug tab ----
  function debugPaneHTML() {
    return `
      <h3>Debug logging</h3>
      <p class="s-desc">Writes a verbose, structured trace of agent discovery, session binding, and the
        scene (shred / swap / spawn) to the <b>DevTower Debug</b> output channel and
        <code>.devtower/debug.log</code>, and shows a per-dev tie-label in the tower (the claude session
        id, owned vs external, and the terminal PID). Use it to diagnose a dev that drifts onto the wrong
        session or splits into a duplicate. Leave off for normal use.</p>
      <div class="s-row">
        <div class="s-row-t">
          <div class="s-row-name">Debug logging</div>
          <div class="s-row-sub">Verbose trace + on-canvas tie labels. Off by default.</div>
        </div>
        <button class="s-toggle ${debug ? "on" : ""}" id="s-debug" role="switch" aria-checked="${debug}"><span class="knob"></span></button>
      </div>
      ${dbgLogExists ? `
      <div class="s-hookbar">
        <button class="s-actbtn" id="s-debug-view">View log</button>
        <button class="s-actbtn" id="s-debug-folder">Open folder</button>
        <button class="s-actbtn" id="s-debug-clear">Clear log</button>
      </div>
      <div class="s-note">A captured log is on disk${dbgArchives ? ` plus ${dbgArchives} rotated archive${dbgArchives === 1 ? "" : "s"}` : ""}.
        The log rotates automatically as it grows; clearing removes the log and all its archives. It stays available to view even with logging off.</div>`
      : `<p class="s-note">No log captured yet. Turn logging on to start recording.</p>`}`;
  }

  // ---- Hooks tab ----
  function hooksPaneHTML() {
    const list = hooks || [];
    const anyOff = list.some((h) => !h.installed);
    const anyOn = list.some((h) => h.installed);
    const rows = list.length
      ? list.map((h) => `
        <div class="s-row">
          <div class="s-row-t">
            <div class="s-row-name">${esc(h.label)}</div>
            <div class="s-row-sub">${esc(h.description)}</div>
          </div>
          <button class="s-toggle ${h.installed ? "on" : ""}" data-hook="${esc(h.id)}" role="switch" aria-checked="${h.installed}"><span class="knob"></span></button>
        </div>`).join("")
      : `<p class="s-desc">No hooks available.</p>`;
    return `
      <h3>Claude Code hooks</h3>
      <p class="s-desc">DevTower can add hooks to your global <code>~/.claude/settings.json</code> to
        watch your sessions more reliably. Toggle each one on or off, or use the buttons below.</p>
      <div class="s-hookbar">
        <button class="s-actbtn" id="s-hook-all" ${anyOff ? "" : "disabled"}>Enable all</button>
        <button class="s-actbtn" id="s-hook-none" ${anyOn ? "" : "disabled"}>Disable all</button>
      </div>
      ${rows}`;
  }

  function renderSettings() {
    const s = $("#settings");
    if (s.hidden) return;
    const nav = SETTINGS_TABS.map((t) =>
      `<button class="s-tab ${settingsTab === t.id ? "on" : ""}" data-tab="${t.id}">${t.label}</button>`).join("");
    const pane = settingsTab === "general" ? generalPaneHTML()
      : settingsTab === "hooks" ? hooksPaneHTML()
      : settingsTab === "debug" ? debugPaneHTML()
      : githubPaneHTML();

    s.innerHTML = `
      <div class="settings-card">
        <button class="s-close" id="s-close" title="Close (Esc)">✕</button>
        <h2>Settings</h2>
        <div class="s-body">
          <nav class="s-tabs">${nav}</nav>
          <div class="s-pane">${pane}</div>
        </div>
      </div>`;

    // shared wiring
    $("#s-close", s).onclick = closeSettings;
    s.onclick = (e) => { if (e.target === s) closeSettings(); }; // click backdrop to close
    $$(".s-tab", s).forEach((b) => (b.onclick = () => { settingsTab = b.dataset.tab; renderSettings(); }));
    $$(".s-link", s).forEach((a) => (a.onclick = () =>
      vscode.postMessage({ type: "action", act: "openPr", url: a.dataset.url })));

    // GitHub-tab wiring
    const save = $("#s-save", s), input = $("#s-token", s);
    if (save && input) {
      const doSave = () => {
        const token = input.value.trim();
        if (!token) return;
        vscode.postMessage({ type: "setGithubToken", token });
        input.value = "";
        save.textContent = "Saving…"; save.disabled = true;
      };
      save.onclick = doSave;
      input.onkeydown = (e) => { if (e.key === "Enter") doSave(); };
    }
    const clear = $("#s-clear", s);
    if (clear) clear.onclick = () => vscode.postMessage({ type: "clearGithubToken" });

    // General-tab wiring: pick a performance mode (segmented control)
    const perfSeg = $("#s-perf", s);
    if (perfSeg) perfSeg.querySelectorAll("[data-perf]").forEach((btn) => {
      btn.onclick = () => {
        const mode = btn.getAttribute("data-perf");
        if (mode === perf) return;
        applyPerf(mode);
        vscode.postMessage({ type: "setPerf", mode });
        renderSettings();
      };
    });

    // General-tab wiring: pick which projects show (global vs this workspace)
    const scopeSeg = $("#s-scope", s);
    if (scopeSeg) scopeSeg.querySelectorAll("[data-scope]").forEach((btn) => {
      btn.onclick = () => {
        const mode = btn.getAttribute("data-scope");
        if (mode === projectScope) return;
        projectScope = mode;
        vscode.postMessage({ type: "setProjectScope", scope: mode });
        renderSettings();
      };
    });
    // General-tab wiring: pick a book preference (physical shelf vs ebook on the phone)
    const bookSeg = $("#s-books", s);
    if (bookSeg) bookSeg.querySelectorAll("[data-book]").forEach((btn) => {
      btn.onclick = () => {
        const mode = btn.getAttribute("data-book");
        if (mode === bookMode) return;
        applyBookMode(mode);
        vscode.postMessage({ type: "setBookPreference", mode });
        renderSettings();
      };
    });

    // Debug-tab wiring: flip locally for an instant response, mirror into the
    // scene, and persist to devtower.debugLog (the host echoes it back via config)
    const dbgT = $("#s-debug", s);
    if (dbgT) dbgT.onclick = () => {
      debug = !debug;
      if (window.DevTowerCrew && DevTowerCrew.setDebug) DevTowerCrew.setDebug(debug);
      vscode.postMessage({ type: "setDebug", on: debug });
      renderSettings();
    };
    // View / Clear act on the host (the clear runs a native "are you sure" modal);
    // the host echoes the new on-disk state back via the config message.
    const dbgView = $("#s-debug-view", s);
    if (dbgView) dbgView.onclick = () => vscode.postMessage({ type: "viewDebugLog" });
    const dbgFolder = $("#s-debug-folder", s);
    if (dbgFolder) dbgFolder.onclick = () => vscode.postMessage({ type: "openLogFolder" });
    const dbgClear = $("#s-debug-clear", s);
    if (dbgClear) dbgClear.onclick = () => vscode.postMessage({ type: "clearDebugLog" });

    // Hooks-tab wiring: optimistically flip local state so the toggle responds
    // instantly, then let the host echo the authoritative state back.
    $$(".s-toggle[data-hook]", s).forEach((t) => (t.onclick = () => {
      const id = t.dataset.hook;
      const h = (hooks || []).find((x) => x.id === id);
      if (!h) return;
      h.installed = !h.installed;
      vscode.postMessage({ type: "setHook", id, on: h.installed });
      renderSettings();
    }));
    const all = $("#s-hook-all", s), none = $("#s-hook-none", s);
    if (all) all.onclick = () => {
      (hooks || []).forEach((h) => (h.installed = true));
      vscode.postMessage({ type: "setAllHooks", on: true });
      renderSettings();
    };
    if (none) none.onclick = () => {
      (hooks || []).forEach((h) => (h.installed = false));
      vscode.postMessage({ type: "setAllHooks", on: false });
      renderSettings();
    };
  }

  /* ---------- agent stats card ---------- */
  function contextOf(a) {
    if (!a.contextTokens) return null;
    // Match Claude Code's status line: pick the session's real context window.
    // The transcript stores the bare model id ("claude-opus-4-8") and drops the
    // "[1m]" suffix the CLI shows, so /1m/ alone misses 1M sessions — the window
    // stayed at 200k and the % read ~5x too high. Detect 1M by model family (the
    // Claude 4.x Opus/Sonnet runs use the 1M beta), or once usage passes 200k.
    const m = (a.model || "").toLowerCase();
    const oneM = /1m/.test(m) || /(opus|sonnet)[ -]4/.test(m) || a.contextTokens > 200_000;
    const limit = oneM ? 1_000_000 : 200_000;
    return Math.min(100, Math.round((a.contextTokens / limit) * 100));
  }

  function renderPanel() {
    const panel = $("#panel");
    const a = get(selectedId);
    if (!a || !panelOpen) { panel.hidden = true; return; }
    panel.hidden = false;

    // Skip the innerHTML rebuild (which replays the entry animation = a visible
    // flash) when nothing the panel shows has changed. Elapsed time is patched in
    // place below so it still ticks without a rebuild.
    const sig = JSON.stringify([
      a.id, a.name, a.repo, a.state, a.model, a.contextTokens,
      (a.skills || []).join("|"), a.question || "", !!a.external,
      a.aiTitle || "",
    ]);
    if (sig === panelSig) {
      const elEl = panel.querySelector(".el-elapsed");
      if (elEl) elEl.textContent = a.elapsed || "";
      return;
    }
    panelSig = sig;

    const hue = hueOf(a.id);
    const pct = contextOf(a);
    const pctColor = pct === null ? "var(--idle)" : pct < 60 ? "var(--active)" : pct < 85 ? "var(--waiting)" : "var(--error)";
    const tokens = a.contextTokens ? (a.contextTokens >= 1000 ? Math.round(a.contextTokens / 1000) + "k" : a.contextTokens) : null;

    panel.innerHTML = `
      <div class="p-head" style="--ac:hsl(${hue} 55% 55%)">
        <button class="p-close" id="p-close" title="Close (Esc)">✕</button>
        <div class="p-id">
          <div class="avatar" style="--av1:hsl(${hue} 55% 58%); --av2:hsl(${hue} 50% 38%)"></div>
          <div class="p-meta">
            <h1>${esc(a.name)}</h1>
            <div class="sub"><b>${esc(a.repo)}</b><span class="sep">·</span><span class="el-elapsed">${esc(a.elapsed || "")}</span></div>
          </div>
          <span class="statebadge" data-state="${a.state}"><i></i>${STATE_LABEL[a.state]}</span>
        </div>
      </div>

      <div class="stats">
        <div class="stat-ctx">
          <span class="sl">Context</span>
          <div class="bar"><i style="width:${pct ?? 0}%; background:${pctColor}"></i></div>
          <b>${pct === null ? "—" : pct + "%"}${tokens ? `<span class="tk"> ${tokens}</span>` : ""}</b>
        </div>
        <div class="srow"><span class="sl">Model</span><b>${esc(a.model || "—")}</b></div>
        ${a.aiTitle ? `<div class="srow ai-title-row"><span class="sl">Summary</span><span class="ai-title">${esc(a.aiTitle)}</span></div>` : ""}
        ${a.skills && a.skills.length ? `
        <div class="srow skills-row">
          <span class="sl">Skills</span>
          <div class="skills">${a.skills.map((s) => `<span class="skill">${esc(s)}</span>`).join("")}</div>
        </div>` : ""}
      </div>

      ${a.state === "waiting" ? `
      <div class="callout">
        <div class="ct"><i></i>${a.question ? "Agent is asking" : "Paused"}</div>
        <div class="q">${esc(a.question || "Waiting in its terminal — likely a permission prompt.")}</div>
        ${a.external ? `<div class="acts ext-note">Respond in its own terminal session.</div>` : `<div class="acts"><button class="qa go" data-tool="terminal">⌗ Respond in terminal</button></div>`}
      </div>` : ""}

      <div class="p-actions">
        ${a.external
          ? `<div class="pa ext-note" title="This session runs outside DevTower — manage it in its own terminal">⌗ Runs in its own session</div>`
          : `<button class="pa primary" data-tool="terminal">⌗ Chat</button>`}
        ${a.external ? "" : `<button class="pa danger" data-tool="sendHome">⌂ Send Home</button>`}
      </div>`;

    // wiring
    $("#p-close", panel).onclick = closePanelToRoom;
    $$("[data-tool]", panel).forEach((t) => (t.onclick = () => {
      vscode.postMessage({ type: "action", id: a.id, act: t.dataset.tool });
    }));
  }

  /* ---------- performance mode ---------- */
  // defaults to "balanced"; the saved setting arrives via the "config" message,
  // and each pick persists the new choice back to settings
  const PERF_MODES = [
    { id: "smooth", name: "Smooth", fps: 15 },
    { id: "balanced", name: "Balanced", fps: 10 },
    { id: "eco", name: "Eco", fps: 6 },
  ];
  let perf = "balanced";
  // devtower.projectScope: which registered projects the tower draws. Arrives via
  // the "config" message; each pick persists the choice back to settings.
  const SCOPE_MODES = [
    { id: "global", name: "All projects" },
    { id: "workspace", name: "This workspace" },
  ];
  let projectScope = "global";
  // where devs get a skill's book: "physical" (walk to the shelf) or "ebook"
  // (read on their phone at the desk). Arrives via the "config" message.
  const BOOK_MODES = [
    { id: "physical", name: "Physical", sub: "Bookshelf" },
    { id: "ebook", name: "Ebook", sub: "Phone" },
  ];
  let bookMode = "physical";
  let debug = false; // devtower.debugLog; arrives via the "config" message
  let dbgLogExists = false; // whether a captured log is on disk (config message)
  let dbgArchives = 0; // number of rotated archive files on disk (config message)
  function applyPerf(mode) {
    perf = PERF_MODES.some((p) => p.id === mode) ? mode : "balanced";
    if (window.DevTowerCrew && DevTowerCrew.setPerf) DevTowerCrew.setPerf(perf);
  }
  function applyBookMode(mode) {
    bookMode = BOOK_MODES.some((b) => b.id === mode) ? mode : "physical";
    if (window.DevTowerCrew && DevTowerCrew.setBookMode) DevTowerCrew.setBookMode(bookMode);
  }
  applyPerf("balanced");
  applyBookMode("physical");

  /* ---------- global wiring ---------- */
  $("#settingsbtn").onclick = openSettings;
  $("#lbbtn").onclick = () => (leaderboardOpen() ? closeLeaderboard() : openLeaderboard());
  const popout = $("#popoutbtn");
  if (popout) popout.onclick = () => vscode.postMessage({ type: "popout" });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (leaderboardOpen()) closeLeaderboard();
      else if (settingsOpen()) closeSettings();
      else if (panelOpen) closePanelToRoom();
    }
  });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "state") {
      diffCrew(m.agents || []);
      agents = m.agents || [];
      // Adopt the host's selection when the panel is open, OR when the host's
      // selection just CHANGED to a real agent (a just-added + DEV, or a host-side
      // select). Detecting a change rather than a brand-new agent id matters because
      // adding a dev posts TWO states: apply() carries the new agent with the OLD
      // selectedId, then setSelected() carries the new selectedId. By the second
      // message the new agent is no longer "brand new" to us, so a brand-new-id test
      // would miss it; comparing against the last host selection still catches it.
      // Routine polls repeating the same selectedId leave it unchanged → ignored,
      // so a closed panel that has panned away isn't yanked back every poll.
      const selChanged = m.selectedId && m.selectedId !== lastHostSel && agents.some((a) => a.id === m.selectedId);
      if (m.selectedId && (panelOpen || selChanged)) selectedId = m.selectedId;
      lastHostSel = m.selectedId ?? null;
      renderTelemetry();
      renderSelDir(m.selectedDir);
      if (window.DevTowerCrew) {
        window.DevTowerCrew.setBoards(m.boards || {});
        window.DevTowerCrew.setRooms(m.rooms || []);
        if (window.DevTowerCrew.setUsedDir) window.DevTowerCrew.setUsedDir(m.usedDir);
      }
      pushCrew();
      renderPanel();
      scheduleLeaderboard(); // patch the open board live, coalesced to one repaint/frame
    } else if (m.type === "prs") {
      prs = { crew: m.crew || [], review: m.review || [] };
      if (panelOpen) renderPanel();
      // tell the tower which branches have an open PR (shown on each board)
      if (window.DevTowerCrew) {
        window.DevTowerCrew.setGithubConnected(m.connected); // drives the disconnected placeholder
        if (window.DevTowerCrew.setPrLoading) window.DevTowerCrew.setPrLoading(!!m.loading); // first poll → spinner
        const branches = [...prs.crew, ...prs.review].map((p) => p.branch).filter(Boolean);
        window.DevTowerCrew.setPrBranches(branches);
      }
    } else if (m.type === "usage") {
      renderUsage(m.usage);
    } else if (m.type === "config") {
      applyPerf(m.perf || "balanced"); // saved performance-mode preference
      projectScope = m.projectScope || "global"; // saved project-scope preference
      applyBookMode(m.books || "physical"); // saved physical/ebook book preference
      debug = !!m.debug; // authoritative devtower.debugLog state from the host
      dbgLogExists = !!m.debugLogExists; // a captured log is on disk
      dbgArchives = m.debugLogArchives | 0; // rotated archive files on disk
      if (DevTowerCrew.setDebug) DevTowerCrew.setDebug(debug); // mirror into the scene
      if (settingsOpen()) renderSettings(); // reflect an external toggle live
    } else if (m.type === "settings") {
      settings = { caps: m.caps, scopeHelp: m.scopeHelp };
      // Only the GitHub pane consumes caps; re-rendering the General pane here
      // just rebuilds identical DOM and flickers, so skip it.
      if (settingsTab === "github") renderSettings();
    } else if (m.type === "hooks") {
      hooks = Array.isArray(m.hooks) ? m.hooks : [];
      if (settingsTab === "hooks") renderSettings(); // authoritative state from the host
    } else if (m.type === "openSettings") {
      if (m.tab) settingsTab = m.tab; // land on a requested tab (e.g. the hooks nudge)
      openSettings();
    } else if (m.type === "focusAgent" && m.id) {
      selectAgent(m.id, true); // host (or harness) asks to open an agent's panel
    }
  });

  mountCrew();
  vscode.postMessage({ type: "ready" });
  vscode.postMessage({ type: "requestPrs" });
})();
