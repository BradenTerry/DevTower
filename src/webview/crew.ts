/* DevTower Crew — pixel office tower / mine renderer (Canvas2D, no WebGL).
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
 * camera motion; hard-stop when hidden. Same window.DevTowerCrew API as before,
 * plus setRooms / onReserve / onAddAgent. */

interface CrewAgent {
  id: string;
  name: string;
  state: string;
  repo: string;
  model: string;
  worktree?: string; // git worktree path; groups desks within a room
  branch?: string; // branch name, shown on the cluster sign
}

interface ReservedRoom {
  name: string;
  path: string;
  floor: number;
  col: number;
  // the island's worktrees (incl. the required main checkout), so empty rooms
  // render before any agent is in them
  worktrees?: { path: string; branch: string }[];
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
const ROOM_H = 84; // taller walls leave a mid-band for the per-room task board
const SLAB = 8; // concrete between floors
const FLOOR_STEP = ROOM_H + SLAB;
const WB_W = 42; // left inset before the first desk
const DESK_W = 26;
const DOOR_W = 18;
// Room depth: the interior is a shallow one-point-perspective box. The far wall
// is inset by DEPTH_X on each side and its floor line sits DEPTH_Y above the
// near floor; the floor, ceiling and side walls are drawn as trapezoids between
// the front opening and that back wall. All wall furniture (whiteboard, task
// board, window) hangs on the back wall.
const DEPTH_X = 24; // far-wall horizontal inset per side
const DEPTH_Y = 22; // far-wall floor sits this far above the near floor
// Two desk rows form a center aisle: a front row at the near floor and a back
// row standing on the far-wall floor line. Devs always walk the aisle on the
// near floor, then "lift" up to the back row when they settle. The lift is
// render-only: a dev's true baseline (tn.base) never moves, so floor-detection
// and the fire-escape exit math stay correct.
const ROWS_OF_DESKS = 2;
const ROW_DY = DEPTH_Y; // back row stands on the far-wall floor line
// back-row desks are staggered toward room center by half the column pitch
// (see PixelCrew.seatX); the pitch is per-room so it scales with desk count
const ROOM_W = 260; // room interior width (door to door); the board is on the back wall
// Desks are laid out per worktree by seatPlan(): each worktree block fills
// columns left to right, two rows (front + back) per column, so every agent
// gets a seat and the blocks span the floor between the left inset and the door.

/** Far (back) wall rectangle in world space: the inset panel the whiteboard,
 *  task board and window hang on, and the line the back desk row stands at. */
const backWall = (x0: number, base: number) => ({
  x0: x0 + DEPTH_X,
  x1: x0 + ROOM_W - DEPTH_X,
  yTop: base - ROOM_H + 10, // just below the receded ceiling
  yBot: base - DEPTH_Y, // far-wall floor line
});

// Roller whiteboard: a freestanding board on an easel that spawns once per
// worktree group, standing to the left of that group's desks. ROLLER_DEPTH
// pushes it back from the front floor so devs can gather around it; the board
// sits ROLLER_LEG above the floor on legs that reach the castors.
const ROLLER_W = 30; // max board width; clamped to the section it sits in
const ROLLER_H = 22;
const ROLLER_DEPTH = 13;
const ROLLER_LEG = 12; // floor-to-board-bottom (the easel height)
const rollerPanel = (cx: number, base: number) => {
  const stand = base - ROLLER_DEPTH; // floor line the castors roll on
  return { x: cx - ROLLER_W / 2, y: stand - ROLLER_LEG - ROLLER_H, w: ROLLER_W, h: ROLLER_H };
};

/** Stat-tracker screen: a big flat-panel "TV" that fills the whole back wall
 *  (the windows live on the side walls now). */
const boardRect = (x0: number, base: number) => {
  const bw = backWall(x0, base);
  const left = bw.x0 + 3;
  const right = bw.x1 - 3;
  const top = bw.yTop + 3;
  const bottom = bw.yBot - 5; // leave the baseboard
  return { x: left, y: top, w: Math.max(20, right - left), h: Math.max(14, bottom - top) };
};
// rooms share walls — one contiguous building, door to door
const COL_STEP = ROOM_W;
const cellX0 = (col: number) => col * COL_STEP - ROOM_W / 2;
const WALK_SPEED = 30;

// Island layout: an island is one repo/directory drawn as a vertical tower one
// column wide — the main (root) checkout on the ground, each worktree stacked a
// floor higher. Towers stand ISLAND_GAP columns apart so they read as distinct
// landmasses, each on its own platform.
const ISLAND_GAP = 1; // empty columns between adjacent islands
const PLINTH_H = 22; // front-face height of the island pedestal (below ground)
const PLINTH_APRON = 8; // depth of the pedestal's top surface tilting toward us
const PLINTH_OV = 9; // how far the pedestal splays out past the tower on each side

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; color: string; size: number; gravity: number;
}
/** A glowing "commit packet" that flies from a dev's desk to the room board
 *  whenever that worktree's files change. */
interface Packet { x: number; y: number; sx: number; sy: number; tx: number; ty: number; t: number; color: string }
interface Stroke { x1: number; y1: number; x2: number; y2: number; color: string }

// A "room" is now one BUILDING = one worktree/checkout. Buildings of the same
// repo share an island; the map key is the building key (worktree path).
interface Room {
  name: string; // unique building key (worktree path, or island name if none)
  island: string; // island this building belongs to (the repo/directory name)
  label: string; // building sign: "main" for the primary checkout, else branch
  branch: string; // the checkout's branch name (shown under the board)
  isMain: boolean; // the island's primary checkout
  floor: number; // packed grid floor (target)
  col: number; // packed grid column (target)
  x0: number; // left edge of this building (world) — tweens toward cellX0(col)
  baseY: number; // near-floor baseline (world) — tweens toward floorBase(floor)
  path?: string; // island directory, when reserved
  hue: number;
  built: number;
  delay: number; // staggered construction start (seconds)
  dying?: boolean; // queued for demolition once its leavers are out
  hasUpper?: boolean; // a worktree building stacks on top → draw an internal staircase
  agents: CrewAgent[];
  scribbles: Stroke[];
  decor: number;
  plan?: SeatPlan; // desks grouped by worktree (recomputed each layout)
  board?: BoardData; // live git/PR data shown on the back-wall screen
  statTotal: number; // last seen modified+staged+ahead, to detect changes → fire packets
  statPulse: number; // 0..1 board glow that decays after a change
}

/** Board payload pushed from the extension (see consolePanel BoardData). */
interface BoardData {
  branch: string;
  modified: number;
  staged: number;
  modifiedFiles: string[];
  stagedFiles: string[];
  unstagedAdd: number;
  unstagedDel: number;
  stagedAdd: number;
  stagedDel: number;
  committedAdd: number;
  committedDel: number;
  ahead: number;
  commits: string[];
  missing?: boolean;
  pr?: {
    number: number;
    title: string;
    url: string;
    draft: boolean;
    checks: "pass" | "fail" | "pending" | "none";
    review: "approved" | "changes" | "required" | "none";
  };
}

/** An island: one repo/directory hosting a contiguous cluster of buildings. */
interface Island {
  name: string; // repo / directory name
  path?: string; // reserved directory, when known
  laneStart: number; // first column of the island's lane
  cols: number; // columns the lane spans
  count: number; // number of live buildings (worktrees)
  hue: number;
}

/** One worktree's block of desks within a room. */
interface DeskGroup {
  name: string; // worktree name ("main" for the primary worktree)
  branch: string; // branch checked out in that worktree
  isMain: boolean;
  startCol: number; // first column index of this block
  cols: number; // columns it spans
  hue: number; // accent hue
}

interface SeatPlan {
  seats: Map<string, { col: number; row: number }>; // agentId -> seat
  groups: DeskGroup[];
  totalCols: number;
  pitch: number; // per-column horizontal step, compressed to fit the room width
}

const GROUP_GAP = 1; // empty columns (partition) between worktree blocks
const DEFAULT_BRANCHES = new Set(["main", "master", "head", "develop", "trunk"]);

interface Toon {
  agent: CrewAgent;
  p: ReturnType<typeof persona>;
  x: number;
  targetX: number;
  base: number; // floor baseline (world y)
  x0: number; // left edge of the toon's room (for lift entry/exit)
  bkey?: string; // building this toon belongs to (so tick can re-glue it)
  seatCol: number; // cached seat within the building (recomputed on layout)
  wbSlot: number; // cached whiteboard huddle slot
  deskIdx: number;
  row: number; // 0 = front aisle, 1 = back row (drawn higher)
  lift: number; // current render-only vertical offset toward the back row
  huddle: boolean;
  sitting: boolean;
  entering: boolean;
  // entry path: upper-floor devs climb the staircase in the floor below to reach
  // their door; ground-floor devs just walk in.
  enterPhase?: "stairs" | "walk";
  stairTopX?: number;
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
  private rooms = new Map<string, Room>(); // key = building key (worktree path)
  private islands = new Map<string, Island>(); // key = island name (repo)
  private reserved: ReservedRoom[] = [];
  private agents: CrewAgent[] = [];
  private particles: Particle[] = [];
  private packets: Packet[] = []; // desk → board "file changed" trails
  private boardsMap: Record<string, BoardData> = {};
  private hasFitted = false; // first layout fits the campus; later ones preserve the view
  // ghost slots come in two kinds: "building" extends an island with the next
  // worktree (click → add agent there), "island" reserves a brand-new directory.
  private ghosts: {
    col: number; floor: number; x0: number; base: number;
    kind: "building" | "island"; island?: string;
  }[] = [];
  private colRange = new Map<number, { min: number; max: number }>();
  private bounds = { minX: -120, maxX: 120, topY: -120, botY: 40, minFloor: 0 };

  private focusRoom_: string | null = null;
  private focusAgentId: string | null = null; // when set, the camera tracks this dev (not the room)
  private prBranches = new Set<string>(); // branches (lowercased) with an open PR
  private focus = { x: 0, y: -ROOM_H / 2, spanW: ROOM_W + 60, spanH: FLOOR_STEP + 60 };
  private cam = { x: 0, y: -ROOM_H / 2, z: 4 };
  private zoomMul = 1;
  private panX = 0;
  private panY = 0;
  private drag = { active: false, moved: false, lastX: 0, lastY: 0 };
  // dragging a toon onto a room (or a ghost cell) issues a /cd for that agent
  private toonDrag: { id: string; active: boolean; mx: number; my: number; blocked: boolean } | null = null;
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
  private onAddDevCb: (island: string, worktree: string) => void = () => {};
  private onAddWorktreeCb: (island: string) => void = () => {};
  private onRemoveRoomCb: (room: string) => void = () => {};
  private onRemoveWorktreeCb: (worktree: string, island: string) => void = () => {};
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
      // grabbing a toon begins a drag-to-relocate gesture, not a camera pan.
      // An active agent can't be relocated (its session is mid-task), so the
      // drag is blocked — a tap still selects it.
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
            // active agent: no relocation target, show it's not allowed
            this.dropTarget = null;
            this.container.style.cursor = "not-allowed";
            this.invalidate();
            return;
          }
          const hit = this.pick(e);
          // dropping on a building (or a +building ghost) moves the agent into
          // that island's directory; a +island ghost picks a new directory.
          if (hit.island && !hit.ghost) this.dropTarget = { room: hit.island };
          else if (hit.ghost?.kind === "building" && hit.ghost.island) this.dropTarget = { room: hit.ghost.island };
          else if (hit.ghost?.kind === "island") this.dropTarget = { ghost: { floor: hit.ghost.floor, col: hit.ghost.col } };
          else this.dropTarget = null;
          this.container.style.cursor = this.dropTarget ? "copy" : "grabbing";
          this.invalidate();
        }
        return;
      }
      if (!this.drag.active) {
        const hit = this.pick(e);
        this.container.style.cursor =
          hit.agent || hit.room || hit.ghost || hit.addDev || hit.removeBtn || hit.removeWtBtn
            ? "pointer"
            : "default";
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
  onAddDev(cb: (island: string, worktree: string) => void) { this.onAddDevCb = cb; }
  onAddWorktree(cb: (island: string) => void) { this.onAddWorktreeCb = cb; }
  onRemoveRoom(cb: (room: string) => void) { this.onRemoveRoomCb = cb; }
  onRemoveWorktree(cb: (worktree: string, island: string) => void) { this.onRemoveWorktreeCb = cb; }
  onCd(cb: (id: string, target: { room?: string; ghost?: { floor: number; col: number } }) => void) {
    this.onCdCb = cb;
  }
  private newToonIds = new Set<string>();

  /* ============ DATA ============ */

  setRooms(reserved: ReservedRoom[]) {
    this.reserved = reserved || [];
    this.layout();
  }

  /** Live board data per worktree path (modified/staged/commits/PR), shown on
   *  each room's back-wall screen. */
  setBoards(boards: Record<string, BoardData>) {
    this.boardsMap = boards || {};
    this.layout();
  }

  /** Branches that currently have an open PR; shown on each worktree's board. */
  setPrBranches(branches: string[]) {
    this.prBranches = new Set((branches || []).filter(Boolean).map((b) => b.toLowerCase()));
    this.invalidate();
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
          agent: a, p: persona(a.id), x: 0, targetX: 0, base: 0, x0: 0,
          seatCol: 0, wbSlot: 0, deskIdx: 0,
          row: 0, lift: 0,
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

  /** Group a room's agents into per-worktree desk blocks. The main worktree
   *  (default branch, or a "." / root checkout) comes first and is labelled
   *  "main"; each other worktree gets a contiguous block of columns after a
   *  one-column partition gap, signed with its branch. */
  private seatPlan(agents: CrewAgent[]): SeatPlan {
    const byTree = new Map<string, CrewAgent[]>();
    for (const a of agents) {
      const key = a.worktree && a.worktree.trim() ? a.worktree : ".";
      if (!byTree.has(key)) byTree.set(key, []);
      byTree.get(key)!.push(a);
    }
    const isMain = (key: string, ags: CrewAgent[]) =>
      key === "." || key === "" || DEFAULT_BRANCHES.has((ags[0].branch ?? "").toLowerCase());
    const treeName = (key: string) => key.split(/[\\/]/).pop() || key;
    const entries = [...byTree.entries()].sort((a, b) => {
      const am = isMain(a[0], a[1]) ? 0 : 1;
      const bm = isMain(b[0], b[1]) ? 0 : 1;
      if (am !== bm) return am - bm;
      return treeName(a[0]) < treeName(b[0]) ? -1 : 1;
    });
    const seats = new Map<string, { col: number; row: number }>();
    const groups: DeskGroup[] = [];
    let startCol = 0;
    let mainTaken = false; // at most one block is the "main" worktree
    for (const [key, ags] of entries) {
      const cols = Math.max(1, Math.ceil(ags.length / ROWS_OF_DESKS));
      ags.forEach((a, i) => {
        seats.set(a.id, { col: startCol + Math.floor(i / ROWS_OF_DESKS), row: i % ROWS_OF_DESKS });
      });
      const main = !mainTaken && isMain(key, ags);
      if (main) mainTaken = true;
      groups.push({
        name: main ? "main" : treeName(key),
        branch: ags[0].branch || "—",
        isMain: main,
        startCol,
        cols,
        hue: main ? 150 : hash(key) % 360,
      });
      startCol += cols + GROUP_GAP;
    }
    const totalCols = Math.max(0, startCol - GROUP_GAP);
    // Compress the column pitch so every worktree block fits between the left
    // inset and the door instead of spilling into the neighboring room. The
    // span is the room left for column starts (last start + a desk's furniture
    // lands at the door); pitch never grows past the natural DESK_W.
    const span = ROOM_W - WB_W - DOOR_W - DESK_W;
    const pitch = totalCols > 1 ? Math.min(DESK_W, span / (totalCols - 1)) : DESK_W;
    return { seats, groups, totalCols, pitch };
  }

  /** World x of a seat (col/row) within a room, using the room's compressed
   *  column pitch so desks, chairs and signs all line up and stay inside. */
  private seatX(r: Room, col: number, row: number): number {
    const pitch = r.plan?.pitch ?? DESK_W;
    return r.x0 + WB_W + col * pitch + row * (pitch / 2);
  }

  /** An island's ordered rooms: ONLY the ones the operator added — the required
   *  main checkout plus each assigned worktree. Live agents attach by checkout
   *  path; agents in unassigned dirs aren't shown. Main leads. */
  private planBuildings(reserved: ReservedRoom, agentsByKey: Map<string, CrewAgent[]>) {
    const rootKey = reserved.path;
    const treeName = (key: string) => key.split(/[\\/]/).pop() || key;
    // declared building keys: main (root) + assigned worktrees (postState sends
    // the main checkout as the first worktree entry, so dedupe against rootKey)
    const branchByKey = new Map<string, string>();
    branchByKey.set(rootKey, "");
    for (const w of reserved.worktrees ?? []) {
      if (!branchByKey.get(w.path)) branchByKey.set(w.path, w.branch || "");
    }
    const keys = [rootKey, ...[...branchByKey.keys()].filter((k) => k !== rootKey)];
    return keys.map((key) => {
      const agents = agentsByKey.get(key) ?? [];
      const isMain = key === rootKey;
      const branch = branchByKey.get(key) || agents[0]?.branch || "";
      return {
        key, agents, isMain, path: rootKey,
        branch: branch || "—",
        label: isMain ? "main" : branch || treeName(key),
      };
    });
  }

  /** Re-aim a toon at its desk/huddle spot using its building's CURRENT (tweening)
   *  position, so seated devs ride a collapsing island instead of snapping. */
  private retargetToon(tn: Toon) {
    const room = tn.bkey ? this.rooms.get(tn.bkey) : undefined;
    if (!room) return;
    tn.base = room.baseY;
    tn.x0 = room.x0;
    const deskX = this.seatX(room, tn.seatCol, tn.row);
    if (tn.huddle) tn.targetX = room.x0 + 26 + tn.wbSlot * 9;
    else if (tn.agent.state === "active") tn.targetX = deskX + 13;
    else tn.targetX = deskX + 19;
  }

  /** Fire a glowing packet from a working dev's desk up to the room's board — the
   *  visual "a file just changed" signal. Falls back to room center if empty. */
  private emitPacket(r: Room) {
    let sx = r.x0 + ROOM_W / 2, sy = r.baseY - 16;
    const occ = r.agents.find((a) => this.toons.get(a.id)?.sitting) ?? r.agents[0];
    const tn = occ ? this.toons.get(occ.id) : undefined;
    if (tn) { sx = tn.x; sy = tn.base - tn.lift - 12; }
    const b = boardRect(r.x0, r.baseY);
    const tx = b.x + b.w * (0.3 + Math.random() * 0.4);
    const ty = b.y + b.h * (0.4 + Math.random() * 0.3);
    this.packets.push({
      x: sx, y: sy, sx, sy, tx, ty, t: 0,
      color: Math.random() < 0.6 ? "#3ee089" : "#56c7ff",
    });
  }

  /** Build the campus: only rooms the operator added (reserved islands + their
   *  assigned worktrees) render. Live agents attach to those rooms by their
   *  checkout path; an agent whose room wasn't added simply isn't shown (its
   *  session keeps running regardless). */
  private layout() {
    // 1. agents grouped by their checkout path (= the building key)
    const agentsByKey = new Map<string, CrewAgent[]>();
    for (const a of this.agents) {
      const key = a.worktree && a.worktree.trim() ? a.worktree : null;
      if (!key) continue;
      if (!agentsByKey.has(key)) agentsByKey.set(key, []);
      agentsByKey.get(key)!.push(a);
    }

    // island order: reserved islands by their stored col/floor hint (left→right)
    const reservedByName = new Map(this.reserved.map((r) => [r.name, r] as const));
    const order = [...this.reserved]
      .sort((a, b) => a.col - b.col || a.floor - b.floor || (a.name < b.name ? -1 : 1))
      .map((r) => r.name);

    // 2. each island is a vertical tower one column wide: the main (root) checkout
    //    sits on the ground at floor 0 and every worktree stacks upward (floor 1,
    //    2, …). Towers stand ISLAND_GAP columns apart. Stacking keeps buildings
    //    4-connected, and re-packing on removal drops survivors down (the collapse
    //    animation in tick()).
    const wanted = new Map<string, {
      island: string; label: string; branch: string; isMain: boolean; col: number; floor: number;
      path?: string; agents: CrewAgent[];
    }>();
    this.islands.clear();
    let lane = 0;
    for (const name of order) {
      const reserved = reservedByName.get(name);
      if (!reserved) continue;
      const buildings = this.planBuildings(reserved, agentsByKey); // main first, then worktrees
      const path = reserved.path;
      buildings.forEach((b, i) => {
        wanted.set(b.key, {
          island: name, label: b.label, branch: b.branch, isMain: b.isMain,
          col: lane, floor: i, path: b.path ?? path, agents: b.agents,
        });
      });
      this.islands.set(name, {
        name, path, laneStart: lane, cols: 1,
        count: buildings.length, hue: hash(name) % 360,
      });
      lane += 1 + ISLAND_GAP;
    }

    // 3. buildings with no agents left (worktree closed) demolish in tick()
    for (const [key, room] of this.rooms) {
      room.dying = !wanted.has(key);
      if (room.dying) room.agents = [];
    }

    // 4. create/update building objects. x0/baseY hold the animated position and
    //    are tweened toward the packed cell in tick(); col/floor are the target.
    let newIdx = 0;
    for (const [key, info] of wanted) {
      let room = this.rooms.get(key);
      if (!room) {
        room = {
          name: key, island: info.island, label: info.label, branch: info.branch, isMain: info.isMain,
          floor: info.floor, col: info.col,
          x0: cellX0(info.col), baseY: floorBase(info.floor), path: info.path,
          hue: hash(info.island) % 360, built: 0,
          delay: newIdx++ * 0.45, // buildings rise one after another
          agents: [], scribbles: [], decor: hash(key + "decor"),
          statTotal: -1, statPulse: 0,
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
      room.hasUpper = false; // recomputed below
    }

    // a building gets an internal staircase when another building stacks on top
    for (const r of this.rooms.values()) {
      if (r.dying) continue;
      for (const u of this.rooms.values()) {
        if (!u.dying && u.island === r.island && u.col === r.col && u.floor === r.floor + 1) {
          r.hasUpper = true;
          break;
        }
      }
    }

    // 5. ghosts: a "+building" slot on top of each tower (the next worktree),
    //    plus a "+island" reserve slot in the gap past the last tower.
    this.ghosts = [];
    for (const isl of this.islands.values()) {
      const floor = isl.count; // stack the next worktree above the top building
      this.ghosts.push({
        col: isl.laneStart, floor, x0: cellX0(isl.laneStart), base: floorBase(floor),
        kind: "building", island: isl.name,
      });
    }
    const reserveCol = this.islands.size === 0 ? 0 : lane;
    this.ghosts.push({
      col: reserveCol, floor: 0, x0: cellX0(reserveCol), base: floorBase(0), kind: "island",
    });

    // 6. per-column roof ranges (skyline) + world bounds
    this.colRange.clear();
    let minX = Infinity, maxX = -Infinity, topY = Infinity, botY = -Infinity, minFloor = 0;
    const extend = (floor: number, x0: number, base: number) => {
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
    for (const g of this.ghosts) extend(g.floor, g.x0, g.base);
    if (!isFinite(minX)) {
      minX = -120; maxX = 120; topY = -120; botY = 40;
    }
    this.bounds = { minX, maxX, topY, botY, minFloor };

    // 7. seat plan + cache each toon's seat; tick re-glues world coords so devs
    //    follow their building as the island collapses.
    const placed = new Set<string>();
    for (const room of this.rooms.values()) {
      const activeCount = room.agents.filter((a) => a.state === "active").length;
      const huddle = activeCount >= 2;
      let wbSlot = 0;
      room.plan = this.seatPlan(room.agents);
      room.agents.forEach((a, di) => {
        const tn = this.toons.get(a.id);
        if (!tn) return;
        placed.add(a.id);
        tn.bkey = room.name;
        tn.deskIdx = di;
        const seat = room.plan!.seats.get(a.id) ?? { col: 0, row: 0 };
        tn.row = seat.row;
        tn.seatCol = seat.col;
        tn.huddle = a.state === "active" && huddle;
        if (tn.huddle) tn.wbSlot = wbSlot++;
        const firstPlace = tn.entering && tn.x === 0;
        this.retargetToon(tn); // desk target + base on this floor
        if (firstPlace) {
          if (room.floor > 0) {
            // arrive on the floor below and climb the staircase to this door
            tn.x = room.x0 + ROOM_W - 40;
            tn.base = floorBase(room.floor - 1);
            tn.targetX = tn.x;
            tn.enterPhase = "stairs";
            tn.stairTopX = room.x0 + ROOM_W - 24;
          } else {
            tn.x = room.x0 + ROOM_W + 8; // walk in through the ground-floor door
            tn.enterPhase = "walk";
          }
        }
      });
      if (!huddle) room.scribbles = [];
    }

    // cull toons whose room wasn't added to the UI — an agent only appears once
    // its directory/worktree has a room (its session keeps running regardless)
    for (const [id, tn] of this.toons) {
      if (!placed.has(id)) {
        tn.bkey = undefined;
        this.toons.delete(id);
      }
    }

    // keep the operator's view across re-layouts: track a focused dev, else
    // refit a focused room. When nothing is focused, DON'T recenter — adding a
    // room or stats ticking shouldn't yank the camera; only the first layout
    // fits the whole campus.
    if (this.focusAgentId && this.toons.has(this.focusAgentId)) this.focusAgent(this.focusAgentId, false);
    else if (this.focusRoom_ && this.rooms.has(this.focusRoom_)) this.focusOn(this.focusRoom_, false);
    else if (!this.hasFitted) { this.clearFocus(true, false); this.hasFitted = true; }
    this.invalidate();
  }

  /* ============ CAMERA ============ */

  /** Center on a building (by its key) or, failing that, on an island (by repo
   *  name → that island's first building). */
  focusOn(name: string, resetZoom = true) {
    let r = this.rooms.get(name);
    if (!r) r = [...this.rooms.values()].find((b) => b.island === name);
    if (!r) return;
    this.focusAgentId = null; // centering on a building releases any dev zoom
    this.focusRoom_ = r.name;
    this.focus.x = r.x0 + ROOM_W / 2;
    this.focus.y = r.baseY - ROOM_H / 2;
    this.focus.spanW = ROOM_W + 26;
    this.focus.spanH = FLOOR_STEP + 34;
    this.panX = 0;
    this.panY = 0;
    if (resetZoom) this.zoomMul = 1;
    this.invalidate();
  }

  /** Tight zoom onto one agent (their corner of the room). On the initial click
   *  (resetZoom) we recentre; periodic re-layouts call it with resetZoom=false to
   *  keep tracking the dev without fighting the operator's pan/zoom. */
  focusAgent(id: string, resetZoom = true) {
    const tn = this.toons.get(id);
    if (!tn) return;
    const room = tn.bkey ? this.rooms.get(tn.bkey) : undefined;
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
    if (this.particles.length || this.leaving.length || this.packets.length) return false;
    for (const r of this.rooms.values()) {
      if (r.dying || r.delay > 0 || r.built < 1 || r.statPulse > 0.02) return false;
      // still sliding toward its packed cell (collapse animation)
      if (Math.abs(cellX0(r.col) - r.x0) > 0.5 || Math.abs(floorBase(r.floor) - r.baseY) > 0.5) return false;
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
      // slide each building toward its packed cell — this is the collapse: when
      // a worktree closes, its island re-packs and the survivors glide together.
      // Dying buildings freeze in place and just shrink.
      if (!r.dying) {
        const tx = cellX0(r.col), ty = floorBase(r.floor);
        const k = Math.min(1, dt * 6);
        r.x0 += (tx - r.x0) * k;
        r.baseY += (ty - r.baseY) * k;
        if (Math.abs(tx - r.x0) < 0.4) r.x0 = tx;
        if (Math.abs(ty - r.baseY) < 0.4) r.baseY = ty;
      }
      if (r.dying) {
        // wait until the departing dev has fully left, then deconstruct
        const hasLeaver = this.leaving.some((t) => t.bkey === r.name);
        if (!hasLeaver) {
          r.built = Math.max(0, r.built - dt / 1.0);
          if (!this.eco) {
            this.particles.push({
              x: r.x0 + Math.random() * ROOM_W * Math.max(0.1, r.built), y: r.baseY - 2 - Math.random() * 10,
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
          this.particles.push({
            x: r.x0 + Math.random() * ROOM_W * r.built, y: r.baseY - 2 - Math.random() * 10,
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

    // boards: when a worktree's git stats grow, a file changed → fire packets
    // from the desks to the board; the glow then decays
    for (const r of this.rooms.values()) {
      if (r.statPulse > 0) r.statPulse = Math.max(0, r.statPulse - dt * 1.4);
      const b = r.board;
      const total = b ? b.modified + b.staged + b.ahead : 0;
      if (r.statTotal < 0) { r.statTotal = total; continue; } // first sync, no burst
      if (total > r.statTotal && r.built > 0.6) {
        const burst = this.eco ? 1 : Math.min(5, 1 + Math.floor((total - r.statTotal) / 4));
        for (let i = 0; i < burst; i++) this.emitPacket(r);
        r.statPulse = 1;
      }
      r.statTotal = total;
    }
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const p = this.packets[i];
      p.t += dt * 1.7;
      const e = Math.min(1, p.t);
      const ease = e * e * (3 - 2 * e);
      p.x = p.sx + (p.tx - p.sx) * ease;
      p.y = p.sy + (p.ty - p.sy) * ease - Math.sin(ease * Math.PI) * 16; // lob it up to the wall
      if (p.t >= 1) this.packets.splice(i, 1);
    }

    // re-glue seated/working devs to their building's live position so they ride
    // the collapse instead of snapping to the final desk
    for (const tn of this.toons.values()) {
      if (!tn.leaving && !tn.entering) this.retargetToon(tn);
    }

    // upper-floor arrivals climb the staircase in the floor below to their door
    for (const tn of this.toons.values()) {
      if (!tn.entering || tn.enterPhase !== "stairs") continue;
      const room = tn.bkey ? this.rooms.get(tn.bkey) : undefined;
      if (!room) { tn.enterPhase = "walk"; continue; }
      tn.climbing = true;
      const k = Math.min(1, dt * 4);
      const tx = tn.stairTopX ?? tn.x;
      tn.x += (tx - tn.x) * k;
      tn.base += (room.baseY - tn.base) * k;
      if (Math.abs(room.baseY - tn.base) < 2) {
        tn.base = room.baseY;
        tn.climbing = false;
        tn.enterPhase = "walk";
        this.retargetToon(tn); // now cross the floor to the desk
      }
    }

    const all: Toon[] = [...this.toons.values(), ...this.leaving];
    for (const tn of all) {
      if (tn.entering && tn.enterPhase === "stairs") continue; // handled above
      const dx = tn.targetX - tn.x;
      if (Math.abs(dx) > 1) tn.x += Math.sign(dx) * Math.min(Math.abs(dx), WALK_SPEED * dt);
      else if (tn.entering) tn.entering = false;
      tn.sitting = tn.agent.state === "active" && !tn.huddle && !tn.entering && Math.abs(dx) <= 1;
      // settle up into the back row once parked at the desk; drop to the aisle
      // (lift -> 0) whenever walking, entering, leaving, or huddling
      const atDesk = Math.abs(dx) <= 1 && !tn.entering && !tn.leaving && !tn.huddle;
      const targetLift = atDesk ? tn.row * ROW_DY : 0;
      tn.lift += (targetLift - tn.lift) * Math.min(1, dt * 9);
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
        const wb = rollerPanel(r.x0 + WB_W / 2, r.baseY); // the main group's roller board
        r.scribbles.push({
          x1: wb.x + 3 + Math.random() * (wb.w - 6), y1: wb.y + 3 + Math.random() * (wb.h - 6),
          x2: wb.x + 3 + Math.random() * (wb.w - 6), y2: wb.y + 3 + Math.random() * (wb.h - 6),
          color: Math.random() < 0.3 ? "#d9534f" : Math.random() < 0.5 ? "#2b6cb0" : "#2d3438",
        });
      }
    }

    // complete devs no longer throw confetti: they kick back and scroll their
    // phone (see drawToon), so a cheer burst would read as a contradiction.
    if (!this.eco && this.frame % 14 === 0) {
      for (const tn of this.toons.values()) {
        if (tn.agent.state === "error") {
          this.particles.push({
            x: tn.x + 6, y: tn.base - tn.lift - 13, vx: 2 + Math.random() * 3, vy: -6 - Math.random() * 4,
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
    room?: string; // building key (for focus)
    island?: string; // island name (for add/remove/cd)
    ghost?: { floor: number; col: number; kind: "building" | "island"; island?: string };
    addDev?: { island: string; key: string }; // + DEV on a specific room
    removeBtn?: string; // island (nuke)
    removeWtBtn?: string; // building key (worktree path)
  } {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    // building buttons (highest priority). Every room has a + DEV (drop an agent
    // into this room's worktree). The main (root) building's ✕ nukes the whole
    // directory; a worktree building's ✕ removes just that worktree.
    for (const r of this.rooms.values()) {
      if (r.built < 0.95) continue;
      const base = r.baseY;
      if (this.inRect(mx, my, r.x0 + ROOM_W - 10, base - ROOM_H + 2, 8, 8)) {
        return r.isMain ? { removeBtn: r.island } : { removeWtBtn: r.name, island: r.island };
      }
      if (this.inRect(mx, my, r.x0 + ROOM_W - DOOR_W - 17, base - ROOM_H + 3, 16, 8)) {
        return { addDev: { island: r.island, key: r.name } };
      }
    }
    // ghost slots: +building (extend an island) and +island (reserve a directory)
    for (const g of this.ghosts) {
      if (this.inRect(mx, my, g.x0, g.base - ROOM_H, ROOM_W, ROOM_H)) {
        return { ghost: { floor: g.floor, col: g.col, kind: g.kind, island: g.island } };
      }
    }
    // toons
    for (const tn of this.toons.values()) {
      const s = this.screenOf(tn.x, tn.base - tn.lift);
      const w = 14 * this.cam.z, h = 22 * this.cam.z;
      if (mx > s.x - w / 2 && mx < s.x + w / 2 && my > s.y - h && my < s.y + 4 * this.cam.z) {
        return { agent: tn.agent.id };
      }
    }
    // buildings
    for (const r of this.rooms.values()) {
      if (this.inRect(mx, my, r.x0, r.baseY - ROOM_H, ROOM_W, ROOM_H + SLAB)) {
        return { room: r.name, island: r.island };
      }
    }
    return {};
  }

  private onClick(e: PointerEvent) {
    const hit = this.pick(e);
    if (hit.removeWtBtn) this.onRemoveWorktreeCb(hit.removeWtBtn, hit.island ?? "");
    else if (hit.removeBtn) this.onRemoveRoomCb(hit.removeBtn);
    else if (hit.addDev) this.onAddDevCb(hit.addDev.island, hit.addDev.key);
    else if (hit.ghost) {
      // +island reserves a new directory; +building creates a new worktree room
      if (hit.ghost.kind === "island") this.onReserveCb(hit.ghost.floor, hit.ghost.col);
      else if (hit.ghost.island) this.onAddWorktreeCb(hit.ghost.island);
    } else if (hit.agent) {
      this.onSelectCb(hit.agent);
      this.focusAgent(hit.agent); // zoom onto the dev you clicked
    } else if (hit.room) {
      // from a dev zoom, clicking the building centers it; clicking the already
      // centered building toggles back out
      if (!this.focusAgentId && this.focusRoom_ === hit.room) this.clearFocus();
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

    // the whole campus sits on a 3D earth slab: a grass top surface that tilts
    // toward the viewer (same apron depth as the island pedestals, so they read
    // as one world) over a shaded dirt front face.
    {
      const gx = minX - 80, gw = maxX - minX + 160;
      const apron = PLINTH_APRON;
      const grassFront = surfaceY + apron;
      const dirtBot = botY + 50;
      // dirt front face (vertical gradient — lit near the grass, dark deep down)
      const dg = ctx.createLinearGradient(0, grassFront, 0, dirtBot);
      dg.addColorStop(0, "#3a2c1d");
      dg.addColorStop(1, "#140d08");
      ctx.fillStyle = dg;
      ctx.fillRect(gx, grassFront, gw, dirtBot - grassFront);
      // pebbles/grit in the dirt
      ctx.fillStyle = "#4a3a26";
      const span = Math.max(1, Math.round(gw));
      const depth = Math.max(1, Math.round(dirtBot - grassFront - 4));
      for (let i = 0; i < 110; i++) {
        const hsh = hash("rock" + i);
        ctx.fillRect(gx + (hsh % span), grassFront + 3 + ((hsh >> 7) % depth), 2, 1.4);
      }
      // grass top surface (apron) — darker at the back, lit toward the viewer
      const gg = ctx.createLinearGradient(0, surfaceY, 0, grassFront);
      gg.addColorStop(0, "#2f5328");
      gg.addColorStop(1, "#4f7d3f");
      ctx.fillStyle = gg;
      ctx.fillRect(gx, surfaceY, gw, apron);
      // bright lip along the grass front edge + a contact shadow under it
      ctx.fillStyle = "#5e9149";
      ctx.fillRect(gx, surfaceY, gw, 1.2);
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.fillRect(gx, grassFront, gw, 1.2);
    }

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

    // island platforms (the foundation the buildings stand on)
    for (const isl of this.islands.values()) this.drawIslandPlatform(ctx, isl);

    // rooms back layer
    for (const r of this.rooms.values()) this.drawRoomBack(ctx, r);

    // ghost slots (+building extends an island, +island reserves a directory)
    for (const g of this.ghosts) this.drawGhost(ctx, g);

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

    // crew + furniture, layered back row -> front row so the aisle reads with
    // depth: for each row we paint its chairs, then its devs, then its desk
    // fronts (which occlude that row's seated devs).
    const chair = (dx: number, db: number) => {
      ctx.fillStyle = "#3a4046";
      ctx.fillRect(dx + 10, db - 8, 7, 1.6);
      ctx.fillRect(dx + 15.6, db - 14, 1.4, 7);
      ctx.fillRect(dx + 13, db - 6.5, 1.4, 6.5);
    };
    const displayRow = (tn: Toon) => (tn.lift > ROW_DY / 2 ? 1 : 0);
    const seated = [...this.toons.values()];
    for (let row = ROWS_OF_DESKS - 1; row >= 0; row--) {
      for (const r of this.rooms.values()) {
        if (r.built < 0.7 || !r.plan) continue;
        const base = r.baseY;
        for (const [, seat] of r.plan.seats) {
          if (seat.row !== row) continue;
          chair(this.seatX(r, seat.col, row), base - row * ROW_DY);
        }
      }
      const rowToons = seated.filter((t) => displayRow(t) === row);
      for (const tn of this.leaving) if (displayRow(tn) === row) rowToons.push(tn);
      rowToons.sort((a, b) => a.x - b.x);
      for (const tn of rowToons) this.drawToon(ctx, tn);
      for (const r of this.rooms.values()) this.drawDesks(ctx, r, row);
    }
    // particles
    for (const p of this.particles) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // commit packets flying from desks up to the boards
    for (const p of this.packets) {
      const fade = p.t < 0.85 ? 1 : clamp((1 - p.t) / 0.15, 0, 1);
      ctx.globalAlpha = 0.35 * fade; // soft glow halo
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 1.6, p.y - 1.6, 3.2, 3.2);
      ctx.globalAlpha = fade;
      ctx.fillRect(p.x - 0.8, p.y - 0.8, 1.6, 1.6);
      // a short trail back toward the source
      ctx.globalAlpha = 0.18 * fade;
      ctx.fillRect(p.x + (p.sx - p.x) * 0.12 - 0.5, p.y + (p.sy - p.y) * 0.12 - 0.5, 1, 1);
    }
    ctx.globalAlpha = 1;

    /* ---- screen-space pass ---- */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center";
    const xBtn = (r: Room, title: string) => {
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
      if (r.built < 0.95) continue;
      const base = r.baseY;
      // "+ DEV" on every room — drop an agent into this room's worktree
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
      // ✕ — main nukes the whole directory, a worktree removes just itself
      xBtn(r, "✕");
    }
    // ghost labels: +building (create a worktree room) vs +island (reserve a dir)
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
    // toon labels + bubbles
    for (const tn of this.toons.values()) {
      const s = this.screenOf(tn.x, tn.base - tn.lift - 23);
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
      // t.room is an island name → highlight the whole island footprint
      const isl = this.islands.get(t.room);
      if (isl) {
        const x0 = cellX0(isl.laneStart);
        const x1 = cellX0(isl.laneStart + isl.cols - 1) + ROOM_W;
        let top = floorBase(0);
        for (const b of this.rooms.values()) if (b.island === isl.name) top = Math.min(top, b.baseY - ROOM_H);
        this.strokeWorldRect(x0, top, x1 - x0, floorBase(0) + SLAB - top, "#7fd1ff");
      }
    } else if (t?.ghost) {
      const g = this.ghosts.find((g) => g.floor === t.ghost!.floor && g.col === t.ghost!.col);
      if (g) this.strokeWorldRect(g.x0, g.base - ROOM_H, ROOM_W, ROOM_H, "#9be38b");
    }
    const d = this.toonDrag!;
    const name = this.toons.get(d.id)?.agent.name ?? "agent";
    const label = d.blocked ? `${name} · active, can't move` : name;
    ctx.font = "11px 'IBM Plex Mono', monospace";
    const w = ctx.measureText(label).width + 14;
    ctx.fillStyle = "rgba(12,16,20,0.92)";
    ctx.fillRect(d.mx + 12, d.my - 9, w, 18);
    ctx.fillStyle = d.blocked ? "#ff9a93" : t ? "#cfe8ff" : "#9aa3ab";
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

  private drawGhost(ctx: CanvasRenderingContext2D, g: { x0: number; base: number; kind: "building" | "island" }) {
    const building = g.kind === "building";
    ctx.save();
    ctx.strokeStyle = building ? "rgba(110,210,150,0.45)" : "rgba(140,150,156,0.4)";
    ctx.lineWidth = 0.8;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(g.x0 + 1, g.base - ROOM_H + 1, ROOM_W - 2, ROOM_H - 2);
    ctx.setLineDash([]);
    // faint blueprint grid
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
  private drawIslandPlatform(ctx: CanvasRenderingContext2D, isl: Island) {
    // The tower sits at the BACK-TOP of a solid pedestal. We look slightly down,
    // so the pedestal's top surface (apron) tilts toward us and splays outward
    // before dropping to a tall front face — a clear 3D block, not a flat band.
    const tx0 = cellX0(isl.laneStart); // tower footprint
    const tx1 = cellX0(isl.laneStart + isl.cols - 1) + ROOM_W;
    const ground = floorBase(0) + SLAB; // where the tower meets the pedestal
    const sat = isl.path ? 26 : 14; // reserved islands read a touch warmer
    const L = (l: number) => `hsl(${isl.hue} ${sat}% ${l}%)`;

    const aTop = ground; // apron back edge (under the tower)
    const aBot = ground + PLINTH_APRON; // apron front edge (toward viewer)
    const fBot = aBot + PLINTH_H; // front face bottom
    const wx0 = tx0 - PLINTH_OV, wx1 = tx1 + PLINTH_OV; // splayed (wide) front corners

    // left + right end faces (darkest), so the corners read as solid
    ctx.fillStyle = L(9);
    ctx.beginPath();
    ctx.moveTo(tx0, aTop); ctx.lineTo(wx0, aBot); ctx.lineTo(wx0, fBot); ctx.lineTo(tx0, fBot); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(tx1, aTop); ctx.lineTo(wx1, aBot); ctx.lineTo(wx1, fBot); ctx.lineTo(tx1, fBot); ctx.closePath(); ctx.fill();

    // top apron (lightest — catches the light), splaying out toward the viewer
    const ag = ctx.createLinearGradient(0, aTop, 0, aBot);
    ag.addColorStop(0, L(34));
    ag.addColorStop(1, L(26));
    ctx.fillStyle = ag;
    ctx.beginPath();
    ctx.moveTo(tx0, aTop); ctx.lineTo(tx1, aTop);
    ctx.lineTo(wx1, aBot); ctx.lineTo(wx0, aBot); ctx.closePath(); ctx.fill();

    // front face (mid, shaded top→bottom) — holds the name
    const fg = ctx.createLinearGradient(0, aBot, 0, fBot);
    fg.addColorStop(0, L(19));
    fg.addColorStop(1, L(11));
    ctx.fillStyle = fg;
    ctx.fillRect(wx0, aBot, wx1 - wx0, PLINTH_H);
    ctx.fillStyle = L(8); // base shadow
    ctx.fillRect(wx0, fBot - 2, wx1 - wx0, 2);

    // signpost with the island (repo/directory) name — fills the front face
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

  private drawRoomBack(ctx: CanvasRenderingContext2D, r: Room) {
    const base = r.baseY;
    const eFloor = clamp(r.built / 0.35, 0, 1);
    const eWall = clamp((r.built - 0.2) / 0.45, 0, 1);
    const eFurn = clamp((r.built - 0.6) / 0.4, 0, 1);
    const x = r.x0, w = ROOM_W, H = ROOM_H;
    const underground = r.floor < 0;
    const lit = r.agents.length > 0;

    // floor slab
    ctx.fillStyle = "#3d2f1f";
    ctx.fillRect(x, base - 1.5, w * eFloor, SLAB - 1);
    ctx.fillStyle = "#4a3a26";
    ctx.fillRect(x, base - 1.5, w * eFloor, 1.2);

    if (eWall <= 0) return;
    // shallow one-point-perspective box: near opening -> inset far wall
    const grow = eWall; // 0..1 build reveal
    const bw = backWall(x, base);
    const topY = base - H * grow; // near ceiling rises as the room builds
    const byT = base - (base - bw.yTop) * grow; // far-wall top rises with it
    const byB = base - DEPTH_Y * grow; // ...and its floor line, so the box never inverts
    const shade = (l: number) => `hsl(${r.hue} ${underground ? 10 : 15}% ${l}%)`;
    // perspective floor (near edge -> far wall)
    ctx.fillStyle = underground ? "#241c12" : "#2b2218";
    ctx.beginPath();
    ctx.moveTo(x, base); ctx.lineTo(x + w, base);
    ctx.lineTo(bw.x1, byB); ctx.lineTo(bw.x0, byB); ctx.closePath(); ctx.fill();
    // smooth room light: brightest at the near (viewer) edge, fading toward the
    // back wall / TV — replaces the patchy per-lamp cones with one soft gradient
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
      ctx.moveTo(x, base); ctx.lineTo(x + w, base);
      ctx.lineTo(bw.x1, byB); ctx.lineTo(bw.x0, byB); ctx.closePath(); ctx.fill();
    }
    // ceiling (darkest)
    ctx.fillStyle = shade(underground ? 9 : 11);
    ctx.beginPath();
    ctx.moveTo(x, topY); ctx.lineTo(x + w, topY);
    ctx.lineTo(bw.x1, byT); ctx.lineTo(bw.x0, byT); ctx.closePath(); ctx.fill();
    // side walls (in shadow)
    ctx.fillStyle = shade(underground ? 12 : 15);
    ctx.beginPath();
    ctx.moveTo(x, topY); ctx.lineTo(bw.x0, byT); ctx.lineTo(bw.x0, byB); ctx.lineTo(x, base); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + w, topY); ctx.lineTo(bw.x1, byT); ctx.lineTo(bw.x1, byB); ctx.lineTo(x + w, base); ctx.closePath(); ctx.fill();
    // far wall (lit)
    ctx.fillStyle = shade(underground ? 17 : 22);
    ctx.fillRect(bw.x0, byT, bw.x1 - bw.x0, byB - byT);
    ctx.fillStyle = shade(underground ? 12 : 16); // baseboard
    ctx.fillRect(bw.x0, byB - 2, bw.x1 - bw.x0, 2);
    // near-edge pillars
    ctx.fillStyle = "#1a2128";
    ctx.fillRect(x, topY, 1.5, base - topY + 3);
    ctx.fillRect(x + w - 1.5, topY, 1.5, base - topY + 3);
    if (grow >= 1) ctx.fillRect(x, base - H - 1.5, w, 1.5);

    if (eFurn <= 0) return;
    ctx.globalAlpha = eFurn;

    // the big stat-tracker screen fills the whole far wall (branch + git/PR data);
    // the island/repo name lives on the platform signpost below
    this.drawBoard(ctx, r, base);

    // window on the LEFT side wall, drawn in perspective (rock face underground)
    const onWall = (t: number, f: number) => {
      // t: 0 near opening → 1 far wall; f: 0 ceiling → 1 floor at that depth
      const xL = x + (bw.x0 - x) * t;
      const yT = topY + (byT - topY) * t;
      const yB = base + (byB - base) * t;
      return { x: xL, y: yT + (yB - yT) * f };
    };
    const wp = [onWall(0.3, 0.26), onWall(0.64, 0.3), onWall(0.64, 0.66), onWall(0.3, 0.7)];
    const quad = (pts: { x: number; y: number }[], fill: string | CanvasGradient) => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    const mid = (a: { x: number; y: number }, c: { x: number; y: number }) => ({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
    // frame
    ctx.strokeStyle = "#0c1116";
    ctx.lineWidth = 3;
    ctx.lineJoin = "miter";
    ctx.beginPath();
    ctx.moveTo(wp[0].x, wp[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(wp[i].x, wp[i].y);
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
      ctx.fillStyle = "rgba(255,255,255,0.6)"; // a distant cloud
      const c = mid(wp[0], wp[2]);
      ctx.fillRect(c.x - 2, c.y - 2.5, 4, 1.3);
    }
    // muntins
    ctx.strokeStyle = "#0c1116";
    ctx.lineWidth = 0.8;
    const mt = mid(wp[0], wp[1]), mb = mid(wp[3], wp[2]);
    ctx.beginPath(); ctx.moveTo(mt.x, mt.y); ctx.lineTo(mb.x, mb.y); ctx.stroke();
    const ml = mid(wp[0], wp[3]), mr = mid(wp[1], wp[2]);
    ctx.beginPath(); ctx.moveTo(ml.x, ml.y); ctx.lineTo(mr.x, mr.y); ctx.stroke();

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

    // ceiling pendants: just the fixtures + a tight bulb glow — the room's actual
    // lighting is the soft floor gradient above, so no big distracting cones
    const LAMPS = 3;
    for (let li = 0; li < LAMPS; li++) {
      const lx = x + (w * (li + 1)) / (LAMPS + 1);
      ctx.fillStyle = "#20262c";
      ctx.fillRect(lx - 0.6, base - H, 1.2, 4);
      ctx.fillStyle = "#3a4046";
      ctx.fillRect(lx - 3.5, base - H + 4, 7, 2);
      // a warm bulb that glows when the room is occupied
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

    // door to the lift, set into the right side wall so it follows the
    // perspective slant instead of floating on the floor
    const sideAt = (t: number) => ({ x: x + w + (bw.x1 - (x + w)) * t, y: base + (bw.yBot - base) * t });
    const dn = sideAt(0.18), df = sideAt(0.5); // near (front) + far (back) jambs
    ctx.fillStyle = "#4a3520"; // frame
    ctx.beginPath();
    ctx.moveTo(dn.x, dn.y);
    ctx.lineTo(dn.x, dn.y - 31);
    ctx.lineTo(df.x, df.y - 26);
    ctx.lineTo(df.x, df.y);
    ctx.closePath();
    ctx.fill();
    const pn = sideAt(0.22), pf = sideAt(0.46); // panel inset
    ctx.fillStyle = "#6e522f";
    ctx.beginPath();
    ctx.moveTo(pn.x, pn.y - 1.5);
    ctx.lineTo(pn.x, pn.y - 29);
    ctx.lineTo(pf.x, pf.y - 24.5);
    ctx.lineTo(pf.x, pf.y - 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#d9b34a"; // handle on the far (latch) jamb
    ctx.fillRect(pf.x + 0.4, pf.y - 14, 1.4, 1.6);

    // staircase up to the worktree stacked on top: a flight against the right
    // wall that upper-floor devs climb in to reach their door
    if (r.hasUpper) {
      const steps = 8;
      const botX = x + w - 42, topX = x + w - 22;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const sx = botX + (topX - botX) * t;
        const sy = base - (H - 4) * t;
        ctx.fillStyle = i % 2 ? "#454c53" : "#3c434a";
        ctx.fillRect(sx - 5, sy - 2.2, 10, 2.4); // tread
        ctx.fillStyle = "#20262c";
        ctx.fillRect(sx - 5, sy + 0.2, 10, 1.8); // riser shadow
      }
      ctx.fillStyle = "#2a3138"; // stringer
      ctx.fillRect(botX - 6, base - H + 2, 1.6, H - 2);
    }

    // vacant reserved rooms sit dark until a dev moves in
    if (!lit && r.path) {
      ctx.fillStyle = "rgba(8,11,14,0.45)";
      ctx.fillRect(x + 1.5, base - H, w - 3, H);
    }
    ctx.globalAlpha = 1;
  }

  /** The room's stat-tracker TV on the far wall: a flat panel showing the branch
   *  plus live git stats (files changed, lines +/-). It glows when the worktree's
   *  files change (see the packets fired from the desks in tick). */
  private drawBoard(ctx: CanvasRenderingContext2D, r: Room, base: number) {
    const b = boardRect(r.x0, base);
    if (b.w < 20 || b.h < 14) return;
    const glow = r.statPulse;

    // bezel + screen
    ctx.fillStyle = "#05080b";
    ctx.fillRect(b.x - 2.5, b.y - 2.5, b.w + 5, b.h + 5);
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(b.x - 1.5, b.y - 1.5, b.w + 3, b.h + 3);
    const scr = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
    scr.addColorStop(0, "#101b27");
    scr.addColorStop(1, "#0a1118");
    ctx.fillStyle = scr;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    // faint scanlines for the screen feel
    ctx.fillStyle = "rgba(120,200,255,0.035)";
    for (let yy = b.y + 2; yy < b.y + b.h - 1; yy += 3) ctx.fillRect(b.x, yy, b.w, 1);

    const pad = 4;
    // header: branch on the left, a live activity dot on the right
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    const branch = r.branch && r.branch !== "—" ? r.branch : r.isMain ? "main" : "—";
    ctx.font = "bold 5px 'Martian Mono', monospace";
    ctx.fillStyle = r.isMain ? "hsl(150 60% 80%)" : `hsl(${r.hue} 65% 82%)`;
    let bt = `⌥ ${branch}`;
    while (ctx.measureText(bt).width > b.w - 12 && bt.length > 6) bt = bt.slice(0, -2);
    if (bt !== `⌥ ${branch}`) bt += "…";
    ctx.fillText(bt, b.x + pad, b.y + 7);
    ctx.fillStyle = glow > 0.02 ? `rgba(62,224,137,${0.35 + glow * 0.65})` : "rgba(90,100,108,0.5)";
    ctx.fillRect(b.x + b.w - pad - 3, b.y + 3, 3, 3);
    // header divider
    ctx.fillStyle = "rgba(120,150,170,0.18)";
    ctx.fillRect(b.x + pad, b.y + 9.5, b.w - pad * 2, 0.8);
    ctx.restore();

    const bd = r.board;
    const placeholder = (text: string, color: string) => {
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.font = "4px 'IBM Plex Mono', monospace";
      ctx.fillStyle = color;
      ctx.fillText(text, b.x + b.w / 2, b.y + b.h / 2 + 4);
      ctx.restore();
    };
    if (!bd) { placeholder("no git", "rgba(225,233,238,0.6)"); return; }
    if (bd.missing) { placeholder("dir missing", "rgba(255,154,147,0.85)"); return; }

    // The board is wide and short, so stats run HORIZONTALLY: three git cells
    // (unstaged · staged · commits), each a count + line churn + a green/red
    // diffstat bar, then a wider PR cell on the right.
    const review = { approved: "approved", changes: "changes req", required: "review req", none: "" };
    const checkTxt = { pass: "checks ✓", fail: "checks ✗", pending: "checks…", none: "" };
    const bodyTop = b.y + 12;
    const bodyBot = b.y + b.h - 2;
    const innerL = b.x + pad;
    const innerR = b.x + b.w - pad;
    const prW = Math.min(74, (innerR - innerL) * 0.34);
    const gitR = innerR - prW - 4; // right edge of the git region
    const cw = (gitR - innerL) / 3; // one git cell
    // truncate a string to a pixel width, adding a trailing ellipsis when cut
    const fit = (s: string, maxW: number) => {
      if (ctx.measureText(s).width <= maxW) return s;
      let t = s;
      while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
      return t + "…";
    };
    // a slim diffstat bar: green share = additions, red = deletions
    const churnBar = (x: number, yy: number, w: number, add: number, del: number) => {
      ctx.fillStyle = "rgba(120,150,170,0.16)";
      ctx.fillRect(x, yy, w, 2);
      const total = add + del;
      if (total <= 0) return;
      const aw = Math.max(1, Math.min(w - 1, Math.round((w * add) / total)));
      ctx.fillStyle = "#3ee089";
      ctx.fillRect(x, yy, aw, 2);
      ctx.fillStyle = "#ff6055";
      ctx.fillRect(x + aw, yy, w - aw, 2);
    };

    ctx.save();
    ctx.textBaseline = "alphabetic";

    /* ---- left: three git cells ---- */
    const cells = [
      { label: "UNSTAGED", count: `${bd.modified} file${bd.modified === 1 ? "" : "s"}`, add: bd.unstagedAdd, del: bd.unstagedDel, tint: "#ffb13d" },
      { label: "STAGED", count: `${bd.staged} file${bd.staged === 1 ? "" : "s"}`, add: bd.stagedAdd, del: bd.stagedDel, tint: "#3ee089" },
      { label: "COMMITS", count: bd.ahead > 0 ? `↑${bd.ahead}` : "0", add: bd.committedAdd, del: bd.committedDel, tint: "#56c7ff" },
    ];
    cells.forEach((c, i) => {
      const cx = innerL + i * cw;
      const cwIn = cw - 4; // inner width (leaves a gutter before the divider)
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

    /* ---- right: PR ---- */
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
      const line = (text: string, color: string) => {
        if (py > bodyBot) return;
        ctx.fillStyle = color;
        ctx.fillText(fit(text, prW), px, py);
        py += 4.6;
      };
      if (bd.pr.checks !== "none") {
        line(checkTxt[bd.pr.checks], bd.pr.checks === "pass" ? "#3ee089" : bd.pr.checks === "fail" ? "#ff6055" : "#ffb13d");
      }
      if (bd.pr.review !== "none") {
        line(review[bd.pr.review], bd.pr.review === "approved" ? "#3ee089" : bd.pr.review === "changes" ? "#ff6055" : "#ffb13d");
      }
      if (bd.pr.draft) line("draft", "rgba(200,210,216,0.7)");
      py += 1;
      ctx.fillStyle = "rgba(120,150,170,0.16)";
      ctx.fillRect(px, py - 3, prW, 0.7);
      py += 2;
      ctx.fillStyle = "rgba(225,233,238,0.85)";
      const words = bd.pr.title.split(/\s+/).filter(Boolean);
      let lineStr = "";
      for (const w of words) {
        if (py > bodyBot) break;
        const next = lineStr ? `${lineStr} ${w}` : w;
        if (ctx.measureText(next).width > prW && lineStr) { ctx.fillText(lineStr, px, py); py += 4.4; lineStr = w; }
        else lineStr = next;
      }
      if (py <= bodyBot && lineStr) ctx.fillText(fit(lineStr, prW), px, py);
    }
    ctx.restore();

    // pulse the border briefly when files change
    if (glow > 0.02) {
      ctx.strokeStyle = `rgba(62,224,137,${glow * 0.85})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    }
  }

  private drawDesks(ctx: CanvasRenderingContext2D, r: Room, row: number) {
    const eFurn = clamp((r.built - 0.6) / 0.4, 0, 1);
    if (eFurn <= 0 || !r.plan) return;
    const base = r.baseY;
    const db = base - row * ROW_DY; // this row's baseline (back row sits higher)
    ctx.globalAlpha = eFurn;
    for (const [id, seat] of r.plan.seats) {
      if (seat.row !== row) continue;
      const dx = this.seatX(r, seat.col, row);
      const tn = this.toons.get(id);
      const occupied = !!tn?.sitting; // monitor lights only when the dev is seated
      const st = occupied ? tn!.agent.state : undefined;
      // contact shadow on the floor so the desk doesn't melt into the boards
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(dx + 1.5, db - 0.6, 19, 1.8);
      // desktop — lighter than the floor, with a top highlight + underside shadow
      ctx.fillStyle = "#7e5e35";
      ctx.fillRect(dx + 2, db - 11, 18, 2);
      ctx.fillStyle = "#9c7a4c";
      ctx.fillRect(dx + 2, db - 11, 18, 0.7); // top highlight
      ctx.fillStyle = "#382a16";
      ctx.fillRect(dx + 2, db - 9.2, 18, 0.7); // shadow line under the top
      ctx.fillStyle = "#54401f";
      ctx.fillRect(dx + 3, db - 9, 1.5, 9);
      ctx.fillRect(dx + 17.5, db - 9, 1.5, 9);
      // monitor: its screen faces the dev (away from us), so we see the dark
      // BACK of the panel; the light it throws lands on the dev (drawn below)
      ctx.fillStyle = "#171c21"; // neck + foot
      ctx.fillRect(dx + 7.2, db - 11.2, 1.6, 1.2);
      ctx.fillRect(dx + 5.4, db - 10.2, 5.4, 1);
      ctx.fillStyle = "#1b2129"; // bezel
      ctx.beginPath();
      ctx.moveTo(dx + 5, db - 18); // back-top (up-left)
      ctx.lineTo(dx + 11, db - 16.5); // front-top (toward dev)
      ctx.lineTo(dx + 11, db - 11); // front-bottom
      ctx.lineTo(dx + 5, db - 12.5); // back-bottom
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#11161c"; // dark back panel
      ctx.beginPath();
      ctx.moveTo(dx + 5.9, db - 17.2);
      ctx.lineTo(dx + 10.1, db - 15.9);
      ctx.lineTo(dx + 10.1, db - 11.6);
      ctx.lineTo(dx + 5.9, db - 13.1);
      ctx.closePath();
      ctx.fill();
      // power LED on the back
      ctx.fillStyle = occupied ? (st === "error" ? "#d9534f" : "#3ee089") : "#2a3138";
      ctx.fillRect(dx + 8.8, db - 12.6, 0.9, 0.9);
      // keyboard in front of the dev, between them and the screen
      ctx.fillStyle = "#2a3138";
      ctx.fillRect(dx + 8.5, db - 11.2, 5.5, 1);
      ctx.fillStyle = "#d9534f";
      ctx.fillRect(dx + 0.5, db - 13, 2, 2);
      if (occupied && this.frame % 8 < 4) {
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillRect(dx + 1, db - 15, 0.8, 1.4);
      }
      // the screen faces the dev, so its glow flickers onto them
      if (occupied) {
        const c = st === "error" ? "217,83,79" : "159,216,255";
        const peak = st === "error" ? 0.3 : st === "active" && this.frame % 4 < 2 ? 0.4 : 0.24;
        const gx = dx + 13, gy = db - 16; // on the seated dev, not the monitor
        const grd = ctx.createRadialGradient(gx, gy, 0, gx, gy, 7);
        grd.addColorStop(0, `rgba(${c},${peak})`);
        grd.addColorStop(0.6, `rgba(${c},${peak * 0.45})`);
        grd.addColorStop(1, `rgba(${c},0)`);
        ctx.fillStyle = grd;
        // clipped tight to the dev, clear of the monitor back to its left
        ctx.fillRect(dx + 10, db - 24, 8, 20);
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
    const y0 = tn.base - tn.lift + (sitting ? -3.5 : 0);
    const hop =
      st === "waiting" && !walking ? -Math.abs(Math.sin(f * 0.35 + tn.ph)) * 1 : 0;
    const slump = st === "error" && !walking ? 1.4 : 0;
    const base = y0 + hop;
    const facingLeft = tn.huddle || sitting; // seated devs face their monitor (to the left)

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
      // typing toward the keyboard/monitor on the left
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
      // asking a question: hand up and WAVING, other hand cupped to mouth
      const wave = Math.sin(f * 0.9 + tn.ph) * 1.1;
      ctx.fillRect(x + 2.8 + wave * 0.4, ty - 4, 1.5, 5);
      ctx.fillStyle = handC;
      ctx.fillRect(x + 2.7 + wave, ty - 5.6, 1.8, 1.8);
      ctx.fillStyle = p.shirt;
      ctx.fillRect(x - 4.4, ty - 0.6, 1.6, 2.8);
      ctx.fillStyle = handC;
      ctx.fillRect(x - 3.2, ty - 2, 1.5, 1.5); // cupped at the mouth
    } else if (walking) {
      const sw = f % 2 === 0 ? 1 : -1;
      ctx.fillRect(x - 4.2, ty + 1.5 + sw * 0.8, 1.4, 4);
      ctx.fillRect(x + 2.8, ty + 1.5 - sw * 0.8, 1.4, 4);
    } else if (st === "idle" || st === "complete") {
      // not working (done, or off the clock): scrolling on their phone
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
      const phoneGaze = (st === "idle" || st === "complete") && !walking && f % 50 > 6 ? 0.9 : 0;
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
(window as any).DevTowerCrew = {
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
  setPrBranches(b: string[]) {
    this._instance?.setPrBranches(b);
  },
  setBoards(boards: Record<string, any>) {
    this._instance?.setBoards(boards);
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
  onAddDev(cb: (island: string, worktree: string) => void) {
    this._instance?.onAddDev(cb);
  },
  onAddWorktree(cb: (island: string) => void) {
    this._instance?.onAddWorktree(cb);
  },
  onRemoveRoom(cb: (room: string) => void) {
    this._instance?.onRemoveRoom(cb);
  },
  onRemoveWorktree(cb: (worktree: string, island: string) => void) {
    this._instance?.onRemoveWorktree(cb);
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
