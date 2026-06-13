/* DevTower console — pixel scene + glass HUD.
   The agent's NATIVE terminal (auto-attached `claude --resume`) is the chat;
   the panel is a compact stats card: context %, model, plus PR actions. */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const STATE_LABEL = { active: "Active", waiting: "Awaiting input", complete: "Complete", error: "Error", idle: "Idle" };
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

  let agents = [], selectedId = null, theme = "dark", panelOpen = false;
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
    window.DevTowerCrew.start();
  }

  function pushCrew() {
    if (!window.DevTowerCrew) return;
    window.DevTowerCrew.setAgents(agents.map((a) => ({ id: a.id, name: a.name, state: a.state, repo: a.repo, model: a.model, worktree: a.worktree, branch: a.branch, skills: a.skills, reviewOf: a.reviewOf, reviewVerdict: a.reviewVerdict })));
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
    const m = Math.floor((secs % 3600) / 60);
    return h >= 1 ? ` · resets in ${h}h ${m}m` : ` · resets in ${m}m`;
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
            <div class="sub"><b>${esc(a.repo)}</b><span class="sep">·</span>${esc(a.elapsed || "")}</div>
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
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (reviewDispatchOpen()) closeReviewDispatch();
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
      }
      pushCrew();
      renderPanel();
    } else if (m.type === "prs") {
      prs = { crew: m.crew || [], review: m.review || [] };
      renderPrBadge();
      if (panelOpen) renderPanel();
      // tell the tower which branches have an open PR (shown on each board)
      if (window.DevTowerCrew) {
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
      if (Array.isArray(m.reviewSkills) && m.reviewSkills.length) reviewSkills = m.reviewSkills;
      if (m.reviewDefaults && typeof m.reviewDefaults === "object") reviewDefaults = m.reviewDefaults;
      if (Array.isArray(m.reviewAgents)) reviewAgents = m.reviewAgents;
    }
  });

  mountCrew();
  vscode.postMessage({ type: "ready" });
  vscode.postMessage({ type: "requestPrs" });
})();
