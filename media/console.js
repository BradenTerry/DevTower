/* DevTower console — pixel scene + glass HUD.
   The agent's NATIVE terminal (auto-attached `claude --resume`) is the chat;
   the panel is a compact stats card: context %, model, branch, changes. */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const STATE_LABEL = { active: "Active", waiting: "Awaiting input", complete: "Complete", error: "Error", idle: "Idle" };
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

  let agents = [], selectedId = null, theme = "dark", panelOpen = false;
  let firstState = true, prboardOpen = false;
  let prs = { crew: [], review: [] };
  const changes = new Map();
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
    window.DevTowerCrew.onAddAgent((room) => vscode.postMessage({ type: "addAgent", room }));
    window.DevTowerCrew.onRemoveRoom((room) => vscode.postMessage({ type: "removeRoom", room }));
    window.DevTowerCrew.onCd((id, target) =>
      vscode.postMessage({ type: "cdAgent", id, room: target.room, ghost: target.ghost })
    );
    window.DevTowerCrew.start();
  }

  function pushCrew() {
    if (!window.DevTowerCrew) return;
    window.DevTowerCrew.setAgents(agents.map((a) => ({ id: a.id, name: a.name, state: a.state, repo: a.repo, model: a.model, worktree: a.worktree, branch: a.branch })));
    window.DevTowerCrew.setSelected(selectedId);
  }

  function updateInsets() {
    if (!window.DevTowerCrew) return;
    window.DevTowerCrew.setInsets(prboardOpen ? 404 : 0, panelOpen ? 392 : 0);
  }

  /* ---------- selection ---------- */
  function selectAgent(id, open) {
    selectedId = id;
    vscode.postMessage({ type: "select", id }); // reveals the agent's terminal
    vscode.postMessage({ type: "requestChanges", id });
    if (window.DevTowerCrew) window.DevTowerCrew.setSelected(id);
    if (open) panelOpen = true;
    const hint = $("#hint");
    if (hint) hint.style.opacity = panelOpen ? "0" : "1";
    updateInsets();
    renderPanel();
  }

  function closePanel() {
    panelOpen = false;
    $("#panel").hidden = true;
    const hint = $("#hint");
    if (hint) hint.style.opacity = "1";
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

  function renderPrBadge() {
    const n = prs.review.length;
    const b = $("#pr-badge");
    b.hidden = n === 0;
    b.textContent = n;
    $("#prbtn").classList.toggle("on", prboardOpen);
  }

  function prRowHTML(p, attn) {
    const checks = p.checks !== "none" ? `<span class="pr-stat ${p.checks}"><span class="pdot"></span>${CHECK_LABEL[p.checks]}</span>` : "";
    const review = p.review !== "none" ? `<span class="pr-stat ${p.review}"><span class="pdot"></span>${REVIEW_LABEL[p.review]}</span>` : "";
    const author = p.author && p.author !== "you" ? `<span class="pr-author">by ${esc(p.author)}</span>` : "";
    return `<div class="pr-row ${attn ? "attn" : ""}" data-url="${esc(p.url)}">
      <div class="pr-r1"><span class="pr-num">#${p.number}</span><span class="pr-title">${esc(p.title)}</span>${p.isDraft ? `<span class="pr-draft">Draft</span>` : ""}</div>
      <div class="pr-r2"><span class="repo">${esc(p.repo)}</span>${author}<span class="spacer"></span>${checks}${review}<button class="pr-review" title="Assign a dev to review this PR" data-number="${p.number}" data-repo="${esc(p.repo)}" data-branch="${esc(p.branch || "")}" data-url="${esc(p.url)}" data-title="${esc(p.title)}">Review</button></div>
    </div>`;
  }

  function renderPrBoard() {
    renderPrBadge();
    const board = $("#prboard");
    if (!prboardOpen) { board.hidden = true; return; }
    board.hidden = false;
    const section = (title, list, attn) =>
      `<div class="pr-section">
        <div class="pr-sec-title ${attn ? "attn" : ""}">${title}<span class="cnt">${list.length}</span><span class="ln"></span></div>
        ${list.length ? list.map((p) => prRowHTML(p, attn)).join("") : `<div class="prb-empty">${attn ? "Nothing waiting on you." : "No open crew PRs yet."}</div>`}
      </div>`;
    board.innerHTML = `
      <div class="prb-head"><span class="ic">⇄</span>Pull Requests
        <span class="right">
          <button class="prb-btn" id="prb-refresh" title="Refresh">↻</button>
          <button class="prb-btn" id="prb-close" title="Close">✕</button>
        </span>
      </div>
      <div class="prb-body">
        ${section("Needs your review", prs.review, true)}
        ${section("Crew PRs", prs.crew, false)}
      </div>`;
    $("#prb-close", board).onclick = () => { prboardOpen = false; renderPrBoard(); updateInsets(); };
    $("#prb-refresh", board).onclick = () => vscode.postMessage({ type: "refreshPrs" });
    $$(".pr-row", board).forEach((r) => (r.onclick = () => vscode.postMessage({ type: "action", act: "openPr", url: r.dataset.url })));
    $$(".pr-review", board).forEach((b) => (b.onclick = (e) => {
      e.stopPropagation(); // don't also open the PR
      vscode.postMessage({
        type: "assignReview",
        pr: {
          number: Number(b.dataset.number),
          repo: b.dataset.repo,
          branch: b.dataset.branch,
          url: b.dataset.url,
          title: b.dataset.title,
        },
      });
    }));
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
    // 1M-context sessions don't always advertise it in the model id — if the
    // window already exceeds 200k, it must be a 1M model
    const limit = /1m/i.test(a.model || "") || a.contextTokens > 180_000 ? 1_000_000 : 200_000;
    return Math.min(100, Math.round((a.contextTokens / limit) * 100));
  }

  function renderPanel() {
    const panel = $("#panel");
    const a = get(selectedId);
    if (!a || !panelOpen) { panel.hidden = true; return; }
    panel.hidden = false;

    const hue = hueOf(a.id);
    const chg = changes.get(a.id) || [];
    const adds = chg.reduce((s, f) => s + f.add, 0);
    const dels = chg.reduce((s, f) => s + f.del, 0);
    const pct = contextOf(a);
    const pctColor = pct === null ? "var(--idle)" : pct < 60 ? "var(--active)" : pct < 85 ? "var(--waiting)" : "var(--error)";
    const tokens = a.contextTokens ? (a.contextTokens >= 1000 ? Math.round(a.contextTokens / 1000) + "k" : a.contextTokens) : null;
    const nowText = a.state === "waiting" ? (a.question || a.task) : a.task || STATE_LABEL[a.state];

    const row = (f) => {
      const cut = f.path.lastIndexOf("/") + 1;
      const btn = f.staged
        ? `<button class="chg-btn unstage" data-act="unstageFile" data-path="${esc(f.path)}">−</button>`
        : `<button class="chg-btn stage" data-act="stageFile" data-path="${esc(f.path)}">+</button>`;
      return `<div class="chg-row" data-path="${esc(f.path)}">
        <span class="fic">≡</span>
        <span class="cpath"><span class="dir">${esc(f.path.slice(0, cut))}</span><b>${esc(f.path.slice(cut))}</b></span>
        <span class="cstat"><span class="a">+${f.add}</span><span class="d">−${f.del}</span></span>
        ${btn}</div>`;
    };

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
        <div class="now ${a.state}"><span class="pulse"></span><span class="nlab">${a.state === "active" ? "Now" : a.state}</span><span class="ntext">${esc(nowText)}</span></div>
        ${prChipHTML(a)}
      </div>

      <div class="stats">
        <div class="stat-ctx">
          <span class="sl">Context</span>
          <div class="bar"><i style="width:${pct ?? 0}%; background:${pctColor}"></i></div>
          <b>${pct === null ? "—" : pct + "%"}${tokens ? `<span class="tk"> ${tokens}</span>` : ""}</b>
        </div>
        <div class="srow"><span class="sl">Model</span><b>${esc(a.model || "—")}</b></div>
        <div class="srow"><span class="sl">Branch</span><b>⌥ ${esc(a.branch || "—")}</b></div>
        <div class="srow"><span class="sl">Changes</span><b>${chg.length} files <span class="a">+${adds}</span> <span class="d">−${dels}</span></b></div>
      </div>

      ${a.state === "waiting" ? `
      <div class="callout">
        <div class="ct"><i></i>${a.question ? "Agent is asking" : "Paused"}</div>
        <div class="q">${esc(a.question || "Waiting in its terminal — likely a permission prompt.")}</div>
        <div class="acts"><button class="qa go" data-tool="terminal">⌗ Respond in terminal</button></div>
      </div>` : ""}

      <div class="p-actions">
        <button class="pa primary" data-tool="terminal">⌗ Claude terminal</button>
        <button class="pa" data-tool="diff">⊙ Diff</button>
        <button class="pa" data-tool="pr">⇄ ${prFor(a.id) ? "PR" : "Create PR"}</button>
      </div>

      <div class="chg-section">
        <div class="chg-title">Changed files<span class="cnt">${chg.length}</span></div>
        ${chg.length ? chg.slice(0, 10).map(row).join("") : `<div class="chg-empty">Clean worktree.</div>`}
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
    $$(".chg-row", panel).forEach((r) => (r.onclick = () => vscode.postMessage({ type: "action", id: a.id, act: "openFileDiff", path: r.dataset.path })));
    $$(".chg-btn", panel).forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "action", id: a.id, act: b.dataset.act, path: b.dataset.path });
    }));
  }

  /* ---------- efficiency mode ---------- */
  let eco = false, ecoAuto = false;
  function setEco(on, auto) {
    eco = on;
    ecoAuto = !!auto;
    if (window.DevTowerCrew) window.DevTowerCrew.setEco(on);
    $("#ecobtn").classList.toggle("on", on);
    $("#ecobtn").title = on
      ? `Efficiency mode on${ecoAuto ? " (auto: on battery)" : ""} — click to disable`
      : "Efficiency mode (auto-on when on battery)";
  }
  $("#ecobtn").onclick = () => setEco(!eco, false);
  if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
      const sync = () => { if (!eco || ecoAuto) setEco(!b.charging, true); };
      sync();
      b.addEventListener("chargingchange", sync);
    }).catch(() => {});
  }

  /* ---------- global wiring ---------- */
  $("#prbtn").onclick = () => {
    prboardOpen = !prboardOpen;
    if (prboardOpen) vscode.postMessage({ type: "refreshPrs" });
    renderPrBoard();
    updateInsets();
  };
  $("#themebtn").onclick = () => {
    theme = theme === "dark" ? "light" : "dark";
    document.body.setAttribute("data-theme", theme);
    $("#themebtn").textContent = theme === "dark" ? "☾" : "☀";
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (panelOpen) closePanel();
      else if (prboardOpen) { prboardOpen = false; renderPrBoard(); updateInsets(); }
    }
  });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "state") {
      diffCrew(m.agents || []);
      agents = m.agents || [];
      if (m.selectedId && panelOpen) selectedId = m.selectedId;
      renderTelemetry();
      if (window.DevTowerCrew) window.DevTowerCrew.setRooms(m.rooms || []);
      pushCrew();
      renderPanel();
    } else if (m.type === "changes") {
      changes.set(m.id, m.files || []);
      if (m.id === selectedId) renderPanel();
    } else if (m.type === "prs") {
      prs = { crew: m.crew || [], review: m.review || [] };
      renderPrBoard();
      if (panelOpen) renderPanel();
      // tell the tower which branches have an open PR (shown on each board)
      if (window.DevTowerCrew) {
        const branches = [...prs.crew, ...prs.review].map((p) => p.branch).filter(Boolean);
        window.DevTowerCrew.setPrBranches(branches);
      }
    } else if (m.type === "usage") {
      renderUsage(m.usage);
    }
  });

  mountCrew();
  vscode.postMessage({ type: "ready" });
  vscode.postMessage({ type: "requestPrs" });
})();
