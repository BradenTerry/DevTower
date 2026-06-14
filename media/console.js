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
    window.DevTowerCrew.onAssignReview((pr) => openReviewDispatch(pr));
    window.DevTowerCrew.onRefreshPrs(() => vscode.postMessage({ type: "refreshPrs" }));
    window.DevTowerCrew.onOpenPr((url) => vscode.postMessage({ type: "action", act: "openPr", url }));
    if (DevTowerCrew.onDebug) DevTowerCrew.onDebug((event, data) => vscode.postMessage({ type: "debug", event, data }));
    window.DevTowerCrew.start();
  }

  function pushCrew() {
    if (!window.DevTowerCrew) return;
    window.DevTowerCrew.setAgents(agents.map((a) => ({ id: a.id, name: a.name, state: a.state, repo: a.repo, model: a.model, worktree: a.worktree, branch: a.branch, skills: a.skills, subagents: a.subagents, external: a.external, clearedSession: a.clearedSession, reviewOf: a.reviewOf, reviewVerdict: a.reviewVerdict })));
    window.DevTowerCrew.setSelected(selectedId);
  }

  function updateInsets() {
    if (!window.DevTowerCrew) return;
    window.DevTowerCrew.setInsets(0, panelOpen ? 392 : 0);
  }

  /* ---------- selection ---------- */
  function selectAgent(id, open) {
    selectedId = id;
    vscode.postMessage({ type: "select", id }); // reveals the agent's terminal
    if (window.DevTowerCrew) window.DevTowerCrew.setSelected(id);
    if (open) panelOpen = true;
    updateInsets();
    renderPanel();
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
  function pushFeed(html, color) {
    const feed = $("#feed");
    const el = document.createElement("div");
    el.className = "feed-item";
    el.style.setProperty("--c", color);
    el.innerHTML = html;
    feed.appendChild(el);
    while (feed.children.length > 5) feed.removeChild(feed.firstChild);
    setTimeout(() => el.classList.add("expire"), 6500);
    setTimeout(() => el.remove(), 7300);
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
        if (a.state === "waiting") pushFeed(`<span class="fi">?</span><b>${esc(a.name)}</b> has a question<span class="repo">${esc(a.repo)}</span>`, "var(--waiting)");
        else if (a.state === "error") pushFeed(`<span class="fi">✗</span><b>${esc(a.name)}</b> hit an error<span class="repo">${esc(a.repo)}</span>`, "var(--error)");
        else if (a.state === "complete") pushFeed(`<span class="fi">✓</span><b>${esc(a.name)}</b> finished<span class="repo">${esc(a.repo)}</span>`, "var(--complete)");
      }
      prevStates.set(a.id, a.state);
    }
  }

  /* ---------- PR board ---------- */
  const CHECK_LABEL = { pass: "checks ✓", fail: "checks ✗", pending: "checks running", none: "" };
  const REVIEW_LABEL = { approved: "approved", changes: "changes requested", required: "review needed", none: "" };

  function prFor(agentId) {
    return prs.crew.find((p) => p.agentId === agentId);
  }

  // count of PRs awaiting the operator's review, shown on the HUD PR button
  function renderPrBadge() {
    const n = prs.review.length;
    const b = $("#pr-badge");
    b.hidden = n === 0;
    b.textContent = n;
  }

  /* ---------- review dispatch card ---------- */
  let reviewSkills = ["code-review", "security-review", "review", "simplify", "verify"];
  let reviewDefaults = {};
  let reviewAgents = []; // {label, path} discovered from .claude/agents
  const EFFORT_LEVELS = ["low", "medium", "high", "max"];
  const EFFORT_SKILLS = new Set(["code-review", "review"]);

  function openReviewDispatch(pr) {
    const scrim = $("#reviewdispatch");
    const sel = new Set((reviewDefaults.skills || []).filter((s) => reviewSkills.includes(s)));
    let effort = reviewDefaults.effort || "high";
    const instr = reviewDefaults.instructions || "";
    let agent = reviewAgents.some((a) => a.path === reviewDefaults.agent) ? reviewDefaults.agent : "";

    const chips = reviewSkills
      .map((s) => `<span class="rd-chip ${sel.has(s) ? "on" : ""}" data-skill="${esc(s)}">${esc(s)}</span>`)
      .join("");
    const seg = EFFORT_LEVELS
      .map((l) => `<button data-effort="${l}" class="${l === effort ? "on" : ""}">${l}</button>`)
      .join("");
    const agentOpts = [`<option value="" ${agent === "" ? "selected" : ""}>None (default prompt)</option>`]
      .concat(reviewAgents.map((a) => `<option value="${esc(a.path)}" ${a.path === agent ? "selected" : ""}>${esc(a.label)}</option>`))
      .join("");
    const agentField = reviewAgents.length
      ? `<div class="rd-field">
          <span class="rd-label">Agent</span>
          <select class="rd-select" id="rd-agent">${agentOpts}</select>
        </div>`
      : "";

    scrim.innerHTML = `
      <div class="rd-card" role="dialog" aria-modal="true">
        <div class="rd-head">
          <span class="rd-ic">⇄</span>
          <div class="rd-t">
            <div class="rd-kicker">Dispatch review</div>
            <h2>${esc(pr.title || "")}</h2>
            <div class="rd-sub">${esc(pr.repo)} · #${pr.number}</div>
          </div>
          <button class="rd-close" id="rd-close" title="Close (Esc)">✕</button>
        </div>
        <div class="rd-field">
          <span class="rd-label">Skills</span>
          <div class="rd-chips" id="rd-chips">${chips}</div>
        </div>
        <div class="rd-field" id="rd-effort-field">
          <span class="rd-label">Effort</span>
          <div class="rd-seg" id="rd-effort">${seg}</div>
        </div>
        ${agentField}
        <div class="rd-field">
          <span class="rd-label">Instructions</span>
          <textarea class="rd-ta" id="rd-instr" placeholder="What should the reviewer focus on? (optional)">${esc(instr)}</textarea>
        </div>
        <div class="rd-foot">
          <label class="rd-default"><input type="checkbox" id="rd-default" /> Save as default</label>
          <span class="spacer"></span>
          <button class="rd-btn" id="rd-cancel">Cancel</button>
          <button class="rd-btn primary" id="rd-go">Dispatch</button>
        </div>
      </div>`;
    scrim.hidden = false;

    const effortField = $("#rd-effort-field", scrim);
    const syncEffort = () => {
      // effort only matters when a skill that takes one is selected
      effortField.hidden = ![...sel].some((s) => EFFORT_SKILLS.has(s));
    };
    syncEffort();

    $$(".rd-chip", scrim).forEach((c) => (c.onclick = () => {
      const s = c.dataset.skill;
      if (sel.has(s)) sel.delete(s); else sel.add(s);
      c.classList.toggle("on");
      syncEffort();
    }));
    $$("#rd-effort button", scrim).forEach((b) => (b.onclick = () => {
      effort = b.dataset.effort;
      $$("#rd-effort button", scrim).forEach((x) => x.classList.toggle("on", x === b));
    }));

    const close = () => { scrim.hidden = true; scrim.innerHTML = ""; };
    $("#rd-close", scrim).onclick = close;
    $("#rd-cancel", scrim).onclick = close;
    scrim.onclick = (e) => { if (e.target === scrim) close(); };
    $("#rd-go", scrim).onclick = () => {
      const agentEl = $("#rd-agent", scrim);
      vscode.postMessage({
        type: "assignReview",
        pr,
        skills: [...sel],
        effort,
        instructions: $("#rd-instr", scrim).value.trim(),
        agent: agentEl ? agentEl.value : "",
        saveDefault: $("#rd-default", scrim).checked,
      });
      close();
    };
  }

  function reviewDispatchOpen() { return !$("#reviewdispatch").hidden; }
  function closeReviewDispatch() { const s = $("#reviewdispatch"); s.hidden = true; s.innerHTML = ""; }

  /* ---------- settings overlay (tabbed: General / Hooks / GitHub) ---------- */
  let settings = null; // last { caps, scopeHelp } pushed by the extension
  let hooks = null; // last [{ id, label, description, installed }] pushed by the extension
  let settingsTab = "general"; // active left-rail tab
  const SETTINGS_TABS = [
    { id: "general", label: "General" },
    { id: "hooks", label: "Hooks" },
    { id: "github", label: "GitHub" },
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
          <div class="s-row-name">Efficiency mode</div>
          <div class="s-row-sub">Reduce animation and CPU use. Turns on automatically when on battery.</div>
        </div>
        <button class="s-toggle ${eco ? "on" : ""}" id="s-eco" role="switch" aria-checked="${eco}"><span class="knob"></span></button>
      </div>`;
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

    // General-tab wiring
    const ecoT = $("#s-eco", s);
    if (ecoT) ecoT.onclick = () => { applyEco(!eco); vscode.postMessage({ type: "setEco", on: eco }); renderSettings(); };

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

  function prChipHTML(a) {
    const p = prFor(a.id);
    if (!p) return "";
    const checks = p.checks !== "none" ? `<span class="pr-stat ${p.checks}"><span class="pdot"></span>${CHECK_LABEL[p.checks]}</span>` : "";
    const review = p.review !== "none" ? `<span class="pr-stat ${p.review}"><span class="pdot"></span>${REVIEW_LABEL[p.review]}</span>` : "";
    return `<div class="prchip" data-url="${esc(p.url)}"><span class="pic">⇄</span><b>#${p.number}</b> ${esc(p.title)}<span class="spacer"></span>${checks}${review}</div>`;
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
      prFor(a.id) || null,
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
          <div>
            <h1>${esc(a.name)}</h1>
            <div class="sub"><b>${esc(a.repo)}</b><span class="sep">·</span><span class="el-elapsed">${esc(a.elapsed || "")}</span></div>
          </div>
          <span class="statebadge" data-state="${a.state}"><i></i>${STATE_LABEL[a.state]}</span>
        </div>
        ${prChipHTML(a)}
      </div>

      <div class="stats">
        <div class="stat-ctx">
          <span class="sl">Context</span>
          <div class="bar"><i style="width:${pct ?? 0}%; background:${pctColor}"></i></div>
          <b>${pct === null ? "—" : pct + "%"}${tokens ? `<span class="tk"> ${tokens}</span>` : ""}</b>
        </div>
        <div class="srow"><span class="sl">Model</span><b>${esc(a.model || "—")}</b></div>
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
          : `<button class="pa primary" data-tool="terminal">⌗ Claude terminal</button>`}
        <button class="pa" data-tool="pr">⇄ ${prFor(a.id) ? "PR" : "Create PR"}</button>
      </div>`;

    // wiring
    $("#p-close", panel).onclick = closePanel;
    const chip = $(".prchip", panel);
    if (chip) chip.onclick = () => vscode.postMessage({ type: "action", act: "openPr", url: chip.dataset.url });
    $$("[data-tool]", panel).forEach((t) => (t.onclick = () => {
      if (t.dataset.tool === "pr") {
        const p = prFor(a.id);
        if (p) vscode.postMessage({ type: "action", act: "openPr", url: p.url });
        else vscode.postMessage({ type: "action", id: a.id, act: "createPr" });
        return;
      }
      vscode.postMessage({ type: "action", id: a.id, act: t.dataset.tool });
    }));
  }

  /* ---------- efficiency mode ---------- */
  // defaults off; the saved setting arrives via the "config" message, and each
  // click persists the new choice back to settings
  let eco = false;
  function applyEco(on) {
    eco = !!on;
    if (window.DevTowerCrew) window.DevTowerCrew.setEco(eco);
    $("#ecobtn").classList.toggle("on", eco);
    $("#ecobtn").title = eco
      ? "Efficiency mode on — click to disable"
      : "Efficiency mode off — click to reduce animation/CPU";
  }
  applyEco(false);
  $("#ecobtn").onclick = () => {
    applyEco(!eco);
    vscode.postMessage({ type: "setEco", on: eco });
  };

  /* ---------- global wiring ---------- */
  // the HUD PR button flies the camera to the review billboard in the scene
  // (and refreshes the PR list) rather than opening a side panel
  $("#prbtn").onclick = () => {
    vscode.postMessage({ type: "refreshPrs" });
    if (window.DevTowerCrew) window.DevTowerCrew.focusReviewBoard();
  };
  $("#settingsbtn").onclick = openSettings;

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (settingsOpen()) closeSettings();
      else if (reviewDispatchOpen()) closeReviewDispatch();
      else if (panelOpen) closePanel();
    }
  });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "state") {
      diffCrew(m.agents || []);
      agents = m.agents || [];
      if (m.selectedId && panelOpen) selectedId = m.selectedId;
      renderTelemetry();
      if (window.DevTowerCrew) {
        window.DevTowerCrew.setBoards(m.boards || {});
        window.DevTowerCrew.setRooms(m.rooms || []);
        if (window.DevTowerCrew.setUsedDir) window.DevTowerCrew.setUsedDir(m.usedDir);
      }
      pushCrew();
      renderPanel();
    } else if (m.type === "prs") {
      prs = { crew: m.crew || [], review: m.review || [] };
      renderPrBadge();
      if (panelOpen) renderPanel();
      // tell the tower which branches have an open PR (shown on each board)
      if (window.DevTowerCrew) {
        window.DevTowerCrew.setGithubConnected(m.connected); // drives the disconnected placeholder
        if (window.DevTowerCrew.setPrLoading) window.DevTowerCrew.setPrLoading(!!m.loading); // first poll → spinner
        const branches = [...prs.crew, ...prs.review].map((p) => p.branch).filter(Boolean);
        window.DevTowerCrew.setPrBranches(branches);
        // feed the central billboard the PRs waiting on the operator's review
        window.DevTowerCrew.setReviewPrs(prs.review.map((p) => ({
          number: p.number, repo: p.repo, title: p.title, branch: p.branch, url: p.url,
        })));
      }
    } else if (m.type === "usage") {
      renderUsage(m.usage);
    } else if (m.type === "config") {
      applyEco(!!m.eco); // saved efficiency-mode preference (default off)
      if (DevTowerCrew.setDebug) DevTowerCrew.setDebug(!!m.debug); // mirror devtower.debugLog into the scene
      if (Array.isArray(m.reviewSkills) && m.reviewSkills.length) reviewSkills = m.reviewSkills;
      if (m.reviewDefaults && typeof m.reviewDefaults === "object") reviewDefaults = m.reviewDefaults;
      if (Array.isArray(m.reviewAgents)) reviewAgents = m.reviewAgents;
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
