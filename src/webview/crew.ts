/* DevTower Crew — pixel office tower renderer (Canvas2D, no WebGL).
 *
 * Tower layout: rooms stack vertically as floors and the building grows upward.
 * Each repo is its own tower; reserving another repo stands a new tower nearby.
 * - Ghost slots on top of each tower (stack the next worktree) and a reserve
 *   slot past the last one: click → pick a directory to reserve for a repo.
 * - Bound rooms show a "+ DEV" button: spawn an agent there (the extension
 *   asks worktree vs project dir).
 *
 * Power model: ~10fps animation tick (6fps eco); renders only on ticks or
 * camera motion; hard-stop when hidden. Same window.DevTowerCrew API as before,
 * plus setRooms / onReserve / onAddAgent. */

import { TEXT } from "./palette";

interface CrewAgent {
  id: string;
  name: string;
  state: string;
  repo: string;
  model: string;
  worktree?: string; // git worktree path; groups desks within a room
  branch?: string; // branch name, shown on the cluster sign
  skills?: string[]; // skills this session has used (accumulated, first-use order)
  external?: boolean; // a live session running OUTSIDE DevTower (not one we launched)
  reviewOf?: { prId: string; number: number; repo: string; url?: string }; // PR this agent reviews
  reviewVerdict?: "approved" | "changes" | "pending"; // derived from the PR's decision
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

/** Desaturate + dim one persona color (hsl() or #hex) for the ghosted render of
 *  an external session — strips the chroma so it reads as gray, not "ours". */
function ghostColor(c: string): string {
  const m = /^hsl\((\d+)\s+(\d+)%\s+(\d+)%\)$/.exec(c);
  if (m) return `hsl(${m[1]} 7% ${Math.round(+m[3] * 0.82)}%)`;
  const h = c.replace("#", "");
  if (h.length < 6) return c;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const y = 0.3 * r + 0.59 * g + 0.11 * b;
  const hx = (v: number) => Math.round(Math.min(255, (v * 0.2 + y * 0.8) * 0.82)).toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/** A persona with every color desaturated, for an external (outside) session. */
function ghostPersona(p: ReturnType<typeof persona>): ReturnType<typeof persona> {
  return {
    ...p,
    shirt: ghostColor(p.shirt),
    shirtDark: ghostColor(p.shirtDark),
    pants: ghostColor(p.pants),
    skin: ghostColor(p.skin),
    hair: ghostColor(p.hair),
    accColor: ghostColor(p.accColor),
  };
}

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
// Bookshelf under the left window: a dev walks here to pick up a "skill" book
// (one per skill it uses) and carries it back to stack on its desk.
const SHELF_REACH = 16; // world x (from room left) a dev stands at to fetch a book
const BOOK_HUES = [4, 28, 48, 140, 200, 262, 320]; // spine colours, cycled per book
// Paper shredder in the front-left corner, left of the bookshelf: when a session
// is /cleared the dev carries its stack of context papers here, feeds them in,
// then walks back. The bookshelf's near end is pulled back to make room for it.
const SHRED_REACH = 18; // world x (from room left) a dev stands at to shred (just right of the bin)
const SHRED_FEED = 1.6; // seconds spent feeding the stack into the shredder
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
// and the elevator exit math stay correct.
const ROWS_OF_DESKS = 2;
// devs fill the front line first (close to the viewer, clear of the back-wall
// board); only once the front row holds this many do they wrap to the back row
const FRONT_CAP = 6;
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

// Elevator: an external shaft bolted to the right exterior wall of each tower
// carries devs between the ground and a stacked worktree floor — both on entry
// (ride up to the floor) and exit (ride down, e.g. when a worktree is removed).
const SHAFT_GAP = 3; // gap from the building's right wall to the shaft's near edge
const SHAFT_W = 18; // external shaft (well) width
const CAR_W = 14; // elevator car (cage) width — sits inside the shaft
const CAR_H = 26; // car height: floor slab to ceiling slab
const CAR_SPEED = 64; // vertical travel speed (world units / sec)
// car/shaft center, just outside the tower's right wall (x0 + ROOM_W)
const shaftX = (x0: number) => x0 + ROOM_W + SHAFT_GAP + SHAFT_W / 2;

// Island layout: an island is one repo/directory drawn as a vertical tower one
// column wide — the main (root) checkout on the ground, each worktree stacked a
// floor higher. Towers stand ISLAND_GAP columns apart so they read as distinct
// landmasses, each on its own platform.
const ISLAND_GAP = 1; // empty columns between adjacent islands
const PLINTH_H = 22; // front-face height of the island pedestal (below ground)
const PLINTH_APRON = 8; // depth of the pedestal's top surface tilting toward us
const PLINTH_OV = 9; // how far the pedestal splays out past the tower on each side
// central "PRs to review" billboard sitting to the left of the campus
const BB_W = 138, BB_HEADER = 16, BB_ROW = 20, BB_MAX = 6, BB_GAP = 56;

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; color: string; size: number; gravity: number;
}
/** A glowing "commit packet" that flies from a dev's desk to the room board
 *  whenever that worktree's files change. */
interface Packet { x: number; y: number; sx: number; sy: number; tx: number; ty: number; t: number; color: string; ph: number; path?: { x: number; y: number }[];
  /** Board snapshot captured when this beam was fired; applied to the room's TV
   *  when the beam lands (so the screen shows the data that triggered it, not
   *  whatever the latest poll happens to be at landing time). */
  applyKey?: string; applySnap?: BoardData }

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
  agents: CrewAgent[];
  decor: number;
  plan?: SeatPlan; // desks grouped by worktree (recomputed each layout)
  board?: BoardData; // latest live git/PR data from the extension (incoming)
  boardShown?: BoardData; // what the screen currently renders; swapped in when a beam lands
  statSig: string; // last seen git signature; any change (stage/commit/…) → fire a beam
  statPulse: number; // 0..1 board glow that decays after a change
  cellPulse: { unstaged: number; staged: number; commits: number; pr: number }; // per-column flash
  numAnim: Record<string, { from: string; to: string; t: number }>; // per-number flip transitions
  marqueeStart?: number; // frame the PR-title marquee (re)started, so it restarts on zoom-in
  swapPending?: boolean; // a beam is in flight; update the screen when it arrives
  swapClock?: number; // seconds since the beam was fired
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
  base: string;
  ahead: number;
  unpushed: number;
  behind: number;
  commits: string[];
  missing?: boolean;
  prReady?: boolean;
  pr?: {
    number: number;
    title: string;
    url: string;
    draft: boolean;
    checks: "pass" | "fail" | "pending" | "none";
    checksPass: number;
    checksFailed: number;
    checksRunning: number;
    checksTotal: number;
    review: "approved" | "changes" | "required" | "none";
    approvals: number;
    changesRequested: number;
    reviewersPending: number;
    comments: number;
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
  deskIdx: number;
  row: number; // 0 = front aisle, 1 = back row (drawn higher)
  lift: number; // current render-only vertical offset toward the back row
  sitting: boolean;
  entering: boolean;
  // entry path: upper-floor devs ride the elevator up from the ground to their
  // door; ground-floor devs just walk in.
  enterPhase?: "elevator" | "walk";
  leaving: boolean;
  // departure path: walk to the elevator → ride the car down to the ground → away
  leavePhase?: "walk" | "elevator" | "away";
  riding?: boolean; // currently inside the elevator car (drives the car render)
  // skills the dev has fetched from the shelf (one book per skill). `skills` is
  // the accumulated set; `booksShown` is how many are resting on the desk and
  // `booksInHand` how many it carried back and is currently reading while the task
  // is active. When skills outnumber the books it has (desk + hand), the dev runs
  // a trip to the shelf (the `errand`) to fetch the rest, reads them at the desk
  // for the duration of the active task, then sets them down on the desk.
  skills: string[];
  booksShown: number;
  booksInHand: number;
  errand?: { phase: "out" | "grab" | "back"; grab: number };
  // context-clear (/clear) trip: a session replaced by a new one in the SAME
  // worktree keeps this dev, which carries its context papers to the shredder
  // ("out"), feeds the stack in ("feed"), then walks back to its seat ("back").
  shred?: { phase: "out" | "feed" | "back"; t: number };
  // review verdict animation: when a reviewer's PR decision resolves, `stampAt`
  // records the frame so the APPROVED/CHANGES stamp can "thud" in over ~1s.
  lastVerdict?: string;
  stampAt?: number;
  ph: number;
}

const floorBase = (floor: number) => -floor * FLOOR_STEP;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Sample a quadratic bezier into `n` points (excluding the start point), so a
 *  curved cable can be drawn and walked as a plain polyline. */
function sampleQuad(
  p0: { x: number; y: number },
  c: { x: number; y: number },
  p1: { x: number; y: number },
  n: number
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    pts.push({
      x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
      y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
    });
  }
  return pts;
}

/** Position at fraction t (0..1) along a polyline, measured by arc length. */
function pointOnPath(path: { x: number; y: number }[], t: number): { x: number; y: number } {
  if (path.length === 1) return path[0];
  const segs: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const len = Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
    segs.push(len);
    total += len;
  }
  if (total === 0) return path[0];
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

/** Signature of every display-relevant board field (incl. PR/checks), so any
 *  real change fires exactly one beam and identical polls fire none. */
function boardSig(b: BoardData | undefined): string {
  if (!b) return "none";
  const pr = b.pr
    ? `${b.pr.number}/${b.pr.checks}/${b.pr.checksPass}/${b.pr.checksFailed}/${b.pr.checksRunning}/${b.pr.checksTotal}/${b.pr.review}/${b.pr.approvals}/${b.pr.changesRequested}/${b.pr.reviewersPending}/${b.pr.draft ? 1 : 0}/${b.pr.title}`
    : "no";
  return [
    b.modified, b.staged, b.ahead, b.unstagedAdd, b.unstagedDel, b.stagedAdd, b.stagedDel,
    b.committedAdd, b.committedDel, b.commits.length, b.base, b.prReady ? 1 : 0, b.missing ? 1 : 0, pr,
  ].join("|");
}

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
  /** Last-known walk state of a toon culled because its room was momentarily
   *  absent (a refresh pushes new rooms before the matching agents, so a
   *  re-layout can briefly unplace a dev). Keyed by agent id + the frame it was
   *  parked, so when setAgents re-creates the toon we resume from where it was
   *  instead of respawning it at the door. */
  private parked = new Map<string, {
    x: number; base: number; lift: number; entering: boolean;
    enterPhase?: "elevator" | "walk"; sitting: boolean; frame: number;
    skills: string[]; booksShown: number; booksInHand: number;
  }>();
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
  private focusIsland_: string | null = null; // when set, frame this whole directory (its tower)
  private focusBillboard_ = false; // when set, the camera frames the review billboard
  // the view to restore when leaving the billboard (so exiting returns to where
  // you were, not the overview)
  private viewBeforeBillboard: null | {
    focusAgentId: string | null; focusRoom_: string | null; focusIsland_: string | null;
    focus: { x: number; y: number; spanW: number; spanH: number };
    panX: number; panY: number; zoomMul: number;
  } = null;
  private prBranches = new Set<string>(); // branches (lowercased) with an open PR
  // review-requested PRs shown on the central billboard (left of the campus);
  // clicking a row opens the dispatch modal to assign a reviewer to it
  private reviewPrs: { number: number; repo: string; title: string; branch?: string; url?: string }[] = [];
  // null = not yet known (startup); false = no GitHub token, show the disconnected
  // placeholder instead of an empty/"nothing awaiting" state
  private githubConnected: boolean | null = null;
  // key of the canvas control under the cursor, so it can be drawn highlighted
  private hoverKey: string | null = null;
  private campusMinX = 0; // rooms-only left edge, before the billboard is added in
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
  private marqueeOn = false; // a PR title marquee is scrolling → keep the loop awake
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
  private onPushCb: (room: string) => void = () => {};
  private onPullCb: (room: string) => void = () => {};
  private onFetchCb: (room: string) => void = () => {};
  /** room key → time a push/pull was requested, so the board change it causes
   *  flashes without firing a beam (the agent didn't do that work). */
  private syncSuppress = new Map<string, number>();
  private onCdCb: (id: string, target: { room?: string; ghost?: { floor: number; col: number } }) => void =
    () => {};
  private onAssignReviewCb: (pr: { number: number; repo: string; title: string; branch?: string; url?: string }) => void = () => {};
  private onRefreshPrsCb: () => void = () => {};
  private onOpenPrCb: (url: string) => void = () => {};
  // debug event sink (forwarded to the extension's debug log when enabled)
  private onDebugCb: (event: string, data?: unknown) => void = () => {};
  private debugOn = false;

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
        const clickable = !!(hit.agent || hit.room || hit.ghost || hit.addDev || hit.removeBtn ||
          hit.removeWtBtn || hit.pushRoom || hit.pullRoom || hit.fetchRoom || hit.openPrUrl ||
          hit.billboardRefresh || hit.reviewPr || hit.billboardZoom);
        this.container.style.cursor = clickable ? "pointer" : "default";
        const hk = this.hoverKeyOf(hit);
        if (hk !== this.hoverKey) { this.hoverKey = hk; this.invalidate(); } // repaint the highlight
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
    canvas.addEventListener("pointerleave", () => {
      if (this.hoverKey !== null) { this.hoverKey = null; this.invalidate(); } // clear button highlight
      this.container.style.cursor = "default";
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
  onPush(cb: (room: string) => void) { this.onPushCb = cb; }
  onPull(cb: (room: string) => void) { this.onPullCb = cb; }
  onFetch(cb: (room: string) => void) { this.onFetchCb = cb; }
  onCd(cb: (id: string, target: { room?: string; ghost?: { floor: number; col: number } }) => void) {
    this.onCdCb = cb;
  }
  onAssignReview(cb: (pr: { number: number; repo: string; title: string; branch?: string; url?: string }) => void) {
    this.onAssignReviewCb = cb;
  }
  onRefreshPrs(cb: () => void) { this.onRefreshPrsCb = cb; }
  onOpenPr(cb: (url: string) => void) { this.onOpenPrCb = cb; }
  onDebug(cb: (event: string, data?: unknown) => void) { this.onDebugCb = cb; }
  setDebug(on: boolean) { this.debugOn = on; }
  /** Emit a scene debug event (no-op unless devtower.debugLog is on). */
  private dbg(event: string, data?: Record<string, unknown>) {
    if (this.debugOn) this.onDebugCb(event, data);
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

  /** Whether DevTower has a GitHub token. false => draw the disconnected glyph in
   *  the PR billboard and board PR cells; null/true => normal. */
  setGithubConnected(connected: boolean | null | undefined) {
    this.githubConnected = connected === undefined ? null : connected;
    this.invalidate();
  }

  /** Review-requested PRs listed on the central billboard. */
  setReviewPrs(prs: { number: number; repo: string; title: string; branch?: string; url?: string }[]) {
    this.reviewPrs = Array.isArray(prs) ? prs : [];
    this.layout(); // bounds depend on the billboard so the overview frames it
  }

  /** Geometry for the review billboard, shared by draw + pick. Null when empty. */
  private billboardGeom(): { x: number; top: number; w: number; bodyH: number; headerH: number; rowH: number; rows: { pr: { number: number; repo: string; title: string; branch?: string; url?: string }; y: number; open: { x: number; y: number; w: number; h: number } }[]; surfaceY: number; extra: number; refresh: { x: number; y: number; w: number; h: number } } {
    // always present, always listing its PRs (or an empty-state line); clicking
    // it flies the camera in rather than expanding in place
    const n = Math.min(this.reviewPrs.length, BB_MAX);
    const x = this.campusMinX - BB_GAP - BB_W;
    const surfaceY = floorBase(0) + SLAB;
    const bodyH = BB_HEADER + Math.max(n, 1) * BB_ROW + 5;
    const top = surfaceY - 40 - bodyH;
    const rows: { pr: { number: number; repo: string; title: string; branch?: string; url?: string }; y: number; open: { x: number; y: number; w: number; h: number } }[] = [];
    for (let i = 0; i < n; i++) {
      const y = top + BB_HEADER + i * BB_ROW;
      rows.push({ pr: this.reviewPrs[i], y, open: { x: x + BB_W - 13, y: y + BB_ROW - 12, w: 10, h: 10 } });
    }
    return {
      x, top, w: BB_W, bodyH, headerH: BB_HEADER, rows, rowH: BB_ROW, surfaceY,
      extra: this.reviewPrs.length - n,
      refresh: { x: x + BB_W - 14, y: top + 3, w: 11, h: 11 },
    };
  }

  /** Remember a toon's walk state so a transient disappearance (a mid-refresh
   *  re-layout that unplaces it, or the agent blinking out of one poll) can
   *  resume from where it was instead of respawning the dev at the door. */
  private parkToon(id: string, tn: Toon) {
    if (tn.x === 0) return; // never placed yet → nothing worth resuming
    this.parked.set(id, {
      x: tn.x, base: tn.base, lift: tn.lift, entering: tn.entering,
      enterPhase: tn.enterPhase, sitting: tn.sitting, frame: this.frame,
      skills: tn.skills, booksShown: tn.booksShown, booksInHand: tn.booksInHand,
    });
  }

  setAgents(agents: CrewAgent[]) {
    const seen = new Set(agents.map((a) => a.id));
    // /clear restart: a session is replaced by a NEW session id in the SAME
    // worktree on one poll (the old transcript stops, the new one starts, and
    // discovery keeps only the live process's newest transcript). Rather than
    // walk the old dev out and a fresh one in, keep the SAME dev at its seat and
    // send it on a shred trip (carry context papers to the shredder, then back).
    const arriving = new Map<string, CrewAgent[]>(); // worktree -> brand-new agents
    for (const a of agents) {
      if (this.toons.has(a.id)) continue;
      const key = a.worktree?.trim();
      if (!key) continue;
      const list = arriving.get(key);
      if (list) list.push(a);
      else arriving.set(key, [a]);
    }
    if (arriving.size) {
      for (const [id, tn] of [...this.toons]) {
        // only a settled, departing dev we OWN. An external (outside-DevTower)
        // toon must never be re-keyed: its session didn't /clear-restart, so
        // grabbing it would drag an unrelated agent through the shred trip and
        // swap desks with the new dev.
        if (seen.has(id) || tn.leaving || tn.entering || tn.agent.external) continue;
        const key = tn.agent.worktree?.trim();
        const next = key ? arriving.get(key)?.shift() : undefined;
        if (!next) continue;
        // re-key the toon to the new session, keeping its persona/seat/position so
        // it reads as the SAME dev continuing after wiping its context.
        this.dbg("shred.swap", { from: id, to: next.id, worktree: key, wasExternal: !!tn.agent.external, nowExternal: !!next.external });
        this.toons.delete(id);
        tn.agent = next;
        tn.shred = { phase: "out", t: 0 };
        tn.errand = undefined;
        // the shredded context resets the dev's skills/books to the fresh session
        tn.skills = [...(next.skills ?? [])];
        tn.booksShown = tn.skills.length;
        tn.booksInHand = 0;
        this.toons.set(next.id, tn);
      }
    }
    for (const [id, tn] of this.toons) {
      if (!seen.has(id)) {
        // the agent dropped out of this poll. It may be a genuine departure or a
        // one-refresh blip (e.g. a PR refresh momentarily drops it). Park its spot
        // so a quick return resumes here; meanwhile it walks out, and if it comes
        // back the recreate below cancels that exit.
        this.dbg("toon.leave", { id, worktree: tn.agent.worktree, external: !!tn.agent.external });
        this.parkToon(id, tn);
        tn.leaving = true;
        this.leaving.push(tn);
        this.toons.delete(id);
      }
    }
    // drop parked state once the toon is back on screen, or after it has gone
    // stale (~10s) so genuinely-departed devs don't linger in the cache
    for (const [id, p] of this.parked) {
      if (this.toons.has(id) || this.frame - p.frame > 600) this.parked.delete(id);
    }
    for (const a of agents) {
      let tn = this.toons.get(a.id);
      if (!tn) {
        // resume a dev that vanished briefly (unplaced by a mid-refresh re-layout,
        // or blinked out of a poll) so it keeps walking from where it was rather
        // than teleporting back to the door
        const resume = this.parked.get(a.id);
        this.parked.delete(a.id);
        // if it was mid-walkout from the removal above, cancel that exit
        if (resume) this.leaving = this.leaving.filter((t) => t.agent.id !== a.id);
        tn = {
          agent: a, p: persona(a.id), x: resume?.x ?? 0, targetX: 0, base: resume?.base ?? 0, x0: 0,
          seatCol: 0, deskIdx: 0,
          row: 0, lift: resume?.lift ?? 0,
          sitting: resume?.sitting ?? false,
          entering: resume?.entering ?? true, enterPhase: resume?.enterPhase,
          leaving: false,
          // resume the dev's book state so a transient cull doesn't replay the
          // whole shelf trip; a fresh spawn starts with the books it already owns
          // already on the desk (no animation for skills used before it appeared)
          skills: resume?.skills ?? [...(a.skills ?? [])],
          booksShown: resume?.booksShown ?? (a.skills?.length ?? 0),
          booksInHand: resume?.booksInHand ?? 0,
          ph: (hash(a.id) % 628) / 100,
        };
        this.toons.set(a.id, tn);
        if (!resume) {
          this.newToonIds.add(a.id);
          this.dbg("toon.spawn", { id: a.id, worktree: a.worktree, external: !!a.external });
        }
      }
      // a reviewer's decision resolving (pending → approved/changes) thuds the
      // verdict stamp in; record the frame so the overlay can animate it once
      const nextV = a.reviewVerdict;
      if (a.reviewOf && (nextV === "approved" || nextV === "changes") && tn.lastVerdict !== nextV) {
        tn.stampAt = this.frame;
      }
      tn.lastVerdict = nextV;
      tn.agent = a;
      // accumulate newly-used skills; the tick walks the dev to the shelf to
      // fetch a book for each one beyond what's already on its desk
      for (const s of a.skills ?? []) if (!tn.skills.includes(s)) tn.skills.push(s);
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
      // a worktree-less agent has no checkout to seat against — skip it, matching
      // layout()'s grouping, so unrelated agents never merge into one "." block
      const key = a.worktree && a.worktree.trim() ? a.worktree : "";
      if (!key) continue;
      if (!byTree.has(key)) byTree.set(key, []);
      byTree.get(key)!.push(a);
    }
    const isMain = (key: string, ags: CrewAgent[]) =>
      DEFAULT_BRANCHES.has((ags[0].branch ?? "").toLowerCase());
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
      // fill the front line left-to-right first, then wrap to the back row;
      // the last row absorbs any overflow beyond the available rows
      ags.forEach((a, i) => {
        let row = Math.floor(i / FRONT_CAP);
        let col = i % FRONT_CAP;
        if (row > ROWS_OF_DESKS - 1) { row = ROWS_OF_DESKS - 1; col = i - row * FRONT_CAP; }
        seats.set(a.id, { col: startCol + col, row });
      });
      const cols = Math.max(1, Math.min(ags.length, FRONT_CAP));
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

  /** Re-aim a toon at its desk using its building's CURRENT (tweening)
   *  position, so seated devs ride a collapsing island instead of snapping. */
  private retargetToon(tn: Toon) {
    const room = tn.bkey ? this.rooms.get(tn.bkey) : undefined;
    if (!room) return;
    tn.base = room.baseY;
    tn.x0 = room.x0;
    const deskX = this.seatX(room, tn.seatCol, tn.row);
    if (tn.agent.state === "active") tn.targetX = deskX + 13;
    else tn.targetX = deskX + 19;
  }

  /** The cable port: a jack on the wall just BELOW the TV that every desk's
   *  cable runs into. The light-ball then hops up from here into the screen. */
  private cablePlug(r: Room): { x: number; y: number } {
    const b = boardRect(r.x0, r.baseY);
    return { x: b.x + b.w / 2, y: b.y + b.h + 5 };
  }

  /** The cable polyline for a seat: computer → floor → a curved sweep to the
   *  central floor bus → up the middle into the port below the screen. All
   *  desks share the central bus, so the cables bundle before going in. */
  private cableRoute(r: Room, seat: { col: number; row: number }): { x: number; y: number }[] {
    const base = r.baseY;
    const dx = this.seatX(r, seat.col, seat.row);
    const db = base - seat.row * ROW_DY;
    const cx = dx + 8; // behind the monitor
    const C = { x: cx, y: db - 12 };
    const F = { x: cx, y: db + 0.5 }; // drop to the floor at the desk
    const J = { x: r.x0 + ROOM_W / 2, y: base - 3 }; // central floor bus
    const P = this.cablePlug(r); // port below the screen
    const cFJ = { x: (cx + J.x) / 2, y: Math.max(F.y, J.y) + 5 }; // bow along the floor to centre
    const cJP = { x: J.x, y: (J.y + P.y) / 2 }; // sweep up the middle to the port
    return [C, F, ...sampleQuad(F, cFJ, J, 8), ...sampleQuad(J, cJP, P, 10)];
  }

  /** Fire a glowing light-ball from a working dev's computer along its network
   *  cable, through the port, and up into the screen — the "git changed" signal.
   *  Falls back to a room-centre → port route when no dev/seat is known. */
  private emitPacket(r: Room, delay = 0, snap?: BoardData) {
    const plug = this.cablePlug(r);
    const occ = r.agents.find((a) => this.toons.get(a.id)?.sitting) ?? r.agents[0];
    const seat = occ ? r.plan?.seats.get(occ.id) : undefined;
    // the ball rides the cable and STOPS at the wall port below the screen
    const path = seat
      ? this.cableRoute(r, seat)
      : [{ x: r.x0 + ROOM_W / 2, y: r.baseY - 16 }, plug];
    const s = path[0];
    // negative t holds the ball at the source so a burst streams out over time
    this.packets.push({
      x: s.x, y: s.y, sx: s.x, sy: s.y, tx: plug.x, ty: plug.y, t: -delay, path,
      color: Math.random() < 0.6 ? "#3ee089" : "#56c7ff",
      ph: Math.random() * Math.PI * 2, // flicker/pulse phase
      applyKey: snap ? r.name : undefined, applySnap: snap,
    });
  }

  /** True while a just-requested sync's resulting board change should flash but
   *  not beam (15s window covers the pull-then-push sequence). */
  private syncSuppressed(room: string): boolean {
    const t = this.syncSuppress.get(room);
    if (t === undefined) return false;
    if (Date.now() - t < 15000) return true;
    this.syncSuppress.delete(room);
    return false;
  }

  /** A beam reached the screen: show the snapshot it carried, and flash only the
   *  column(s) that differ from what was on the TV (so it's clear what moved). */
  private applyBoardSnapshot(key: string | undefined, snap: BoardData) {
    const r = key ? this.rooms.get(key) : undefined;
    if (!r) return;
    const o = r.boardShown, cp = r.cellPulse;
    if (o) {
      const uChanged = o.modified !== snap.modified || o.unstagedAdd !== snap.unstagedAdd || o.unstagedDel !== snap.unstagedDel;
      const sChanged = o.staged !== snap.staged || o.stagedAdd !== snap.stagedAdd || o.stagedDel !== snap.stagedDel;
      const cChanged = o.ahead !== snap.ahead || o.committedAdd !== snap.committedAdd || o.committedDel !== snap.committedDel || o.commits.length !== snap.commits.length;
      if (uChanged) cp.unstaged = 1;
      if (sChanged) cp.staged = 1;
      if (cChanged) cp.commits = 1;
      if (JSON.stringify(o.pr) !== JSON.stringify(snap.pr)) cp.pr = 1;
      // a pure stage/unstage MOVE (file count conserved, the two sides swap in
      // opposite directions) just flashes the columns; genuine new churn flips
      // the numbers
      const pureMove = uChanged && sChanged &&
        o.modified + o.staged === snap.modified + snap.staged &&
        (o.modified > snap.modified) !== (o.staged > snap.staged);
      const num = (b: BoardData) => ({
        "u.count": `${b.modified} file${b.modified === 1 ? "" : "s"}`, "u.add": `+${b.unstagedAdd}`, "u.del": `-${b.unstagedDel}`,
        "s.count": `${b.staged} file${b.staged === 1 ? "" : "s"}`, "s.add": `+${b.stagedAdd}`, "s.del": `-${b.stagedDel}`,
        "c.count": `${b.ahead}`, "c.add": `+${b.committedAdd}`, "c.del": `-${b.committedDel}`,
      } as Record<string, string>);
      const oN = num(o), nN = num(snap);
      for (const k of Object.keys(nN)) {
        if (oN[k] === nN[k]) continue;
        if (pureMove && (k[0] === "u" || k[0] === "s")) continue; // moved → flash only
        r.numAnim[k] = { from: oN[k], to: nN[k], t: 0 };
      }
    }
    r.boardShown = snap;
    r.statPulse = 1;
  }

  /** Draw each occupied desk's network cable: computer → floor → a curved sweep
   *  to the central floor bus → up into the port below the screen. Static art;
   *  the light-balls (packets) ride this same route when git changes. */
  private drawCables(ctx: CanvasRenderingContext2D, r: Room) {
    if (r.built < 0.85 || !r.plan) return;
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // one pass for the dark bodies, one for the highlights, so overlapping
    // cables along the shared bus don't stack into a muddy dark band
    for (const [, seat] of r.plan.seats) {
      const route = this.cableRoute(r, seat);
      ctx.beginPath();
      ctx.moveTo(route[0].x, route[0].y);
      for (let i = 1; i < route.length; i++) ctx.lineTo(route[i].x, route[i].y);
      ctx.strokeStyle = "rgba(12,16,20,0.4)"; // cable body
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.strokeStyle = "rgba(80,102,122,0.4)"; // faint top highlight
      ctx.lineWidth = 0.5;
      ctx.stroke();
      // a little jack where it plugs into the desk computer
      ctx.fillStyle = "#2a3138";
      ctx.fillRect(route[0].x - 1, route[0].y - 1, 2, 2);
    }
    // the wall port below the screen the whole bundle runs into
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
          agents: [], decor: hash(key + "decor"),
          statSig: "", statPulse: 0,
          cellPulse: { unstaged: 0, staged: 0, commits: 0, pr: 0 },
          numAnim: {},
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
    // reserve room for the review billboard on the left so the overview frames it
    this.campusMinX = minX;
    const bb = this.billboardGeom();
    minX = Math.min(minX, bb.x - 14);
    topY = Math.min(topY, bb.top - 8);
    this.bounds = { minX, maxX, topY, botY, minFloor };

    // 7. seat plan + cache each toon's seat; tick re-glues world coords so devs
    //    follow their building as the island collapses.
    const placed = new Set<string>();
    for (const room of this.rooms.values()) {
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
        const firstPlace = tn.entering && tn.x === 0;
        this.retargetToon(tn); // desk target + base on this floor
        if (firstPlace) {
          if (room.floor > 0) {
            // ride the elevator up the right-wall shaft from the ground to this door
            tn.x = shaftX(room.x0);
            tn.base = floorBase(0);
            tn.targetX = tn.x;
            tn.enterPhase = "elevator";
            tn.riding = true;
          } else {
            tn.x = room.x0 + ROOM_W + 8; // walk in through the ground-floor door
            tn.enterPhase = "walk";
          }
        }
      });
    }

    // cull toons whose room wasn't added to the UI — an agent only appears once
    // its directory/worktree has a room (its session keeps running regardless).
    // Stash the toon's walk state first: if this was just a transient unplacing
    // mid-refresh, setAgents re-creates the toon and resumes from here rather
    // than teleporting the dev back to the door.
    for (const [id, tn] of this.toons) {
      if (!placed.has(id)) {
        this.parkToon(id, tn);
        tn.bkey = undefined;
        this.toons.delete(id);
      }
    }

    // Preserve the operator's view across re-layouts. Only TRACK a focused dev's
    // (or room's) position so the camera follows it; never change zoom/pan, and
    // never fall back to a wider view when the toon is briefly absent mid-refresh
    // (that caused the random zoom-out). Centering/zoom is only set by a click.
    if (this.focusAgentId) {
      const tn = this.toons.get(this.focusAgentId);
      if (tn) {
        this.focus.x = tn.targetX;
        this.focus.y = tn.base - ROOM_H / 2 + 6;
      }
      // toon momentarily gone during a re-layout → leave the camera put
    } else if (this.focusRoom_) {
      const r = this.rooms.get(this.focusRoom_);
      if (r) {
        this.focus.x = r.x0 + ROOM_W / 2;
        this.focus.y = r.baseY - ROOM_H / 2;
      }
    } else if (this.focusIsland_) {
      if (!this.frameIsland(this.focusIsland_)) this.focusIsland_ = null; // island gone
    } else if (this.focusBillboard_) {
      const bb = this.billboardGeom(); // re-center as the sign grows/shrinks or shifts
      this.focus.x = bb.x + bb.w / 2;
      this.focus.y = bb.top + bb.bodyH / 2;
    } else if (!this.hasFitted) {
      this.clearFocus(true, false);
      this.hasFitted = true;
    }
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
    this.focusIsland_ = null;
    this.focusBillboard_ = false;
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

  /** Toggle the review billboard zoom: fly to it, or (if already there) return to
   *  the view you were at before. Driven by the HUD PR button. */
  toggleBillboard() {
    if (this.focusBillboard_) this.exitBillboard();
    else this.focusBillboard();
  }

  /** Fly the camera to the review billboard (and expand it so the PRs show),
   *  snapshotting the current view so exiting can return to it. */
  focusBillboard() {
    if (!this.focusBillboard_) {
      // remember where we were, but only when entering from a non-billboard view
      this.viewBeforeBillboard = {
        focusAgentId: this.focusAgentId, focusRoom_: this.focusRoom_, focusIsland_: this.focusIsland_,
        focus: { ...this.focus }, panX: this.panX, panY: this.panY, zoomMul: this.zoomMul,
      };
    }
    this.focusAgentId = null;
    this.focusRoom_ = null;
    this.focusIsland_ = null;
    this.focusBillboard_ = true;
    const bb = this.billboardGeom();
    this.focus.x = bb.x + bb.w / 2;
    this.focus.y = bb.top + bb.bodyH / 2;
    this.focus.spanW = bb.w + 70;
    this.focus.spanH = bb.bodyH + 56;
    this.panX = 0;
    this.panY = 0;
    this.zoomMul = 1;
    this.invalidate();
  }

  /** Leave the billboard, gliding back to the view captured on entry (falling
   *  back to the campus overview if there was none). */
  exitBillboard() {
    const v = this.viewBeforeBillboard;
    this.viewBeforeBillboard = null;
    this.focusBillboard_ = false;
    if (!v) { this.clearFocus(); return; }
    this.focusAgentId = v.focusAgentId;
    this.focusRoom_ = v.focusRoom_;
    this.focusIsland_ = v.focusIsland_;
    this.focus.x = v.focus.x;
    this.focus.y = v.focus.y;
    this.focus.spanW = v.focus.spanW;
    this.focus.spanH = v.focus.spanH;
    this.panX = v.panX;
    this.panY = v.panY;
    this.zoomMul = v.zoomMul;
    this.invalidate();
  }

  /** Set the focus box to frame a whole directory (island): all its stacked
   *  buildings plus the platform/signpost. Returns false if the island is gone. */
  private frameIsland(islandName: string): boolean {
    const rooms = [...this.rooms.values()].filter((b) => b.island === islandName && !b.dying);
    if (!rooms.length) return false;
    let minX = Infinity, maxX = -Infinity, topY = Infinity, botY = -Infinity;
    for (const b of rooms) {
      const rx = cellX0(b.col), ry = floorBase(b.floor);
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx + ROOM_W);
      topY = Math.min(topY, ry - ROOM_H);
      botY = Math.max(botY, ry + SLAB);
    }
    botY += 34; // room for the platform + directory name below
    this.focus.x = (minX + maxX) / 2;
    this.focus.y = (topY + botY) / 2;
    this.focus.spanW = maxX - minX + 46;
    this.focus.spanH = botY - topY + 40;
    return true;
  }

  /** Zoom out from a room to an overview of just THAT directory (its tower),
   *  rather than the whole campus. */
  focusIslandView(islandName: string) {
    this.focusAgentId = null;
    this.focusRoom_ = null;
    this.focusBillboard_ = false;
    this.focusIsland_ = islandName;
    if (!this.frameIsland(islandName)) { this.focusIsland_ = null; this.clearFocus(); return; }
    this.panX = 0;
    this.panY = 0;
    this.zoomMul = 1;
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
    this.focusIsland_ = null;
    this.focusBillboard_ = false;
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
    this.focusIsland_ = null;
    this.focusBillboard_ = false;
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
    if (this.marqueeOn) return false; // a PR title is scrolling
    for (const r of this.rooms.values()) {
      if (r.dying || r.delay > 0 || r.built < 1 || r.statPulse > 0.02 || r.swapPending) return false;
      const cp = r.cellPulse;
      if (cp.unstaged > 0.02 || cp.staged > 0.02 || cp.commits > 0.02 || cp.pr > 0.02) return false;
      for (const _k in r.numAnim) return false; // a number is mid-flip
      if (r.boardShown && r.boardShown.prReady === false) return false; // PR spinner still spinning
      if (r.boardShown?.pr && r.boardShown.pr.checksRunning > 0) return false; // CI dot pulsing
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

    // boards: a change the AGENT made locally (edits, staging, commits, push)
    // fires a beam from its computer carrying a board SNAPSHOT; the TV updates
    // to that snapshot when the beam lands. Changes it did NOT cause — a sync you
    // triggered, or external PR/CI/remote updates — just flash the column, no beam
    for (const r of this.rooms.values()) {
      if (r.statPulse > 0) r.statPulse = Math.max(0, r.statPulse - dt * 1.4);
      const cp = r.cellPulse;
      if (cp.unstaged > 0) cp.unstaged = Math.max(0, cp.unstaged - dt * 0.9);
      if (cp.staged > 0) cp.staged = Math.max(0, cp.staged - dt * 0.9);
      if (cp.commits > 0) cp.commits = Math.max(0, cp.commits - dt * 0.9);
      if (cp.pr > 0) cp.pr = Math.max(0, cp.pr - dt * 0.9);
      for (const k in r.numAnim) {
        const an = r.numAnim[k];
        an.t += dt * 3; // ~0.33s flip
        if (an.t >= 1) delete r.numAnim[k];
      }
      const b = r.board;
      const o = r.boardShown;
      const sig = boardSig(b);
      if (r.statSig === "") { r.statSig = sig; r.boardShown = b; continue; } // first sync shows at once
      if (sig === r.statSig) continue;
      r.statSig = sig;
      // did the AGENT change local state (working tree / staged / local commits /
      // unpushed)? "behind", base, PR and checks are external — they never beam.
      const localChanged = !o || !b ? !!b : (
        o.modified !== b.modified || o.staged !== b.staged ||
        o.unstagedAdd !== b.unstagedAdd || o.unstagedDel !== b.unstagedDel ||
        o.stagedAdd !== b.stagedAdd || o.stagedDel !== b.stagedDel ||
        o.ahead !== b.ahead || o.committedAdd !== b.committedAdd || o.committedDel !== b.committedDel ||
        o.commits.length !== b.commits.length || o.unpushed !== b.unpushed
      );
      if (b && r.built > 0.6 && localChanged && !this.syncSuppressed(r.name)) {
        this.emitPacket(r, 0, b); // agent did the work → beam carries the snapshot
      } else if (b) {
        this.applyBoardSnapshot(r.name, b); // external / synced → flash the column, no beam
      } else {
        r.boardShown = b; // board removed
      }
    }
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const p = this.packets[i];
      p.t += dt * 0.55; // slow travel so the run along the cable is easy to follow
      const e = clamp(p.t, 0, 1); // negative t (staggered start) holds at the source
      if (p.path && p.path.length >= 2) {
        // ride the cable: computer → floor → screen, eased by arc length
        const pos = pointOnPath(p.path, e * e * (3 - 2 * e));
        p.x = pos.x; p.y = pos.y;
      } else {
        const ease = e * e * (3 - 2 * e);
        p.x = p.sx + (p.tx - p.sx) * ease;
        p.y = p.sy + (p.ty - p.sy) * ease - Math.sin(ease * Math.PI) * 16; // lob it up to the wall
      }
      if (p.t >= 1) {
        if (p.applySnap) this.applyBoardSnapshot(p.applyKey, p.applySnap);
        this.packets.splice(i, 1);
      }
    }

    // re-glue seated/working devs to their building's live position so they ride
    // the collapse instead of snapping to the final desk. Also drive book errands:
    // a dev that used a new skill walks to the left-window shelf, then back.
    for (const tn of this.toons.values()) {
      if (tn.leaving || tn.entering) continue;
      this.retargetToon(tn); // glue base/x0 + aim at the desk seat
      const room = tn.bkey ? this.rooms.get(tn.bkey) : undefined;
      if (!room) continue;
      // start a trip once settled at the desk and a skill's book is still missing
      // (neither on the desk nor already in hand)
      if (!tn.errand && !tn.shred && tn.skills.length > tn.booksShown + tn.booksInHand && Math.abs(tn.targetX - tn.x) <= 1) {
        tn.errand = { phase: "out", grab: 0 };
      }
      // out/grab: head for (and hold at) the shelf; back: keep the desk aim above
      if (tn.errand && tn.errand.phase !== "back") tn.targetX = room.x0 + SHELF_REACH;
      // the shred trip overrides the desk aim toward the shredder until it heads back
      if (tn.shred && tn.shred.phase !== "back") tn.targetX = room.x0 + SHRED_REACH;
    }

    // upper-floor arrivals ride the elevator up the shaft to their door
    for (const tn of this.toons.values()) {
      if (!tn.entering || tn.enterPhase !== "elevator") continue;
      const room = tn.bkey ? this.rooms.get(tn.bkey) : undefined;
      if (!room) { tn.enterPhase = "walk"; tn.riding = false; continue; }
      tn.riding = true;
      tn.x0 = room.x0;
      tn.x = shaftX(room.x0);
      tn.targetX = tn.x;
      const dy = room.baseY - tn.base;
      tn.base += Math.sign(dy) * Math.min(Math.abs(dy), CAR_SPEED * dt);
      if (Math.abs(room.baseY - tn.base) < 1) {
        tn.base = room.baseY;
        tn.riding = false;
        tn.enterPhase = "walk";
        this.retargetToon(tn); // step out of the car and cross to the desk
      }
    }

    const all: Toon[] = [...this.toons.values(), ...this.leaving];
    for (const tn of all) {
      if (tn.entering && tn.enterPhase === "elevator") continue; // handled above
      const dx = tn.targetX - tn.x;
      if (Math.abs(dx) > 1) tn.x += Math.sign(dx) * Math.min(Math.abs(dx), WALK_SPEED * dt);
      else if (tn.entering) tn.entering = false;
      tn.sitting = tn.agent.state === "active" && !tn.entering && !tn.errand && !tn.shred && Math.abs(dx) <= 1;
      // settle up into the back row once parked at the desk; drop to the aisle
      // (lift -> 0) whenever walking, entering, leaving, or off on a book
      // errand (so the dev rides the near floor to the shelf and back)
      const atDesk = Math.abs(dx) <= 1 && !tn.entering && !tn.leaving && !tn.errand && !tn.shred;
      const targetLift = atDesk ? tn.row * ROW_DY : 0;
      tn.lift += (targetLift - tn.lift) * Math.min(1, dt * 9);
    }
    // advance book errands now that this frame's walk has been applied: arrive at
    // the shelf → pause to grab → carry home → read at the desk
    for (const tn of this.toons.values()) {
      const er = tn.errand;
      if (!er) continue;
      const arrived = Math.abs(tn.targetX - tn.x) <= 1;
      if (er.phase === "out") {
        if (arrived) { er.phase = "grab"; er.grab = 0.55; }
      } else if (er.phase === "grab") {
        er.grab -= dt;
        if (er.grab <= 0) er.phase = "back";
      } else if (arrived) {
        // back at the desk: the fetched books are now in hand to read, not yet
        // set down (they go on the desk once the task stops being active, below)
        tn.booksInHand = tn.skills.length - tn.booksShown;
        tn.errand = undefined;
      }
    }
    // advance the shred trip: arrive at the shredder → feed the stack in → walk
    // back to the desk. Mirrors the book errand but carries nothing home.
    for (const tn of this.toons.values()) {
      const sh = tn.shred;
      if (!sh) continue;
      const arrived = Math.abs(tn.targetX - tn.x) <= 1;
      if (sh.phase === "out") {
        if (arrived) { sh.phase = "feed"; sh.t = SHRED_FEED; }
      } else if (sh.phase === "feed") {
        sh.t -= dt;
        if (sh.t <= 0) sh.phase = "back";
      } else if (arrived) {
        tn.shred = undefined;
      }
    }
    // a dev reads its fetched book(s) at the desk while the task is live; once the
    // task is no longer running (idle/complete/error — waiting still counts) it
    // sets them down on the desk to join the stack
    for (const tn of this.toons.values()) {
      if (tn.booksInHand <= 0 || tn.errand) continue;
      const st = tn.agent.state;
      if (st !== "active" && st !== "waiting") {
        tn.booksShown = tn.skills.length;
        tn.booksInHand = 0;
      }
    }
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const tn = this.leaving[i];
      if (!tn.leavePhase) {
        tn.riding = false; // clear any stale entry-ride state
        const floor = Math.round(-tn.base / FLOOR_STEP);
        if (floor > 0) {
          // upper floor: walk to the elevator on this floor, then ride down
          tn.targetX = shaftX(tn.x0);
        } else {
          // ground floor: walk straight out to the building's edge
          let maxC = -Infinity;
          for (const r of this.rooms.values()) {
            if (r.floor === floor) maxC = Math.max(maxC, r.col);
          }
          const edge = isFinite(maxC) ? cellX0(maxC) + ROOM_W : tn.x0 + ROOM_W;
          tn.targetX = edge + 5;
        }
        tn.leavePhase = "walk";
      }
      const atX = Math.abs(tn.x - tn.targetX) <= 1.5;
      if (tn.leavePhase === "walk" && atX) {
        if (Math.abs(tn.base) > 1) {
          // not at ground level → board the car and ride down the shaft
          tn.leavePhase = "elevator";
          tn.riding = true;
          tn.x = shaftX(tn.x0);
          tn.targetX = tn.x;
        } else {
          tn.leavePhase = "away";
          tn.targetX = tn.x + 28;
        }
      } else if (tn.leavePhase === "elevator") {
        tn.x = shaftX(tn.x0);
        tn.targetX = tn.x;
        const step = Math.min(Math.abs(tn.base), CAR_SPEED * dt);
        tn.base += Math.sign(-tn.base) * step; // descend toward the ground
        if (Math.abs(tn.base) <= 0.5) {
          tn.base = 0;
          tn.riding = false;
          tn.leavePhase = "away";
          tn.targetX = tn.x + 28; // step out and walk off the edge
        }
      } else if (tn.leavePhase === "away" && atX) {
        this.leaving.splice(i, 1);
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
    pushRoom?: string; // building key → push local commits
    pullRoom?: string; // building key → pull upstream commits
    fetchRoom?: string; // building key → fetch remote refs (refresh behind/ahead)
    reviewPr?: { number: number; repo: string; title: string; branch?: string; url?: string };
    billboardRefresh?: boolean; // ↻ on the review sign
    billboardZoom?: boolean; // click the sign body → fly the camera to it
    openPrUrl?: string; // ↗ on a row → open the PR on GitHub
  } {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    // review billboard: refresh button → rows → anywhere else zooms to the sign
    const bb = this.billboardGeom();
    {
      if (this.inRect(mx, my, bb.refresh.x, bb.refresh.y, bb.refresh.w, bb.refresh.h)) return { billboardRefresh: true };
      for (const { pr, y, open } of bb.rows) {
        if (pr.url && this.inRect(mx, my, open.x, open.y, open.w, open.h)) return { openPrUrl: pr.url };
        if (this.inRect(mx, my, bb.x, y, bb.w, bb.rowH)) return { reviewPr: pr };
      }
      if (this.inRect(mx, my, bb.x, bb.top, bb.w, bb.bodyH)) return { billboardZoom: true };
    }

    // building buttons (highest priority). Every room has a + DEV (drop an agent
    // into this room's worktree). The main (root) building's ✕ nukes the whole
    // directory; a worktree building's ✕ removes just that worktree.
    for (const r of this.rooms.values()) {
      if (r.built < 0.95) continue;
      const base = r.baseY;
      if (this.inRect(mx, my, r.x0 + ROOM_W - 10, base - ROOM_H + 2, 8, 8)) {
        return r.isMain ? { removeBtn: r.island } : { removeWtBtn: r.name, island: r.island };
      }
      if (this.inRect(mx, my, r.x0 + ROOM_W - DOOR_W - 17, base - ROOM_H + 2, 16, 8)) {
        return { addDev: { island: r.island, key: r.name } };
      }
      const btns = this.commitButtons(r);
      if (btns.push && this.inRect(mx, my, btns.push.x, btns.push.y, btns.push.w, btns.push.h)) return { pushRoom: r.name };
      if (btns.pull && this.inRect(mx, my, btns.pull.x, btns.pull.y, btns.pull.w, btns.pull.h)) return { pullRoom: r.name };
      if (btns.fetch && this.inRect(mx, my, btns.fetch.x, btns.fetch.y, btns.fetch.w, btns.fetch.h)) return { fetchRoom: r.name };
      const prb = this.prOpenButton(r);
      if (prb && this.inRect(mx, my, prb.x, prb.y, prb.w, prb.h)) return { openPrUrl: prb.url };
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

  /** A stable key for the clickable control under a pick result, so the renderer
   *  can highlight whatever the cursor is hovering. null = not a button. */
  private hoverKeyOf(h: ReturnType<PixelCrew["pick"]>): string | null {
    if (h.billboardRefresh) return "bbRefresh";
    if (h.openPrUrl) return "openpr:" + h.openPrUrl;
    if (h.addDev) return "addDev:" + h.addDev.key;
    if (h.removeBtn) return "remove:" + h.removeBtn;
    if (h.removeWtBtn) return "remove:" + h.removeWtBtn;
    if (h.fetchRoom) return "fetch:" + h.fetchRoom;
    if (h.pushRoom) return "push:" + h.pushRoom;
    if (h.pullRoom) return "pull:" + h.pullRoom;
    return null;
  }

  /** Is the given control key the one currently hovered? */
  private hov(key: string): boolean {
    return this.hoverKey === key;
  }

  private onClick(e: PointerEvent) {
    const hit = this.pick(e);
    if (hit.billboardRefresh) { this.onRefreshPrsCb(); }
    else if (hit.openPrUrl) { this.onOpenPrCb(hit.openPrUrl); }
    else if (hit.billboardZoom) { this.focusBillboard(); }
    else if (hit.reviewPr) { this.onAssignReviewCb(hit.reviewPr); }
    else if (hit.fetchRoom) { this.onFetchCb(hit.fetchRoom); }
    else if (hit.pushRoom) { this.syncSuppress.set(hit.pushRoom, Date.now()); this.onPushCb(hit.pushRoom); }
    else if (hit.pullRoom) { this.syncSuppress.set(hit.pullRoom, Date.now()); this.onPullCb(hit.pullRoom); }
    else if (hit.removeWtBtn) this.onRemoveWorktreeCb(hit.removeWtBtn, hit.island ?? "");
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
      // already centered on this room → zoom out to an overview of just this
      // directory (its tower), not the whole campus
      if (!this.focusAgentId && this.focusRoom_ === hit.room) this.focusIslandView(hit.island ?? "");
      else this.focusOn(hit.room);
    } else if (this.focusBillboard_) {
      // leaving the PR billboard returns to the view we were at before flying in
      this.exitBillboard();
    } else {
      // clicking empty space steps out one level: room / dev → its directory
      // overview → the whole campus
      const key = this.focusRoom_ ?? (this.focusAgentId ? this.toons.get(this.focusAgentId)?.bkey : undefined);
      const r = key ? this.rooms.get(key) : undefined;
      if (r) this.focusIslandView(r.island);
      else this.clearFocus();
    }
  }

  /* ============ DRAW ============ */

  private draw() {
    this.marqueeOn = false; // set true by drawBoard while a PR title is scrolling
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

    // ragged skyline: a roof slab caps each column
    for (const [col, rng] of this.colRange) {
      const x0 = cellX0(col);
      const roofY = floorBase(rng.max) - ROOM_H;
      ctx.fillStyle = "#2c353e";
      ctx.fillRect(x0 - 1.5, roofY - 3, ROOM_W + 3, 3.4);
    }

    // island platforms (the foundation the buildings stand on)
    for (const isl of this.islands.values()) this.drawIslandPlatform(ctx, isl);

    // central "PRs to review" billboard, standing to the left of the campus
    this.drawReviewBillboard(ctx);

    // rooms back layer
    for (const r of this.rooms.values()) this.drawRoomBack(ctx, r);

    // network cables run each desk's computer down to the floor and back to the
    // screen; drawn here so the desks + devs (next layer) occlude the near runs
    for (const r of this.rooms.values()) this.drawCables(ctx, r);

    // ghost slots (+building extends an island, +island reserves a directory)
    for (const g of this.ghosts) this.drawGhost(ctx, g);

    // external elevator shafts: a track bolted to the right exterior wall of
    // every tower that has an upper floor; the car (below) rides inside it.
    for (const [col, rng] of this.colRange) {
      if (rng.max <= 0) continue; // ground-only towers need no lift
      const sx = shaftX(cellX0(col));
      const left = sx - SHAFT_W / 2;
      const top = floorBase(rng.max) - ROOM_H;
      const bot = SLAB; // foot planted at the ground / pedestal
      ctx.fillStyle = "#161b21"; // shaft well
      ctx.fillRect(left, top, SHAFT_W, bot - top);
      ctx.fillStyle = "#2a3138"; // guide rails up each side
      ctx.fillRect(left, top, 1.6, bot - top);
      ctx.fillRect(left + SHAFT_W - 1.6, top, 1.6, bot - top);
      ctx.fillStyle = "#323b43"; // a landing line at each served floor
      for (let f = 0; f <= rng.max; f++) ctx.fillRect(left, floorBase(f) - 0.7, SHAFT_W, 1.4);
      ctx.fillStyle = "#2c353e"; // motor housing capping the shaft
      ctx.fillRect(left - 1, top - 5, SHAFT_W + 2, 5);
    }

    // elevator cars: a cage rides the external shaft carrying a dev between
    // floors (entering up, leaving down). Drawn before the crew so the rider's
    // toon renders inside the open-front cage.
    for (const tn of [...this.toons.values(), ...this.leaving]) {
      if (!tn.riding) continue;
      const cx = shaftX(tn.x0);
      const b = tn.base;
      const halfW = CAR_W / 2;
      // hoist cable running up the shaft to the motor at the top
      const col = Math.round((tn.x0 + ROOM_W / 2) / COL_STEP);
      const rng = this.colRange.get(col);
      const cableTop = rng ? floorBase(rng.max) - ROOM_H : b - CAR_H - 14;
      ctx.fillStyle = "#1c2228";
      ctx.fillRect(cx - 0.6, cableTop, 1.2, b - CAR_H - cableTop);
      // cage well + interior
      ctx.fillStyle = "#10161c";
      ctx.fillRect(cx - halfW, b - CAR_H, CAR_W, CAR_H);
      ctx.fillStyle = "#222a31";
      ctx.fillRect(cx - halfW + 1.5, b - CAR_H + 1.5, CAR_W - 3, CAR_H - 3);
      // ceiling + floor slabs
      ctx.fillStyle = "#4a545d";
      ctx.fillRect(cx - halfW, b - CAR_H, CAR_W, 2.4);
      ctx.fillRect(cx - halfW, b - 2, CAR_W, 2.6);
      // side posts + a guide-rail glint on the wall side
      ctx.fillStyle = "#3a434c";
      ctx.fillRect(cx - halfW, b - CAR_H, 1.8, CAR_H);
      ctx.fillRect(cx + halfW - 1.8, b - CAR_H, 1.8, CAR_H);
      ctx.fillStyle = "#5a646c";
      ctx.fillRect(cx + halfW - 0.6, b - CAR_H, 0.6, CAR_H);
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
      for (const tn of rowToons) {
        // a session running OUTSIDE DevTower is rendered ghosted — grayed and
        // semi-transparent — so it reads as "not one of ours" at a glance
        // outside-DevTower sessions render translucent (here) and desaturated
        // (palette swap in drawToon) so they read as "not one of ours"
        const ghost = tn.agent.external;
        if (ghost) {
          ctx.save();
          ctx.globalAlpha *= 0.62;
        }
        this.drawToon(ctx, tn);
        if (ghost) ctx.restore();
      }
      for (const r of this.rooms.values()) this.drawDesks(ctx, r, row);
    }
    // particles
    for (const p of this.particles) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // a small glowing light that flickers + pulses as it travels the cable
    for (const p of this.packets) {
      if (p.t < 0) continue; // still queued at the source (staggered start)
      const fade = p.t < 0.85 ? 1 : clamp((1 - p.t) / 0.15, 0, 1);
      const pulse = 0.8 + 0.2 * Math.sin(this.frame * 0.55 + p.ph); // slow breathing
      const flick = 0.82 + Math.random() * 0.18; // subtle flicker
      const a = fade * pulse * flick;
      const rad = 1.3 + 0.45 * Math.sin(this.frame * 0.55 + p.ph);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = 0.22 * a; // soft outer halo
      ctx.fillRect(p.x - rad - 1.4, p.y - rad - 1.4, (rad + 1.4) * 2, (rad + 1.4) * 2);
      ctx.globalAlpha = 0.5 * a; // colored glow
      ctx.fillRect(p.x - rad, p.y - rad, rad * 2, rad * 2);
      ctx.globalAlpha = Math.min(1, a + 0.1); // small bright core
      ctx.fillStyle = "#e6fff4";
      ctx.fillRect(p.x - 0.6, p.y - 0.6, 1.2, 1.2);
    }
    ctx.globalAlpha = 1;

    /* ---- screen-space pass ---- */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center";
    for (const r of this.rooms.values()) {
      if (r.built < 0.95) continue;
      const base = r.baseY;
      const top = base - ROOM_H + 2; // shared top so + DEV and ✕ line up vertically
      // "+ DEV" on every room — drop an agent into this room's worktree
      const d1 = this.screenOf(r.x0 + ROOM_W - DOOR_W - 17, top);
      const d2 = this.screenOf(r.x0 + ROOM_W - DOOR_W - 1, top + 8);
      const devHov = this.hov("addDev:" + r.name);
      this.drawRoomButton(ctx, d1.x, d1.y, d2.x - d1.x, d2.y - d1.y, "+ DEV",
        devHov ? "#aef5cf" : "#3ee089", `600 ${clamp(3.2 * this.cam.z, 7, 11)}px 'Martian Mono', monospace`, devHov);
      // ✕ — main nukes the whole directory, a worktree removes just itself
      const x1 = this.screenOf(r.x0 + ROOM_W - 10, top);
      const x2 = this.screenOf(r.x0 + ROOM_W - 2, top + 8);
      const xHov = this.hov("remove:" + (r.isMain ? r.island : r.name));
      this.drawRoomButton(ctx, x1.x, x1.y, x2.x - x1.x, x2.y - x1.y, "✕",
        xHov ? "#ffd2ce" : "#ff6055", `bold ${clamp(2.8 * this.cam.z, 7, 10)}px monospace`, xHov);
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
    // toon labels + bubbles. Names stay a fixed, readable size (they do NOT scale
    // with the zoom), but when devs converge on screen — zoomed out, or many in
    // one room — their labels would pile into a colliding mess. So we DECLUTTER:
    // a name is drawn only if its box doesn't overlap one already drawn. The
    // selected dev is sorted first so it always wins and stays visible.
    const claimed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const nameOverlaps = (b: { x0: number; x1: number; y0: number; y1: number }) =>
      claimed.some((c) => b.x0 < c.x1 && b.x1 > c.x0 && b.y0 < c.y1 && b.y1 > c.y0);
    const labelToons = [...this.toons.values()].sort(
      (a, b) => (b.agent.id === this.selectedId ? 1 : 0) - (a.agent.id === this.selectedId ? 1 : 0)
    );
    ctx.textAlign = "center";
    for (const tn of labelToons) {
      const s = this.screenOf(tn.x, tn.base - tn.lift - 23);
      const st = tn.agent.state;
      const sel = tn.agent.id === this.selectedId;
      ctx.font = "9px 'IBM Plex Mono', monospace";
      const nw = ctx.measureText(tn.agent.name).width;
      const box = { x0: s.x - nw / 2 - 2, x1: s.x + nw / 2 + 2, y0: s.y - 18, y1: s.y - 6 };
      if (sel || !nameOverlaps(box)) {
        claimed.push(box);
        const ext = tn.agent.external;
        ctx.fillStyle = sel ? "#ffb13d" : ext ? "rgba(150,162,170,0.7)" : "rgba(230,238,240,0.88)";
        ctx.fillText(tn.agent.name, s.x, s.y - 8);
        if (ext && !sel) {
          // dashed underline: the "running outside DevTower" marker
          ctx.save();
          ctx.strokeStyle = "rgba(160,172,180,0.8)";
          ctx.lineWidth = 1;
          ctx.setLineDash([2.5, 2]);
          ctx.beginPath();
          ctx.moveTo(s.x - nw / 2, s.y - 5);
          ctx.lineTo(s.x + nw / 2, s.y - 5);
          ctx.stroke();
          ctx.restore();
        }
      }
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
      // reviewer badge: a pill above the dev showing the PR under review, which
      // stamps into APPROVED / CHANGES once the PR's decision resolves
      if (tn.agent.reviewOf) {
        const v = tn.agent.reviewVerdict;
        const resolved = v === "approved" || v === "changes";
        const label = v === "approved" ? "APPROVED" : v === "changes" ? "CHANGES" : `REVIEWING #${tn.agent.reviewOf.number}`;
        const col = v === "approved" ? "#3ee089" : v === "changes" ? "#ff6b6b" : "#ffb13d";
        // thud-in scale when a verdict just landed (overshoot then settle ~0.6s)
        let scale = 1;
        if (resolved && tn.stampAt !== undefined) {
          const dt = this.frame - tn.stampAt;
          scale = dt < 3 ? 1.5 : dt < 6 ? 1.2 : 1;
        }
        ctx.save();
        const by = s.y - 30;
        ctx.translate(s.x, by);
        ctx.scale(scale, scale);
        ctx.font = "bold 7px 'Martian Mono', monospace";
        ctx.textAlign = "center";
        const w = ctx.measureText(label).width + 10;
        ctx.fillStyle = "rgba(10,15,18,0.88)";
        ctx.fillRect(-w / 2, -7, w, 11);
        ctx.strokeStyle = col;
        ctx.lineWidth = resolved ? 1.4 : 1;
        ctx.strokeRect(-w / 2, -7, w, 11);
        ctx.fillStyle = col;
        ctx.fillText(label, 0, 1.5);
        ctx.restore();
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

  /** Truncate `s` with a trailing ellipsis so it fits within `maxW` world units
   *  at the currently-set font. */
  private fitText(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
    if (ctx.measureText(s).width <= maxW) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(s.slice(0, mid) + "…").width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return s.slice(0, lo).trimEnd() + "…";
  }

  /** The standalone signboard listing review-requested PRs. Each row is a tap
   *  target (see pick → reviewPr) that opens the dispatch modal for that PR. */
  private drawReviewBillboard(ctx: CanvasRenderingContext2D) {
    const bb = this.billboardGeom();
    const { x, top, w, bodyH, headerH, rows, surfaceY, extra, refresh } = bb;
    const legTop = top + bodyH;
    // two posts down to the ground + a soft contact shadow
    ctx.fillStyle = "#3a2c1d";
    ctx.fillRect(x + 12, legTop, 5, surfaceY - legTop);
    ctx.fillRect(x + w - 17, legTop, 5, surfaceY - legTop);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(x + 6, surfaceY - 1, w - 12, 2);
    // panel body
    ctx.fillStyle = "#16202b";
    ctx.fillRect(x, top, w, bodyH);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(x, top, w, 1);
    ctx.strokeStyle = "#2b3a47";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, top + 0.5, w - 1, bodyH - 1);
    // header band: chevron + title + count + refresh
    ctx.fillStyle = "#1d2a36";
    ctx.fillRect(x, top, w, headerH);
    ctx.fillStyle = "#ffb13d";
    ctx.font = "700 8px 'Martian Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillText("⌕ PRs TO REVIEW", x + 6, top + 11);
    ctx.fillStyle = "rgba(255,177,61,0.6)"; // PR count, left of the refresh glyph
    ctx.textAlign = "right";
    ctx.fillText(String(this.reviewPrs.length), x + w - 19, top + 11);
    // refresh button
    const bbRefHov = this.hov("bbRefresh");
    ctx.fillStyle = bbRefHov ? "rgba(255,177,61,0.22)" : "rgba(255,255,255,0.06)"; // hover tint
    ctx.fillRect(refresh.x, refresh.y, refresh.w, refresh.h);
    ctx.fillStyle = bbRefHov ? "#ffb13d" : "rgba(230,238,240,0.85)";
    ctx.font = "8px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText("↻", refresh.x + refresh.w / 2, refresh.y + refresh.h - 2.5);
    // PR rows
    ctx.textAlign = "left";
    for (const { pr, y, open } of rows) {
      ctx.fillStyle = "rgba(255,255,255,0.06)"; // separator
      ctx.fillRect(x + 4, y, w - 8, 0.6);
      ctx.fillStyle = "#7fb8df"; // PR number
      ctx.font = "600 7px 'IBM Plex Mono', monospace";
      ctx.fillText(`#${pr.number}`, x + 6, y + 9);
      ctx.fillStyle = TEXT.muted; // repo (right of number)
      ctx.font = "6px 'IBM Plex Mono', monospace";
      ctx.textAlign = "right";
      ctx.fillText(this.fitText(ctx, pr.repo.split("/").pop() ?? pr.repo, w * 0.45), x + w - 6, y + 9);
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(230,238,240,0.9)"; // title
      ctx.font = "7px 'IBM Plex Mono', monospace";
      ctx.fillText(this.fitText(ctx, pr.title || "", w - 30), x + 6, y + 17);
      // open-in-GitHub button (↗)
      const aHov = !!pr.url && this.hov("openpr:" + pr.url);
      ctx.fillStyle = aHov ? "rgba(127,184,223,0.42)" : "rgba(127,184,223,0.18)"; // accent chip, brighter on hover
      ctx.fillRect(open.x, open.y, open.w, open.h);
      ctx.fillStyle = aHov ? "#d6ecfb" : "#9fd0f0"; // brighter accent arrow
      ctx.font = "bold 8px 'IBM Plex Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("↗", open.x + open.w / 2, open.y + open.h - 2.2);
      ctx.textAlign = "left";
    }
    if (!rows.length) {
      const cy = top + headerH + BB_ROW / 2 + 2;
      ctx.textAlign = "center";
      if (this.githubConnected === false) {
        // no token: show the disconnected glyph + a prompt, not a misleading empty
        this.drawDisconnected(ctx, x + w / 2, cy - 4, 7, "#ffb13d");
        ctx.fillStyle = TEXT.primary;
        ctx.font = "6px 'IBM Plex Mono', monospace";
        ctx.fillText("GitHub not connected", x + w / 2, cy + 11);
        ctx.fillStyle = TEXT.muted;
        ctx.font = "5px 'IBM Plex Mono', monospace";
        ctx.fillText("add a token in ⚙ Settings", x + w / 2, cy + 19);
      } else {
        ctx.fillStyle = TEXT.muted;
        ctx.font = "6.5px 'IBM Plex Mono', monospace";
        ctx.fillText("nothing awaiting you", x + w / 2, cy);
      }
      ctx.textAlign = "left";
    }
    if (extra > 0) {
      ctx.fillStyle = TEXT.muted;
      ctx.font = "6px 'IBM Plex Mono', monospace";
      ctx.fillText(`+${extra} more`, x + 6, top + bodyH - 3);
    }
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
    // window edges run along constant-f wall lines (same as the bookshelf below),
    // so both slant with the wall's perspective and line up
    const winT0 = 0.3, winT1 = 0.64, winFTop = 0.28, winFBot = 0.66;
    const wp = [onWall(winT0, winFTop), onWall(winT1, winFTop), onWall(winT1, winFBot), onWall(winT0, winFBot)];
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

    // the skills library: a long bookshelf running the full left wall, slanted
    // to the wall's perspective, just below the window
    this.drawBookshelf(ctx, r, onWall);

    // the paper shredder a dev visits on /clear (right of the desks, on the floor)
    this.drawShredder(ctx, r);

    // plant + hash decor
    const px = x + w - DOOR_W - 6;
    ctx.fillStyle = "#7a4a2a";
    ctx.fillRect(px, base - 4.5, 4, 3);
    ctx.fillStyle = "#3f8a4a";
    ctx.fillRect(px + 0.5, base - 9, 1.4, 4.5);
    ctx.fillRect(px + 2.2, base - 8, 1.4, 3.5);
    ctx.fillRect(px - 0.8, base - 7.5, 1.4, 3);
    // floor-standing decor only (a high wall poster used to live here too, but it
    // collided with the full-wall task board, so it was removed)
    const extra = r.decor % 2;
    if (extra === 0) {
      const wx = x + WB_W - 8;
      ctx.fillStyle = "#cfd6da";
      ctx.fillRect(wx, base - 12, 5, 10.5);
      ctx.fillStyle = "#56c7ff";
      ctx.fillRect(wx + 0.8, base - 15.5, 3.4, 4);
    } else {
      const sx = x + w - DOOR_W - 14;
      ctx.fillStyle = "#171c21";
      ctx.fillRect(sx, base - 16, 6, 14.5);
      for (let i = 0; i < 4; i++) {
        const on = (this.frame + i * 3 + (r.decor % 7)) % 8 < 4;
        ctx.fillStyle = on ? (i === 2 ? "#3ee089" : "#ffb13d") : "#2a3138";
        ctx.fillRect(sx + 4.2, base - 14.5 + i * 3.2, 1, 1);
      }
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

    // the elevator shaft rides the right side wall (the lift door above); devs
    // travel it between floors, so no internal staircase is drawn here.

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
  /** Buttons in the bottom band of the COMMITS cell, shared by the renderer and
   *  the hit-test so they always agree. `push` (↑) appears when there are local
   *  commits to push, `pull` (↓) when the branch is behind upstream, and `fetch`
   *  (↻) is always available to refresh behind/ahead from the remote. Geometry
   *  must mirror drawBoard's cell layout. `synced` flags the all-clear state. */
  private commitButtons(r: Room): {
    push?: { x: number; y: number; w: number; h: number };
    pull?: { x: number; y: number; w: number; h: number };
    fetch?: { x: number; y: number; w: number; h: number };
    synced?: boolean;
  } {
    const bd = r.boardShown ?? r.board;
    if (!bd || bd.missing) return {};
    const b = boardRect(r.x0, r.baseY);
    if (b.w < 20 || b.h < 14) return {};
    const pad = 4;
    const innerL = b.x + pad, innerR = b.x + b.w - pad;
    const prW = Math.min(96, (innerR - innerL) * 0.42);
    const gitR = innerR - prW - 4;
    const cw = (gitR - innerL) / 3;
    const cx = innerL + 2 * cw; // COMMITS cell
    const cwIn = cw - 4;
    const y = b.y + b.h - 8.5, h = 7.5, slot = 8.5;
    let lx = cx - 0.5;
    const push = bd.unpushed > 0 ? { x: lx, y, w: slot, h } : undefined;
    if (push) lx += slot;
    const pull = bd.behind > 0 ? { x: lx, y, w: slot, h } : undefined;
    const fetch = { x: cx + cwIn - 6.5, y, w: 7, h };
    return { push, pull, fetch, synced: !push && !pull };
  }

  /** Rect of the open-in-GitHub (↗) button in a room's board PR cell, plus the
   *  PR url to open. Mirrors drawBoard's PR-cell layout. Null when there's no PR. */
  private prOpenButton(r: Room): { x: number; y: number; w: number; h: number; url: string } | null {
    const bd = r.boardShown ?? r.board;
    if (!bd || bd.missing || !bd.pr?.url) return null;
    const b = boardRect(r.x0, r.baseY);
    if (b.w < 20 || b.h < 14) return null;
    const innerR = b.x + b.w - 4;
    const bodyTop = b.y + 12;
    return { x: innerR - 6, y: bodyTop, w: 6, h: 6, url: bd.pr.url };
  }

  /** Draw a number, rolling the old value up and out while the new value rises in
   *  when it just changed (a flip-board feel). Uses the caller's font + fillStyle.
   *  `fontH` is the cap height, used to size the clip box and the roll distance. */
  private drawRoll(ctx: CanvasRenderingContext2D, x: number, y: number, key: string, text: string, fontH: number, r: Room) {
    const an = r.numAnim[key];
    if (!an || an.to !== text) { ctx.fillText(text, x, y); return; }
    const e = an.t * an.t * (3 - 2 * an.t);
    const h = fontH * 1.2;
    const w = Math.max(ctx.measureText(an.from).width, ctx.measureText(text).width) + 2;
    const a0 = ctx.globalAlpha;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 1, y - fontH, w + 2, fontH + 2.5);
    ctx.clip();
    ctx.globalAlpha = a0 * (1 - e);
    ctx.fillText(an.from, x, y - e * h); // old rolls up and out
    ctx.globalAlpha = a0 * e;
    ctx.fillText(text, x, y + (1 - e) * h); // new rises into place
    ctx.restore();
    ctx.globalAlpha = a0;
  }

  /** A small spinning arc, e.g. while the first GitHub PR lookup is in flight. */
  private drawSpinner(ctx: CanvasRenderingContext2D, cx: number, cy: number, rad: number, color: string) {
    const a0 = (this.frame * 0.35) % (Math.PI * 2);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.9;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, rad, a0, a0 + Math.PI * 1.4);
    ctx.stroke();
    ctx.restore();
  }

  /** A "disconnected" glyph: a ringed plug whose prongs are pulled apart, shown
   *  where PR data would be when there is no GitHub token. */
  private drawDisconnected(ctx: CanvasRenderingContext2D, cx: number, cy: number, rad: number, color: string) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.6, rad * 0.16);
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.9;
    // ring
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();
    // a broken connector: two stubs meeting a gap across the ring's middle
    const g = rad * 0.26; // half-gap
    const reach = rad * 0.92;
    ctx.beginPath();
    ctx.moveTo(cx - reach, cy);
    ctx.lineTo(cx - g, cy);
    ctx.moveTo(cx + g, cy);
    ctx.lineTo(cx + reach, cy);
    ctx.stroke();
    // a slash through the gap to read clearly as "no connection"
    ctx.beginPath();
    ctx.moveTo(cx - g * 0.9, cy + g * 1.5);
    ctx.lineTo(cx + g * 0.9, cy - g * 1.5);
    ctx.stroke();
    ctx.restore();
  }

  /** A room chrome button (+ DEV, ✕) drawn to match the HUD glass icon buttons:
   *  a rounded translucent chip with a neutral light border and a colored glyph,
   *  brightening on hover. `sx,sy,sw,sh` are screen-space. */
  private drawRoomButton(
    ctx: CanvasRenderingContext2D,
    sx: number, sy: number, sw: number, sh: number,
    icon: string, color: string, font: string, hovered: boolean
  ) {
    const rad = Math.min(sw, sh) * 0.26;
    ctx.beginPath();
    ctx.roundRect(sx, sy, sw, sh, rad);
    ctx.fillStyle = hovered ? "rgba(20,28,33,0.92)" : "rgba(10,15,18,0.72)"; // --glass / --glass-2
    ctx.fill();
    ctx.lineWidth = hovered ? 1.3 : 1;
    ctx.strokeStyle = hovered ? "rgba(255,255,255,0.30)" : "rgba(255,255,255,0.14)"; // --edge
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(icon, sx + sw / 2, sy + sh / 2 + 0.2);
    ctx.textBaseline = "alphabetic";
  }

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
    // " → base" suffix tells you what this branch targets / is based off of
    const baseName = (r.boardShown ?? r.board)?.base || "";
    const suffix = baseName && baseName !== branch ? `→ ${baseName}` : "";
    ctx.font = "4px 'IBM Plex Mono', monospace";
    const suffixW = suffix ? ctx.measureText(suffix).width + 3 : 0;
    ctx.font = "bold 5px 'Martian Mono', monospace";
    ctx.fillStyle = r.isMain ? "hsl(150 60% 80%)" : `hsl(${r.hue} 65% 82%)`;
    let bt = `⌥ ${branch}`;
    while (ctx.measureText(bt).width > b.w - 12 - suffixW && bt.length > 6) bt = bt.slice(0, -2);
    if (bt !== `⌥ ${branch}`) bt += "…";
    ctx.fillText(bt, b.x + pad, b.y + 7);
    if (suffix) {
      const branchW = ctx.measureText(bt).width;
      ctx.font = "bold 4px 'IBM Plex Mono', monospace";
      ctx.fillStyle = "rgba(205,220,232,0.95)";
      ctx.fillText(suffix, b.x + pad + branchW + 3, b.y + 7);
    }
    ctx.fillStyle = glow > 0.02 ? `rgba(62,224,137,${0.35 + glow * 0.65})` : "rgba(90,100,108,0.5)";
    ctx.fillRect(b.x + b.w - pad - 3, b.y + 3, 3, 3);
    // header divider
    ctx.fillStyle = "rgba(120,150,170,0.18)";
    ctx.fillRect(b.x + pad, b.y + 9.5, b.w - pad * 2, 0.8);
    ctx.restore();

    const bd = r.boardShown ?? r.board;
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
    const bodyTop = b.y + 12;
    const bodyBot = b.y + b.h - 2;
    const innerL = b.x + pad;
    const innerR = b.x + b.w - pad;
    const prW = Math.min(96, (innerR - innerL) * 0.42); // wider PR cell for review detail
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
    // flash a single column when its value just changed (set in applyBoardSnapshot)
    const cellGlow = (x: number, w: number, pulse: number) => {
      if (pulse <= 0.02) return;
      const a = Math.min(1, pulse);
      ctx.fillStyle = `rgba(62,224,137,${0.14 * a})`;
      ctx.fillRect(x, bodyTop - 2, w, bodyBot - bodyTop + 4);
      ctx.strokeStyle = `rgba(62,224,137,${0.9 * a})`;
      ctx.lineWidth = 0.8;
      ctx.strokeRect(x + 0.4, bodyTop - 1.6, w - 0.8, bodyBot - bodyTop + 3.2);
    };
    const cp = r.cellPulse;

    ctx.save();
    ctx.textBaseline = "alphabetic";

    /* ---- left: three git cells ---- */
    const cells = [
      { label: "UNSTAGED", count: `${bd.modified} file${bd.modified === 1 ? "" : "s"}`, add: bd.unstagedAdd, del: bd.unstagedDel, tint: "#ffb13d" },
      { label: "STAGED", count: `${bd.staged} file${bd.staged === 1 ? "" : "s"}`, add: bd.stagedAdd, del: bd.stagedDel, tint: "#3ee089" },
      { label: "COMMITS", count: `${bd.ahead}`, add: bd.committedAdd, del: bd.committedDel, tint: "#56c7ff" },
    ];
    const cellKeys = ["unstaged", "staged", "commits"] as const;
    cells.forEach((c, i) => {
      const cx = innerL + i * cw;
      const cwIn = cw - 4; // inner width (leaves a gutter before the divider)
      cellGlow(cx - 1.5, cw - 1, cp[cellKeys[i]]);
      if (i > 0) {
        ctx.fillStyle = "rgba(120,150,170,0.12)";
        ctx.fillRect(cx - 2, bodyTop, 0.7, bodyBot - bodyTop);
      }
      const pfx = ["u", "s", "c"][i];
      ctx.textAlign = "left";
      ctx.font = "3px 'IBM Plex Mono', monospace";
      ctx.fillStyle = TEXT.heading; // readable cell heading (AA, see palette/contrast test)
      ctx.fillText(c.label, cx, bodyTop + 3);
      ctx.font = "bold 5.5px 'Martian Mono', monospace";
      ctx.fillStyle = c.tint;
      this.drawRoll(ctx, cx, bodyTop + 10, `${pfx}.count`, fit(c.count, cwIn), 5.5, r);
      ctx.font = "bold 3.6px 'Martian Mono', monospace";
      const plus = `+${c.add}`;
      ctx.fillStyle = "#3ee089";
      this.drawRoll(ctx, cx, bodyTop + 16, `${pfx}.add`, plus, 3.6, r);
      ctx.fillStyle = "#ff6055";
      this.drawRoll(ctx, cx + ctx.measureText(plus).width + 3, bodyTop + 16, `${pfx}.del`, `-${c.del}`, 3.6, r);
      churnBar(cx, bodyTop + 18.5, cwIn, c.add, c.del);
      // COMMITS cell bottom band: push (↑), pull (↓) and fetch (↻) controls
      if (i === 2) {
        const btns = this.commitButtons(r);
        const sy = bodyBot - 1.5; // shared baseline for the row
        ctx.textAlign = "left";
        // a faint rounded tint behind whichever control the cursor is over
        const hoverTint = (rc: { x: number; y: number; w: number; h: number }, color: string) => {
          ctx.fillStyle = color;
          ctx.fillRect(rc.x - 0.5, rc.y, rc.w + 1, rc.h);
        };
        if (btns.push) {
          const hv = this.hov("push:" + r.name);
          if (hv) hoverTint(btns.push, "rgba(255,177,61,0.22)");
          ctx.fillStyle = hv ? "#ffd9a3" : "#ffb13d"; // up = push local commits upstream
          ctx.font = "bold 4px 'Martian Mono', monospace";
          ctx.fillText(`↑${bd.unpushed}`, btns.push.x + 0.5, sy);
        }
        if (btns.pull) {
          const hv = this.hov("pull:" + r.name);
          if (hv) hoverTint(btns.pull, "rgba(86,199,255,0.22)");
          ctx.fillStyle = hv ? "#a9e2ff" : "#56c7ff"; // down = pull upstream commits
          ctx.font = "bold 4px 'Martian Mono', monospace";
          ctx.fillText(`↓${bd.behind}`, btns.pull.x + 0.5, sy);
        }
        if (btns.synced) {
          ctx.fillStyle = "rgba(120,200,255,0.5)";
          ctx.font = "3px 'IBM Plex Mono', monospace";
          ctx.fillText("synced", cx, sy);
        }
        if (btns.fetch) {
          const hv = this.hov("fetch:" + r.name);
          if (hv) hoverTint(btns.fetch, "rgba(120,200,255,0.22)");
          ctx.fillStyle = hv ? "#cfecff" : "rgba(120,200,255,0.8)"; // refresh = fetch remote refs
          ctx.font = "5px 'Martian Mono', monospace";
          ctx.fillText("↻", btns.fetch.x + 1, sy + 0.4);
        }
      }
    });

    /* ---- right: PR ---- */
    const px = gitR + 4;
    cellGlow(gitR + 2, innerR - gitR - 2, cp.pr);
    ctx.fillStyle = "rgba(120,150,170,0.14)";
    ctx.fillRect(gitR + 1, bodyTop, 0.7, bodyBot - bodyTop);
    let py = bodyTop + 3;
    ctx.textAlign = "left";
    ctx.font = "3px 'IBM Plex Mono', monospace";
    ctx.fillStyle = TEXT.heading; // readable PR-cell heading
    ctx.fillText("PR", px, py);
    const loadingPr = !bd.pr && !bd.prReady; // first GitHub lookup still in flight
    const pr = bd.pr;
    if (pr) {
      if (pr.draft) { // draft badge by the PR label
        ctx.font = "bold 2.8px 'Martian Mono', monospace";
        ctx.fillStyle = "rgba(180,190,198,0.85)";
        ctx.fillText("DRAFT", px + 7, py);
      }
      ctx.font = "bold 6px 'Martian Mono', monospace";
      ctx.fillStyle = pr.draft ? "rgba(180,188,196,0.9)" : "#b98cff";
      ctx.textAlign = "right";
      ctx.fillText(`#${pr.number}`, innerR - 8, py + 0.4); // leave room for the ↗ button
      ctx.textAlign = "left";
      // open-in-GitHub button (↗) at the top-right of the PR cell
      const ob = { x: innerR - 6, y: bodyTop, w: 6, h: 6 };
      const obHov = !!bd.pr?.url && this.hov("openpr:" + bd.pr.url);
      ctx.fillStyle = obHov ? "rgba(127,184,223,0.44)" : "rgba(127,184,223,0.20)"; // accent chip, brighter on hover
      ctx.fillRect(ob.x, ob.y, ob.w, ob.h);
      ctx.fillStyle = obHov ? "#d6ecfb" : "#9fd0f0"; // brighter accent arrow
      ctx.font = "bold 6px 'IBM Plex Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("↗", ob.x + ob.w / 2, ob.y + ob.h - 1.1);
      ctx.textAlign = "left";
    } else if (loadingPr) {
      this.drawSpinner(ctx, innerR - 2.6, py - 1.4, 2.4, "rgba(185,140,255,0.9)");
    } else if (this.githubConnected === false) {
      this.drawDisconnected(ctx, innerR - 2.6, py - 1.4, 2.2, "rgba(255,177,61,0.8)");
    }
    py += 6;
    if (!pr) {
      ctx.font = "3.4px 'IBM Plex Mono', monospace";
      if (loadingPr) {
        ctx.fillStyle = "#c9b0ff"; // brighter, opaque so the tiny label reads
        ctx.fillText("checking…", px, py);
      } else if (this.githubConnected === false) {
        ctx.fillStyle = "#ffb13d"; // amber, AA-contrast (see palette test)
        ctx.fillText("not connected", px, py);
      } else {
        ctx.fillStyle = TEXT.muted;
        ctx.fillText("no open PR", px, py);
      }
    } else {
      // ---- title at the TOP, up to 2 lines (2nd line marquees if it overflows) ----
      ctx.font = "bold 3.4px 'IBM Plex Mono', monospace";
      ctx.fillStyle = "rgba(228,236,240,0.95)";
      const words = pr.title.split(/\s+/).filter(Boolean);
      let l1 = "", wi = 0;
      for (; wi < words.length; wi++) {
        const next = l1 ? `${l1} ${words[wi]}` : words[wi];
        if (ctx.measureText(next).width > prW && l1) break;
        l1 = next;
      }
      const rest = words.slice(wi).join(" ");
      ctx.fillText(l1, px, py);
      py += 4.4;
      if (rest) {
        const rw = ctx.measureText(rest).width;
        if (rw <= prW) {
          ctx.fillText(rest, px, py);
        } else {
          ctx.save();
          ctx.beginPath(); ctx.rect(px, py - 4, prW, 5.5); ctx.clip();
          const gap = 14, period = rw + gap;
          const zoomedIn = this.cam.z > 3; // only animate when it's actually readable
          if (zoomedIn) { this.marqueeOn = true; if (r.marqueeStart === undefined) r.marqueeStart = this.frame; }
          else r.marqueeStart = undefined;
          const scroll = zoomedIn ? ((this.frame - (r.marqueeStart ?? this.frame)) * 0.75) % period : 0;
          ctx.fillText(rest, px - scroll, py);
          ctx.fillText(rest, px - scroll + period, py); // seamless wrap
          ctx.restore();
        }
      }
      py += 4.5;
      // divider between the title and the chart
      ctx.fillStyle = "rgba(120,150,170,0.16)";
      ctx.fillRect(px, py - 2.5, prW, 0.6);
      py += 3.5;
      // ---- chart: checks (✓ pass / ✗ fail / pulsing dot while running) ----
      if (pr.checksTotal > 0) {
        ctx.font = "bold 4px 'Martian Mono', monospace";
        let sx = px;
        if (pr.checksPass > 0) { ctx.fillStyle = "#3ee089"; const t = `${pr.checksPass}✓`; ctx.fillText(t, sx, py); sx += ctx.measureText(t).width + 3; }
        if (pr.checksFailed > 0) { ctx.fillStyle = "#ff6055"; const t = `${pr.checksFailed}✗`; ctx.fillText(t, sx, py); sx += ctx.measureText(t).width + 3; }
        if (pr.checksRunning > 0) {
          const pa = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.frame * 0.35));
          ctx.globalAlpha = pa; ctx.fillStyle = "#ffb13d";
          ctx.beginPath(); ctx.arc(sx + 1.4, py - 1.3, 1.4, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1; ctx.fillStyle = "#ffb13d";
          ctx.fillText(`${pr.checksRunning}`, sx + 3.6, py);
        }
      } else {
        ctx.font = "3px 'IBM Plex Mono', monospace";
        ctx.fillStyle = TEXT.muted;
        ctx.fillText("no checks", px, py);
      }
      py += 5;
      // ---- chart: reviewers compressed onto one line (0 if none) ----
      if (pr.draft && pr.approvals === 0 && pr.changesRequested === 0) {
        ctx.font = "3px 'IBM Plex Mono', monospace";
        ctx.fillStyle = "#ffb13d";
        ctx.fillText("reviewers pending", px, py);
      } else {
        ctx.font = "3px 'IBM Plex Mono', monospace";
        let sx = px;
        const seg = (label: string, n: number, on: string) => {
          ctx.fillStyle = n > 0 ? on : "rgba(150,162,170,0.5)";
          const t = `${n} ${label}`;
          ctx.fillText(t, sx, py);
          sx += ctx.measureText(t).width + 3;
        };
        seg("appr", pr.approvals, "#3ee089");
        seg("chg", pr.changesRequested, "#ff6055");
        seg("req", pr.reviewersPending, "#56c7ff");
        seg("cmt", pr.comments, "rgba(210,218,224,0.85)");
      }
    }
    ctx.restore();
    // (column-level flashes are drawn per cell above via cellGlow; no full-board
    // border pulse anymore, so it's clear which stat changed)
  }

  /** The skills library: a long, low bookshelf that runs the full left wall,
   *  drawn slanted in the wall's one-point perspective just below the window.
   *  A dev walks to it when it uses a skill and carries a book back to its desk
   *  (see the errand state machine in tick + drawDesks' book stack). `onWall`
   *  maps (t: 0 near opening → 1 far wall, f: 0 ceiling → 1 floor) to world xy. */
  private drawBookshelf(
    ctx: CanvasRenderingContext2D,
    r: Room,
    onWall: (t: number, f: number) => { x: number; y: number }
  ) {
    const eFurn = clamp((r.built - 0.6) / 0.4, 0, 1);
    if (eFurn <= 0) return;
    ctx.save();
    ctx.globalAlpha = eFurn;
    const quad = (
      a: { x: number; y: number }, b: { x: number; y: number },
      c: { x: number; y: number }, d: { x: number; y: number }, fill: string
    ) => {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
      ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    };
    // full-wall span, from just below the window's lower edge (f≈0.66) to the
    // floor. The cabinet stands PROUD of the wall: `front` offsets a wall point
    // toward the room (and slightly down) to fake depth, the offset shrinking
    // toward the back wall so it reads in perspective.
    // t0 starts back from the near opening so the front-left corner is clear for
    // the paper shredder (see drawShredder); the cabinet is a touch less wide.
    const t0 = 0.4, t1 = 0.95, fTop = 0.68, fBot = 0.99;
    const front = (t: number, f: number) => {
      const p = onWall(t, f);
      const d = 6 * (1 - t * 0.5); // protrusion: bigger up front, smaller at the back
      return { x: p.x + d, y: p.y + d * 0.5 };
    };
    // left end cap (the cabinet's near side, between the wall and the front face)
    quad(onWall(t0, fTop), front(t0, fTop), front(t0, fBot), onWall(t0, fBot), "#1f1408");
    // top surface: from the wall back-edge out to the front lip — catches light
    quad(onWall(t0, fTop), onWall(t1, fTop), front(t1, fTop), front(t0, fTop), "#6a4d2c");
    quad(front(t0, fTop), front(t1, fTop), front(t1, fTop + 0.02), front(t0, fTop + 0.02), "#3a2917"); // front lip shadow
    // front face (dark recess the books sit in)
    quad(front(t0, fTop + 0.02), front(t1, fTop + 0.02), front(t1, fBot), front(t0, fBot), "#2c1f10");
    // TWO shelves of book spines so each book is a reasonable size (a single tall
    // band read as oversized). onWall compresses the far ones for free perspective.
    const N = 24, hOff = hash(r.name) % BOOK_HUES.length;
    const board = (f: number) =>
      quad(front(t0, f), front(t1, f), front(t1, f + 0.015), front(t0, f + 0.015), "#3a2917");
    const shelfRow = (rowTop: number, rowBot: number, salt: number) => {
      for (let i = 0; i < N; i++) {
        const ta = t0 + (t1 - t0) * (i / N);
        const tb = t0 + (t1 - t0) * ((i + 0.8) / N); // small gap between spines
        const fT = rowTop + (hash(r.name + salt + i) % 4) * 0.006; // slight height variance
        const hue = BOOK_HUES[(i + hOff + salt) % BOOK_HUES.length];
        quad(front(ta, fT), front(tb, fT), front(tb, rowBot), front(ta, rowBot), `hsl(${hue} 42% 42%)`);
        const tHi = ta + (tb - ta) * 0.26; // near-edge spine highlight
        quad(front(ta, fT), front(tHi, fT), front(tHi, rowBot), front(ta, rowBot), `hsl(${hue} 42% 54%)`);
      }
    };
    shelfRow(0.715, 0.80, 1);   // upper shelf
    board(0.805);               // divider board between the two shelves
    shelfRow(0.835, 0.92, 7);   // lower shelf
    // plinth/base rail under the books
    quad(front(t0, 0.93), front(t1, 0.93), front(t1, fBot), front(t0, fBot), "#1a1108");
    ctx.restore();
  }

  /** A floor-standing paper shredder right of the desks. A dev walks here when
   *  its session is /cleared, feeds its stack of context papers in, then returns
   *  to its seat (see the shred state machine in tick + the carried stack in
   *  drawToon). It blinks red and spits confetti strips while a dev is feeding. */
  private drawShredder(ctx: CanvasRenderingContext2D, r: Room) {
    const eFurn = clamp((r.built - 0.6) / 0.4, 0, 1);
    if (eFurn <= 0) return;
    const base = r.baseY;
    const sx = r.x0 + 3; // bin tucked into the front-left corner, left of where the dev stands
    // remaining feed fraction if a dev is shredding into THIS room's bin (0 = idle)
    let feed = 0;
    for (const tn of this.toons.values()) {
      if (tn.shred?.phase === "feed" && this.rooms.get(tn.bkey ?? "") === r) {
        feed = Math.max(feed, clamp(tn.shred.t / SHRED_FEED, 0, 1));
      }
    }
    ctx.save();
    ctx.globalAlpha = eFurn;
    ctx.fillStyle = "rgba(0,0,0,0.3)"; // contact shadow
    ctx.fillRect(sx - 1.5, base - 0.6, 12, 1.6);
    // bin body
    ctx.fillStyle = "#23282e";
    ctx.fillRect(sx, base - 15, 9, 15);
    ctx.fillStyle = "#2e343b"; // lit left face
    ctx.fillRect(sx, base - 15, 2, 15);
    ctx.fillStyle = "#171b20"; // right shadow
    ctx.fillRect(sx + 7, base - 15, 2, 15);
    // window onto the collected shreds
    ctx.fillStyle = "#3a4148";
    ctx.fillRect(sx + 2, base - 11, 5, 8);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? "#cfc9b6" : "#b4ae9b";
      ctx.fillRect(sx + 2.4 + i * 1.1, base - 10.5, 0.7, 7);
    }
    // shredder head (motor unit) on top of the bin, wider than the body
    ctx.fillStyle = "#3a4046";
    ctx.fillRect(sx - 1, base - 19, 11, 4);
    ctx.fillStyle = "#4a5158";
    ctx.fillRect(sx - 1, base - 19, 11, 1); // top highlight
    ctx.fillStyle = "#0f1318"; // intake slot
    ctx.fillRect(sx + 0.5, base - 16.4, 8, 1);
    // status LED: steady green idle, blinking red while shredding
    const blink = this.frame % 6 < 3;
    ctx.fillStyle = feed > 0 ? (blink ? "#ff5a52" : "#5a2522") : "#3ee089";
    ctx.fillRect(sx + 8, base - 18.5, 1.2, 1.2);
    if (feed > 0) {
      // a sheet jutting from the slot, shrinking as it feeds through
      const sheetH = 4 + feed * 5;
      ctx.fillStyle = "#e9e3d2";
      ctx.fillRect(sx + 2.5, base - 16.4 - sheetH, 4, sheetH);
      ctx.fillStyle = "#cfc9b6";
      ctx.fillRect(sx + 2.5, base - 16.4 - sheetH, 4, 0.6);
      // confetti strips spilling out below the head into the bin window
      for (let i = 0; i < 6; i++) {
        const fx = sx + 1.8 + i * 1.05;
        const fy = base - 14.5 + ((this.frame * 0.9 + i * 4) % 10);
        ctx.fillStyle = i % 2 ? "#e9e3d2" : "#d8d2bf";
        ctx.fillRect(fx, fy, 0.7, 1.6);
      }
    }
    ctx.restore();
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
      ctx.fillRect(dx - 0.5, db - 0.6, 23, 1.8);
      // desktop — lighter than the floor, with a top highlight + underside shadow.
      // extended left so the coffee mug sits fully on it, and right to make room
      // for the dev's stack of skill books fetched from the shelf
      ctx.fillStyle = "#7e5e35";
      ctx.fillRect(dx, db - 11, 22, 2);
      ctx.fillStyle = "#9c7a4c";
      ctx.fillRect(dx, db - 11, 22, 0.7); // top highlight
      ctx.fillStyle = "#382a16";
      ctx.fillRect(dx, db - 9.2, 22, 0.7); // shadow line under the top
      ctx.fillStyle = "#54401f";
      ctx.fillRect(dx + 3, db - 9, 1.5, 9);
      ctx.fillRect(dx + 19.5, db - 9, 1.5, 9);
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
        const peak = st === "error" ? 0.3 : st === "active" && this.frame % 8 < 4 ? 0.4 : 0.24;
        const gx = dx + 13, gy = db - 16; // on the seated dev, not the monitor
        const grd = ctx.createRadialGradient(gx, gy, 0, gx, gy, 7);
        grd.addColorStop(0, `rgba(${c},${peak})`);
        grd.addColorStop(0.6, `rgba(${c},${peak * 0.45})`);
        grd.addColorStop(1, `rgba(${c},0)`);
        ctx.fillStyle = grd;
        // clipped tight to the dev, clear of the monitor back to its left
        ctx.fillRect(dx + 10, db - 24, 8, 20);
      }
      // skill books the dev carried back from the shelf, stacked on the desk's
      // right end (one per skill); the trip itself is animated in tick
      const books = tn?.booksShown ?? 0;
      for (let k = 0; k < books; k++) {
        const hue = BOOK_HUES[k % BOOK_HUES.length];
        const jx = (k % 2) * 0.7; // stagger so the pile isn't a rigid column
        const by = db - 11 - k * 1.4; // stack upward from the desktop surface
        ctx.fillStyle = `hsl(${hue} 45% 44%)`;
        ctx.fillRect(dx + 16.6 + jx, by - 1.4, 4, 1.4);
        ctx.fillStyle = `hsl(${hue} 45% 55%)`;
        ctx.fillRect(dx + 16.6 + jx, by - 1.4, 4, 0.4); // top-edge highlight
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawToon(ctx: CanvasRenderingContext2D, tn: Toon) {
    const p = tn.agent.external ? ghostPersona(tn.p) : tn.p;
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
    const facingLeft = sitting; // seated devs face their monitor (to the left)

    ctx.fillStyle = p.pants;
    if (sitting) {
      ctx.fillRect(x - 3, base - 4, 6, 2);
      ctx.fillRect(x - 3.6, base - 3, 1.6, 3.4);
      ctx.fillRect(x + 2, base - 3, 1.6, 3.4);
    } else if (walking) {
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
    if (sitting && tn.agent.reviewOf) {
      // reviewing a PR: hold a magnifier out over a printout on the desk and
      // sweep it slowly back and forth as if scanning the diff
      const sweep = Math.sin(f * 0.12 + tn.ph) * 1.3;
      const mx = x - 6 + sweep, my = ty + 0.6;
      ctx.fillStyle = p.shirt; // forearm reaching to the glass
      ctx.fillRect(x - 5, ty + 2.2, 3, 1.4);
      ctx.fillStyle = "#e9e3d2"; // PR printout on the desk
      ctx.fillRect(x - 9.5, ty + 4, 7, 4.2);
      ctx.fillStyle = "rgba(70,70,70,0.4)"; // a couple of diff lines
      ctx.fillRect(x - 8.7, ty + 5, 5, 0.5);
      ctx.fillRect(x - 8.7, ty + 6.2, 4, 0.5);
      ctx.strokeStyle = "#7a5a2a"; // magnifier handle
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(mx + 1.3, my + 1.3); ctx.lineTo(mx + 2.9, my + 2.9); ctx.stroke();
      ctx.fillStyle = "rgba(159,216,255,0.4)"; // glass
      ctx.beginPath(); ctx.arc(mx, my, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#2a2f35"; // rim
      ctx.beginPath(); ctx.arc(mx, my, 2.1, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = handC; // hand gripping the handle
      ctx.fillRect(mx + 2.4, my + 2.4, 1.5, 1.6);
      ctx.fillStyle = p.shirt; // other hand resting on the desk
      ctx.fillRect(x + 2.6, ty + 2, 1.4, 2.6);
    } else if (sitting && tn.booksInHand > 0) {
      // reading the fetched skill book(s) at the desk: the forearms come up
      // here (below the head, so they stay behind it), but the open book itself
      // is drawn after the head further down so it reads as held up in front of
      // the face rather than tucked behind the skull
      ctx.fillStyle = p.shirt; // forearms up to the book
      ctx.fillRect(x - 2.4, ty + 1.4, 1.8, 1.8);
      ctx.fillRect(x + 2.2, ty + 1.4, 1.8, 1.8);
    } else if (sitting) {
      // typing toward the keyboard/monitor on the left
      const tap = f % 2 === 0 ? 0 : 0.8;
      ctx.fillRect(x - 6, ty + 2.2, 3.4, 1.4);
      ctx.fillStyle = handC;
      ctx.fillRect(x - 7, ty + 2 + tap, 1.4, 1.4);
      ctx.fillRect(x - 7, ty + 3.6 - tap, 1.4, 1.4);
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

    // the open book is drawn after the head so it sits in front of the face
    // (the dev is holding it up to read), not occluded behind the skull; still
    // drawn within drawToon, so the desk/monitor edge occludes only its far corner
    if (sitting && tn.booksInHand > 0 && !tn.agent.reviewOf) {
      const bob = Math.sin(f * 0.16 + tn.ph) * 0.35;
      const bx = x - 3, by = ty - 3.5 + bob, bw = 6, bh = 3.6;
      ctx.fillStyle = "#e9e3d2"; // open pages
      ctx.fillRect(bx, by, bw, bh);
      const hue = BOOK_HUES[tn.booksShown % BOOK_HUES.length];
      ctx.fillStyle = `hsl(${hue} 42% 40%)`; // cover edges
      ctx.fillRect(bx - 0.7, by - 0.4, 0.9, bh + 0.8);
      ctx.fillRect(bx + bw - 0.2, by - 0.4, 0.9, bh + 0.8);
      ctx.fillStyle = "#b6ae98"; // center gutter
      ctx.fillRect(bx + bw / 2 - 0.25, by, 0.5, bh);
      ctx.fillStyle = "rgba(70,70,70,0.45)"; // a few text lines
      ctx.fillRect(bx + 0.8, by + 1.1, 1.8, 0.4);
      ctx.fillRect(bx + 0.8, by + 2.1, 1.5, 0.4);
      ctx.fillRect(bx + bw / 2 + 0.7, by + 1.1, 1.7, 0.4);
      ctx.fillRect(bx + bw / 2 + 0.7, by + 2.1, 1.4, 0.4);
      ctx.fillStyle = handC; // hands gripping the lower corners
      ctx.fillRect(bx - 0.6, by + bh - 0.4, 1.4, 1.4);
      ctx.fillRect(bx + bw - 0.8, by + bh - 0.4, 1.4, 1.4);
    }

    // skill books in the dev's arms on the way back from the shelf (it leaves
    // empty-handed on the "out" leg and carries the new stack home after grabbing)
    if (tn.errand && tn.errand.phase !== "out") {
      const carry = Math.max(0, tn.skills.length - tn.booksShown);
      const dir = tn.targetX >= tn.x ? 1 : -1; // held in the direction of travel
      const bx = x - 2 + (dir > 0 ? 1.4 : -0.4);
      for (let k = 0; k < carry; k++) {
        const hue = BOOK_HUES[(tn.booksShown + k) % BOOK_HUES.length];
        const by = ty + 3 - k * 1.4;
        ctx.fillStyle = `hsl(${hue} 45% 46%)`;
        ctx.fillRect(bx, by - 1.4, 4, 1.4);
        ctx.fillStyle = `hsl(${hue} 45% 56%)`;
        ctx.fillRect(bx, by - 1.4, 4, 0.4);
      }
    }

    // the stack of context papers a dev carries to the shredder on /clear. It
    // leaves the desk with a full stack ("out") that thins as it feeds it in
    // ("feed"); on the way back ("back") its arms are empty.
    if (tn.shred && tn.shred.phase !== "back") {
      const sheets = tn.shred.phase === "feed"
        ? Math.ceil(clamp(tn.shred.t / SHRED_FEED, 0, 1) * 4)
        : 4;
      const bx = x - 4.4; // stack held to the dev's left, toward the shredder bin
      for (let k = 0; k < sheets; k++) {
        const by = ty + 3 - k * 1.2;
        ctx.fillStyle = "#e9e3d2"; // white paper
        ctx.fillRect(bx, by - 1.2, 4, 1.2);
        ctx.fillStyle = "#cfc9b6"; // edge shadow line
        ctx.fillRect(bx, by - 0.3, 4, 0.3);
      }
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
  setReviewPrs(prs: { number: number; repo: string; title: string; branch?: string; url?: string }[]) {
    this._instance?.setReviewPrs(prs);
  },
  setGithubConnected(connected: boolean | null | undefined) {
    this._instance?.setGithubConnected(connected);
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
  onPush(cb: (room: string) => void) {
    this._instance?.onPush(cb);
  },
  onPull(cb: (room: string) => void) {
    this._instance?.onPull(cb);
  },
  onFetch(cb: (room: string) => void) {
    this._instance?.onFetch(cb);
  },
  onCd(cb: (id: string, target: { room?: string; ghost?: { floor: number; col: number } }) => void) {
    this._instance?.onCd(cb);
  },
  onAssignReview(cb: (pr: { number: number; repo: string; title: string; branch?: string; url?: string }) => void) {
    this._instance?.onAssignReview(cb);
  },
  onRefreshPrs(cb: () => void) {
    this._instance?.onRefreshPrs(cb);
  },
  onOpenPr(cb: (url: string) => void) {
    this._instance?.onOpenPr(cb);
  },
  focusReviewBoard() {
    this._instance?.toggleBillboard();
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
  setDebug(on: boolean) {
    this._instance?.setDebug(on);
  },
  onDebug(cb: (event: string, data?: unknown) => void) {
    this._instance?.onDebug(cb);
  },
};
