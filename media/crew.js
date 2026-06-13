"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => {
    __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
    return value;
  };

  // src/webview/crew.ts
  var STATE_COLOR = {
    active: "#3ee089",
    waiting: "#ffb13d",
    complete: "#56c7ff",
    error: "#ff6055",
    idle: "#8a9598"
  };
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  var SKINS = ["#f2c8a0", "#e0a87e", "#c68642", "#8d5524", "#ffd9b3", "#a86b3c"];
  var HAIRS = ["#2e2620", "#4a342a", "#16100c", "#7a5230", "#b88a4a", "#55585e", "#6e3a28"];
  var ACCENTS = ["#ff6055", "#56c7ff", "#3ee089", "#ffb13d", "#b98cff", "#ff8fc7"];
  function persona(id) {
    const h = hash(id);
    const hue = h % 360;
    return {
      shirt: `hsl(${hue} 45% 52%)`,
      shirtDark: `hsl(${hue} 48% 38%)`,
      pants: `hsl(${(hue + 200) % 360} 16% 30%)`,
      skin: SKINS[(h >> 3) % SKINS.length],
      hair: HAIRS[(h >> 5) % HAIRS.length],
      acc: (h >> 7) % 4,
      // 0 none, 1 glasses, 2 cap, 3 headphones
      accColor: ACCENTS[(h >> 9) % ACCENTS.length]
    };
  }
  var ROOM_H = 84;
  var SLAB = 8;
  var FLOOR_STEP = ROOM_H + SLAB;
  var WB_W = 42;
  var DESK_W = 26;
  var DOOR_W = 18;
  var DEPTH_X = 24;
  var DEPTH_Y = 22;
  var ROWS_OF_DESKS = 2;
  var FRONT_CAP = 6;
  var ROW_DY = DEPTH_Y;
  var ROOM_W = 260;
  var backWall = (x0, base) => ({
    x0: x0 + DEPTH_X,
    x1: x0 + ROOM_W - DEPTH_X,
    yTop: base - ROOM_H + 10,
    // just below the receded ceiling
    yBot: base - DEPTH_Y
    // far-wall floor line
  });
  var ROLLER_W = 30;
  var ROLLER_H = 22;
  var ROLLER_DEPTH = 13;
  var ROLLER_LEG = 12;
  var rollerPanel = (cx, base) => {
    const stand = base - ROLLER_DEPTH;
    return { x: cx - ROLLER_W / 2, y: stand - ROLLER_LEG - ROLLER_H, w: ROLLER_W, h: ROLLER_H };
  };
  var boardRect = (x0, base) => {
    const bw = backWall(x0, base);
    const left = bw.x0 + 3;
    const right = bw.x1 - 3;
    const top = bw.yTop + 3;
    const bottom = bw.yBot - 5;
    return { x: left, y: top, w: Math.max(20, right - left), h: Math.max(14, bottom - top) };
  };
  var COL_STEP = ROOM_W;
  var cellX0 = (col) => col * COL_STEP - ROOM_W / 2;
  var WALK_SPEED = 30;
  var ISLAND_GAP = 1;
  var PLINTH_H = 22;
  var PLINTH_APRON = 8;
  var PLINTH_OV = 9;
  var GROUP_GAP = 1;
  var DEFAULT_BRANCHES = /* @__PURE__ */ new Set(["main", "master", "head", "develop", "trunk"]);
  var floorBase = (floor) => -floor * FLOOR_STEP;
  var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function sampleQuad(p0, c, p1, n) {
    const pts = [];
    for (let i = 1; i <= n; i++) {
      const t = i / n, mt = 1 - t;
      pts.push({
        x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
        y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y
      });
    }
    return pts;
  }
  function pointOnPath(path, t) {
    if (path.length === 1)
      return path[0];
    const segs = [];
    let total = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const len = Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
      segs.push(len);
      total += len;
    }
    if (total === 0)
      return path[0];
    let d = clamp(t, 0, 1) * total;
    for (let i = 0; i < segs.length; i++) {
      if (d <= segs[i] || i === segs.length - 1) {
        const f = segs[i] === 0 ? 0 : d / segs[i];
        return { x: path[i].x + (path[i + 1].x - path[i].x) * f, y: path[i].y + (path[i + 1].y - path[i].y) * f };
      }
      d -= segs[i];
    }
    return path[path.length - 1];
  }
  var PixelCrew = class {
    constructor(container, canvas) {
      this.container = container;
      this.canvas = canvas;
      __publicField(this, "ctx");
      __publicField(this, "toons", /* @__PURE__ */ new Map());
      __publicField(this, "leaving", []);
      __publicField(this, "rooms", /* @__PURE__ */ new Map());
      // key = building key (worktree path)
      __publicField(this, "islands", /* @__PURE__ */ new Map());
      // key = island name (repo)
      __publicField(this, "reserved", []);
      __publicField(this, "agents", []);
      __publicField(this, "particles", []);
      __publicField(this, "packets", []);
      // desk → board "file changed" trails
      __publicField(this, "boardsMap", {});
      __publicField(this, "hasFitted", false);
      // first layout fits the campus; later ones preserve the view
      // ghost slots come in two kinds: "building" extends an island with the next
      // worktree (click → add agent there), "island" reserves a brand-new directory.
      __publicField(this, "ghosts", []);
      __publicField(this, "colRange", /* @__PURE__ */ new Map());
      __publicField(this, "bounds", { minX: -120, maxX: 120, topY: -120, botY: 40, minFloor: 0 });
      __publicField(this, "focusRoom_", null);
      __publicField(this, "focusAgentId", null);
      // when set, the camera tracks this dev (not the room)
      __publicField(this, "prBranches", /* @__PURE__ */ new Set());
      // branches (lowercased) with an open PR
      __publicField(this, "focus", { x: 0, y: -ROOM_H / 2, spanW: ROOM_W + 60, spanH: FLOOR_STEP + 60 });
      __publicField(this, "cam", { x: 0, y: -ROOM_H / 2, z: 4 });
      __publicField(this, "zoomMul", 1);
      __publicField(this, "panX", 0);
      __publicField(this, "panY", 0);
      __publicField(this, "drag", { active: false, moved: false, lastX: 0, lastY: 0 });
      // dragging a toon onto a room (or a ghost cell) issues a /cd for that agent
      __publicField(this, "toonDrag", null);
      __publicField(this, "dropTarget", null);
      __publicField(this, "running", false);
      __publicField(this, "raf", 0);
      __publicField(this, "lastNow", 0);
      __publicField(this, "acc", 0);
      __publicField(this, "frame", 0);
      __publicField(this, "dirty", true);
      __publicField(this, "eco", false);
      // HUD overlays (agent panel / PR board) cover the canvas edges; inset the
      // viewport so rooms frame into the visible area and stay clickable
      __publicField(this, "insetL", 0);
      __publicField(this, "insetR", 0);
      __publicField(this, "selectedId");
      __publicField(this, "onSelectCb", () => {
      });
      __publicField(this, "onReserveCb", () => {
      });
      __publicField(this, "onAddDevCb", () => {
      });
      __publicField(this, "onAddWorktreeCb", () => {
      });
      __publicField(this, "onRemoveRoomCb", () => {
      });
      __publicField(this, "onRemoveWorktreeCb", () => {
      });
      __publicField(this, "onCdCb", () => {
      });
      __publicField(this, "resizeT");
      __publicField(this, "newToonIds", /* @__PURE__ */ new Set());
      this.ctx = canvas.getContext("2d");
      new ResizeObserver(() => {
        clearTimeout(this.resizeT);
        this.resizeT = setTimeout(() => this.resize(), 80);
      }).observe(container);
      this.resize();
      document.fonts?.ready?.then(() => {
        this.invalidate();
      });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden)
          this.stop();
        else
          this.start();
      });
      const canvasXY = (e) => {
        const rect = canvas.getBoundingClientRect();
        return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
      };
      canvas.addEventListener("pointerdown", (e) => {
        canvas.setPointerCapture(e.pointerId);
        const hit = this.pick(e);
        if (hit.agent) {
          const { mx, my } = canvasXY(e);
          const blocked = this.toons.get(hit.agent)?.agent.state === "active";
          this.toonDrag = { id: hit.agent, active: false, mx, my, blocked };
          return;
        }
        this.drag.active = true;
        this.drag.moved = false;
        this.drag.lastX = e.clientX;
        this.drag.lastY = e.clientY;
      });
      canvas.addEventListener("pointermove", (e) => {
        if (this.toonDrag) {
          const { mx, my } = canvasXY(e);
          if (!this.toonDrag.active && Math.abs(mx - this.toonDrag.mx) + Math.abs(my - this.toonDrag.my) > 4) {
            this.toonDrag.active = true;
          }
          this.toonDrag.mx = mx;
          this.toonDrag.my = my;
          if (this.toonDrag.active) {
            if (this.toonDrag.blocked) {
              this.dropTarget = null;
              this.container.style.cursor = "not-allowed";
              this.invalidate();
              return;
            }
            const hit = this.pick(e);
            if (hit.island && !hit.ghost)
              this.dropTarget = { room: hit.island };
            else if (hit.ghost?.kind === "building" && hit.ghost.island)
              this.dropTarget = { room: hit.ghost.island };
            else if (hit.ghost?.kind === "island")
              this.dropTarget = { ghost: { floor: hit.ghost.floor, col: hit.ghost.col } };
            else
              this.dropTarget = null;
            this.container.style.cursor = this.dropTarget ? "copy" : "grabbing";
            this.invalidate();
          }
          return;
        }
        if (!this.drag.active) {
          const hit = this.pick(e);
          this.container.style.cursor = hit.agent || hit.room || hit.ghost || hit.addDev || hit.removeBtn || hit.removeWtBtn ? "pointer" : "default";
          return;
        }
        const dx = e.clientX - this.drag.lastX;
        const dy = e.clientY - this.drag.lastY;
        if (this.drag.moved || Math.abs(dx) + Math.abs(dy) > 4) {
          this.drag.moved = true;
          this.drag.lastX = e.clientX;
          this.drag.lastY = e.clientY;
          const limX = (this.bounds.maxX - this.bounds.minX) / 2 + ROOM_W;
          const limY = (this.bounds.botY - this.bounds.topY) / 2 + FLOOR_STEP;
          this.panX = clamp(this.panX - dx / this.cam.z, -limX, limX);
          this.panY = clamp(this.panY - dy / this.cam.z, -limY, limY);
          this.container.style.cursor = "grabbing";
          this.invalidate();
        }
      });
      const endDrag = (e) => {
        if (this.toonDrag) {
          const td = this.toonDrag;
          this.toonDrag = null;
          this.container.style.cursor = "default";
          if (!td.active) {
            this.onClick(e);
          } else if (this.dropTarget) {
            this.onCdCb(td.id, this.dropTarget);
          }
          this.dropTarget = null;
          this.invalidate();
          return;
        }
        if (!this.drag.active)
          return;
        const wasDrag = this.drag.moved;
        this.drag.active = false;
        this.drag.moved = false;
        this.container.style.cursor = "default";
        if (!wasDrag)
          this.onClick(e);
      };
      canvas.addEventListener("pointerup", endDrag);
      canvas.addEventListener("pointercancel", () => {
        this.drag.active = false;
        this.drag.moved = false;
        this.toonDrag = null;
        this.dropTarget = null;
        this.invalidate();
      });
      canvas.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          this.zoomMul = clamp(this.zoomMul * (1 - e.deltaY * 12e-4), 0.35, 4);
          this.invalidate();
        },
        { passive: false }
      );
    }
    onSelect(cb) {
      this.onSelectCb = cb;
    }
    onReserve(cb) {
      this.onReserveCb = cb;
    }
    onAddDev(cb) {
      this.onAddDevCb = cb;
    }
    onAddWorktree(cb) {
      this.onAddWorktreeCb = cb;
    }
    onRemoveRoom(cb) {
      this.onRemoveRoomCb = cb;
    }
    onRemoveWorktree(cb) {
      this.onRemoveWorktreeCb = cb;
    }
    onCd(cb) {
      this.onCdCb = cb;
    }
    /* ============ DATA ============ */
    setRooms(reserved) {
      this.reserved = reserved || [];
      this.layout();
    }
    /** Live board data per worktree path (modified/staged/commits/PR), shown on
     *  each room's back-wall screen. */
    setBoards(boards) {
      this.boardsMap = boards || {};
      this.layout();
    }
    /** Branches that currently have an open PR; shown on each worktree's board. */
    setPrBranches(branches) {
      this.prBranches = new Set((branches || []).filter(Boolean).map((b) => b.toLowerCase()));
      this.invalidate();
    }
    setAgents(agents) {
      const seen = new Set(agents.map((a) => a.id));
      for (const [id, tn] of this.toons) {
        if (!seen.has(id)) {
          tn.leaving = true;
          this.leaving.push(tn);
          this.toons.delete(id);
        }
      }
      for (const a of agents) {
        let tn = this.toons.get(a.id);
        if (!tn) {
          tn = {
            agent: a,
            p: persona(a.id),
            x: 0,
            targetX: 0,
            base: 0,
            x0: 0,
            seatCol: 0,
            wbSlot: 0,
            deskIdx: 0,
            row: 0,
            lift: 0,
            huddle: false,
            sitting: false,
            entering: true,
            leaving: false,
            ph: hash(a.id) % 628 / 100
          };
          this.toons.set(a.id, tn);
          this.newToonIds.add(a.id);
        }
        tn.agent = a;
      }
      this.agents = agents;
      this.layout();
    }
    /** Group a room's agents into per-worktree desk blocks. The main worktree
     *  (default branch, or a "." / root checkout) comes first and is labelled
     *  "main"; each other worktree gets a contiguous block of columns after a
     *  one-column partition gap, signed with its branch. */
    seatPlan(agents) {
      const byTree = /* @__PURE__ */ new Map();
      for (const a of agents) {
        const key = a.worktree && a.worktree.trim() ? a.worktree : ".";
        if (!byTree.has(key))
          byTree.set(key, []);
        byTree.get(key).push(a);
      }
      const isMain = (key, ags) => key === "." || key === "" || DEFAULT_BRANCHES.has((ags[0].branch ?? "").toLowerCase());
      const treeName = (key) => key.split(/[\\/]/).pop() || key;
      const entries = [...byTree.entries()].sort((a, b) => {
        const am = isMain(a[0], a[1]) ? 0 : 1;
        const bm = isMain(b[0], b[1]) ? 0 : 1;
        if (am !== bm)
          return am - bm;
        return treeName(a[0]) < treeName(b[0]) ? -1 : 1;
      });
      const seats = /* @__PURE__ */ new Map();
      const groups = [];
      let startCol = 0;
      let mainTaken = false;
      for (const [key, ags] of entries) {
        ags.forEach((a, i) => {
          let row = Math.floor(i / FRONT_CAP);
          let col = i % FRONT_CAP;
          if (row > ROWS_OF_DESKS - 1) {
            row = ROWS_OF_DESKS - 1;
            col = i - row * FRONT_CAP;
          }
          seats.set(a.id, { col: startCol + col, row });
        });
        const cols = Math.max(1, Math.min(ags.length, FRONT_CAP));
        const main = !mainTaken && isMain(key, ags);
        if (main)
          mainTaken = true;
        groups.push({
          name: main ? "main" : treeName(key),
          branch: ags[0].branch || "\u2014",
          isMain: main,
          startCol,
          cols,
          hue: main ? 150 : hash(key) % 360
        });
        startCol += cols + GROUP_GAP;
      }
      const totalCols = Math.max(0, startCol - GROUP_GAP);
      const span = ROOM_W - WB_W - DOOR_W - DESK_W;
      const pitch = totalCols > 1 ? Math.min(DESK_W, span / (totalCols - 1)) : DESK_W;
      return { seats, groups, totalCols, pitch };
    }
    /** World x of a seat (col/row) within a room, using the room's compressed
     *  column pitch so desks, chairs and signs all line up and stay inside. */
    seatX(r, col, row) {
      const pitch = r.plan?.pitch ?? DESK_W;
      return r.x0 + WB_W + col * pitch + row * (pitch / 2);
    }
    /** An island's ordered rooms: ONLY the ones the operator added — the required
     *  main checkout plus each assigned worktree. Live agents attach by checkout
     *  path; agents in unassigned dirs aren't shown. Main leads. */
    planBuildings(reserved, agentsByKey) {
      const rootKey = reserved.path;
      const treeName = (key) => key.split(/[\\/]/).pop() || key;
      const branchByKey = /* @__PURE__ */ new Map();
      branchByKey.set(rootKey, "");
      for (const w of reserved.worktrees ?? []) {
        if (!branchByKey.get(w.path))
          branchByKey.set(w.path, w.branch || "");
      }
      const keys = [rootKey, ...[...branchByKey.keys()].filter((k) => k !== rootKey)];
      return keys.map((key) => {
        const agents = agentsByKey.get(key) ?? [];
        const isMain = key === rootKey;
        const branch = branchByKey.get(key) || agents[0]?.branch || "";
        return {
          key,
          agents,
          isMain,
          path: rootKey,
          branch: branch || "\u2014",
          label: isMain ? "main" : branch || treeName(key)
        };
      });
    }
    /** Re-aim a toon at its desk/huddle spot using its building's CURRENT (tweening)
     *  position, so seated devs ride a collapsing island instead of snapping. */
    retargetToon(tn) {
      const room = tn.bkey ? this.rooms.get(tn.bkey) : void 0;
      if (!room)
        return;
      tn.base = room.baseY;
      tn.x0 = room.x0;
      const deskX = this.seatX(room, tn.seatCol, tn.row);
      if (tn.huddle)
        tn.targetX = room.x0 + 26 + tn.wbSlot * 9;
      else if (tn.agent.state === "active")
        tn.targetX = deskX + 13;
      else
        tn.targetX = deskX + 19;
    }
    /** The cable port: a jack on the wall just BELOW the TV that every desk's
     *  cable runs into. The light-ball then hops up from here into the screen. */
    cablePlug(r) {
      const b = boardRect(r.x0, r.baseY);
      return { x: b.x + b.w / 2, y: b.y + b.h + 5 };
    }
    /** The cable polyline for a seat: computer → floor → a curved sweep to the
     *  central floor bus → up the middle into the port below the screen. All
     *  desks share the central bus, so the cables bundle before going in. */
    cableRoute(r, seat) {
      const base = r.baseY;
      const dx = this.seatX(r, seat.col, seat.row);
      const db = base - seat.row * ROW_DY;
      const cx = dx + 8;
      const C = { x: cx, y: db - 12 };
      const F = { x: cx, y: db + 0.5 };
      const J = { x: r.x0 + ROOM_W / 2, y: base - 3 };
      const P = this.cablePlug(r);
      const cFJ = { x: (cx + J.x) / 2, y: Math.max(F.y, J.y) + 5 };
      const cJP = { x: J.x, y: (J.y + P.y) / 2 };
      return [C, F, ...sampleQuad(F, cFJ, J, 8), ...sampleQuad(J, cJP, P, 10)];
    }
    /** Fire a glowing light-ball from a working dev's computer along its network
     *  cable, through the port, and up into the screen — the "git changed" signal.
     *  Falls back to a room-centre → port route when no dev/seat is known. */
    emitPacket(r) {
      const b = boardRect(r.x0, r.baseY);
      const plug = this.cablePlug(r);
      const screen = { x: b.x + b.w / 2, y: b.y + b.h * 0.5 };
      const occ = r.agents.find((a) => this.toons.get(a.id)?.sitting) ?? r.agents[0];
      const seat = occ ? r.plan?.seats.get(occ.id) : void 0;
      const cable = seat ? this.cableRoute(r, seat) : [{ x: r.x0 + ROOM_W / 2, y: r.baseY - 16 }, plug];
      const path = [...cable, screen];
      const s = path[0];
      this.packets.push({
        x: s.x,
        y: s.y,
        sx: s.x,
        sy: s.y,
        tx: screen.x,
        ty: screen.y,
        t: 0,
        path,
        color: Math.random() < 0.6 ? "#3ee089" : "#56c7ff"
      });
    }
    /** Draw each occupied desk's network cable: computer → floor → a curved sweep
     *  to the central floor bus → up into the port below the screen. Static art;
     *  the light-balls (packets) ride this same route when git changes. */
    drawCables(ctx, r) {
      if (r.built < 0.85 || !r.plan)
        return;
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (const [, seat] of r.plan.seats) {
        const route = this.cableRoute(r, seat);
        ctx.beginPath();
        ctx.moveTo(route[0].x, route[0].y);
        for (let i = 1; i < route.length; i++)
          ctx.lineTo(route[i].x, route[i].y);
        ctx.strokeStyle = "rgba(12,16,20,0.4)";
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.strokeStyle = "rgba(80,102,122,0.4)";
        ctx.lineWidth = 0.5;
        ctx.stroke();
        ctx.fillStyle = "#2a3138";
        ctx.fillRect(route[0].x - 1, route[0].y - 1, 2, 2);
      }
      const plug = this.cablePlug(r);
      ctx.fillStyle = "#10161c";
      ctx.fillRect(plug.x - 4, plug.y - 1.5, 8, 3);
      ctx.fillStyle = "#2a3138";
      ctx.fillRect(plug.x - 3, plug.y - 0.6, 6, 1.2);
      ctx.restore();
    }
    /** Build the campus: only rooms the operator added (reserved islands + their
     *  assigned worktrees) render. Live agents attach to those rooms by their
     *  checkout path; an agent whose room wasn't added simply isn't shown (its
     *  session keeps running regardless). */
    layout() {
      const agentsByKey = /* @__PURE__ */ new Map();
      for (const a of this.agents) {
        const key = a.worktree && a.worktree.trim() ? a.worktree : null;
        if (!key)
          continue;
        if (!agentsByKey.has(key))
          agentsByKey.set(key, []);
        agentsByKey.get(key).push(a);
      }
      const reservedByName = new Map(this.reserved.map((r) => [r.name, r]));
      const order = [...this.reserved].sort((a, b) => a.col - b.col || a.floor - b.floor || (a.name < b.name ? -1 : 1)).map((r) => r.name);
      const wanted = /* @__PURE__ */ new Map();
      this.islands.clear();
      let lane = 0;
      for (const name of order) {
        const reserved = reservedByName.get(name);
        if (!reserved)
          continue;
        const buildings = this.planBuildings(reserved, agentsByKey);
        const path = reserved.path;
        buildings.forEach((b, i) => {
          wanted.set(b.key, {
            island: name,
            label: b.label,
            branch: b.branch,
            isMain: b.isMain,
            col: lane,
            floor: i,
            path: b.path ?? path,
            agents: b.agents
          });
        });
        this.islands.set(name, {
          name,
          path,
          laneStart: lane,
          cols: 1,
          count: buildings.length,
          hue: hash(name) % 360
        });
        lane += 1 + ISLAND_GAP;
      }
      for (const [key, room] of this.rooms) {
        room.dying = !wanted.has(key);
        if (room.dying)
          room.agents = [];
      }
      let newIdx = 0;
      for (const [key, info] of wanted) {
        let room = this.rooms.get(key);
        if (!room) {
          room = {
            name: key,
            island: info.island,
            label: info.label,
            branch: info.branch,
            isMain: info.isMain,
            floor: info.floor,
            col: info.col,
            x0: cellX0(info.col),
            baseY: floorBase(info.floor),
            path: info.path,
            hue: hash(info.island) % 360,
            built: 0,
            delay: newIdx++ * 0.45,
            // buildings rise one after another
            agents: [],
            scribbles: [],
            decor: hash(key + "decor"),
            statSig: "",
            statPulse: 0
          };
          this.rooms.set(key, room);
        }
        room.island = info.island;
        room.label = info.label;
        room.branch = info.branch;
        room.isMain = info.isMain;
        room.board = this.boardsMap[key];
        room.floor = info.floor;
        room.col = info.col;
        room.path = info.path ?? room.path;
        room.agents = info.agents;
        room.hasUpper = false;
      }
      for (const r of this.rooms.values()) {
        if (r.dying)
          continue;
        for (const u of this.rooms.values()) {
          if (!u.dying && u.island === r.island && u.col === r.col && u.floor === r.floor + 1) {
            r.hasUpper = true;
            break;
          }
        }
      }
      this.ghosts = [];
      for (const isl of this.islands.values()) {
        const floor = isl.count;
        this.ghosts.push({
          col: isl.laneStart,
          floor,
          x0: cellX0(isl.laneStart),
          base: floorBase(floor),
          kind: "building",
          island: isl.name
        });
      }
      const reserveCol = this.islands.size === 0 ? 0 : lane;
      this.ghosts.push({
        col: reserveCol,
        floor: 0,
        x0: cellX0(reserveCol),
        base: floorBase(0),
        kind: "island"
      });
      this.colRange.clear();
      let minX = Infinity, maxX = -Infinity, topY = Infinity, botY = -Infinity, minFloor = 0;
      const extend = (floor, x0, base) => {
        minX = Math.min(minX, x0);
        maxX = Math.max(maxX, x0 + ROOM_W);
        topY = Math.min(topY, base - ROOM_H);
        botY = Math.max(botY, base + SLAB + PLINTH_APRON + PLINTH_H + 2);
        minFloor = Math.min(minFloor, floor);
      };
      for (const r of this.rooms.values()) {
        const rng = this.colRange.get(r.col) ?? { min: r.floor, max: r.floor };
        rng.min = Math.min(rng.min, r.floor);
        rng.max = Math.max(rng.max, r.floor);
        this.colRange.set(r.col, rng);
        extend(r.floor, cellX0(r.col), floorBase(r.floor));
      }
      for (const g of this.ghosts)
        extend(g.floor, g.x0, g.base);
      if (!isFinite(minX)) {
        minX = -120;
        maxX = 120;
        topY = -120;
        botY = 40;
      }
      this.bounds = { minX, maxX, topY, botY, minFloor };
      const placed = /* @__PURE__ */ new Set();
      for (const room of this.rooms.values()) {
        const activeCount = room.agents.filter((a) => a.state === "active").length;
        const huddle = activeCount >= 2;
        let wbSlot = 0;
        room.plan = this.seatPlan(room.agents);
        room.agents.forEach((a, di) => {
          const tn = this.toons.get(a.id);
          if (!tn)
            return;
          placed.add(a.id);
          tn.bkey = room.name;
          tn.deskIdx = di;
          const seat = room.plan.seats.get(a.id) ?? { col: 0, row: 0 };
          tn.row = seat.row;
          tn.seatCol = seat.col;
          tn.huddle = a.state === "active" && huddle;
          if (tn.huddle)
            tn.wbSlot = wbSlot++;
          const firstPlace = tn.entering && tn.x === 0;
          this.retargetToon(tn);
          if (firstPlace) {
            if (room.floor > 0) {
              tn.x = room.x0 + ROOM_W - 40;
              tn.base = floorBase(room.floor - 1);
              tn.targetX = tn.x;
              tn.enterPhase = "stairs";
              tn.stairTopX = room.x0 + ROOM_W - 24;
            } else {
              tn.x = room.x0 + ROOM_W + 8;
              tn.enterPhase = "walk";
            }
          }
        });
        if (!huddle)
          room.scribbles = [];
      }
      for (const [id, tn] of this.toons) {
        if (!placed.has(id)) {
          tn.bkey = void 0;
          this.toons.delete(id);
        }
      }
      if (this.focusAgentId && this.toons.has(this.focusAgentId))
        this.focusAgent(this.focusAgentId, false);
      else if (this.focusRoom_ && this.rooms.has(this.focusRoom_))
        this.focusOn(this.focusRoom_, false);
      else if (!this.hasFitted) {
        this.clearFocus(true, false);
        this.hasFitted = true;
      }
      this.invalidate();
    }
    /* ============ CAMERA ============ */
    /** Center on a building (by its key) or, failing that, on an island (by repo
     *  name → that island's first building). */
    focusOn(name, resetZoom = true) {
      let r = this.rooms.get(name);
      if (!r)
        r = [...this.rooms.values()].find((b) => b.island === name);
      if (!r)
        return;
      this.focusAgentId = null;
      this.focusRoom_ = r.name;
      this.focus.x = r.x0 + ROOM_W / 2;
      this.focus.y = r.baseY - ROOM_H / 2;
      this.focus.spanW = ROOM_W + 26;
      this.focus.spanH = FLOOR_STEP + 34;
      this.panX = 0;
      this.panY = 0;
      if (resetZoom)
        this.zoomMul = 1;
      this.invalidate();
    }
    /** Tight zoom onto one agent (their corner of the room). On the initial click
     *  (resetZoom) we recentre; periodic re-layouts call it with resetZoom=false to
     *  keep tracking the dev without fighting the operator's pan/zoom. */
    focusAgent(id, resetZoom = true) {
      const tn = this.toons.get(id);
      if (!tn)
        return;
      const room = tn.bkey ? this.rooms.get(tn.bkey) : void 0;
      this.focusAgentId = id;
      this.focusRoom_ = room?.name ?? null;
      this.focus.x = tn.targetX;
      this.focus.y = tn.base - ROOM_H / 2 + 6;
      this.focus.spanW = 96;
      this.focus.spanH = FLOOR_STEP + 18;
      if (resetZoom) {
        this.panX = 0;
        this.panY = 0;
        this.zoomMul = 1;
      }
      this.invalidate();
    }
    clearFocus(resetZoom = true, preservePan = false) {
      this.focusRoom_ = null;
      this.focusAgentId = null;
      this.focus.x = (this.bounds.minX + this.bounds.maxX) / 2;
      this.focus.y = (this.bounds.topY + this.bounds.botY) / 2;
      this.focus.spanW = this.bounds.maxX - this.bounds.minX + 60;
      this.focus.spanH = this.bounds.botY - this.bounds.topY + 46;
      if (!preservePan) {
        this.panX = 0;
        this.panY = 0;
      }
      if (resetZoom)
        this.zoomMul = 1;
      this.invalidate();
    }
    setSelected(id) {
      this.selectedId = id;
      if (id && this.newToonIds.has(id)) {
        this.newToonIds.delete(id);
        this.focusAgent(id);
      }
      this.invalidate();
    }
    setEco(on) {
      this.eco = on;
      this.invalidate();
    }
    resize() {
      const dpr = Math.min(window.devicePixelRatio, 2);
      const w = this.container.clientWidth || 1;
      const h = this.container.clientHeight || 1;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + "px";
      this.canvas.style.height = h + "px";
      this.invalidate();
    }
    targetZoom() {
      const cw = Math.max(80, (this.container.clientWidth || 1) - this.insetL - this.insetR);
      const ch = this.container.clientHeight || 1;
      const fitW = cw * 0.9 / this.focus.spanW;
      const fitH = ch * 0.86 / this.focus.spanH;
      return clamp(Math.min(fitW, fitH) * this.zoomMul, 0.7, 14);
    }
    /* ============ LOOP ============ */
    start() {
      if (this.running)
        return;
      this.running = true;
      this.lastNow = performance.now();
      const loop = (now) => {
        if (!this.running)
          return;
        const dt = Math.min(250, now - this.lastNow);
        this.lastNow = now;
        const tickMs = this.eco ? 166 : 100;
        this.acc += dt;
        let ticked = false;
        while (this.acc >= tickMs) {
          this.acc -= tickMs;
          this.frame++;
          this.tick(tickMs / 1e3);
          ticked = true;
        }
        const tz = this.targetZoom();
        const tx = this.focus.x + this.panX;
        const ty = this.focus.y + this.panY;
        const moving = Math.abs(this.cam.x - tx) > 0.05 || Math.abs(this.cam.y - ty) > 0.05 || Math.abs(this.cam.z - tz) > 0.01;
        if (moving) {
          const k = Math.min(1, dt / 1e3 * 5);
          this.cam.x += (tx - this.cam.x) * k;
          this.cam.y += (ty - this.cam.y) * k;
          this.cam.z += (tz - this.cam.z) * k;
        }
        if (ticked || moving || this.dirty) {
          this.dirty = false;
          this.draw();
        }
        if (!moving && !this.dirty && this.sceneIdle()) {
          this.running = false;
          return;
        }
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
    stop() {
      this.running = false;
      cancelAnimationFrame(this.raf);
    }
    /** Wake the loop after a state change; no-op while hidden or already running. */
    wake() {
      if (!this.running && !document.hidden)
        this.start();
    }
    /** Mark a redraw is needed and ensure the loop is running. */
    invalidate() {
      this.dirty = true;
      this.wake();
    }
    /** True when nothing needs animating, so the loop can park until woken. */
    sceneIdle() {
      if (this.particles.length || this.leaving.length || this.packets.length)
        return false;
      for (const r of this.rooms.values()) {
        if (r.dying || r.delay > 0 || r.built < 1 || r.statPulse > 0.02)
          return false;
        if (Math.abs(cellX0(r.col) - r.x0) > 0.5 || Math.abs(floorBase(r.floor) - r.baseY) > 0.5)
          return false;
      }
      for (const tn of this.toons.values()) {
        if (tn.entering || Math.abs(tn.targetX - tn.x) > 1)
          return false;
        const s = tn.agent.state;
        if (s === "active" || s === "waiting")
          return false;
      }
      return true;
    }
    /* ============ TICK ============ */
    tick(dt) {
      const demolished = [];
      for (const r of this.rooms.values()) {
        if (!r.dying) {
          const tx = cellX0(r.col), ty = floorBase(r.floor);
          const k = Math.min(1, dt * 6);
          r.x0 += (tx - r.x0) * k;
          r.baseY += (ty - r.baseY) * k;
          if (Math.abs(tx - r.x0) < 0.4)
            r.x0 = tx;
          if (Math.abs(ty - r.baseY) < 0.4)
            r.baseY = ty;
        }
        if (r.dying) {
          const hasLeaver = this.leaving.some((t) => t.bkey === r.name);
          if (!hasLeaver) {
            r.built = Math.max(0, r.built - dt / 1);
            if (!this.eco) {
              this.particles.push({
                x: r.x0 + Math.random() * ROOM_W * Math.max(0.1, r.built),
                y: r.baseY - 2 - Math.random() * 10,
                vx: (Math.random() - 0.5) * 10,
                vy: -4 - Math.random() * 6,
                life: 0.7,
                color: "#9a8a72",
                size: 1.2,
                gravity: 14
              });
            }
            if (r.built <= 0)
              demolished.push(r.name);
          }
          continue;
        }
        if (r.delay > 0) {
          r.delay -= dt;
          continue;
        }
        if (r.built < 1) {
          r.built = Math.min(1, r.built + dt / 1.4);
          if (!this.eco) {
            this.particles.push({
              x: r.x0 + Math.random() * ROOM_W * r.built,
              y: r.baseY - 2 - Math.random() * 10,
              vx: (Math.random() - 0.5) * 10,
              vy: -4 - Math.random() * 6,
              life: 0.7,
              color: "#9a8a72",
              size: 1.2,
              gravity: 14
            });
          }
        }
      }
      if (demolished.length) {
        for (const name of demolished)
          this.rooms.delete(name);
        this.layout();
      }
      for (const r of this.rooms.values()) {
        if (r.statPulse > 0)
          r.statPulse = Math.max(0, r.statPulse - dt * 1.4);
        const b = r.board;
        const sig = b ? `${b.modified}|${b.staged}|${b.ahead}|${b.committedAdd}|${b.committedDel}|${b.commits.length}` : "none";
        if (r.statSig === "") {
          r.statSig = sig;
          continue;
        }
        if (sig !== r.statSig && r.built > 0.6) {
          const burst = this.eco ? 1 : 4;
          for (let i = 0; i < burst; i++)
            this.emitPacket(r);
          r.statPulse = 1;
        }
        r.statSig = sig;
      }
      for (let i = this.packets.length - 1; i >= 0; i--) {
        const p = this.packets[i];
        p.t += dt * 1.3;
        const e = Math.min(1, p.t);
        if (p.path && p.path.length >= 2) {
          const pos = pointOnPath(p.path, e * e * (3 - 2 * e));
          p.x = pos.x;
          p.y = pos.y;
        } else {
          const ease = e * e * (3 - 2 * e);
          p.x = p.sx + (p.tx - p.sx) * ease;
          p.y = p.sy + (p.ty - p.sy) * ease - Math.sin(ease * Math.PI) * 16;
        }
        if (p.t >= 1)
          this.packets.splice(i, 1);
      }
      for (const tn of this.toons.values()) {
        if (!tn.leaving && !tn.entering)
          this.retargetToon(tn);
      }
      for (const tn of this.toons.values()) {
        if (!tn.entering || tn.enterPhase !== "stairs")
          continue;
        const room = tn.bkey ? this.rooms.get(tn.bkey) : void 0;
        if (!room) {
          tn.enterPhase = "walk";
          continue;
        }
        tn.climbing = true;
        const k = Math.min(1, dt * 4);
        const tx = tn.stairTopX ?? tn.x;
        tn.x += (tx - tn.x) * k;
        tn.base += (room.baseY - tn.base) * k;
        if (Math.abs(room.baseY - tn.base) < 2) {
          tn.base = room.baseY;
          tn.climbing = false;
          tn.enterPhase = "walk";
          this.retargetToon(tn);
        }
      }
      const all = [...this.toons.values(), ...this.leaving];
      for (const tn of all) {
        if (tn.entering && tn.enterPhase === "stairs")
          continue;
        const dx = tn.targetX - tn.x;
        if (Math.abs(dx) > 1)
          tn.x += Math.sign(dx) * Math.min(Math.abs(dx), WALK_SPEED * dt);
        else if (tn.entering)
          tn.entering = false;
        tn.sitting = tn.agent.state === "active" && !tn.huddle && !tn.entering && Math.abs(dx) <= 1;
        const atDesk = Math.abs(dx) <= 1 && !tn.entering && !tn.leaving && !tn.huddle;
        const targetLift = atDesk ? tn.row * ROW_DY : 0;
        tn.lift += (targetLift - tn.lift) * Math.min(1, dt * 9);
      }
      for (let i = this.leaving.length - 1; i >= 0; i--) {
        const tn = this.leaving[i];
        tn.climbing = false;
        if (!tn.leavePhase) {
          const floor = Math.round(-tn.base / FLOOR_STEP);
          let maxC = -Infinity;
          for (const r of this.rooms.values()) {
            if (r.floor === floor)
              maxC = Math.max(maxC, r.col);
          }
          const edge = isFinite(maxC) ? cellX0(maxC) + ROOM_W : tn.x0 + ROOM_W;
          tn.targetX = edge + 5;
          tn.leavePhase = "walk";
        }
        const atX = Math.abs(tn.x - tn.targetX) <= 1.5;
        if (tn.leavePhase === "walk" && atX) {
          if (Math.abs(tn.base) > 1) {
            tn.leavePhase = "ladder";
            tn.ladderFrom = tn.base;
            tn.ladderX = tn.x;
          } else {
            tn.leavePhase = "away";
            tn.targetX = tn.x + 28;
          }
        } else if (tn.leavePhase === "ladder") {
          tn.climbing = true;
          const step = Math.min(Math.abs(tn.base), 30 * dt);
          tn.base += Math.sign(-tn.base) * step;
          if (Math.abs(tn.base) <= 0.5) {
            tn.base = 0;
            tn.leavePhase = "away";
            tn.targetX = tn.x + 28;
          }
        } else if (tn.leavePhase === "away" && atX) {
          this.leaving.splice(i, 1);
        }
      }
      for (const r of this.rooms.values()) {
        const huddlers = r.agents.filter((a) => {
          const tn = this.toons.get(a.id);
          return tn?.huddle;
        });
        if (huddlers.length >= 2 && r.scribbles.length < 16 && this.frame % 6 === 0) {
          const wb = rollerPanel(r.x0 + WB_W / 2, r.baseY);
          r.scribbles.push({
            x1: wb.x + 3 + Math.random() * (wb.w - 6),
            y1: wb.y + 3 + Math.random() * (wb.h - 6),
            x2: wb.x + 3 + Math.random() * (wb.w - 6),
            y2: wb.y + 3 + Math.random() * (wb.h - 6),
            color: Math.random() < 0.3 ? "#d9534f" : Math.random() < 0.5 ? "#2b6cb0" : "#2d3438"
          });
        }
      }
      if (!this.eco && this.frame % 14 === 0) {
        for (const tn of this.toons.values()) {
          if (tn.agent.state === "error") {
            this.particles.push({
              x: tn.x + 6,
              y: tn.base - tn.lift - 13,
              vx: 2 + Math.random() * 3,
              vy: -6 - Math.random() * 4,
              life: 1,
              color: "#7a8287",
              size: 1.2,
              gravity: -4
            });
          }
        }
      }
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += p.gravity * dt;
        p.life -= dt * 1.1;
        if (p.life <= 0)
          this.particles.splice(i, 1);
      }
    }
    /* ============ PICKING ============ */
    screenOf(wx, wy) {
      const cw = this.container.clientWidth, ch = this.container.clientHeight;
      const cx = this.insetL + (cw - this.insetL - this.insetR) / 2;
      return {
        x: cx + (wx - this.cam.x) * this.cam.z,
        y: ch / 2 + (wy - this.cam.y) * this.cam.z
      };
    }
    setInsets(left, right) {
      if (this.insetL === left && this.insetR === right)
        return;
      this.insetL = left;
      this.insetR = right;
      this.invalidate();
    }
    inRect(mx, my, wx, wy, ww, wh) {
      const a = this.screenOf(wx, wy);
      const b = this.screenOf(wx + ww, wy + wh);
      return mx > a.x && mx < b.x && my > a.y && my < b.y;
    }
    pick(e) {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      for (const r of this.rooms.values()) {
        if (r.built < 0.95)
          continue;
        const base = r.baseY;
        if (this.inRect(mx, my, r.x0 + ROOM_W - 10, base - ROOM_H + 2, 8, 8)) {
          return r.isMain ? { removeBtn: r.island } : { removeWtBtn: r.name, island: r.island };
        }
        if (this.inRect(mx, my, r.x0 + ROOM_W - DOOR_W - 17, base - ROOM_H + 3, 16, 8)) {
          return { addDev: { island: r.island, key: r.name } };
        }
      }
      for (const g of this.ghosts) {
        if (this.inRect(mx, my, g.x0, g.base - ROOM_H, ROOM_W, ROOM_H)) {
          return { ghost: { floor: g.floor, col: g.col, kind: g.kind, island: g.island } };
        }
      }
      for (const tn of this.toons.values()) {
        const s = this.screenOf(tn.x, tn.base - tn.lift);
        const w = 14 * this.cam.z, h = 22 * this.cam.z;
        if (mx > s.x - w / 2 && mx < s.x + w / 2 && my > s.y - h && my < s.y + 4 * this.cam.z) {
          return { agent: tn.agent.id };
        }
      }
      for (const r of this.rooms.values()) {
        if (this.inRect(mx, my, r.x0, r.baseY - ROOM_H, ROOM_W, ROOM_H + SLAB)) {
          return { room: r.name, island: r.island };
        }
      }
      return {};
    }
    onClick(e) {
      const hit = this.pick(e);
      if (hit.removeWtBtn)
        this.onRemoveWorktreeCb(hit.removeWtBtn, hit.island ?? "");
      else if (hit.removeBtn)
        this.onRemoveRoomCb(hit.removeBtn);
      else if (hit.addDev)
        this.onAddDevCb(hit.addDev.island, hit.addDev.key);
      else if (hit.ghost) {
        if (hit.ghost.kind === "island")
          this.onReserveCb(hit.ghost.floor, hit.ghost.col);
        else if (hit.ghost.island)
          this.onAddWorktreeCb(hit.ghost.island);
      } else if (hit.agent) {
        this.onSelectCb(hit.agent);
        this.focusAgent(hit.agent);
      } else if (hit.room) {
        if (!this.focusAgentId && this.focusRoom_ === hit.room)
          this.clearFocus();
        else
          this.focusOn(hit.room);
      } else
        this.clearFocus();
    }
    /* ============ DRAW ============ */
    draw() {
      const ctx = this.ctx;
      const dpr = Math.min(window.devicePixelRatio, 2);
      const cw = this.container.clientWidth, ch = this.container.clientHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      const grad = ctx.createLinearGradient(0, 0, 0, ch);
      grad.addColorStop(0, "#0a0e14");
      grad.addColorStop(1, "#141b23");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      for (let i = 0; i < 24; i++) {
        const hsh = hash("star" + i);
        ctx.fillRect(hsh % cw, (hsh >> 8) % Math.max(1, Math.round(ch * 0.45)), 1.5, 1.5);
      }
      const z = this.cam.z;
      const cx = this.insetL + (cw - this.insetL - this.insetR) / 2;
      const ox = cx - this.cam.x * z;
      const oy = ch / 2 - this.cam.y * z;
      ctx.setTransform(dpr * z, 0, 0, dpr * z, Math.round(dpr * ox), Math.round(dpr * oy));
      const surfaceY = floorBase(0) + SLAB;
      const { minX, maxX, botY, minFloor } = this.bounds;
      {
        const gx = minX - 80, gw = maxX - minX + 160;
        const apron = PLINTH_APRON;
        const grassFront = surfaceY + apron;
        const dirtBot = botY + 50;
        const dg = ctx.createLinearGradient(0, grassFront, 0, dirtBot);
        dg.addColorStop(0, "#3a2c1d");
        dg.addColorStop(1, "#140d08");
        ctx.fillStyle = dg;
        ctx.fillRect(gx, grassFront, gw, dirtBot - grassFront);
        ctx.fillStyle = "#4a3a26";
        const span = Math.max(1, Math.round(gw));
        const depth = Math.max(1, Math.round(dirtBot - grassFront - 4));
        for (let i = 0; i < 110; i++) {
          const hsh = hash("rock" + i);
          ctx.fillRect(gx + hsh % span, grassFront + 3 + (hsh >> 7) % depth, 2, 1.4);
        }
        const gg = ctx.createLinearGradient(0, surfaceY, 0, grassFront);
        gg.addColorStop(0, "#2f5328");
        gg.addColorStop(1, "#4f7d3f");
        ctx.fillStyle = gg;
        ctx.fillRect(gx, surfaceY, gw, apron);
        ctx.fillStyle = "#5e9149";
        ctx.fillRect(gx, surfaceY, gw, 1.2);
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.fillRect(gx, grassFront, gw, 1.2);
      }
      for (const [col, rng] of this.colRange) {
        const x0 = cellX0(col);
        const roofY = floorBase(rng.max) - ROOM_H;
        ctx.fillStyle = "#2c353e";
        ctx.fillRect(x0 - 1.5, roofY - 3, ROOM_W + 3, 3.4);
      }
      for (const isl of this.islands.values())
        this.drawIslandPlatform(ctx, isl);
      for (const r of this.rooms.values())
        this.drawRoomBack(ctx, r);
      for (const r of this.rooms.values())
        this.drawCables(ctx, r);
      for (const g of this.ghosts)
        this.drawGhost(ctx, g);
      for (const tn of this.leaving) {
        if (tn.ladderFrom === void 0 || tn.ladderX === void 0)
          continue;
        const top = Math.min(0, tn.ladderFrom);
        const bot = Math.max(0, tn.ladderFrom);
        ctx.fillStyle = "#5a646c";
        ctx.fillRect(tn.ladderX - 2.6, top, 0.9, bot - top + 1);
        ctx.fillRect(tn.ladderX + 1.7, top, 0.9, bot - top + 1);
        for (let y = top + 2; y < bot; y += 4) {
          ctx.fillRect(tn.ladderX - 2.6, y, 5.2, 0.8);
        }
      }
      const chair = (dx, db) => {
        ctx.fillStyle = "#3a4046";
        ctx.fillRect(dx + 10, db - 8, 7, 1.6);
        ctx.fillRect(dx + 15.6, db - 14, 1.4, 7);
        ctx.fillRect(dx + 13, db - 6.5, 1.4, 6.5);
      };
      const displayRow = (tn) => tn.lift > ROW_DY / 2 ? 1 : 0;
      const seated = [...this.toons.values()];
      for (let row = ROWS_OF_DESKS - 1; row >= 0; row--) {
        for (const r of this.rooms.values()) {
          if (r.built < 0.7 || !r.plan)
            continue;
          const base = r.baseY;
          for (const [, seat] of r.plan.seats) {
            if (seat.row !== row)
              continue;
            chair(this.seatX(r, seat.col, row), base - row * ROW_DY);
          }
        }
        const rowToons = seated.filter((t) => displayRow(t) === row);
        for (const tn of this.leaving)
          if (displayRow(tn) === row)
            rowToons.push(tn);
        rowToons.sort((a, b) => a.x - b.x);
        for (const tn of rowToons)
          this.drawToon(ctx, tn);
        for (const r of this.rooms.values())
          this.drawDesks(ctx, r, row);
      }
      for (const p of this.particles) {
        ctx.globalAlpha = clamp(p.life, 0, 1);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, p.size, p.size);
      }
      ctx.globalAlpha = 1;
      for (const p of this.packets) {
        const e = Math.min(1, p.t);
        const eased = e * e * (3 - 2 * e);
        const fade = p.t < 0.85 ? 1 : clamp((1 - p.t) / 0.15, 0, 1);
        if (p.path && p.path.length >= 2) {
          for (let k = 1; k <= 4; k++) {
            const tp = pointOnPath(p.path, Math.max(0, eased - k * 0.035));
            const s = 2.4 - k * 0.4;
            ctx.globalAlpha = (0.2 - k * 0.035) * fade;
            ctx.fillStyle = p.color;
            ctx.fillRect(tp.x - s / 2, tp.y - s / 2, s, s);
          }
        }
        ctx.fillStyle = p.color;
        ctx.globalAlpha = 0.4 * fade;
        ctx.fillRect(p.x - 2.6, p.y - 2.6, 5.2, 5.2);
        ctx.globalAlpha = 0.85 * fade;
        ctx.fillRect(p.x - 1.4, p.y - 1.4, 2.8, 2.8);
        ctx.globalAlpha = fade;
        ctx.fillStyle = "#eafff4";
        ctx.fillRect(p.x - 0.7, p.y - 0.7, 1.4, 1.4);
      }
      ctx.globalAlpha = 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.textAlign = "center";
      const xBtn = (r, title) => {
        const base = r.baseY;
        const c1 = this.screenOf(r.x0 + ROOM_W - 10, base - ROOM_H + 2);
        const c2 = this.screenOf(r.x0 + ROOM_W - 2, base - ROOM_H + 10);
        ctx.fillStyle = "rgba(10,15,18,0.8)";
        ctx.fillRect(c1.x, c1.y, c2.x - c1.x, c2.y - c1.y);
        ctx.strokeStyle = "rgba(255,96,85,0.7)";
        ctx.lineWidth = 1;
        ctx.strokeRect(c1.x, c1.y, c2.x - c1.x, c2.y - c1.y);
        ctx.fillStyle = "#ff6055";
        ctx.font = `bold ${clamp(2.8 * this.cam.z, 7, 10)}px monospace`;
        ctx.textAlign = "center";
        ctx.fillText(title, (c1.x + c2.x) / 2, (c1.y + c2.y) / 2 + 3);
      };
      for (const r of this.rooms.values()) {
        if (r.built < 0.95)
          continue;
        const base = r.baseY;
        const b = this.screenOf(r.x0 + ROOM_W - DOOR_W - 17, base - ROOM_H + 3);
        const b2 = this.screenOf(r.x0 + ROOM_W - DOOR_W - 1, base - ROOM_H + 11);
        ctx.fillStyle = "rgba(10,15,18,0.8)";
        ctx.fillRect(b.x, b.y, b2.x - b.x, b2.y - b.y);
        ctx.strokeStyle = "#3ee089";
        ctx.lineWidth = 1;
        ctx.strokeRect(b.x, b.y, b2.x - b.x, b2.y - b.y);
        ctx.fillStyle = "#3ee089";
        ctx.font = `600 ${clamp(3.2 * this.cam.z, 7, 11)}px 'Martian Mono', monospace`;
        ctx.textAlign = "center";
        ctx.fillText("+ DEV", (b.x + b2.x) / 2, (b.y + b2.y) / 2 + 3);
        xBtn(r, "\u2715");
      }
      for (const g of this.ghosts) {
        const s = this.screenOf(g.x0 + ROOM_W / 2, g.base - ROOM_H / 2);
        const building = g.kind === "building";
        ctx.fillStyle = building ? "rgba(110,210,150,0.8)" : "rgba(170,180,186,0.75)";
        ctx.font = `600 ${clamp(3 * this.cam.z, 8, 12)}px 'Martian Mono', monospace`;
        ctx.textAlign = "center";
        ctx.fillText(building ? "+ WORKTREE" : "+ RESERVE", s.x, s.y - 2);
        ctx.font = `${clamp(2.4 * this.cam.z, 7, 10)}px 'IBM Plex Mono', monospace`;
        ctx.fillStyle = "rgba(140,150,156,0.6)";
        ctx.fillText(building ? "new branch room" : "pick a directory", s.x, s.y + 11);
      }
      for (const tn of this.toons.values()) {
        const s = this.screenOf(tn.x, tn.base - tn.lift - 23);
        const st = tn.agent.state;
        ctx.font = "9px 'IBM Plex Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = tn.agent.id === this.selectedId ? "#ffb13d" : "rgba(230,238,240,0.85)";
        ctx.fillText(tn.agent.name, s.x, s.y - 8);
        const glyph = st === "waiting" ? "?" : st === "complete" ? "\u2713" : st === "error" ? "\u2717" : "";
        if (glyph) {
          const bob = st === "waiting" ? Math.sin(this.frame * 0.6 + tn.ph) * 2 : 0;
          const bx = s.x + 10, by = s.y - 24 + bob;
          ctx.fillStyle = "rgba(10,15,18,0.85)";
          ctx.fillRect(bx - 6, by - 8, 12, 12);
          ctx.strokeStyle = STATE_COLOR[st];
          ctx.lineWidth = 1;
          ctx.strokeRect(bx - 6, by - 8, 12, 12);
          ctx.fillStyle = STATE_COLOR[st];
          ctx.font = "bold 9px 'IBM Plex Mono', monospace";
          ctx.fillText(glyph, bx, by + 1.5);
        }
        if (tn.agent.id === this.selectedId) {
          ctx.fillStyle = "#ffb13d";
          ctx.font = "bold 11px monospace";
          ctx.fillText("\u25BE", s.x, s.y - 18 + Math.sin(this.frame * 0.5) * 2);
        }
      }
      if (this.toonDrag?.active)
        this.paintDropHint();
    }
    /** Overlay drawn while a toon is being dragged: highlight the drop target
     *  room/ghost and show the agent name floating at the cursor. */
    paintDropHint() {
      const ctx = this.ctx;
      const dpr = Math.min(window.devicePixelRatio, 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const t = this.dropTarget;
      if (t?.room) {
        const isl = this.islands.get(t.room);
        if (isl) {
          const x0 = cellX0(isl.laneStart);
          const x1 = cellX0(isl.laneStart + isl.cols - 1) + ROOM_W;
          let top = floorBase(0);
          for (const b of this.rooms.values())
            if (b.island === isl.name)
              top = Math.min(top, b.baseY - ROOM_H);
          this.strokeWorldRect(x0, top, x1 - x0, floorBase(0) + SLAB - top, "#7fd1ff");
        }
      } else if (t?.ghost) {
        const g = this.ghosts.find((g2) => g2.floor === t.ghost.floor && g2.col === t.ghost.col);
        if (g)
          this.strokeWorldRect(g.x0, g.base - ROOM_H, ROOM_W, ROOM_H, "#9be38b");
      }
      const d = this.toonDrag;
      const name = this.toons.get(d.id)?.agent.name ?? "agent";
      const label = d.blocked ? `${name} \xB7 active, can't move` : name;
      ctx.font = "11px 'IBM Plex Mono', monospace";
      const w = ctx.measureText(label).width + 14;
      ctx.fillStyle = "rgba(12,16,20,0.92)";
      ctx.fillRect(d.mx + 12, d.my - 9, w, 18);
      ctx.fillStyle = d.blocked ? "#ff9a93" : t ? "#cfe8ff" : "#9aa3ab";
      ctx.fillText(label, d.mx + 19, d.my + 3.5);
    }
    /** Stroke a world-space rectangle in screen space (dashed highlight). */
    strokeWorldRect(wx, wy, ww, wh, color) {
      const ctx = this.ctx;
      const a = this.screenOf(wx, wy);
      const b = this.screenOf(wx + ww, wy + wh);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.restore();
    }
    drawGhost(ctx, g) {
      const building = g.kind === "building";
      ctx.save();
      ctx.strokeStyle = building ? "rgba(110,210,150,0.45)" : "rgba(140,150,156,0.4)";
      ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(g.x0 + 1, g.base - ROOM_H + 1, ROOM_W - 2, ROOM_H - 2);
      ctx.setLineDash([]);
      ctx.strokeStyle = building ? "rgba(110,210,150,0.10)" : "rgba(86,140,180,0.08)";
      for (let gx = g.x0 + 12; gx < g.x0 + ROOM_W - 4; gx += 12) {
        ctx.beginPath();
        ctx.moveTo(gx, g.base - ROOM_H + 3);
        ctx.lineTo(gx, g.base - 3);
        ctx.stroke();
      }
      ctx.restore();
    }
    /** The island's foundation: a plinth spanning its lane at ground level, with a
     *  signpost carrying the repo/directory name. The buildings stand on this. */
    drawIslandPlatform(ctx, isl) {
      const tx0 = cellX0(isl.laneStart);
      const tx1 = cellX0(isl.laneStart + isl.cols - 1) + ROOM_W;
      const ground = floorBase(0) + SLAB;
      const sat = isl.path ? 26 : 14;
      const L = (l) => `hsl(${isl.hue} ${sat}% ${l}%)`;
      const aTop = ground;
      const aBot = ground + PLINTH_APRON;
      const fBot = aBot + PLINTH_H;
      const wx0 = tx0 - PLINTH_OV, wx1 = tx1 + PLINTH_OV;
      ctx.fillStyle = L(9);
      ctx.beginPath();
      ctx.moveTo(tx0, aTop);
      ctx.lineTo(wx0, aBot);
      ctx.lineTo(wx0, fBot);
      ctx.lineTo(tx0, fBot);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(tx1, aTop);
      ctx.lineTo(wx1, aBot);
      ctx.lineTo(wx1, fBot);
      ctx.lineTo(tx1, fBot);
      ctx.closePath();
      ctx.fill();
      const ag = ctx.createLinearGradient(0, aTop, 0, aBot);
      ag.addColorStop(0, L(34));
      ag.addColorStop(1, L(26));
      ctx.fillStyle = ag;
      ctx.beginPath();
      ctx.moveTo(tx0, aTop);
      ctx.lineTo(tx1, aTop);
      ctx.lineTo(wx1, aBot);
      ctx.lineTo(wx0, aBot);
      ctx.closePath();
      ctx.fill();
      const fg = ctx.createLinearGradient(0, aBot, 0, fBot);
      fg.addColorStop(0, L(19));
      fg.addColorStop(1, L(11));
      ctx.fillStyle = fg;
      ctx.fillRect(wx0, aBot, wx1 - wx0, PLINTH_H);
      ctx.fillStyle = L(8);
      ctx.fillRect(wx0, fBot - 2, wx1 - wx0, 2);
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = `hsl(${isl.hue} 50% 80%)`;
      const cx = (wx0 + wx1) / 2;
      const cy = aBot + PLINTH_H / 2 + 1;
      const label = isl.name.toUpperCase();
      let size = PLINTH_H - 10;
      ctx.font = `bold ${size}px 'Martian Mono', monospace`;
      const maxW = wx1 - wx0 - 10;
      while (ctx.measureText(label).width > maxW && size > 6) {
        size -= 0.5;
        ctx.font = `bold ${size}px 'Martian Mono', monospace`;
      }
      ctx.fillText(label, cx, cy);
      ctx.restore();
    }
    drawRoomBack(ctx, r) {
      const base = r.baseY;
      const eFloor = clamp(r.built / 0.35, 0, 1);
      const eWall = clamp((r.built - 0.2) / 0.45, 0, 1);
      const eFurn = clamp((r.built - 0.6) / 0.4, 0, 1);
      const x = r.x0, w = ROOM_W, H = ROOM_H;
      const underground = r.floor < 0;
      const lit = r.agents.length > 0;
      ctx.fillStyle = "#3d2f1f";
      ctx.fillRect(x, base - 1.5, w * eFloor, SLAB - 1);
      ctx.fillStyle = "#4a3a26";
      ctx.fillRect(x, base - 1.5, w * eFloor, 1.2);
      if (eWall <= 0)
        return;
      const grow = eWall;
      const bw = backWall(x, base);
      const topY = base - H * grow;
      const byT = base - (base - bw.yTop) * grow;
      const byB = base - DEPTH_Y * grow;
      const shade = (l) => `hsl(${r.hue} ${underground ? 10 : 15}% ${l}%)`;
      ctx.fillStyle = underground ? "#241c12" : "#2b2218";
      ctx.beginPath();
      ctx.moveTo(x, base);
      ctx.lineTo(x + w, base);
      ctx.lineTo(bw.x1, byB);
      ctx.lineTo(bw.x0, byB);
      ctx.closePath();
      ctx.fill();
      if (grow > 0.5) {
        const fl = ctx.createLinearGradient(0, base, 0, byB);
        if (lit && !underground) {
          fl.addColorStop(0, "rgba(255,208,130,0.20)");
          fl.addColorStop(0.5, "rgba(255,198,120,0.07)");
          fl.addColorStop(1, "rgba(255,198,120,0)");
        } else {
          fl.addColorStop(0, "rgba(150,172,196,0.07)");
          fl.addColorStop(1, "rgba(150,172,196,0)");
        }
        ctx.fillStyle = fl;
        ctx.beginPath();
        ctx.moveTo(x, base);
        ctx.lineTo(x + w, base);
        ctx.lineTo(bw.x1, byB);
        ctx.lineTo(bw.x0, byB);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = shade(underground ? 9 : 11);
      ctx.beginPath();
      ctx.moveTo(x, topY);
      ctx.lineTo(x + w, topY);
      ctx.lineTo(bw.x1, byT);
      ctx.lineTo(bw.x0, byT);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = shade(underground ? 12 : 15);
      ctx.beginPath();
      ctx.moveTo(x, topY);
      ctx.lineTo(bw.x0, byT);
      ctx.lineTo(bw.x0, byB);
      ctx.lineTo(x, base);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + w, topY);
      ctx.lineTo(bw.x1, byT);
      ctx.lineTo(bw.x1, byB);
      ctx.lineTo(x + w, base);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = shade(underground ? 17 : 22);
      ctx.fillRect(bw.x0, byT, bw.x1 - bw.x0, byB - byT);
      ctx.fillStyle = shade(underground ? 12 : 16);
      ctx.fillRect(bw.x0, byB - 2, bw.x1 - bw.x0, 2);
      ctx.fillStyle = "#1a2128";
      ctx.fillRect(x, topY, 1.5, base - topY + 3);
      ctx.fillRect(x + w - 1.5, topY, 1.5, base - topY + 3);
      if (grow >= 1)
        ctx.fillRect(x, base - H - 1.5, w, 1.5);
      if (eFurn <= 0)
        return;
      ctx.globalAlpha = eFurn;
      this.drawBoard(ctx, r, base);
      const onWall = (t, f) => {
        const xL = x + (bw.x0 - x) * t;
        const yT = topY + (byT - topY) * t;
        const yB = base + (byB - base) * t;
        return { x: xL, y: yT + (yB - yT) * f };
      };
      const wp = [onWall(0.3, 0.26), onWall(0.64, 0.3), onWall(0.64, 0.66), onWall(0.3, 0.7)];
      const quad = (pts, fill) => {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++)
          ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
      };
      const mid = (a, c) => ({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
      ctx.strokeStyle = "#0c1116";
      ctx.lineWidth = 3;
      ctx.lineJoin = "miter";
      ctx.beginPath();
      ctx.moveTo(wp[0].x, wp[0].y);
      for (let i = 1; i < 4; i++)
        ctx.lineTo(wp[i].x, wp[i].y);
      ctx.closePath();
      ctx.stroke();
      const ys = Math.min(...wp.map((p) => p.y)), yb = Math.max(...wp.map((p) => p.y));
      if (underground) {
        quad(wp, "#241a12");
      } else {
        const sky = ctx.createLinearGradient(0, ys, 0, yb);
        sky.addColorStop(0, "#2c4a6e");
        sky.addColorStop(1, "#b86a3a");
        quad(wp, sky);
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        const c = mid(wp[0], wp[2]);
        ctx.fillRect(c.x - 2, c.y - 2.5, 4, 1.3);
      }
      ctx.strokeStyle = "#0c1116";
      ctx.lineWidth = 0.8;
      const mt = mid(wp[0], wp[1]), mb = mid(wp[3], wp[2]);
      ctx.beginPath();
      ctx.moveTo(mt.x, mt.y);
      ctx.lineTo(mb.x, mb.y);
      ctx.stroke();
      const ml = mid(wp[0], wp[3]), mr = mid(wp[1], wp[2]);
      ctx.beginPath();
      ctx.moveTo(ml.x, ml.y);
      ctx.lineTo(mr.x, mr.y);
      ctx.stroke();
      const px = x + w - DOOR_W - 6;
      ctx.fillStyle = "#7a4a2a";
      ctx.fillRect(px, base - 4.5, 4, 3);
      ctx.fillStyle = "#3f8a4a";
      ctx.fillRect(px + 0.5, base - 9, 1.4, 4.5);
      ctx.fillRect(px + 2.2, base - 8, 1.4, 3.5);
      ctx.fillRect(px - 0.8, base - 7.5, 1.4, 3);
      const extra = r.decor % 3;
      if (extra === 0) {
        const wx = x + WB_W - 8;
        ctx.fillStyle = "#cfd6da";
        ctx.fillRect(wx, base - 12, 5, 10.5);
        ctx.fillStyle = "#56c7ff";
        ctx.fillRect(wx + 0.8, base - 15.5, 3.4, 4);
      } else if (extra === 1) {
        const sx = x + w - DOOR_W - 14;
        ctx.fillStyle = "#171c21";
        ctx.fillRect(sx, base - 16, 6, 14.5);
        for (let i = 0; i < 4; i++) {
          const on = (this.frame + i * 3 + r.decor % 7) % 8 < 4;
          ctx.fillStyle = on ? i === 2 ? "#3ee089" : "#ffb13d" : "#2a3138";
          ctx.fillRect(sx + 4.2, base - 14.5 + i * 3.2, 1, 1);
        }
      } else {
        ctx.fillStyle = `hsl(${(r.hue + 120) % 360} 40% 45%)`;
        ctx.fillRect(x + WB_W + 2, base - H + 10, 7, 9);
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fillRect(x + WB_W + 3.2, base - H + 12, 4.6, 1);
      }
      const LAMPS = 3;
      for (let li = 0; li < LAMPS; li++) {
        const lx = x + w * (li + 1) / (LAMPS + 1);
        ctx.fillStyle = "#20262c";
        ctx.fillRect(lx - 0.6, base - H, 1.2, 4);
        ctx.fillStyle = "#3a4046";
        ctx.fillRect(lx - 3.5, base - H + 4, 7, 2);
        ctx.fillStyle = lit ? "#ffd27a" : "#4a4636";
        ctx.fillRect(lx - 1.4, base - H + 5.4, 2.8, 1.6);
        if (lit) {
          const g = ctx.createRadialGradient(lx, base - H + 6.2, 0, lx, base - H + 6.2, 5);
          g.addColorStop(0, "rgba(255,210,130,0.22)");
          g.addColorStop(1, "rgba(255,210,130,0)");
          ctx.fillStyle = g;
          ctx.fillRect(lx - 5, base - H + 1, 10, 10);
        }
      }
      const sideAt = (t) => ({ x: x + w + (bw.x1 - (x + w)) * t, y: base + (bw.yBot - base) * t });
      const dn = sideAt(0.18), df = sideAt(0.5);
      ctx.fillStyle = "#4a3520";
      ctx.beginPath();
      ctx.moveTo(dn.x, dn.y);
      ctx.lineTo(dn.x, dn.y - 31);
      ctx.lineTo(df.x, df.y - 26);
      ctx.lineTo(df.x, df.y);
      ctx.closePath();
      ctx.fill();
      const pn = sideAt(0.22), pf = sideAt(0.46);
      ctx.fillStyle = "#6e522f";
      ctx.beginPath();
      ctx.moveTo(pn.x, pn.y - 1.5);
      ctx.lineTo(pn.x, pn.y - 29);
      ctx.lineTo(pf.x, pf.y - 24.5);
      ctx.lineTo(pf.x, pf.y - 1.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#d9b34a";
      ctx.fillRect(pf.x + 0.4, pf.y - 14, 1.4, 1.6);
      if (r.hasUpper) {
        const steps = 8;
        const botX = x + w - 42, topX = x + w - 22;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const sx = botX + (topX - botX) * t;
          const sy = base - (H - 4) * t;
          ctx.fillStyle = i % 2 ? "#454c53" : "#3c434a";
          ctx.fillRect(sx - 5, sy - 2.2, 10, 2.4);
          ctx.fillStyle = "#20262c";
          ctx.fillRect(sx - 5, sy + 0.2, 10, 1.8);
        }
        ctx.fillStyle = "#2a3138";
        ctx.fillRect(botX - 6, base - H + 2, 1.6, H - 2);
      }
      if (!lit && r.path) {
        ctx.fillStyle = "rgba(8,11,14,0.45)";
        ctx.fillRect(x + 1.5, base - H, w - 3, H);
      }
      ctx.globalAlpha = 1;
    }
    /** The room's stat-tracker TV on the far wall: a flat panel showing the branch
     *  plus live git stats (files changed, lines +/-). It glows when the worktree's
     *  files change (see the packets fired from the desks in tick). */
    drawBoard(ctx, r, base) {
      const b = boardRect(r.x0, base);
      if (b.w < 20 || b.h < 14)
        return;
      const glow = r.statPulse;
      ctx.fillStyle = "#05080b";
      ctx.fillRect(b.x - 2.5, b.y - 2.5, b.w + 5, b.h + 5);
      ctx.fillStyle = "#0b0f14";
      ctx.fillRect(b.x - 1.5, b.y - 1.5, b.w + 3, b.h + 3);
      const scr = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
      scr.addColorStop(0, "#101b27");
      scr.addColorStop(1, "#0a1118");
      ctx.fillStyle = scr;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = "rgba(120,200,255,0.035)";
      for (let yy = b.y + 2; yy < b.y + b.h - 1; yy += 3)
        ctx.fillRect(b.x, yy, b.w, 1);
      const pad = 4;
      ctx.save();
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      const branch = r.branch && r.branch !== "\u2014" ? r.branch : r.isMain ? "main" : "\u2014";
      const baseName = r.board?.base || "";
      const suffix = baseName && baseName !== branch ? `\u2192 ${baseName}` : "";
      ctx.font = "4px 'IBM Plex Mono', monospace";
      const suffixW = suffix ? ctx.measureText(suffix).width + 3 : 0;
      ctx.font = "bold 5px 'Martian Mono', monospace";
      ctx.fillStyle = r.isMain ? "hsl(150 60% 80%)" : `hsl(${r.hue} 65% 82%)`;
      let bt = `\u2325 ${branch}`;
      while (ctx.measureText(bt).width > b.w - 12 - suffixW && bt.length > 6)
        bt = bt.slice(0, -2);
      if (bt !== `\u2325 ${branch}`)
        bt += "\u2026";
      ctx.fillText(bt, b.x + pad, b.y + 7);
      if (suffix) {
        const branchW = ctx.measureText(bt).width;
        ctx.font = "bold 4px 'IBM Plex Mono', monospace";
        ctx.fillStyle = "rgba(205,220,232,0.95)";
        ctx.fillText(suffix, b.x + pad + branchW + 3, b.y + 7);
      }
      ctx.fillStyle = glow > 0.02 ? `rgba(62,224,137,${0.35 + glow * 0.65})` : "rgba(90,100,108,0.5)";
      ctx.fillRect(b.x + b.w - pad - 3, b.y + 3, 3, 3);
      ctx.fillStyle = "rgba(120,150,170,0.18)";
      ctx.fillRect(b.x + pad, b.y + 9.5, b.w - pad * 2, 0.8);
      ctx.restore();
      const bd = r.board;
      const placeholder = (text, color) => {
        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.font = "4px 'IBM Plex Mono', monospace";
        ctx.fillStyle = color;
        ctx.fillText(text, b.x + b.w / 2, b.y + b.h / 2 + 4);
        ctx.restore();
      };
      if (!bd) {
        placeholder("no git", "rgba(225,233,238,0.6)");
        return;
      }
      if (bd.missing) {
        placeholder("dir missing", "rgba(255,154,147,0.85)");
        return;
      }
      const review = { approved: "approved", changes: "changes req", required: "review req", none: "" };
      const checkTxt = { pass: "checks \u2713", fail: "checks \u2717", pending: "checks\u2026", none: "" };
      const bodyTop = b.y + 12;
      const bodyBot = b.y + b.h - 2;
      const innerL = b.x + pad;
      const innerR = b.x + b.w - pad;
      const prW = Math.min(74, (innerR - innerL) * 0.34);
      const gitR = innerR - prW - 4;
      const cw = (gitR - innerL) / 3;
      const fit = (s, maxW) => {
        if (ctx.measureText(s).width <= maxW)
          return s;
        let t = s;
        while (t.length > 1 && ctx.measureText(t + "\u2026").width > maxW)
          t = t.slice(0, -1);
        return t + "\u2026";
      };
      const churnBar = (x, yy, w, add, del) => {
        ctx.fillStyle = "rgba(120,150,170,0.16)";
        ctx.fillRect(x, yy, w, 2);
        const total = add + del;
        if (total <= 0)
          return;
        const aw = Math.max(1, Math.min(w - 1, Math.round(w * add / total)));
        ctx.fillStyle = "#3ee089";
        ctx.fillRect(x, yy, aw, 2);
        ctx.fillStyle = "#ff6055";
        ctx.fillRect(x + aw, yy, w - aw, 2);
      };
      ctx.save();
      ctx.textBaseline = "alphabetic";
      const cells = [
        { label: "UNSTAGED", count: `${bd.modified} file${bd.modified === 1 ? "" : "s"}`, add: bd.unstagedAdd, del: bd.unstagedDel, tint: "#ffb13d" },
        { label: "STAGED", count: `${bd.staged} file${bd.staged === 1 ? "" : "s"}`, add: bd.stagedAdd, del: bd.stagedDel, tint: "#3ee089" },
        { label: "COMMITS", count: bd.ahead > 0 ? `\u2191${bd.ahead}` : "0", add: bd.committedAdd, del: bd.committedDel, tint: "#56c7ff" }
      ];
      cells.forEach((c, i) => {
        const cx = innerL + i * cw;
        const cwIn = cw - 4;
        if (i > 0) {
          ctx.fillStyle = "rgba(120,150,170,0.12)";
          ctx.fillRect(cx - 2, bodyTop, 0.7, bodyBot - bodyTop);
        }
        ctx.textAlign = "left";
        ctx.font = "3px 'IBM Plex Mono', monospace";
        ctx.fillStyle = "rgba(170,182,190,0.7)";
        ctx.fillText(c.label, cx, bodyTop + 3);
        ctx.font = "bold 5.5px 'Martian Mono', monospace";
        ctx.fillStyle = c.tint;
        ctx.fillText(fit(c.count, cwIn), cx, bodyTop + 10);
        ctx.font = "bold 3.6px 'Martian Mono', monospace";
        const plus = `+${c.add}`;
        ctx.fillStyle = "#3ee089";
        ctx.fillText(plus, cx, bodyTop + 16);
        ctx.fillStyle = "#ff6055";
        ctx.fillText(`-${c.del}`, cx + ctx.measureText(plus).width + 3, bodyTop + 16);
        churnBar(cx, bodyTop + 18.5, cwIn, c.add, c.del);
      });
      const px = gitR + 4;
      ctx.fillStyle = "rgba(120,150,170,0.14)";
      ctx.fillRect(gitR + 1, bodyTop, 0.7, bodyBot - bodyTop);
      let py = bodyTop + 3;
      ctx.textAlign = "left";
      ctx.font = "3px 'IBM Plex Mono', monospace";
      ctx.fillStyle = "rgba(170,182,190,0.7)";
      ctx.fillText("PR", px, py);
      ctx.font = "bold 5.5px 'Martian Mono', monospace";
      ctx.fillStyle = bd.pr ? "#b98cff" : "#ffb13d";
      ctx.textAlign = "right";
      ctx.fillText(bd.pr ? `#${bd.pr.number}` : "pending", innerR, py + 0.2);
      ctx.textAlign = "left";
      py += 6;
      if (!bd.pr) {
        ctx.font = "3.4px 'IBM Plex Mono', monospace";
        ctx.fillStyle = "rgba(185,140,255,0.8)";
        ctx.fillText("no PR yet", px, py);
      } else {
        ctx.font = "3.4px 'IBM Plex Mono', monospace";
        const line = (text, color) => {
          if (py > bodyBot)
            return;
          ctx.fillStyle = color;
          ctx.fillText(fit(text, prW), px, py);
          py += 4.6;
        };
        const checkCol = bd.pr.checks === "pass" ? "#3ee089" : bd.pr.checks === "fail" ? "#ff6055" : "#ffb13d";
        if (bd.pr.checksTotal > 0) {
          const icon = bd.pr.checks === "pass" ? "\u2713" : bd.pr.checks === "fail" ? "\u2717" : "\u2026";
          line(`checks ${bd.pr.checksPass}/${bd.pr.checksTotal} ${icon}`, checkCol);
        } else if (bd.pr.checks !== "none") {
          line(checkTxt[bd.pr.checks], checkCol);
        }
        const rparts = [];
        if (bd.pr.approvals > 0)
          rparts.push(`${bd.pr.approvals} approved`);
        if (bd.pr.changesRequested > 0)
          rparts.push(`${bd.pr.changesRequested} changes`);
        if (bd.pr.reviewersPending > 0)
          rparts.push(`${bd.pr.reviewersPending} pending`);
        const revCol = bd.pr.changesRequested > 0 ? "#ff6055" : bd.pr.approvals > 0 ? "#3ee089" : "#ffb13d";
        if (rparts.length)
          line(rparts.join(" \xB7 "), revCol);
        else if (bd.pr.review !== "none")
          line(review[bd.pr.review], bd.pr.review === "approved" ? "#3ee089" : bd.pr.review === "changes" ? "#ff6055" : "#ffb13d");
        if (bd.pr.draft)
          line("draft", "rgba(200,210,216,0.7)");
        py += 1;
        ctx.fillStyle = "rgba(120,150,170,0.16)";
        ctx.fillRect(px, py - 3, prW, 0.7);
        py += 2;
        ctx.fillStyle = "rgba(225,233,238,0.85)";
        const words = bd.pr.title.split(/\s+/).filter(Boolean);
        let lineStr = "";
        for (const w of words) {
          if (py > bodyBot)
            break;
          const next = lineStr ? `${lineStr} ${w}` : w;
          if (ctx.measureText(next).width > prW && lineStr) {
            ctx.fillText(lineStr, px, py);
            py += 4.4;
            lineStr = w;
          } else
            lineStr = next;
        }
        if (py <= bodyBot && lineStr)
          ctx.fillText(fit(lineStr, prW), px, py);
      }
      ctx.restore();
      if (glow > 0.02) {
        ctx.strokeStyle = `rgba(62,224,137,${glow * 0.85})`;
        ctx.lineWidth = 1;
        ctx.strokeRect(b.x, b.y, b.w, b.h);
      }
    }
    drawDesks(ctx, r, row) {
      const eFurn = clamp((r.built - 0.6) / 0.4, 0, 1);
      if (eFurn <= 0 || !r.plan)
        return;
      const base = r.baseY;
      const db = base - row * ROW_DY;
      ctx.globalAlpha = eFurn;
      for (const [id, seat] of r.plan.seats) {
        if (seat.row !== row)
          continue;
        const dx = this.seatX(r, seat.col, row);
        const tn = this.toons.get(id);
        const occupied = !!tn?.sitting;
        const st = occupied ? tn.agent.state : void 0;
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.fillRect(dx + 1.5, db - 0.6, 19, 1.8);
        ctx.fillStyle = "#7e5e35";
        ctx.fillRect(dx + 2, db - 11, 18, 2);
        ctx.fillStyle = "#9c7a4c";
        ctx.fillRect(dx + 2, db - 11, 18, 0.7);
        ctx.fillStyle = "#382a16";
        ctx.fillRect(dx + 2, db - 9.2, 18, 0.7);
        ctx.fillStyle = "#54401f";
        ctx.fillRect(dx + 3, db - 9, 1.5, 9);
        ctx.fillRect(dx + 17.5, db - 9, 1.5, 9);
        ctx.fillStyle = "#171c21";
        ctx.fillRect(dx + 7.2, db - 11.2, 1.6, 1.2);
        ctx.fillRect(dx + 5.4, db - 10.2, 5.4, 1);
        ctx.fillStyle = "#1b2129";
        ctx.beginPath();
        ctx.moveTo(dx + 5, db - 18);
        ctx.lineTo(dx + 11, db - 16.5);
        ctx.lineTo(dx + 11, db - 11);
        ctx.lineTo(dx + 5, db - 12.5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#11161c";
        ctx.beginPath();
        ctx.moveTo(dx + 5.9, db - 17.2);
        ctx.lineTo(dx + 10.1, db - 15.9);
        ctx.lineTo(dx + 10.1, db - 11.6);
        ctx.lineTo(dx + 5.9, db - 13.1);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = occupied ? st === "error" ? "#d9534f" : "#3ee089" : "#2a3138";
        ctx.fillRect(dx + 8.8, db - 12.6, 0.9, 0.9);
        ctx.fillStyle = "#2a3138";
        ctx.fillRect(dx + 8.5, db - 11.2, 5.5, 1);
        ctx.fillStyle = "#d9534f";
        ctx.fillRect(dx + 0.5, db - 13, 2, 2);
        if (occupied && this.frame % 8 < 4) {
          ctx.fillStyle = "rgba(255,255,255,0.25)";
          ctx.fillRect(dx + 1, db - 15, 0.8, 1.4);
        }
        if (occupied) {
          const c = st === "error" ? "217,83,79" : "159,216,255";
          const peak = st === "error" ? 0.3 : st === "active" && this.frame % 4 < 2 ? 0.4 : 0.24;
          const gx = dx + 13, gy = db - 16;
          const grd = ctx.createRadialGradient(gx, gy, 0, gx, gy, 7);
          grd.addColorStop(0, `rgba(${c},${peak})`);
          grd.addColorStop(0.6, `rgba(${c},${peak * 0.45})`);
          grd.addColorStop(1, `rgba(${c},0)`);
          ctx.fillStyle = grd;
          ctx.fillRect(dx + 10, db - 24, 8, 20);
        }
      }
      ctx.globalAlpha = 1;
    }
    drawToon(ctx, tn) {
      const p = tn.p;
      const st = tn.agent.state;
      const walking = Math.abs(tn.targetX - tn.x) > 1;
      const f = this.frame + Math.floor(tn.ph * 10);
      const x = Math.round(tn.x * 2) / 2;
      const sitting = tn.sitting;
      const y0 = tn.base - tn.lift + (sitting ? -3.5 : 0);
      const hop = st === "waiting" && !walking ? -Math.abs(Math.sin(f * 0.35 + tn.ph)) * 1 : 0;
      const slump = st === "error" && !walking ? 1.4 : 0;
      const base = y0 + hop;
      const facingLeft = tn.huddle || sitting;
      const climbing = !!tn.climbing;
      ctx.fillStyle = p.pants;
      if (sitting) {
        ctx.fillRect(x - 3, base - 4, 6, 2);
        ctx.fillRect(x - 3.6, base - 3, 1.6, 3.4);
        ctx.fillRect(x + 2, base - 3, 1.6, 3.4);
      } else if (walking || climbing) {
        const sw = f % 2 === 0;
        ctx.fillRect(x - (sw ? 3 : 1.6), base - 6, 2, 6);
        ctx.fillRect(x + (sw ? 1 : -0.4), base - 6, 2, 6);
      } else {
        ctx.fillRect(x - 2.6, base - 6, 2, 6);
        ctx.fillRect(x + 0.6, base - 6, 2, 6);
      }
      ctx.fillStyle = "#23262a";
      if (!sitting) {
        ctx.fillRect(x - 3, base - 0.8, 2.6, 0.9);
        ctx.fillRect(x + 0.4, base - 0.8, 2.6, 0.9);
      }
      const ty = base - 12 + slump * 0.4;
      ctx.fillStyle = p.shirt;
      ctx.fillRect(x - 3.2, ty, 6.4, 6.4);
      ctx.fillStyle = p.shirtDark;
      ctx.fillRect(x - 3.2, ty + 5.2, 6.4, 1.2);
      ctx.fillStyle = p.shirt;
      const handC = p.skin;
      if (climbing) {
        const g = f % 2;
        ctx.fillRect(x - 4.2, ty - 2 + g, 1.4, 4);
        ctx.fillRect(x + 2.8, ty - 2 + (1 - g), 1.4, 4);
        ctx.fillStyle = handC;
        ctx.fillRect(x - 4.4, ty - 3.4 + g, 1.6, 1.6);
        ctx.fillRect(x + 2.6, ty - 3.4 + (1 - g), 1.6, 1.6);
      } else if (sitting) {
        const tap = f % 2 === 0 ? 0 : 0.8;
        ctx.fillRect(x - 6, ty + 2.2, 3.4, 1.4);
        ctx.fillStyle = handC;
        ctx.fillRect(x - 7, ty + 2 + tap, 1.4, 1.4);
        ctx.fillRect(x - 7, ty + 3.6 - tap, 1.4, 1.4);
      } else if (tn.huddle && !walking) {
        const lead = tn.deskIdx % 2 === 0;
        if (lead) {
          const draw = Math.sin(f * 0.5 + tn.ph) * 1.5;
          ctx.fillRect(x - 5.4, ty - 1.5 + draw * 0.4, 3, 1.4);
          ctx.fillStyle = handC;
          ctx.fillRect(x - 6.6, ty - 1.8 + draw * 0.4, 1.4, 1.4);
        } else {
          const nod = f % 4 < 2 ? 0 : 0.7;
          ctx.fillRect(x - 4.6, ty + 1 + nod, 2.4, 1.4);
          ctx.fillStyle = handC;
          ctx.fillRect(x - 5.8, ty + 0.8 + nod, 1.2, 1.2);
          ctx.fillStyle = p.shirt;
          ctx.fillRect(x + 3.2, ty + 2.4, 1.4, 3);
        }
      } else if (st === "waiting" && !walking) {
        const wave = Math.sin(f * 0.9 + tn.ph) * 1.1;
        ctx.fillRect(x + 2.8 + wave * 0.4, ty - 4, 1.5, 5);
        ctx.fillStyle = handC;
        ctx.fillRect(x + 2.7 + wave, ty - 5.6, 1.8, 1.8);
        ctx.fillStyle = p.shirt;
        ctx.fillRect(x - 4.4, ty - 0.6, 1.6, 2.8);
        ctx.fillStyle = handC;
        ctx.fillRect(x - 3.2, ty - 2, 1.5, 1.5);
      } else if (walking) {
        const sw = f % 2 === 0 ? 1 : -1;
        ctx.fillRect(x - 4.2, ty + 1.5 + sw * 0.8, 1.4, 4);
        ctx.fillRect(x + 2.8, ty + 1.5 - sw * 0.8, 1.4, 4);
      } else if (st === "idle" || st === "complete") {
        ctx.fillRect(x - 4.2, ty + 1.5, 1.4, 4);
        ctx.fillRect(x + 2.6, ty + 1.2, 1.4, 2.4);
        ctx.fillStyle = "#171c21";
        ctx.fillRect(x + 1.8, ty + 2.8, 2.6, 3.6);
        const glow = f % 6 < 3 ? "#9fd8ff" : "#7fb8df";
        ctx.fillStyle = glow;
        ctx.fillRect(x + 2.2, ty + 3.2, 1.8, 2.8);
        ctx.fillStyle = handC;
        ctx.fillRect(x + 3.6, ty + 3.4 + (f % 4 < 2 ? 0 : 0.8), 1.2, 1.2);
        ctx.fillStyle = "rgba(159,216,255,0.10)";
        ctx.fillRect(x - 1.5, ty - 4.5, 4.5, 5);
      } else {
        ctx.fillRect(x - 4.2, ty + 1.5, 1.4, 4);
        ctx.fillRect(x + 2.8, ty + 1.5, 1.4, 4);
      }
      const hy = ty - 6 + slump;
      ctx.fillStyle = p.skin;
      ctx.fillRect(x - 2.8, hy, 5.6, 5.6);
      ctx.fillStyle = p.hair;
      ctx.fillRect(x - 3, hy - 1, 6, 2.2);
      ctx.fillRect(x - 3, hy - 0.5, 1.2, 3.4);
      ctx.fillRect(x + 1.8, hy - 0.5, 1.2, 2.4);
      if (p.acc === 2) {
        ctx.fillStyle = p.accColor;
        ctx.fillRect(x - 3.2, hy - 1.6, 6.4, 1.8);
        ctx.fillRect(facingLeft ? x - 4.6 : x + 1.6, hy - 0.4, 3, 1);
      } else if (p.acc === 3) {
        ctx.fillStyle = p.accColor;
        ctx.fillRect(x - 3.6, hy + 1.6, 1.2, 2.4);
        ctx.fillRect(x + 2.4, hy + 1.6, 1.2, 2.4);
        ctx.fillRect(x - 3.4, hy - 1.6, 6.8, 1);
      }
      const blink = (f + Math.floor(tn.ph * 7)) % 40 === 0;
      if (!blink) {
        ctx.fillStyle = "#14181b";
        const phoneGaze = (st === "idle" || st === "complete") && !walking && f % 50 > 6 ? 0.9 : 0;
        const ey = hy + 2.4 + slump * 0.5 + phoneGaze;
        if (facingLeft || walking && tn.targetX < tn.x) {
          ctx.fillRect(x - 2.2, ey, 1.1, 1.1);
          ctx.fillRect(x - 0.2, ey, 1.1, 1.1);
        } else {
          ctx.fillRect(x - 0.8, ey, 1.1, 1.1);
          ctx.fillRect(x + 1.2, ey, 1.1, 1.1);
        }
      }
      if (p.acc === 1) {
        ctx.strokeStyle = "#23262a";
        ctx.lineWidth = 0.5;
        const ey = hy + 2.6;
        ctx.strokeRect(x - 1.4, ey - 0.8, 1.9, 1.9);
        ctx.strokeRect(x + 0.9, ey - 0.8, 1.9, 1.9);
      }
    }
  };
  window.DevTowerCrew = {
    _instance: null,
    mount(container, canvas) {
      this._instance = new PixelCrew(container, canvas);
      return this._instance;
    },
    setAgents(a) {
      this._instance?.setAgents(a);
    },
    setRooms(r) {
      this._instance?.setRooms(r);
    },
    setPrBranches(b) {
      this._instance?.setPrBranches(b);
    },
    setBoards(boards) {
      this._instance?.setBoards(boards);
    },
    setSelected(id) {
      this._instance?.setSelected(id);
    },
    onSelect(cb) {
      this._instance?.onSelect(cb);
    },
    onReserve(cb) {
      this._instance?.onReserve(cb);
    },
    onAddDev(cb) {
      this._instance?.onAddDev(cb);
    },
    onAddWorktree(cb) {
      this._instance?.onAddWorktree(cb);
    },
    onRemoveRoom(cb) {
      this._instance?.onRemoveRoom(cb);
    },
    onRemoveWorktree(cb) {
      this._instance?.onRemoveWorktree(cb);
    },
    onCd(cb) {
      this._instance?.onCd(cb);
    },
    start() {
      this._instance?.start();
    },
    stop() {
      this._instance?.stop();
    },
    resize() {
      this._instance?.resize();
    },
    focusIsland(repo) {
      this._instance?.focusOn(repo);
    },
    clearFocus() {
      this._instance?.clearFocus();
    },
    setEco(on) {
      this._instance?.setEco(on);
    },
    setInsets(left, right) {
      this._instance?.setInsets(left, right);
    }
  };
})();
//# sourceMappingURL=crew.js.map
