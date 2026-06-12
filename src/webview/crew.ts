/* Fleet Crew — pixel office tower / mine renderer (Canvas2D, no WebGL).
 *
 * Mining-game layout: rooms stack vertically as floors. Above ground it's an
 * office tower; reserve floors below ground and you're digging a basement.
 * - Ghost slots at the top and bottom: click → pick a directory to reserve
 *   that floor for a repo/project.
 * - Bound rooms show a "+ DEV" button: spawn an agent there (the extension
 *   asks worktree vs project dir).
 * - 2+ active agents in one room huddle at the whiteboard.
 *
 * Power model: ~10fps animation tick (6fps eco); renders only on ticks or
 * camera motion; hard-stop when hidden. Same window.FleetCrew API as before,
 * plus setRooms / onReserve / onAddAgent. */

interface CrewAgent {
  id: string;
  name: string;
  state: string;
  repo: string;
  model: string;
}

interface ReservedRoom {
  name: string;
  path: string;
  floor: number;
  col: number;
}

const STATE_COLOR: Record<string, string> = {
  active: "#3ee089",
  waiting: "#ffb13d",
  complete: "#56c7ff",
  error: "#ff6055",
  idle: "#8a9598",
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const SKINS = ["#f2c8a0", "#e0a87e", "#c68642", "#8d5524", "#ffd9b3", "#a86b3c"];
const HAIRS = ["#2e2620", "#4a342a", "#16100c", "#7a5230", "#b88a4a", "#55585e", "#6e3a28"];
const ACCENTS = ["#ff6055", "#56c7ff", "#3ee089", "#ffb13d", "#b98cff", "#ff8fc7"];

function persona(id: string) {
  const h = hash(id);
  const hue = h % 360;
  return {
    shirt: `hsl(${hue} 45% 52%)`,
    shirtDark: `hsl(${hue} 48% 38%)`,
    pants: `hsl(${(hue + 200) % 360} 16% 30%)`,
    skin: SKINS[(h >> 3) % SKINS.length],
    hair: HAIRS[(h >> 5) % HAIRS.length],
    acc: (h >> 7) % 4, // 0 none, 1 glasses, 2 cap, 3 headphones
    accColor: ACCENTS[(h >> 9) % ACCENTS.length],
  };
}

/* ---- layout constants (art pixels) ---- */
const ROOM_H = 52;
const SLAB = 8; // concrete between floors
const FLOOR_STEP = ROOM_H + SLAB;
const WB_W = 30;
const DESK_W = 26;
const DOOR_W = 18;
const MAX_DESKS = 4;
const ROOM_W = WB_W + MAX_DESKS * DESK_W + DOOR_W; // uniform room width
// rooms share walls — one contiguous building, door to door
const COL_STEP = ROOM_W;
const cellX0 = (col: number) => col * COL_STEP - ROOM_W / 2;
const WALK_SPEED = 30;

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; color: string; size: number; gravity: number;
}
interface Stroke { x1: number; y1: number; x2: number; y2: number; color: string }

interface Room {
  name: string;
  floor: number;
  col: number;
  x0: number; // left edge of this room (world)
  path?: string; // set for reserved rooms
  hue: number;
  built: number;
  delay: number; // staggered construction start (seconds)
  dying?: boolean; // queued for demolition once its leavers are out
  agents: CrewAgent[];
  scribbles: Stroke[];
  decor: number;
}

interface Toon {
  agent: CrewAgent;
  p: ReturnType<typeof persona>;
  x: number;
  targetX: number;
  base: number; // floor baseline (world y)
  x0: number; // left edge of the toon's room (for lift entry/exit)
  deskIdx: number;
  huddle: boolean;
  sitting: boolean;
  entering: boolean;
  leaving: boolean;
  // departure path: walk to the building edge → ladder to ground → away
  leavePhase?: "walk" | "ladder" | "away";
  ladderFrom?: number;
  ladderX?: number;
  climbing?: boolean;
  ph: number;
}

const floorBase = (floor: number) => -floor * FLOOR_STEP;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class PixelCrew {
  private ctx: CanvasRenderingContext2D;
  private toons = new Map<string, Toon>();
  private leaving: Toon[] = [];
  private rooms = new Map<string, Room>(); // key = room name
  private reserved: ReservedRoom[] = [];
  private agents: CrewAgent[] = [];
  private particles: Particle[] = [];
  private ghosts: { col: number; floor: number; x0: number; base: number }[] = [];
  private colRange = new Map<number, { min: number; max: number }>();
  private bounds = { minX: -120, maxX: 120, topY: -120, botY: 40, minFloor: 0 };

  private focusRoom_: string | null = null;
  private focus = { x: 0, y: -ROOM_H / 2, spanW: ROOM_W + 60, spanH: FLOOR_STEP + 60 };
  private cam = { x: 0, y: -ROOM_H / 2, z: 4 };
  private zoomMul = 1;
  private panX = 0;
  private panY = 0;
  private drag = { active: false, moved: false, lastX: 0, lastY: 0 };
  // dragging a toon onto a room (or a ghost cell) issues a /cd for that agent
  private toonDrag: { id: string; active: boolean; mx: number; my: number } | null = null;
  private dropTarget: { room?: string; ghost?: { floor: number; col: number } } | null = null;

  private running = false;
  private raf = 0;
  private lastNow = 0;
  private acc = 0;
  private frame = 0;
  private dirty = true;
  private eco = false;
  // HUD overlays (agent panel / PR board) cover the canvas edges; inset the
  // viewport so rooms frame into the visible area and stay clickable
  private insetL = 0;
  private insetR = 0;

  private selectedId?: string;
  private onSelectCb: (id: string) => void = () => {};
  private onReserveCb: (floor: number, col: number) => void = () => {};
  private onAddAgentCb: (room: string) => void = () => {};
  private onRemoveRoomCb: (room: string) => void = () => {};
  private onCdCb: (id: string, target: { room?: string; ghost?: { floor: number; col: number } }) => void =
    () => {};

  private resizeT: ReturnType<typeof setTimeout> | undefined;

  constructor(private container: HTMLElement, private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    // debounce: the editor fires a burst of resizes while the panel animates
    // open, and each one reallocates the backing store — only honor the last
    new ResizeObserver(() => {
      clearTimeout(this.resizeT);
      this.resizeT = setTimeout(() => this.resize(), 80);
    }).observe(container);
    this.resize();
    // canvas text renders with fallback metrics until webfonts arrive
    (document as any).fonts?.ready?.then(() => {
      this.invalidate();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.stop();
      else this.start();
    });

    const canvasXY = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
    };
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      // grabbing a toon begins a drag-to-relocate gesture, not a camera pan
      const hit = this.pick(e);
      if (hit.agent) {
        const { mx, my } = canvasXY(e);
        this.toonDrag = { id: hit.agent, active: false, mx, my };
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
          const hit = this.pick(e);
          this.dropTarget = hit.room ? { room: hit.room } : hit.ghost ? { ghost: hit.ghost } : null;
          this.container.style.cursor = this.dropTarget ? "copy" : "grabbing";
          this.invalidate();
        }
        return;
      }
      if (!this.drag.active) {
        const hit = this.pick(e);
        this.container.style.cursor =
          hit.agent || hit.room || hit.ghost || hit.addBtn || hit.removeBtn ? "pointer" : "default";
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
    const endDrag = (e: PointerEvent) => {
      if (this.toonDrag) {
        const td = this.toonDrag;
        this.toonDrag = null;
        this.container.style.cursor = "default";
        if (!td.active) {
          this.onClick(e); // a tap, not a drag → select the agent
        } else if (this.dropTarget) {
          this.onCdCb(td.id, this.dropTarget);
        }
        this.dropTarget = null;
        this.invalidate();
        return;
      }
      if (!this.drag.active) return;
      const wasDrag = this.drag.moved;
      this.drag.active = false;
      this.drag.moved = false;
      this.container.style.cursor = "default";
      if (!wasDrag) this.onClick(e);
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
        this.zoomMul = clamp(this.zoomMul * (1 - e.deltaY * 0.0012), 0.35, 4);
        this.invalidate();
      },
      { passive: false }
    );
  }

  onSelect(cb: (id: string) => void) { this.onSelectCb = cb; }
  onReserve(cb: (floor: number, col: number) => void) { this.onReserveCb = cb; }
  onAddAgent(cb: (room: string) => void) { this.onAddAgentCb = cb; }
  onRemoveRoom(cb: (room: string) => void) { this.onRemoveRoomCb = cb; }
  onCd(cb: (id: string, target: { room?: string; ghost?: { floor: number; col: number } }) => void) {
    this.onCdCb = cb;
  }
  private newToonIds = new Set<string>();

  /* ============ DATA ============ */

  setRooms(reserved: ReservedRoom[]) {
    this.reserved = reserved || [];
    this.layout();
  }

  setAgents(agents: CrewAgent[]) {
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
          agent: a, p: persona(a.id), x: 0, targetX: 0, base: 0, x0: 0, deskIdx: 0,
          huddle: false, sitting: false, entering: true, leaving: false,
          ph: (hash(a.id) % 628) / 100,
        };
        this.toons.set(a.id, tn);
        this.newToonIds.add(a.id);
      }
      tn.agent = a;
    }
    this.agents = agents;
    this.layout();
  }

  /** Merge reserved rooms + live repos into grid cells; assign toon targets. */
  private layout() {
    const byRepo = new Map<string, CrewAgent[]>();
    for (const a of this.agents) {
      if (!byRepo.has(a.repo)) byRepo.set(a.repo, []);
      byRepo.get(a.repo)!.push(a);
    }

    const wanted = new Map<string, { floor: number; col: number; path?: string }>();
    const occupied = new Set<string>();
    for (const r of this.reserved) {
      const col = r.col ?? 0;
      wanted.set(r.name, { floor: r.floor, col, path: r.path });
      occupied.add(col + "," + r.floor);
    }
    // cells of soon-to-be-demolished rooms stay occupied so nothing replaces
    // them while the leaver is still walking out / demolition is playing
    for (const [name, room] of this.rooms) {
      if (!wanted.has(name) && !byRepo.has(name)) occupied.add(room.col + "," + room.floor);
    }

    // live repos without a reservation fill column 0's free floors from 0 up
    let next = 0;
    for (const repo of byRepo.keys()) {
      if (wanted.has(repo)) continue;
      while (occupied.has("0," + next)) next++;
      wanted.set(repo, { floor: next, col: 0 });
      occupied.add("0," + next);
      next++;
    }

    // rooms that lost their reservation/agents get demolished later (tick),
    // not deleted mid-animation
    for (const [name, room] of this.rooms) {
      room.dying = !wanted.has(name);
      if (room.dying) room.agents = [];
    }
    let newIdx = 0;
    for (const [name, info] of wanted) {
      let room = this.rooms.get(name);
      if (!room) {
        room = {
          name, floor: info.floor, col: info.col, x0: cellX0(info.col), path: info.path,
          hue: hash(name) % 360, built: 0,
          delay: newIdx++ * 0.45, // floors build one after another, not all at once
          agents: [], scribbles: [], decor: hash(name + "decor"),
        };
        this.rooms.set(name, room);
      }
      room.floor = info.floor;
      room.col = info.col;
      room.x0 = cellX0(info.col);
      room.path = info.path ?? room.path;
      room.agents = byRepo.get(name) ?? [];
    }

    // ghost slots: every empty 4-neighbor of an occupied cell → build in any direction
    this.ghosts = [];
    const ghostKeys = new Set<string>();
    if (occupied.size === 0) {
      this.ghosts.push({ col: 0, floor: 0, x0: cellX0(0), base: floorBase(0) });
    } else {
      for (const key of occupied) {
        const [c, f] = key.split(",").map(Number);
        for (const [nc, nf] of [[c + 1, f], [c - 1, f], [c, f + 1], [c, f - 1]] as [number, number][]) {
          const k = nc + "," + nf;
          if (occupied.has(k) || ghostKeys.has(k)) continue;
          ghostKeys.add(k);
          this.ghosts.push({ col: nc, floor: nf, x0: cellX0(nc), base: floorBase(nf) });
        }
      }
    }

    // per-column floor ranges (lift shafts/roofs) + world bounds
    this.colRange.clear();
    let minX = Infinity, maxX = -Infinity, topY = Infinity, botY = -Infinity, minFloor = 0;
    const extend = (floor: number, x0: number, base: number) => {
      minX = Math.min(minX, x0);
      maxX = Math.max(maxX, x0 + ROOM_W);
      topY = Math.min(topY, base - ROOM_H);
      botY = Math.max(botY, base + SLAB);
      minFloor = Math.min(minFloor, floor);
    };
    for (const r of this.rooms.values()) {
      const rng = this.colRange.get(r.col) ?? { min: r.floor, max: r.floor };
      rng.min = Math.min(rng.min, r.floor);
      rng.max = Math.max(rng.max, r.floor);
      this.colRange.set(r.col, rng);
      extend(r.floor, r.x0, floorBase(r.floor));
    }
    for (const g of this.ghosts) extend(g.floor, g.x0, g.base);
    if (!isFinite(minX)) {
      minX = -120; maxX = 120; topY = -120; botY = 40;
    }
    this.bounds = { minX, maxX, topY, botY, minFloor };

    // toon targets per room
    for (const room of this.rooms.values()) {
      const base = floorBase(room.floor);
      const activeCount = room.agents.filter((a) => a.state === "active").length;
      const huddle = activeCount >= 2;
      let wbSlot = 0;
      room.agents.forEach((a, di) => {
        const tn = this.toons.get(a.id);
        if (!tn) return;
        tn.base = base;
        tn.x0 = room.x0;
        tn.deskIdx = di;
        const deskX = room.x0 + WB_W + (di % MAX_DESKS) * DESK_W;
        if (a.state === "active" && huddle) {
          tn.huddle = true;
          tn.targetX = room.x0 + 26 + wbSlot * 9;
          wbSlot++;
        } else if (a.state === "active") {
          tn.huddle = false;
          tn.targetX = deskX + 13;
        } else {
          tn.huddle = false;
          tn.targetX = deskX + 19;
        }
        if (tn.entering && tn.x === 0) tn.x = room.x0 + ROOM_W + 8; // in through the door
      });
      if (!huddle) room.scribbles = [];
    }

    // keep the operator's view: refit a focused room, otherwise keep pan as-is
    if (this.focusRoom_ && this.rooms.has(this.focusRoom_)) this.focusOn(this.focusRoom_, false);
    else this.clearFocus(false, true);
    this.invalidate();
  }

  /* ============ CAMERA ============ */

  focusOn(name: string, resetZoom = true) {
    const r = this.rooms.get(name);
    if (!r) return;
    this.focusRoom_ = name;
    this.focus.x = r.x0 + ROOM_W / 2;
    this.focus.y = floorBase(r.floor) - ROOM_H / 2;
    this.focus.spanW = ROOM_W + 26;
    this.focus.spanH = FLOOR_STEP + 34;
    this.panX = 0;
    this.panY = 0;
    if (resetZoom) this.zoomMul = 1;
    this.invalidate();
  }

  /** Tight zoom onto one agent (their corner of the room). */
  focusAgent(id: string) {
    const tn = this.toons.get(id);
    if (!tn) return;
    const room = this.rooms.get(tn.agent.repo);
    this.focusRoom_ = room?.name ?? null; // stays framed across re-layouts
    this.focus.x = tn.targetX;
    this.focus.y = tn.base - ROOM_H / 2 + 6;
    this.focus.spanW = 96;
    this.focus.spanH = FLOOR_STEP + 18;
    this.panX = 0;
    this.panY = 0;
    this.zoomMul = 1;
    this.invalidate();
  }

  clearFocus(resetZoom = true, preservePan = false) {
    this.focusRoom_ = null;
    this.focus.x = (this.bounds.minX + this.bounds.maxX) / 2;
    this.focus.y = (this.bounds.topY + this.bounds.botY) / 2;
    this.focus.spanW = this.bounds.maxX - this.bounds.minX + 60;
    this.focus.spanH = this.bounds.botY - this.bounds.topY + 46;
    if (!preservePan) {
      this.panX = 0;
      this.panY = 0;
    }
    if (resetZoom) this.zoomMul = 1;
    this.invalidate();
  }

  setSelected(id: string | undefined) {
    this.selectedId = id;
    // a freshly spawned dev you selected: ride along into their room
    if (id && this.newToonIds.has(id)) {
      this.newToonIds.delete(id);
      this.focusAgent(id);
    }
    this.invalidate();
  }
  setEco(on: boolean) {
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

  private targetZoom(): number {
    const cw = Math.max(80, (this.container.clientWidth || 1) - this.insetL - this.insetR);
    const ch = this.container.clientHeight || 1;
    const fitW = (cw * 0.9) / this.focus.spanW;
    const fitH = (ch * 0.86) / this.focus.spanH;
    return clamp(Math.min(fitW, fitH) * this.zoomMul, 0.7, 14);
  }

  /* ============ LOOP ============ */

  start() {
    if (this.running) return;
    this.running = true;
    this.lastNow = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(250, now - this.lastNow);
      this.lastNow = now;

      const tickMs = this.eco ? 166 : 100;
      this.acc += dt;
      let ticked = false;
      while (this.acc >= tickMs) {
        this.acc -= tickMs;
        this.frame++;
        this.tick(tickMs / 1000);
        ticked = true;
      }

      const tz = this.targetZoom();
      const tx = this.focus.x + this.panX;
      const ty = this.focus.y + this.panY;
      const moving =
        Math.abs(this.cam.x - tx) > 0.05 ||
        Math.abs(this.cam.y - ty) > 0.05 ||
        Math.abs(this.cam.z - tz) > 0.01;
      if (moving) {
        const k = Math.min(1, (dt / 1000) * 5);
        this.cam.x += (tx - this.cam.x) * k;
        this.cam.y += (ty - this.cam.y) * k;
        this.cam.z += (tz - this.cam.z) * k;
      }
      if (ticked || moving || this.dirty) {
        this.dirty = false;
        this.draw();
      }
      if (!moving && !this.dirty && this.sceneIdle()) {
        // nothing left to animate — park the loop until woken
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
  private wake() {
    if (!this.running && !document.hidden) this.start();
  }

  /** Mark a redraw is needed and ensure the loop is running. */
  private invalidate() {
    this.dirty = true;
    this.wake();
  }

  /** True when nothing needs animating, so the loop can park until woken. */
  private sceneIdle(): boolean {
    if (this.particles.length || this.leaving.length) return false;
    for (const r of this.rooms.values()) {
      if (r.dying || r.delay > 0 || r.built < 1) return false;
    }
    for (const tn of this.toons.values()) {
      if (tn.entering || Math.abs(tn.targetX - tn.x) > 1) return false;
      const s = tn.agent.state;
      if (s === "active" || s === "waiting") return false;
    }
    return true;
  }

  /* ============ TICK ============ */

  private tick(dt: number) {
    const demolished: string[] = [];
    for (const r of this.rooms.values()) {
      if (r.dying) {
        // wait until the departing dev has fully left, then deconstruct
        const hasLeaver = this.leaving.some((t) => t.agent.repo === r.name);
        if (!hasLeaver) {
          r.built = Math.max(0, r.built - dt / 1.0);
          if (!this.eco) {
            const base = floorBase(r.floor);
            this.particles.push({
              x: r.x0 + Math.random() * ROOM_W * Math.max(0.1, r.built), y: base - 2 - Math.random() * 10,
              vx: (Math.random() - 0.5) * 10, vy: -4 - Math.random() * 6,
              life: 0.7, color: "#9a8a72", size: 1.2, gravity: 14,
            });
          }
          if (r.built <= 0) demolished.push(r.name);
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
          const base = floorBase(r.floor);
          this.particles.push({
            x: r.x0 + Math.random() * ROOM_W * r.built, y: base - 2 - Math.random() * 10,
            vx: (Math.random() - 0.5) * 10, vy: -4 - Math.random() * 6,
            life: 0.7, color: "#9a8a72", size: 1.2, gravity: 14,
          });
        }
      }
    }
    if (demolished.length) {
      for (const name of demolished) this.rooms.delete(name);
      this.layout(); // free the cells → ghost slots reappear
    }

    const all: Toon[] = [...this.toons.values(), ...this.leaving];
    for (const tn of all) {
      const dx = tn.targetX - tn.x;
      if (Math.abs(dx) > 1) tn.x += Math.sign(dx) * Math.min(Math.abs(dx), WALK_SPEED * dt);
      else if (tn.entering) tn.entering = false;
      tn.sitting = tn.agent.state === "active" && !tn.huddle && !tn.entering && Math.abs(dx) <= 1;
    }
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const tn = this.leaving[i];
      tn.climbing = false;
      if (!tn.leavePhase) {
        // walk to the building's edge on this floor (door to door through rooms)
        const floor = Math.round(-tn.base / FLOOR_STEP);
        let maxC = -Infinity;
        for (const r of this.rooms.values()) {
          if (r.floor === floor) maxC = Math.max(maxC, r.col);
        }
        const edge = isFinite(maxC) ? cellX0(maxC) + ROOM_W : tn.x0 + ROOM_W;
        tn.targetX = edge + 5;
        tn.leavePhase = "walk";
      }
      const atX = Math.abs(tn.x - tn.targetX) <= 1.5;
      if (tn.leavePhase === "walk" && atX) {
        if (Math.abs(tn.base) > 1) {
          // not at ground level → take the fire-escape ladder
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
        tn.base += Math.sign(-tn.base) * step; // climb toward ground (down or up)
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
        const base = floorBase(r.floor);
        const bx = r.x0 + 5, by = base - ROOM_H + 14;
        r.scribbles.push({
          x1: bx + 2 + Math.random() * 16, y1: by + 2 + Math.random() * 8,
          x2: bx + 2 + Math.random() * 16, y2: by + 2 + Math.random() * 8,
          color: Math.random() < 0.3 ? "#d9534f" : Math.random() < 0.5 ? "#2b6cb0" : "#2d3438",
        });
      }
    }

    if (!this.eco && this.frame % 24 === 0) {
      for (const tn of this.toons.values()) {
        if (tn.agent.state === "complete") {
          for (let i = 0; i < 7; i++) {
            this.particles.push({
              x: tn.x, y: tn.base - 18, vx: (Math.random() - 0.5) * 28, vy: -22 - Math.random() * 16,
              life: 1, color: ACCENTS[i % ACCENTS.length], size: 1.4, gravity: 60,
            });
          }
        }
      }
    }
    if (!this.eco && this.frame % 14 === 0) {
      for (const tn of this.toons.values()) {
        if (tn.agent.state === "error") {
          this.particles.push({
            x: tn.x + 6, y: tn.base - 13, vx: 2 + Math.random() * 3, vy: -6 - Math.random() * 4,
            life: 1, color: "#7a8287", size: 1.2, gravity: -4,
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
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  }

  /* ============ PICKING ============ */

  private screenOf(wx: number, wy: number) {
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    const cx = this.insetL + (cw - this.insetL - this.insetR) / 2;
    return {
      x: cx + (wx - this.cam.x) * this.cam.z,
      y: ch / 2 + (wy - this.cam.y) * this.cam.z,
    };
  }

  setInsets(left: number, right: number) {
    if (this.insetL === left && this.insetR === right) return;
    this.insetL = left;
    this.insetR = right;
    this.invalidate();
  }

  private inRect(mx: number, my: number, wx: number, wy: number, ww: number, wh: number) {
    const a = this.screenOf(wx, wy);
    const b = this.screenOf(wx + ww, wy + wh);
    return mx > a.x && mx < b.x && my > a.y && my < b.y;
  }

  private pick(e: PointerEvent): {
    agent?: string;
    room?: string;
    ghost?: { floor: number; col: number };
    addBtn?: string;
    removeBtn?: string;
  } {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    // room buttons (highest priority): ✕ remove (reserved rooms) and + DEV
    for (const r of this.rooms.values()) {
      if (r.built < 0.95) continue;
      const base = floorBase(r.floor);
      if (r.path && this.inRect(mx, my, r.x0 + ROOM_W - 10, base - ROOM_H + 2, 8, 8)) {
        return { removeBtn: r.name };
      }
      if (this.inRect(mx, my, r.x0 + ROOM_W - DOOR_W - 17, base - ROOM_H + 3, 16, 8)) {
        return { addBtn: r.name };
      }
    }
    // ghost slots (any direction)
    for (const g of this.ghosts) {
      if (this.inRect(mx, my, g.x0, g.base - ROOM_H, ROOM_W, ROOM_H)) {
        return { ghost: { floor: g.floor, col: g.col } };
      }
    }
    // toons
    for (const tn of this.toons.values()) {
      const s = this.screenOf(tn.x, tn.base);
      const w = 14 * this.cam.z, h = 22 * this.cam.z;
      if (mx > s.x - w / 2 && mx < s.x + w / 2 && my > s.y - h && my < s.y + 4 * this.cam.z) {
        return { agent: tn.agent.id };
      }
    }
    // rooms
    for (const r of this.rooms.values()) {
      const base = floorBase(r.floor);
      if (this.inRect(mx, my, r.x0, base - ROOM_H, ROOM_W, ROOM_H + SLAB)) {
        return { room: r.name };
      }
    }
    return {};
  }

  private onClick(e: PointerEvent) {
    const hit = this.pick(e);
    if (hit.removeBtn) this.onRemoveRoomCb(hit.removeBtn);
    else if (hit.addBtn) this.onAddAgentCb(hit.addBtn);
    else if (hit.ghost) this.onReserveCb(hit.ghost.floor, hit.ghost.col);
    else if (hit.agent) {
      this.onSelectCb(hit.agent);
      this.focusAgent(hit.agent); // zoom onto the dev you clicked
    } else if (hit.room) {
      if (this.focusRoom_ === hit.room) this.clearFocus();
      else this.focusOn(hit.room);
    } else this.clearFocus();
  }

  /* ============ DRAW ============ */

  private draw() {
    const ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    // sky gradient backdrop + stars
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

    const surfaceY = floorBase(0) + SLAB; // ground level under floor 0
    const { minX, maxX, botY, minFloor } = this.bounds;

    // earth below the surface across the whole campus
    if (minFloor <= 0 || botY > surfaceY) {
      ctx.fillStyle = "#241a12";
      ctx.fillRect(minX - 60, surfaceY, maxX - minX + 120, botY - surfaceY + 26);
      ctx.fillStyle = "#3a2c1d";
      for (let i = 0; i < 90; i++) {
        const hsh = hash("rock" + i);
        const rx = minX - 56 + (hsh % Math.max(1, Math.round(maxX - minX + 112)));
        const ry = surfaceY + 4 + ((hsh >> 7) % Math.max(1, Math.round(botY - surfaceY + 16)));
        ctx.fillRect(rx, ry, 2, 1.4);
      }
    }
    // grass lip at the surface
    ctx.fillStyle = "#3f6a35";
    ctx.fillRect(minX - 60, surfaceY - 1.6, maxX - minX + 120, 1.6);

    // ragged skyline: a roof slab caps each column; beacon on the tallest
    let tallestCol = 0, tallestMax = -Infinity;
    for (const [col, rng] of this.colRange) {
      if (rng.max > tallestMax) {
        tallestMax = rng.max;
        tallestCol = col;
      }
    }
    for (const [col, rng] of this.colRange) {
      const x0 = cellX0(col);
      const roofY = floorBase(rng.max) - ROOM_H;
      ctx.fillStyle = "#2c353e";
      ctx.fillRect(x0 - 1.5, roofY - 3, ROOM_W + 3, 3.4);
      if (col === tallestCol) {
        ctx.fillStyle = "#3a4550";
        ctx.fillRect(x0 + 8, roofY - 9, 2, 6); // antenna
        ctx.fillStyle = "#ff6055";
        if (this.frame % 10 < 5) ctx.fillRect(x0 + 7.4, roofY - 10.6, 3.2, 1.6); // beacon
      }
    }

    // rooms back layer
    const occupants = new Map<string, Map<number, Toon>>();
    for (const tn of this.toons.values()) {
      if (!occupants.has(tn.agent.repo)) occupants.set(tn.agent.repo, new Map());
      if (tn.sitting) occupants.get(tn.agent.repo)!.set(tn.deskIdx, tn);
    }
    for (const r of this.rooms.values()) this.drawRoomBack(ctx, r);

    // ghost slots (reserve a directory, any direction)
    for (const g of this.ghosts) this.drawGhost(ctx, g);

    // chairs
    for (const r of this.rooms.values()) {
      if (r.built < 0.7) continue;
      const base = floorBase(r.floor);
      const slots = Math.min(MAX_DESKS, Math.max(1, r.agents.length || 1));
      for (let i = 0; i < slots; i++) {
        const dx = r.x0 + WB_W + i * DESK_W;
        ctx.fillStyle = "#3a4046";
        ctx.fillRect(dx + 10, base - 8, 7, 1.6);
        ctx.fillRect(dx + 15.6, base - 14, 1.4, 7);
        ctx.fillRect(dx + 13, base - 6.5, 1.4, 6.5);
      }
    }
    // fire-escape ladders under departing climbers
    for (const tn of this.leaving) {
      if (tn.ladderFrom === undefined || tn.ladderX === undefined) continue;
      const top = Math.min(0, tn.ladderFrom);
      const bot = Math.max(0, tn.ladderFrom);
      ctx.fillStyle = "#5a646c";
      ctx.fillRect(tn.ladderX - 2.6, top, 0.9, bot - top + 1);
      ctx.fillRect(tn.ladderX + 1.7, top, 0.9, bot - top + 1);
      for (let y = top + 2; y < bot; y += 4) {
        ctx.fillRect(tn.ladderX - 2.6, y, 5.2, 0.8);
      }
    }

    // toons
    const allToons = [...this.toons.values(), ...this.leaving];
    allToons.sort((a, b) => a.x - b.x);
    for (const tn of allToons) this.drawToon(ctx, tn);
    // desk fronts
    for (const r of this.rooms.values()) this.drawDesks(ctx, r, occupants.get(r.name));
    // particles
    for (const p of this.particles) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    /* ---- screen-space pass ---- */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center";
    for (const r of this.rooms.values()) {
      if (r.built < 0.85) continue;
      const base = floorBase(r.floor);
      const s = this.screenOf(r.x0 + 7, base - ROOM_H + 9);
      ctx.font = "600 9px 'Martian Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = `hsl(${r.hue} 50% 65%)`;
      const lvl = r.floor >= 0 ? `F${r.floor}` : `B${-r.floor}`;
      ctx.fillText(`${lvl} · ${r.name.toUpperCase()}`, s.x, s.y - 4 * this.cam.z);
      // "+ DEV" button
      if (r.built >= 0.95) {
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
      }
      // ✕ remove (reserved rooms only)
      if (r.path && r.built >= 0.95) {
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
        ctx.fillText("✕", (c1.x + c2.x) / 2, (c1.y + c2.y) / 2 + 3);
      }
    }
    // ghost labels
    for (const g of this.ghosts) {
      const s = this.screenOf(g.x0 + ROOM_W / 2, g.base - ROOM_H / 2);
      ctx.fillStyle = "rgba(170,180,186,0.75)";
      ctx.font = `600 ${clamp(3 * this.cam.z, 8, 12)}px 'Martian Mono', monospace`;
      ctx.textAlign = "center";
      ctx.fillText("+ RESERVE", s.x, s.y - 2);
      ctx.font = `${clamp(2.4 * this.cam.z, 7, 10)}px 'IBM Plex Mono', monospace`;
      ctx.fillStyle = "rgba(140,150,156,0.6)";
      const lvl = g.floor >= 0 ? `F${g.floor}` : `B${-g.floor}`;
      ctx.fillText(`${lvl} · pick a directory`, s.x, s.y + 11);
    }
    // toon labels + bubbles
    for (const tn of this.toons.values()) {
      const s = this.screenOf(tn.x, tn.base - 23);
      const st = tn.agent.state;
      ctx.font = "9px 'IBM Plex Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = tn.agent.id === this.selectedId ? "#ffb13d" : "rgba(230,238,240,0.85)";
      ctx.fillText(tn.agent.name, s.x, s.y - 8);
      const glyph = st === "waiting" ? "?" : st === "complete" ? "✓" : st === "error" ? "✗" : "";
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
        ctx.fillText("▾", s.x, s.y - 18 + Math.sin(this.frame * 0.5) * 2);
      }
    }

    if (this.toonDrag?.active) this.paintDropHint();
  }

  /** Overlay drawn while a toon is being dragged: highlight the drop target
   *  room/ghost and show the agent name floating at the cursor. */
  private paintDropHint() {
    const ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = this.dropTarget;
    if (t?.room) {
      const r = this.rooms.get(t.room);
      if (r) this.strokeWorldRect(r.x0, floorBase(r.floor) - ROOM_H, ROOM_W, ROOM_H + SLAB, "#7fd1ff");
    } else if (t?.ghost) {
      const g = this.ghosts.find((g) => g.floor === t.ghost!.floor && g.col === t.ghost!.col);
      if (g) this.strokeWorldRect(g.x0, g.base - ROOM_H, ROOM_W, ROOM_H, "#9be38b");
    }
    const d = this.toonDrag!;
    const label = this.toons.get(d.id)?.agent.name ?? "agent";
    ctx.font = "11px 'IBM Plex Mono', monospace";
    const w = ctx.measureText(label).width + 14;
    ctx.fillStyle = "rgba(12,16,20,0.92)";
    ctx.fillRect(d.mx + 12, d.my - 9, w, 18);
    ctx.fillStyle = t ? "#cfe8ff" : "#9aa3ab";
    ctx.fillText(label, d.mx + 19, d.my + 3.5);
  }

  /** Stroke a world-space rectangle in screen space (dashed highlight). */
  private strokeWorldRect(wx: number, wy: number, ww: number, wh: number, color: string) {
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

  private drawGhost(ctx: CanvasRenderingContext2D, g: { x0: number; base: number }) {
    ctx.save();
    ctx.strokeStyle = "rgba(140,150,156,0.4)";
    ctx.lineWidth = 0.8;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(g.x0 + 1, g.base - ROOM_H + 1, ROOM_W - 2, ROOM_H - 2);
    ctx.setLineDash([]);
    // faint blueprint grid
    ctx.strokeStyle = "rgba(86,140,180,0.08)";
    for (let gx = g.x0 + 12; gx < g.x0 + ROOM_W - 4; gx += 12) {
      ctx.beginPath();
      ctx.moveTo(gx, g.base - ROOM_H + 3);
      ctx.lineTo(gx, g.base - 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawRoomBack(ctx: CanvasRenderingContext2D, r: Room) {
    const base = floorBase(r.floor);
    const eFloor = clamp(r.built / 0.35, 0, 1);
    const eWall = clamp((r.built - 0.2) / 0.45, 0, 1);
    const eFurn = clamp((r.built - 0.6) / 0.4, 0, 1);
    const x = r.x0, w = ROOM_W, H = ROOM_H;
    const underground = r.floor < 0;

    // floor slab
    ctx.fillStyle = "#3d2f1f";
    ctx.fillRect(x, base - 1.5, w * eFloor, SLAB - 1);
    ctx.fillStyle = "#4a3a26";
    ctx.fillRect(x, base - 1.5, w * eFloor, 1.2);

    if (eWall <= 0) return;
    const wallH = H * eWall;
    ctx.fillStyle = underground ? `hsl(${r.hue} 10% 16%)` : `hsl(${r.hue} 14% 20%)`;
    ctx.fillRect(x + 1.5, base - wallH, w - 3, wallH);
    ctx.fillStyle = underground ? `hsl(${r.hue} 12% 12%)` : `hsl(${r.hue} 16% 16%)`;
    ctx.fillRect(x + 1.5, base - Math.min(10, wallH), w - 3, Math.min(10, wallH));
    ctx.fillStyle = "#1a2128";
    ctx.fillRect(x, base - wallH, 1.5, wallH + 3);
    ctx.fillRect(x + w - 1.5, base - wallH, 1.5, wallH + 3);
    if (eWall >= 1) ctx.fillRect(x, base - H - 1.5, w, 1.5);

    if (eFurn <= 0) return;
    ctx.globalAlpha = eFurn;

    // window above ground; framed rock face below
    const winX = x + w - DOOR_W - 24, winY = base - H + 8;
    ctx.fillStyle = "#10151c";
    ctx.fillRect(winX - 1, winY - 1, 20, 15);
    if (underground) {
      ctx.fillStyle = "#241a12";
      ctx.fillRect(winX, winY, 18, 13);
      ctx.fillStyle = "#3a2c1d";
      ctx.fillRect(winX + 3, winY + 4, 4, 2);
      ctx.fillRect(winX + 11, winY + 8, 5, 2);
      // a worm
      ctx.fillStyle = "#c98ab0";
      if (this.frame % 16 < 8) ctx.fillRect(winX + 8, winY + 10, 2.4, 1);
    } else {
      const sky = ctx.createLinearGradient(0, winY, 0, winY + 13);
      sky.addColorStop(0, "#2c4a6e");
      sky.addColorStop(1, "#b86a3a");
      ctx.fillStyle = sky;
      ctx.fillRect(winX, winY, 18, 13);
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillRect(winX + 3, winY + 3, 3, 1);
      ctx.fillRect(winX + 11, winY + 6, 4, 1);
    }
    ctx.fillStyle = "#10151c";
    ctx.fillRect(winX + 8.5, winY, 1, 13);

    // whiteboard
    const bx = x + 5, by = base - H + 14;
    ctx.fillStyle = "#20262c";
    ctx.fillRect(bx - 1, by - 1, 23, 15);
    ctx.fillStyle = "#e8ecef";
    ctx.fillRect(bx, by, 21, 13);
    ctx.fillStyle = "#aab2b8";
    ctx.fillRect(bx, by + 13, 21, 1.2);
    ctx.lineWidth = 0.8;
    for (const s of r.scribbles) {
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    }

    // plant + hash decor
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
        const on = (this.frame + i * 3 + (r.decor % 7)) % 8 < 4;
        ctx.fillStyle = on ? (i === 2 ? "#3ee089" : "#ffb13d") : "#2a3138";
        ctx.fillRect(sx + 4.2, base - 14.5 + i * 3.2, 1, 1);
      }
    } else {
      ctx.fillStyle = `hsl(${(r.hue + 120) % 360} 40% 45%)`;
      ctx.fillRect(x + WB_W + 2, base - H + 10, 7, 9);
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillRect(x + WB_W + 3.2, base - H + 12, 4.6, 1);
    }

    // ceiling lamp
    const lx = x + w / 2;
    ctx.fillStyle = "#20262c";
    ctx.fillRect(lx - 0.6, base - H, 1.2, 4);
    ctx.fillStyle = "#3a4046";
    ctx.fillRect(lx - 3.5, base - H + 4, 7, 2);
    const lit = r.agents.length > 0;
    ctx.fillStyle = lit ? "rgba(255,200,110,0.07)" : "rgba(255,200,110,0.02)";
    ctx.beginPath();
    ctx.moveTo(lx - 3, base - H + 6);
    ctx.lineTo(lx + 3, base - H + 6);
    ctx.lineTo(lx + 13, base);
    ctx.lineTo(lx - 13, base);
    ctx.closePath();
    ctx.fill();

    // door to the lift
    const doorX = x + w - DOOR_W + 3;
    ctx.fillStyle = "#5a4126";
    ctx.fillRect(doorX, base - 21, 11, 21);
    ctx.fillStyle = "#6e522f";
    ctx.fillRect(doorX + 1.2, base - 19.5, 8.6, 18);
    ctx.fillStyle = "#d9b34a";
    ctx.fillRect(doorX + 8.2, base - 11, 1.4, 1.4);

    // vacant reserved rooms sit dark until a dev moves in
    if (!lit && r.path) {
      ctx.fillStyle = "rgba(8,11,14,0.45)";
      ctx.fillRect(x + 1.5, base - H, w - 3, H);
    }
    ctx.globalAlpha = 1;
  }

  private drawDesks(ctx: CanvasRenderingContext2D, r: Room, occ?: Map<number, Toon>) {
    const eFurn = clamp((r.built - 0.6) / 0.4, 0, 1);
    if (eFurn <= 0) return;
    const base = floorBase(r.floor);
    ctx.globalAlpha = eFurn;
    const slots = Math.min(MAX_DESKS, Math.max(1, r.agents.length || 1));
    for (let i = 0; i < slots; i++) {
      const dx = r.x0 + WB_W + i * DESK_W;
      const tn = occ?.get(i);
      const st = tn?.agent.state;
      ctx.fillStyle = "#6e522f";
      ctx.fillRect(dx + 2, base - 11, 18, 2);
      ctx.fillStyle = "#54401f";
      ctx.fillRect(dx + 3, base - 9, 1.5, 9);
      ctx.fillRect(dx + 17.5, base - 9, 1.5, 9);
      const flicker = tn && st === "active" && this.frame % 4 < 2;
      ctx.fillStyle = "#171c21";
      ctx.fillRect(dx + 4, base - 18, 9, 7);
      ctx.fillStyle = st === "error" ? "#8a2f28" : tn ? (flicker ? "#9fd8ff" : "#7fc4ef") : "#222d35";
      ctx.fillRect(dx + 4.8, base - 17.2, 7.4, 5.4);
      ctx.fillStyle = "#171c21";
      ctx.fillRect(dx + 8, base - 11, 1.4, 1);
      ctx.fillStyle = "#2a3138";
      ctx.fillRect(dx + 13.5, base - 11.8, 5, 1);
      ctx.fillStyle = "#d9534f";
      ctx.fillRect(dx + 0.5, base - 13, 2, 2);
      if (tn && this.frame % 8 < 4) {
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillRect(dx + 1, base - 15, 0.8, 1.4);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawToon(ctx: CanvasRenderingContext2D, tn: Toon) {
    const p = tn.p;
    const st = tn.agent.state;
    const walking = Math.abs(tn.targetX - tn.x) > 1;
    const f = this.frame + Math.floor(tn.ph * 10);
    const x = Math.round(tn.x * 2) / 2;
    const sitting = tn.sitting;
    const y0 = tn.base + (sitting ? -3.5 : 0);
    const hop =
      st === "complete" && !walking ? -Math.abs(Math.sin(f * 0.55 + tn.ph)) * 2 :
      st === "waiting" && !walking ? -Math.abs(Math.sin(f * 0.35 + tn.ph)) * 1 : 0;
    const slump = st === "error" && !walking ? 1.4 : 0;
    const base = y0 + hop;
    const facingLeft = tn.huddle;

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
      // hand-over-hand on the ladder rungs
      const g = f % 2;
      ctx.fillRect(x - 4.2, ty - 2 + g, 1.4, 4);
      ctx.fillRect(x + 2.8, ty - 2 + (1 - g), 1.4, 4);
      ctx.fillStyle = handC;
      ctx.fillRect(x - 4.4, ty - 3.4 + g, 1.6, 1.6);
      ctx.fillRect(x + 2.6, ty - 3.4 + (1 - g), 1.6, 1.6);
    } else if (sitting) {
      const tap = f % 2 === 0 ? 0 : 0.8;
      ctx.fillRect(x + 2.6, ty + 2.2, 3.4, 1.4);
      ctx.fillStyle = handC;
      ctx.fillRect(x + 5.6, ty + 2 + tap, 1.4, 1.4);
      ctx.fillRect(x + 5.6, ty + 3.6 - tap, 1.4, 1.4);
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
      // asking a question: hand up and WAVING, other hand cupped to mouth
      const wave = Math.sin(f * 0.9 + tn.ph) * 1.1;
      ctx.fillRect(x + 2.8 + wave * 0.4, ty - 4, 1.5, 5);
      ctx.fillStyle = handC;
      ctx.fillRect(x + 2.7 + wave, ty - 5.6, 1.8, 1.8);
      ctx.fillStyle = p.shirt;
      ctx.fillRect(x - 4.4, ty - 0.6, 1.6, 2.8);
      ctx.fillStyle = handC;
      ctx.fillRect(x - 3.2, ty - 2, 1.5, 1.5); // cupped at the mouth
    } else if (st === "complete" && !walking) {
      const v = f % 2 === 0 ? 0 : 1;
      ctx.fillRect(x - 4.6, ty - 3 + v, 1.5, 4);
      ctx.fillRect(x + 3.1, ty - 3 + (1 - v), 1.5, 4);
      ctx.fillStyle = handC;
      ctx.fillRect(x - 4.8, ty - 4.6 + v, 1.8, 1.8);
      ctx.fillRect(x + 2.9, ty - 4.6 + (1 - v), 1.8, 1.8);
    } else if (walking) {
      const sw = f % 2 === 0 ? 1 : -1;
      ctx.fillRect(x - 4.2, ty + 1.5 + sw * 0.8, 1.4, 4);
      ctx.fillRect(x + 2.8, ty + 1.5 - sw * 0.8, 1.4, 4);
    } else if (st === "idle") {
      // off the clock: scrolling on their phone (clearly NOT working)
      ctx.fillRect(x - 4.2, ty + 1.5, 1.4, 4); // left arm hangs
      ctx.fillRect(x + 2.6, ty + 1.2, 1.4, 2.4); // right arm bent up
      // phone with glowing screen
      ctx.fillStyle = "#171c21";
      ctx.fillRect(x + 1.8, ty + 2.8, 2.6, 3.6);
      const glow = f % 6 < 3 ? "#9fd8ff" : "#7fb8df";
      ctx.fillStyle = glow;
      ctx.fillRect(x + 2.2, ty + 3.2, 1.8, 2.8);
      // thumb scrolls
      ctx.fillStyle = handC;
      ctx.fillRect(x + 3.6, ty + 3.4 + (f % 4 < 2 ? 0 : 0.8), 1.2, 1.2);
      // soft screen light on the face
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
      // eyes drop to the phone when idle, occasionally glancing back up
      const phoneGaze = st === "idle" && !walking && f % 50 > 6 ? 0.9 : 0;
      const ey = hy + 2.4 + slump * 0.5 + phoneGaze;
      if (facingLeft || (walking && tn.targetX < tn.x)) {
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
}

/* ============ window API ============ */
(window as any).FleetCrew = {
  _instance: null as PixelCrew | null,
  mount(container: HTMLElement, canvas: HTMLCanvasElement) {
    this._instance = new PixelCrew(container, canvas);
    return this._instance;
  },
  setAgents(a: CrewAgent[]) {
    this._instance?.setAgents(a);
  },
  setRooms(r: ReservedRoom[]) {
    this._instance?.setRooms(r);
  },
  setSelected(id: string | undefined) {
    this._instance?.setSelected(id);
  },
  onSelect(cb: (id: string) => void) {
    this._instance?.onSelect(cb);
  },
  onReserve(cb: (floor: number) => void) {
    this._instance?.onReserve(cb);
  },
  onAddAgent(cb: (room: string) => void) {
    this._instance?.onAddAgent(cb);
  },
  onRemoveRoom(cb: (room: string) => void) {
    this._instance?.onRemoveRoom(cb);
  },
  onCd(cb: (id: string, target: { room?: string; ghost?: { floor: number; col: number } }) => void) {
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
  focusIsland(repo: string) {
    this._instance?.focusOn(repo);
  },
  clearFocus() {
    this._instance?.clearFocus();
  },
  setEco(on: boolean) {
    this._instance?.setEco(on);
  },
  setInsets(left: number, right: number) {
    this._instance?.setInsets(left, right);
  },
};
