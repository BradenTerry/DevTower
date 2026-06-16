/* DevTower Crew — pixel office tower renderer (Canvas2D, no WebGL).
 *
 * Tower layout: rooms stack vertically as floors and the building grows upward.
 * Each repo is its own tower; reserving another repo stands a new tower nearby.
 * - Ghost slots on top of each tower (stack the next worktree) and a reserve
 *   slot past the last one: click → pick a directory to reserve for a repo.
 * - Bound rooms show a "+ DEV" button: spawn an agent there (the extension
 *   asks worktree vs project dir).
 *
 * Power model: perf-mode animation tick (smooth 15fps / balanced 10fps /
 * eco 6fps); renders only on ticks or
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
  subagents?: number; // in-flight sub-agents (Task/Agent tool calls not yet returned)
  tasks?: { done: number; total: number }; // Task-tool checklist progress (2+ tasks); drives the desk TV
  contextTokens?: number; // tokens occupying the session's context window (for the token board)
  external?: boolean; // a live session running OUTSIDE DevTower (not one we launched)
  session?: string; // the claude session uuid this dev is currently tied to (debug tie-label)
  launchId?: string; // the terminal's stable --session-id (debug tie-label)
  terminalPid?: number; // PID of the VS Code terminal shell DevTower opened (debug tie-label)
  clearedSession?: string; // session id of the dev's latest /clear; a change sends it to the shredder
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
  if (typeof c !== "string") return "#888888"; // never let a bad color throw in the draw loop
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
    // unsigned shifts (>>>): `hash` fills all 32 bits, so a signed `>>` on a
    // top-bit-set hash goes negative, and `negative % len` is negative — that
    // indexed SKINS/HAIRS/ACCENTS as undefined, which crashed ghostColor() every
    // frame for external sessions and froze the scene.
    skin: SKINS[(h >>> 3) % SKINS.length],
    hair: HAIRS[(h >>> 5) % HAIRS.length],
    acc: (h >>> 7) % 4, // 0 none, 1 glasses, 2 cap, 3 headphones
    accColor: ACCENTS[(h >>> 9) % ACCENTS.length],
  };
}

/* ---- layout constants (art pixels) ---- */
const ROOM_H = 84; // taller walls leave a mid-band for the per-room task board
const SLAB = 8; // concrete between floors
const FLOOR_STEP = ROOM_H + SLAB;
const WB_W = 42; // left inset before the first desk
const DESK_W = 32; // column pitch (desk-to-desk spacing); furniture itself is ~22px, so the rest is gap
const DOOR_W = 18;
// Bookshelf under the left window: a dev walks here to pick up a "skill" book
// (one per skill it uses) and carries it back to stack on its desk.
const SHELF_REACH = 20; // world x (from room left) a dev stands at to fetch a book
// At the shelf the dev steps a little BACK into the room (a render-only lift) so
// it stands clear of the front shredder — otherwise returning a book reads as
// feeding it into the shredder. The lift stays small (far short of the full
// back-row depth, DEPTH_Y) so the dev stands on the floor IN FRONT of the
// bookshelf, to the right, rather than riding up into the spines and reading as
// standing on the shelf itself.
const SHELF_LIFT = 7;
const BOOK_HUES = [4, 28, 48, 140, 200, 262, 320]; // spine colours, cycled per book
// Paper shredder against the left wall, just in front of the bookshelf's near
// end: when a session is /cleared the dev carries its stack of context papers
// here, feeds them in, then walks back.
const SHRED_REACH = 21; // world x (from room left) a dev stands at to shred (just right of the bin)
const SHRED_FEED = 1.6; // seconds spent feeding the stack into the shredder
const SHELF_PLACE = 0.7; // seconds spent slotting returned books back onto the shelf
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

// The lift door is set into the right side wall and follows its perspective
// slant. `sideAt(t)` walks the wall's floor line from the near-right corner
// (t=0) back toward the far-right corner (t=1); the door's jambs and leaf hang
// off it. Shared by the renderer and the walk logic so a dev disappears exactly
// where the wall edge is. `rightEdge` is that occluding edge (the near jamb): a
// dev walking out is clipped here so the wall reads as standing in front of it.
const doorGeom = (x0: number, base: number) => {
  const x = x0;
  const bw = backWall(x, base);
  const sideAt = (t: number) => ({ x: x + ROOM_W + (bw.x1 - (x + ROOM_W)) * t, y: base + (bw.yBot - base) * t });
  const dn = sideAt(0.18), df = sideAt(0.5); // near + far jamb feet
  const pn = sideAt(0.22), pf = sideAt(0.46); // door-leaf inner bounds
  return { dn, df, pn, pf, rightEdge: dn.x };
};
// where a dev stands to walk through the door (just shy of the wall edge)
const doorThreshold = (x0: number) => x0 + ROOM_W + 2;
// the door sill sits up the perspective slant, so a dev walking through steps
// BACK into the room (a render-only lift, like the back row) as it nears the
// door — otherwise its feet hug the near floor and it reads as passing through
// the wall below the door. Ramps in over the last DOOR_APPROACH px.
const DOOR_LIFT = 11;
const DOOR_APPROACH = 40;

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
  doorOpen: number; // 0 shut .. 1 swung open; eased while a dev passes through
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
    merged?: boolean; // PR was merged → board shows a MERGED badge, then clears
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
  // worktree switch: the SAME session changed its checkout (cd into another
  // worktree). The dev relocates between buildings — walk out the old room's
  // door ("out"), ride the car down to the lobby ("down"), cross the ground to
  // the destination building ("cross"), ride up to that worktree's floor ("up"),
  // and walk in to a desk ("in"). If the destination worktree has no building in
  // the project, it leaves the building instead (strolls out of the lobby, gone).
  // `fromKey`/`fromX0` pin the source building so the down-ride and demolish
  // guard survive the source room re-packing or even being torn down behind it.
  transfer?: { toKey: string; fromKey?: string; fromX0: number; phase: "out" | "down" | "cross" | "up" | "in" };
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
  // ("out"), feeds the stack in ("feed"), then carries its skill books on to the
  // shelf ("shelf") and slots them back ("place") before walking to its seat
  // ("back"). `books` is how many it left the desk carrying, drawn in its arms.
  shred?: { phase: "out" | "feed" | "shelf" | "place" | "back"; t: number; books: number };
  // last /clear session id this toon has reacted to. A change (the dev's session
  // was replaced in place, owned or external) kicks off a fresh shred trip; we
  // dedupe on it so a re-render with the same value doesn't replay the walk.
  clearedSession?: string;
  // review verdict animation: when a reviewer's PR decision resolves, `stampAt`
  // records the frame so the APPROVED/CHANGES stamp can "thud" in over ~1s.
  lastVerdict?: string;
  stampAt?: number;
  // desk TV that tracks this session's Task-tool checklist. `tvShow` is the
  // deploy/retract scale (0 hidden, 1 fully raised on its stand); `taskDone` is
  // the last completed-count seen, so a rise kicks `tapAt` — the frame the dev
  // slapped the desk button, which flashes the screen and rolls the count up.
  tvShow: number;
  taskDone?: number;
  tapAt?: number;
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
    ? `${b.pr.number}/${b.pr.checks}/${b.pr.checksPass}/${b.pr.checksFailed}/${b.pr.checksRunning}/${b.pr.checksTotal}/${b.pr.review}/${b.pr.approvals}/${b.pr.changesRequested}/${b.pr.reviewersPending}/${b.pr.draft ? 1 : 0}/${b.pr.merged ? 1 : 0}/${b.pr.title}`
    : "no";
  return [
    b.modified, b.staged, b.ahead, b.unstagedAdd, b.unstagedDel, b.stagedAdd, b.stagedDel,
    b.committedAdd, b.committedDel, b.commits.length, b.base, b.prReady ? 1 : 0, b.missing ? 1 : 0, pr,
    // include push/pull state so a push (unpushed→0) or fetch (behind change)
    // actually repaints the COMMITS cell — without these the sig is unchanged and
    // the displayed board is never refreshed after the action
    b.unpushed, b.behind,
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
  // Sticky desk slots: worktree key -> (agent id -> slot index within its block).
  // A seated dev keeps its slot for life, so when a neighbour leaves the others
  // stay put and only the departed desk vanishes; a new dev fills the lowest free
  // slot (reusing a gap) rather than shoving everyone over.
  private seatSlots = new Map<string, Map<string, number>>();

  private focusRoom_: string | null = null;
  private focusAgentId: string | null = null; // when set, the camera tracks this dev (not the room)
  private focusIsland_: string | null = null; // when set, frame this whole directory (its tower)
  private prBranches = new Set<string>(); // branches (lowercased) with an open PR
  // null = not yet known (startup); false = no GitHub token, show the disconnected
  // placeholder instead of an empty/"nothing awaiting" state
  private githubConnected: boolean | null = null;
  // true while the first GitHub PR poll is still in flight → show a loading
  // spinner instead of "not connected" (which would be premature/misleading)
  private prLoading = false;
  // controls with an in-flight action (a room board's push/pull/fetch). While a
  // key is present that control draws a spinner; it clears when the resulting
  // board update lands, or after a timeout.
  // value = this.frame when the action started (for the min-spin + timeout).
  private busy = new Map<string, number>();
  // key of the canvas control under the cursor, so it can be drawn highlighted
  private hoverKey: string | null = null;
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
  // set while the panel is hidden (stopped, or seen 0-size in the loop). On the
  // next restore the camera snaps straight to its target instead of animating
  // back in from wherever it drifted — so switching tabs and returning is static.
  private restoreSnap = false;
  // The camera only ANIMATES toward its target when the focus/pan/zoom intent
  // changed (you clicked a room, panned, scrolled). When the target moves for any
  // other reason — the container resized, the panel was hidden then shown — the
  // camera SNAPS, so tab-switching never plays a zoom-in. `camTweening` runs an
  // in-progress focus animation to completion; `lastFocusSig` detects intent
  // changes frame-to-frame.
  private camTweening = false;
  private lastFocusSig = "";
  private raf = 0;
  private lastNow = 0;
  private acc = 0;
  private frame = 0;
  private marqueeOn = false; // a PR title marquee is scrolling → keep the loop awake
  private dirty = true;
  private eco = false; // reduced-particle mode (perf "eco")
  private tickMs = 100; // animation tick interval; set by perf mode (100=10fps)
  // HUD overlays (agent panel / PR board) cover the canvas edges; inset the
  // viewport so rooms frame into the visible area and stay clickable.
  // insetL/insetR are the TARGETs; curInsetL/curInsetR are the animated values
  // the projection actually uses, so the panel's shift glides in step with the
  // camera flight instead of snapping the whole scene sideways in one frame.
  private insetL = 0;
  private insetR = 0;
  private curInsetL = 0;
  private curInsetR = 0;

  private selectedId?: string;
  /** building key whose "USE DIR" the user pressed: that room is the one the
   *  Selected Directory view mirrors, so its button reads "SELECTED DIR". */
  private usedDirRoom?: string;
  private onSelectCb: (id: string) => void = () => {};
  /** fired when the user clicks OFF the selected agent (empty space or another
   *  room), so the host can close that agent's stat panel. */
  private onDeselectCb: () => void = () => {};
  /** fired when a room/building is clicked (even an empty one), so the host can
   *  point the Source Control panel at that worktree. room = building key. */
  private onPickRoomCb: (room: string) => void = () => {};
  /** fired by a room's "USE DIR" button: mount that worktree in the Explorer. */
  private onUseDirCb: (room: string) => void = () => {};
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
      // the scene owns this gesture (pan / drag-to-relocate); stop the browser
      // from starting a native selection that would highlight the page instead.
      e.preventDefault();
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
        const clickable = !!(hit.agent || hit.room || hit.ghost || hit.addDev || hit.useDir || hit.removeBtn ||
          hit.removeWtBtn || hit.openPrUrl);
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
  onDeselect(cb: () => void) { this.onDeselectCb = cb; }
  onPickRoom(cb: (room: string) => void) { this.onPickRoomCb = cb; }
  onUseDir(cb: (room: string) => void) { this.onUseDirCb = cb; }
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
    // a fresh board set is the result of the push/pull/fetch we kicked off → stop
    // those spinners (a min-spin guard keeps a too-fast update from flickering)
    this.clearBusy("push:");
    this.clearBusy("pull:");
    this.clearBusy("fetch:");
    this.layout();
  }

  /** Branches that currently have an open PR; shown on each worktree's board. */
  setPrBranches(branches: string[]) {
    this.prBranches = new Set((branches || []).filter(Boolean).map((b) => b.toLowerCase()));
    this.invalidate();
  }

  /** Whether DevTower has a GitHub token. false => draw the disconnected glyph in
   *  the board PR cells; null/true => normal. */
  setGithubConnected(connected: boolean | null | undefined) {
    this.githubConnected = connected === undefined ? null : connected;
    this.invalidate();
  }

  /** Whether the first GitHub PR poll is still running. While true the room PR
   *  cells show a spinner rather than a "not connected" placeholder, so a
   *  present-but-not-yet-loaded token doesn't read as missing. */
  setPrLoading(loading: boolean) {
    this.prLoading = !!loading;
    this.invalidate();
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
        if (seen.has(id) || tn.leaving || tn.entering || tn.transfer || tn.agent.external) continue;
        const key = tn.agent.worktree?.trim();
        // a /clear-restart of an OWNED dev mints another OWNED session in the same
        // DevTower terminal. An EXTERNAL arrival is a different outside session, not
        // this dev continuing — re-keying onto it would drag the owned dev through
        // the shred trip and leave it rendered as a ghost. Match only an owned
        // arrival; leave any external one to enter as its own toon below.
        const pool = key ? arriving.get(key) : undefined;
        const ni = pool ? pool.findIndex((a) => !a.external) : -1;
        if (ni < 0) continue;
        const next = pool!.splice(ni, 1)[0];
        // re-key the toon to the new session, keeping its persona/seat/position so
        // it reads as the SAME dev continuing after wiping its context.
        this.dbg("shred.swap", { from: id, to: next.id, worktree: key, wasExternal: !!tn.agent.external, nowExternal: !!next.external });
        this.toons.delete(id);
        tn.agent = next;
        // carry the old context's papers to the shredder AND return its skill books
        // to the shelf — but ONLY the books whose skill the fresh session no longer
        // carries. A skill that persists into the new context keeps its book on the
        // desk (shown statically); returning then instantly re-fetching it would be
        // a pointless round trip (e.g. /clear while a skill marker still lingers).
        const newSkills = [...(next.skills ?? [])];
        const kept = tn.skills.filter((s) => newSkills.includes(s)).length;
        tn.shred = { phase: "out", t: 0, books: Math.max(0, tn.booksShown + tn.booksInHand - kept) };
        tn.errand = undefined;
        tn.skills = newSkills;
        tn.booksShown = newSkills.length;
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
          // seed with the dev's current /clear id so a clear that happened BEFORE
          // it appeared isn't replayed as a shred trip on first sight — only a
          // change while the toon is on screen animates.
          clearedSession: a.clearedSession,
          tvShow: 0,
          taskDone: a.tasks?.done,
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
      // /clear in place (owned OR external): discovery bumps clearedSession when a
      // dev's session is replaced. On a change, send the SAME dev on its shredder
      // trip — carry the context papers over, feed them in, walk back to its seat.
      const nextClear = a.clearedSession;
      if (nextClear && tn.clearedSession !== nextClear && !tn.entering && !tn.leaving && !tn.shred && !tn.transfer) {
        // carry the context papers to the shredder AND return the skill books to the
        // shelf — but ONLY books whose skill the fresh context no longer carries. A
        // skill that survives the /clear keeps its book on the desk (shown
        // statically); returning then instantly re-fetching it would be a pointless
        // round trip (e.g. /clear while a skill marker still lingers in the tail).
        const newSkills = [...(a.skills ?? [])];
        const kept = tn.skills.filter((s) => newSkills.includes(s)).length;
        tn.shred = { phase: "out", t: 0, books: Math.max(0, tn.booksShown + tn.booksInHand - kept) };
        tn.errand = undefined;
        tn.skills = newSkills;
        tn.booksShown = newSkills.length;
        tn.booksInHand = 0;
        this.invalidate(); // wake the loop so the walk plays now, not at the next event
      }
      tn.clearedSession = nextClear;
      // a task ticking over to completed: the dev slaps the desk button to bump
      // its TV. Seed taskDone on first sight so a pre-existing count never replays.
      const nextDone = a.tasks?.done ?? 0;
      if (tn.taskDone !== undefined && nextDone > tn.taskDone) {
        tn.tapAt = this.frame;
        this.invalidate(); // wake the loop so the tap + count roll play now
      }
      tn.taskDone = nextDone;
      // a worktree switch: the SAME session cd'd into another checkout. Relocate
      // the dev rather than letting layout teleport it — out the old door, down
      // to the lobby, across to the destination building and up to that
      // worktree's floor (the tick driver resolves whether a building exists and,
      // if not, walks it out of the building). Only once it's actually placed and
      // not already mid-trip.
      const prevTree = tn.agent.worktree?.trim();
      const nextTree = a.worktree?.trim();
      if (prevTree && nextTree && prevTree !== nextTree && tn.x !== 0 &&
          !tn.transfer && !tn.leaving && !tn.entering) {
        this.dbg("toon.transfer", { id: a.id, from: prevTree, to: nextTree });
        tn.transfer = { toKey: nextTree, fromKey: tn.bkey, fromX0: tn.x0, phase: "out" };
        tn.errand = undefined;
        tn.shred = undefined;
        tn.riding = false;
        tn.sitting = false;
        this.invalidate(); // wake the loop so the relocation plays now
      }
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
    // NB: stale slot maps are pruned once per layout in layout() against ALL
    // rooms' worktrees — never here. seatPlan runs per-room, so pruning against
    // this single room's `byTree` would delete every OTHER room's slot map,
    // wiping their sticky seats and reshuffling devs whenever any dev joins/leaves.
    const seats = new Map<string, { col: number; row: number }>();
    const groups: DeskGroup[] = [];
    let startCol = 0;
    let mainTaken = false; // at most one block is the "main" worktree
    for (const [key, ags] of entries) {
      // Each dev holds a sticky slot index within its worktree block. Keep the
      // slots of devs still present, release a departed dev's slot, and hand any
      // brand-new dev the lowest free slot — so a leaver's desk just disappears
      // and the rest stay seated instead of all sliding left.
      let slots = this.seatSlots.get(key);
      if (!slots) { slots = new Map(); this.seatSlots.set(key, slots); }
      const present = new Set(ags.map((a) => a.id));
      for (const id of [...slots.keys()]) if (!present.has(id)) slots.delete(id);
      const taken = new Set(slots.values());
      let maxSlot = -1;
      for (const a of ags) {
        let i = slots.get(a.id);
        if (i === undefined) {
          i = 0;
          while (taken.has(i)) i++;
          slots.set(a.id, i);
          taken.add(i);
        }
        maxSlot = Math.max(maxSlot, i);
        // fill the front line left-to-right first, then wrap to the back row;
        // the last row absorbs any overflow beyond the available rows
        let row = Math.floor(i / FRONT_CAP);
        let col = i % FRONT_CAP;
        if (row > ROWS_OF_DESKS - 1) { row = ROWS_OF_DESKS - 1; col = i - row * FRONT_CAP; }
        seats.set(a.id, { col: startCol + col, row });
      }
      // reserve the block's width up to the furthest occupied slot so the gap a
      // departed dev left stays empty instead of collapsing the neighbours in
      const cols = Math.max(1, Math.min(maxSlot + 1, FRONT_CAP));
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
    // active devs work at the keyboard; idle/complete devs stay in the chair too
    // (they recline back, see drawToon). Only waiting/error devs stand back.
    const s = tn.agent.state;
    if (s === "active" || s === "idle" || s === "complete") tn.targetX = deskX + 13;
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
    // Sort agents within each worktree by ID so desk assignment stays consistent
    // even if the order they appear in this.agents changes (e.g., when a worktree
    // is added or removed).
    for (const agents of agentsByKey.values()) {
      agents.sort((a, b) => a.id.localeCompare(b.id));
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
          agents: [], decor: hash(key + "decor"), doorOpen: 0,
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
    this.bounds = { minX, maxX, topY, botY, minFloor };

    // 7. seat plan + cache each toon's seat; tick re-glues world coords so devs
    //    follow their building as the island collapses.
    const placed = new Set<string>();
    // forget sticky slot maps for worktrees that no longer host any agent. Done
    // once here against EVERY live worktree (seatPlan runs per-room and must not
    // prune the global map against one room's worktrees — that wiped the others).
    const liveTreeKeys = new Set<string>();
    for (const a of this.agents) if (a.worktree && a.worktree.trim()) liveTreeKeys.add(a.worktree);
    for (const k of [...this.seatSlots.keys()]) if (!liveTreeKeys.has(k)) this.seatSlots.delete(k);
    for (const room of this.rooms.values()) {
      room.plan = this.seatPlan(room.agents);
      room.agents.forEach((a, di) => {
        const tn = this.toons.get(a.id);
        if (!tn) return;
        placed.add(a.id);
        // a relocating dev owns its own position/bkey through the trip; don't
        // snap it to the destination desk until the transfer driver hands back.
        if (tn.transfer) return;
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
            tn.lift = DOOR_LIFT; // emerge already at the door's depth (no upward pop)
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
      // a relocating dev legitimately has no room while it crosses the lobby
      // (its destination worktree may not even have a building) — the transfer
      // driver owns its lifecycle, so never cull it here.
      if (!placed.has(id) && !tn.transfer) {
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

  /** Pull back from a tight dev zoom to an overview of the room that dev is in.
   *  Used when the agent's stat panel is closed (its ✕ / Esc): instead of leaving
   *  the camera pinned on the dev, frame their room. No-op (returns false) when
   *  we aren't currently zoomed onto an agent, so other close paths are untouched.
   *  Also a no-op if the user has since panned or zoomed the camera themselves
   *  (focusAgent resets pan/zoom to 0/1, so any nonzero value means they moved):
   *  if they've wandered off, snapping them back to the room would be jarring. */
  zoomOutToAgentRoom() {
    const id = this.focusAgentId;
    if (!id) return false;
    const moved =
      Math.abs(this.panX) > 0.5 || Math.abs(this.panY) > 0.5 || Math.abs(this.zoomMul - 1) > 0.01;
    if (moved) return false;
    const tn = this.toons.get(id);
    const room = tn?.bkey ? this.rooms.get(tn.bkey) : undefined;
    if (room) this.focusOn(room.name);
    else this.clearFocus();
    return true;
  }

  clearFocus(resetZoom = true, preservePan = false) {
    this.focusRoom_ = null;
    this.focusAgentId = null;
    this.focusIsland_ = null;
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

  /** Mark which room's worktree is mounted in the Selected Directory view, so
   *  that room's button reads "SELECTED DIR" instead of "USE DIR". */
  setUsedDir(room: string | undefined) {
    if (this.usedDirRoom === room) return;
    this.usedDirRoom = room;
    this.invalidate();
  }

  setSelected(id: string | undefined) {
    this.selectedId = id;
    // a freshly spawned dev you selected: frame their whole ROOM rather than
    // tight-zooming the desk, so the walk from the elevator to the desk stays
    // on-screen instead of happening off-camera. The selection arrow and the
    // dev's stats are driven by selectedId, so they show either way.
    if (id && this.newToonIds.has(id)) {
      const tn = this.toons.get(id);
      const room = tn?.bkey ? this.rooms.get(tn.bkey) : undefined;
      // Only consume the "new dev" flag once we can actually frame it. If the
      // toon isn't placed yet — culled mid-spawn because its worktree room
      // hasn't landed this poll, or briefly unplaced by a re-layout — deleting
      // the flag here would strand the camera on the previously-selected dev:
      // focusAgent() no-ops with no toon, and a toon that later resumes from the
      // parked cache is never re-flagged. Keep the flag so a later poll (once the
      // room lands) frames the room instead.
      if (room) { this.newToonIds.delete(id); this.focusOn(room.name); }
      else if (tn) { this.newToonIds.delete(id); this.focusAgent(id); }
    }
    this.invalidate();
  }
  /** Apply a performance mode: sets the animation tick rate and whether the
   *  cheap particle effects are suppressed. "smooth" 15fps, "balanced" 10fps
   *  (full effects), "eco" 6fps (reduced particles). */
  setPerf(mode: string) {
    this.tickMs = mode === "smooth" ? 66 : mode === "eco" ? 166 : 100;
    this.eco = mode === "eco";
    this.invalidate();
  }
  /** Back-compat for the old boolean toggle. */
  setEco(on: boolean) {
    this.setPerf(on ? "eco" : "balanced");
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    // panel hidden (switched to another editor tab) reports a 0-size container.
    // Bail so we don't shrink the canvas to 1px or let targetZoom() collapse to
    // the min zoom — that's what made the camera jump to the overview and then
    // re-animate in when you came back.
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.invalidate();
  }

  private targetZoom(): number {
    // Fit against the FINAL inset, not the animating one. While the panel is
    // sliding closed (clicking off a dev), curInset is still wide for a few
    // frames, which would make the fit zoom out too far and then glide back in
    // as the inset shrinks - a visible zoom-out-then-in. The horizontal centring
    // (cx in draw) keeps using curInset so the view still slides in step.
    const cw = Math.max(80, (this.container.clientWidth || 1) - this.insetL - this.insetR);
    const ch = this.container.clientHeight || 1;
    const fitW = (cw * 0.9) / this.focus.spanW;
    const fitH = (ch * 0.86) / this.focus.spanH;
    return clamp(Math.min(fitW, fitH) * this.zoomMul, 0.7, 14);
  }

  /** Screen-space rects for a room's top-row HUD controls (✕, + DEV, USE DIR).
   *  The controls live in WORLD space: every size (and the font, see the render
   *  pass) scales with the live zoom (cam.z), so the chips keep a constant
   *  proportion to the room's console at every zoom — zoom in close and they grow
   *  with it instead of staying a fixed pixel size and looking tiny against the
   *  enlarged console. Box and font scale by the same factor so the text always
   *  fills the chip. Shared by the hit-test (pick) and the renderer so they never
   *  diverge. */
  private topRects(r: Room): {
    close: { x: number; y: number; w: number; h: number };
    dev: { x: number; y: number; w: number; h: number };
    useDir: { x: number; y: number; w: number; h: number; selected: boolean };
  } {
    const s = this.cam.z;
    const selected = !!this.usedDirRoom && r.name === this.usedDirRoom;
    // The cluster sits in the band to the RIGHT of the rightmost ceiling lamp,
    // above the board (TV), inside the room — never touching the lamp, the TV or
    // the right wall. Lamps hang at ROOM_W*(i+1)/4, so the last one is at 3/4 W;
    // the band runs from just past it to a small inset off the right wall, and
    // the three chips share that band. All world units (× s), so the whole thing
    // scales with zoom and keeps its proportion to the room.
    const lampRight = (ROOM_W * 3) / 4 + 6; // last lamp centre + half + a gap
    const edge = ROOM_W - 6; // inset from the right wall
    const band = edge - lampRight; // available world width
    const gapW = band * 0.045;
    const inner = band - gapW * 2;
    const closeW = inner * 0.15 * s, devW = inner * 0.37 * s, useW = inner * 0.48 * s;
    const hW = 9, gap = gapW * s, h = hW * s;
    // board top = backWall.yTop + 3 = baseY - ROOM_H + 13; lift the chip + a gap
    const top = r.baseY - ROOM_H + 13 - 4 - hW;
    const a = this.screenOf(r.x0 + lampRight, top); // band's top-left, in screen
    const useX = a.x;
    const devX = useX + useW + gap;
    const closeX = devX + devW + gap;
    return {
      useDir: { x: useX, y: a.y, w: useW, h, selected },
      dev: { x: devX, y: a.y, w: devW, h },
      close: { x: closeX, y: a.y, w: closeW, h },
    };
  }

  /** Screen-space point-in-rect test (mx,my are already in screen px). */
  private hit(mx: number, my: number, b: { x: number; y: number; w: number; h: number }): boolean {
    return mx > b.x && mx < b.x + b.w && my > b.y && my < b.y + b.h;
  }

  /* ============ LOOP ============ */

  start() {
    if (this.running) return;
    this.running = true;
    this.lastNow = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      // panel hidden / mid-resize → 0-size container. Don't tick or move the
      // camera (targetZoom would collapse to the min and drag the view out);
      // just hold and re-check next frame (RAF is paused while hidden anyway).
      if (!this.container.clientWidth || !this.container.clientHeight) {
        this.restoreSnap = true; // snap to target once a real size returns
        this.lastNow = now;
        this.raf = requestAnimationFrame(loop);
        return;
      }
      // first frame back from hidden: jump the camera to where it should be so it
      // doesn't visibly re-zoom into the last spot
      if (this.restoreSnap) { this.restoreSnap = false; this.snapCamera(); }
      const dt = Math.min(250, now - this.lastNow);
      this.lastNow = now;

      const tickMs = this.tickMs;
      this.acc += dt;
      let ticked = false;
      while (this.acc >= tickMs) {
        this.acc -= tickMs;
        this.frame++;
        this.tick(tickMs / 1000);
        ticked = true;
      }

      // Glide the HUD inset toward its target so the panel opening shifts the
      // viewport in step with the camera, not as a separate one-frame snap.
      const insetMoving =
        Math.abs(this.curInsetL - this.insetL) > 0.5 ||
        Math.abs(this.curInsetR - this.insetR) > 0.5;
      if (insetMoving) {
        const ki = Math.min(1, (dt / 1000) * 5);
        this.curInsetL += (this.insetL - this.curInsetL) * ki;
        this.curInsetR += (this.insetR - this.curInsetR) * ki;
      } else {
        this.curInsetL = this.insetL;
        this.curInsetR = this.insetR;
      }
      const tz = this.targetZoom();
      const tx = this.focus.x + this.panX;
      const ty = this.focus.y + this.panY;
      // Did the user's view INTENT change this frame (focus / pan / manual zoom)?
      // If so, start/continue a smooth tween. A target that moved without an
      // intent change can only be a container resize (incl. hide→show), which
      // must NOT animate — otherwise returning to the tab replays a zoom-in.
      const fsig = `${this.focusAgentId}|${this.focusRoom_}|${this.focusIsland_}|${this.zoomMul}|${this.panX.toFixed(1)}|${this.panY.toFixed(1)}`;
      if (fsig !== this.lastFocusSig) { this.lastFocusSig = fsig; this.camTweening = true; }
      const moving =
        insetMoving ||
        Math.abs(this.cam.x - tx) > 0.05 ||
        Math.abs(this.cam.y - ty) > 0.05 ||
        Math.abs(this.cam.z - tz) > 0.01;
      if (moving) {
        if (this.camTweening || insetMoving) {
          const k = Math.min(1, (dt / 1000) * 5); // smooth glide for a real view change
          this.cam.x += (tx - this.cam.x) * k;
          this.cam.y += (ty - this.cam.y) * k;
          this.cam.z += (tz - this.cam.z) * k;
        } else {
          this.cam.x = tx; this.cam.y = ty; this.cam.z = tz; // resize-only → snap, no zoom-in
        }
      } else {
        this.camTweening = false; // arrived → next target move (resize) will snap
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
    this.restoreSnap = true; // re-show should land on the target, not animate in
    cancelAnimationFrame(this.raf);
  }

  /** Jump the camera straight to its current target (no tween). Used when the
   *  panel is restored after being hidden, so the view doesn't re-zoom. */
  private snapCamera() {
    this.curInsetL = this.insetL;
    this.curInsetR = this.insetR;
    this.cam.x = this.focus.x + this.panX;
    this.cam.y = this.focus.y + this.panY;
    this.cam.z = this.targetZoom();
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

  /** Mark a control as performing an action (it will draw a spinner). */
  private setBusy(key: string) {
    this.busy.set(key, this.frame);
    this.invalidate();
  }

  /** Clear busy controls whose key starts with `prefix`, once they have spun for
   *  at least `minFrames` (so a near-instant update still shows a brief spin and
   *  an unrelated refresh that lands in the same frame doesn't cancel it). */
  private clearBusy(prefix: string, minFrames = 2) {
    let changed = false;
    for (const [k, started] of this.busy) {
      if (k.startsWith(prefix) && this.frame - started >= minFrames) { this.busy.delete(k); changed = true; }
    }
    if (changed) this.invalidate();
  }

  /** True when nothing needs animating, so the loop can park until woken. */
  private sceneIdle(): boolean {
    if (this.particles.length || this.leaving.length || this.packets.length) return false;
    if (this.marqueeOn) return false; // a PR title is scrolling
    if (this.prLoading || this.busy.size) return false; // a spinner is turning
    for (const r of this.rooms.values()) {
      if (r.dying || r.delay > 0 || r.built < 1 || r.statPulse > 0.02 || r.swapPending) return false;
      // a board update (e.g. a PR merged/closed from GitHub) that tick() hasn't
      // promoted onto the screen yet: stay awake one more frame so the TV reflects
      // it, instead of parking on the stale board until the next unrelated event
      if (boardSig(r.board) !== r.statSig) return false;
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
      // a shredder (/clear) or shelf (skill) trip is a multi-frame walk; keep the
      // loop alive through it even though the dev's state is idle and it hasn't
      // started moving yet (tick sets its targetX on the next frame).
      if (tn.shred || tn.errand || tn.transfer) return false;
      // the desk TV mid-deploy, or a just-pressed completion button, both animate
      if (tn.tvShow > 0.02 && tn.tvShow < 0.98) return false;
      if (tn.tapAt !== undefined && this.frame - tn.tapAt < 8) return false;
      const s = tn.agent.state;
      if (s === "active" || s === "waiting") return false;
      // a no-longer-working dev still holding fetched books hasn't run its
      // put-down yet; keep the loop alive one more tick so it sets them on the
      // desk, otherwise the loop can park before tick() fires and strand the read
      if (tn.booksInHand > 0) return false;
    }
    return true;
  }

  /* ============ TICK ============ */

  private tick(dt: number) {
    // fallback: stop a spinner that never got an update (action failed, was a
    // no-op, or its refresh was throttled) so it can't spin forever (~12s).
    if (this.busy.size) {
      for (const [k, started] of this.busy) if (this.frame - started > 120) this.busy.delete(k);
    }
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
        // wait until the departing dev has fully left, then deconstruct — count
        // both walk-outs and a dev still relocating out of this building
        const hasLeaver = this.leaving.some((t) => t.bkey === r.name) ||
          [...this.toons.values()].some((t) => t.transfer && t.transfer.fromKey === r.name &&
            (t.transfer.phase === "out" || t.transfer.phase === "down"));
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
      p.t += dt * 0.825; // travel speed along the cable (1.5x); still slow enough to follow
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
      if (tn.leaving || tn.entering || tn.transfer) continue;
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
      // the /clear trip overrides the desk aim: first toward the shredder (out/feed),
      // then on to the shelf to return the books (shelf/place), then back to the seat
      if (tn.shred) {
        if (tn.shred.phase === "out" || tn.shred.phase === "feed") tn.targetX = room.x0 + SHRED_REACH;
        else if (tn.shred.phase === "shelf" || tn.shred.phase === "place") tn.targetX = room.x0 + SHELF_REACH;
      }
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
        tn.lift = DOOR_LIFT; // step out at the door's depth (no upward pop)
        this.retargetToon(tn); // step out of the car and cross to the desk
      }
    }

    const all: Toon[] = [...this.toons.values(), ...this.leaving];
    for (const tn of all) {
      if (tn.entering && tn.enterPhase === "elevator") continue; // handled above
      // a relocating dev riding a car (down its old shaft, or up its new one) is
      // moved vertically by the transfer driver, not walked horizontally here.
      if (tn.transfer && (tn.transfer.phase === "down" || tn.transfer.phase === "up")) continue;
      const dx = tn.targetX - tn.x;
      if (Math.abs(dx) > 1) tn.x += Math.sign(dx) * Math.min(Math.abs(dx), WALK_SPEED * dt);
      else if (tn.entering) tn.entering = false;
      const seatable = tn.agent.state === "active" || tn.agent.state === "idle" || tn.agent.state === "complete";
      tn.sitting = seatable && !tn.entering && !tn.leaving && !tn.errand && !tn.shred && !tn.transfer && Math.abs(dx) <= 1;
      // settle up into the back row once parked at the desk; drop to the aisle
      // (lift -> 0) whenever walking, entering, or leaving. A dev AT the bookshelf
      // (fetching a book, or returning one on /clear) steps back to SHELF_LIFT so it
      // reads as standing at the shelf on the back-left wall, clear of the front
      // shredder — but the /clear papers leg keeps it forward at the shredder.
      const atShelf =
        (!!tn.errand && tn.errand.phase !== "back") ||
        (!!tn.shred && (tn.shred.phase === "shelf" || tn.shred.phase === "place"));
      // a relocating dev only settles into its back-row seat once it has walked
      // in to the destination desk ("in" phase); through every other phase it
      // stays down in the aisle.
      const transferSeating = !!tn.transfer && tn.transfer.phase === "in";
      const atDesk = Math.abs(dx) <= 1 && !tn.entering && !tn.leaving && !tn.errand && !tn.shred &&
        (!tn.transfer || transferSeating);
      // a dev walking through the lift door steps back to the door's depth so it
      // lines up with the raised sill instead of clipping the wall below it. The
      // relocating dev does the same as it steps out the old door ("out") and in
      // the new one ("in"); while it crosses the open lobby it walks at ground.
      const thruDoor =
        ((tn.leaving && tn.leavePhase === "walk") ||
          (tn.entering && tn.enterPhase === "walk") ||
          (tn.transfer && (tn.transfer.phase === "out" || tn.transfer.phase === "in"))) && !tn.riding;
      let targetLift = atDesk ? tn.row * ROW_DY : atShelf ? SHELF_LIFT : 0;
      if (thruDoor) {
        const dist = tn.x0 + ROOM_W - tn.x; // px left of the near corner
        targetLift = Math.max(targetLift, clamp(1 - dist / DOOR_APPROACH, 0, 1) * DOOR_LIFT);
      }
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
    // advance the /clear trip: arrive at the shredder → feed the papers in → carry
    // the books on to the shelf → slot them back → walk to the desk empty-handed.
    // A dev with no books to return skips straight from feeding to heading back.
    for (const tn of this.toons.values()) {
      const sh = tn.shred;
      if (!sh) continue;
      const arrived = Math.abs(tn.targetX - tn.x) <= 1;
      if (sh.phase === "out") {
        if (arrived) { sh.phase = "feed"; sh.t = SHRED_FEED; }
      } else if (sh.phase === "feed") {
        sh.t -= dt;
        if (sh.t <= 0) sh.phase = sh.books > 0 ? "shelf" : "back";
      } else if (sh.phase === "shelf") {
        if (arrived) { sh.phase = "place"; sh.t = SHELF_PLACE; }
      } else if (sh.phase === "place") {
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
    // raise/retract each dev's desk TV: it rises on its stand once the dev is
    // seated and the session has a 2+ task list, and folds back down when the
    // list goes away or the dev leaves the desk (errand/shred/walk).
    for (const tn of this.toons.values()) {
      const tv = tn.agent.tasks;
      const want = !!tv && tv.total >= 2 && tn.sitting && !tn.errand && !tn.shred ? 1 : 0;
      tn.tvShow += (want - tn.tvShow) * Math.min(1, dt * 8);
      if (Math.abs(want - tn.tvShow) < 0.01) tn.tvShow = want;
    }
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const tn = this.leaving[i];
      if (!tn.leavePhase) {
        tn.riding = false; // clear any stale entry-ride state
        // every dev exits through the lift door on its own right wall: walk to
        // the threshold (the wall clips it as it steps through), then ride down
        // (upper floors) or vanish into the ground lobby.
        tn.targetX = doorThreshold(tn.x0);
        tn.leavePhase = "walk";
      }
      const atDoor = tn.x >= tn.x0 + ROOM_W - 0.5; // fully behind the wall edge
      if (tn.leavePhase === "walk" && atDoor) {
        if (Math.abs(tn.base) > 1) {
          // upper floor: now hidden behind the wall → step into the car, ride down
          tn.leavePhase = "elevator";
          tn.riding = true;
          tn.x = shaftX(tn.x0);
          tn.targetX = tn.x;
        } else {
          this.leaving.splice(i, 1); // ground floor: through the door, out of the building
        }
      } else if (tn.leavePhase === "elevator") {
        tn.x = shaftX(tn.x0);
        tn.targetX = tn.x;
        const step = Math.min(Math.abs(tn.base), CAR_SPEED * dt);
        tn.base += Math.sign(-tn.base) * step; // descend toward the ground
        if (Math.abs(tn.base) <= 0.5) {
          tn.base = 0;
          tn.riding = false;
          this.leaving.splice(i, 1); // alighted at the ground lobby — gone
        }
      }
    }

    // drive each relocating dev's trip between buildings. The generic walk loop
    // above moves it horizontally (and lifts it through doors); here we steer the
    // target, ride the cars vertically, and advance the phase as it arrives.
    const transferGone: string[] = [];
    for (const tn of this.toons.values()) {
      const tr = tn.transfer;
      if (!tr) continue;
      if (tr.phase === "out") {
        // walk to the old room's lift door, then ride down (upper floor) or step
        // straight out into the lobby (ground floor)
        tn.x0 = tr.fromX0;
        tn.riding = false;
        tn.targetX = doorThreshold(tr.fromX0);
        if (tn.x >= tr.fromX0 + ROOM_W - 0.5) {
          if (Math.abs(tn.base) > 1) {
            tr.phase = "down";
            tn.riding = true;
            tn.x = shaftX(tr.fromX0);
            tn.targetX = tn.x;
          } else {
            tr.phase = "cross";
          }
        }
      } else if (tr.phase === "down") {
        tn.x0 = tr.fromX0;
        tn.x = shaftX(tr.fromX0);
        tn.targetX = tn.x;
        tn.riding = true;
        tn.base += Math.sign(-tn.base) * Math.min(Math.abs(tn.base), CAR_SPEED * dt);
        if (Math.abs(tn.base) <= 0.5) {
          tn.base = 0;
          tn.riding = false;
          tr.phase = "cross";
        }
      } else if (tr.phase === "cross") {
        // on the ground now. Resolve the destination (layout has run): a building
        // for this worktree means walk over and ride up; none means the dev has
        // left the project — stroll out of the lobby and vanish.
        tn.base = 0;
        tn.riding = false;
        const dest = this.rooms.get(tr.toKey);
        if (!dest || dest.dying) {
          tn.targetX = tr.fromX0 + ROOM_W + 90; // out past the old shaft, gone
          if (tn.x >= tr.fromX0 + ROOM_W + 80) transferGone.push(tn.agent.id);
        } else {
          const destShaftX = shaftX(dest.x0);
          tn.targetX = destShaftX;
          if (Math.abs(tn.x - destShaftX) <= 1) {
            tn.x0 = dest.x0;
            tn.bkey = tr.toKey;
            const seat = dest.plan?.seats.get(tn.agent.id) ?? { col: 0, row: 0 };
            tn.row = seat.row;
            tn.seatCol = seat.col;
            if (Math.abs(dest.baseY) > 1) {
              tr.phase = "up";
              tn.riding = true;
              tn.x = destShaftX;
              tn.targetX = tn.x;
            } else {
              tr.phase = "in";
              this.retargetToon(tn); // step in off the lobby and cross to the desk
            }
          }
        }
      } else if (tr.phase === "up") {
        const dest = this.rooms.get(tr.toKey);
        if (!dest || dest.dying) { transferGone.push(tn.agent.id); continue; }
        tn.x0 = dest.x0;
        tn.x = shaftX(dest.x0);
        tn.targetX = tn.x;
        tn.riding = true;
        const dy = dest.baseY - tn.base;
        tn.base += Math.sign(dy) * Math.min(Math.abs(dy), CAR_SPEED * dt);
        if (Math.abs(dest.baseY - tn.base) < 1) {
          tn.base = dest.baseY;
          tn.riding = false;
          tn.lift = DOOR_LIFT; // step out at the door's depth (no upward pop)
          tr.phase = "in";
          this.retargetToon(tn);
        }
      } else if (tr.phase === "in") {
        const dest = this.rooms.get(tr.toKey);
        if (!dest) { transferGone.push(tn.agent.id); continue; }
        tn.bkey = tr.toKey;
        tn.x0 = dest.x0;
        this.retargetToon(tn); // base on this floor + aim at the desk seat
        if (Math.abs(tn.targetX - tn.x) <= 1) tn.transfer = undefined; // arrived — back to normal seating
      }
    }
    for (const id of transferGone) this.toons.delete(id); // left the building

    // swing each room's lift door open while a dev is walking through it (on foot,
    // entering or leaving — not riding the car) and ease it shut once clear.
    const wantOpen = new Set<string>();
    const transiting: Toon[] = [
      ...this.leaving.filter((t) => t.leavePhase === "walk"),
      ...[...this.toons.values()].filter((t) => t.entering && t.enterPhase === "walk" && !t.riding),
      // a relocating dev opens the old room's door on the way out and the new
      // room's door on the way in
      ...[...this.toons.values()].filter((t) => t.transfer && (t.transfer.phase === "out" || t.transfer.phase === "in") && !t.riding),
    ];
    for (const tn of transiting) {
      if (!tn.bkey) continue;
      if (Math.abs(tn.x - (tn.x0 + ROOM_W)) < 38) wantOpen.add(tn.bkey);
    }
    for (const r of this.rooms.values()) {
      const target = wantOpen.has(r.name) ? 1 : 0;
      r.doorOpen += (target - r.doorOpen) * Math.min(1, dt * 9);
      if (Math.abs(target - r.doorOpen) < 0.01) r.doorOpen = target;
    }

    // complete devs no longer throw confetti: they kick back with a coffee
    // (see drawToon), so a cheer burst would read as a contradiction.
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
    const cx = this.curInsetL + (cw - this.curInsetL - this.curInsetR) / 2;
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
    useDir?: string; // building key → point this window's Explorer at the worktree
    removeBtn?: string; // island (nuke)
    removeWtBtn?: string; // building key (worktree path)
    openPrUrl?: string; // ↗ on a room board → open the PR on GitHub
  } {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;

    // building buttons (highest priority). Every room has a + DEV (drop an agent
    // into this room's worktree). The main (root) building's ✕ nukes the whole
    // directory; a worktree building's ✕ removes just that worktree.
    for (const r of this.rooms.values()) {
      if (r.built < 0.95) continue;
      const tr = this.topRects(r);
      if (this.hit(mx, my, tr.close)) {
        return r.isMain ? { removeBtn: r.island } : { removeWtBtn: r.name, island: r.island };
      }
      if (this.hit(mx, my, tr.dev)) {
        return { addDev: { island: r.island, key: r.name } };
      }
      // "USE DIR" / "SELECTED DIR" sits just left of "+ DEV": mount this
      // worktree in the Selected Directory view. The room already mounted shows a
      // disabled "SELECTED DIR" — re-pressing it is a no-op, so it isn't clickable
      // (no pointer, no hover) and falls through the hit-test.
      if (!tr.useDir.selected && this.hit(mx, my, tr.useDir)) {
        return { useDir: r.name };
      }
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
    if (h.openPrUrl) return "openpr:" + h.openPrUrl;
    if (h.addDev) return "addDev:" + h.addDev.key;
    if (h.useDir) return "useDir:" + h.useDir;
    if (h.removeBtn) return "remove:" + h.removeBtn;
    if (h.removeWtBtn) return "remove:" + h.removeWtBtn;
    return null;
  }

  /** Is the given control key the one currently hovered? */
  private hov(key: string): boolean {
    return this.hoverKey === key;
  }

  private onClick(e: PointerEvent) {
    const hit = this.pick(e);
    if (hit.openPrUrl) { this.onOpenPrCb(hit.openPrUrl); }
    else if (hit.removeWtBtn) this.onRemoveWorktreeCb(hit.removeWtBtn, hit.island ?? "");
    else if (hit.removeBtn) this.onRemoveRoomCb(hit.removeBtn);
    else if (hit.addDev) this.onAddDevCb(hit.addDev.island, hit.addDev.key);
    else if (hit.useDir) this.onUseDirCb(hit.useDir);
    else if (hit.ghost) {
      // +island reserves a new directory; +building creates a new worktree room
      if (hit.ghost.kind === "island") this.onReserveCb(hit.ghost.floor, hit.ghost.col);
      else if (hit.ghost.island) this.onAddWorktreeCb(hit.ghost.island);
    } else if (hit.agent) {
      this.onSelectCb(hit.agent);
      this.focusAgent(hit.agent); // zoom onto the dev you clicked
    } else if (hit.room) {
      // clicking a room is clicking OFF any selected agent → close its stat panel
      this.onDeselectCb();
      // mirror this building's worktree into the Source Control panel, even when
      // the room holds no agent
      this.onPickRoomCb(hit.room);
      // from a dev zoom, clicking the building centers it; clicking the already
      // centered building toggles back out
      // already centered on this room → zoom out to an overview of just this
      // directory (its tower), not the whole campus
      if (!this.focusAgentId && this.focusRoom_ === hit.room) this.focusIslandView(hit.island ?? "");
      else this.focusOn(hit.room);
    } else {
      // clicking empty space deselects (closes the agent stat panel) and steps
      // out one focus level: room / dev → its directory overview → whole campus
      this.onDeselectCb();
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
    const cx = this.curInsetL + (cw - this.curInsetL - this.curInsetR) / 2;
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

    // rooms back layer
    for (const r of this.rooms.values()) this.drawRoomBack(ctx, r);

    // network cables run each desk's computer down to the floor and back to the
    // screen; drawn here so the desks + devs (next layer) occlude the near runs
    for (const r of this.rooms.values()) this.drawCables(ctx, r);

    // ghost slots (+building extends an island, +island reserves a directory)
    for (const g of this.ghosts) this.drawGhost(ctx, g);

    // external elevator shafts: a track bolted to the right exterior wall of
    // every tower; the car (below) rides inside it. A ground-only first floor
    // still gets its shaft so it reads as a real building.
    for (const [col, rng] of this.colRange) {
      if (rng.max < 0) continue; // every tower gets a shaft; only skip empty columns
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
        // a dev walking through the lift door (on foot, not riding) is clipped at
        // the wall's near jamb so the wall hides it as it steps through — it
        // disappears INTO the doorway instead of skating across the wall.
        const thru =
          (tn.leaving && tn.leavePhase === "walk") ||
          (tn.entering && tn.enterPhase === "walk" && !tn.riding) ||
          (!!tn.transfer && (tn.transfer.phase === "out" || tn.transfer.phase === "in") && !tn.riding);
        if (ghost || thru) ctx.save();
        if (ghost) ctx.globalAlpha *= 0.62;
        if (thru) {
          const edge = doorGeom(tn.x0, tn.base).rightEdge;
          ctx.beginPath();
          ctx.rect(tn.x0 - ROOM_W, tn.base - ROOM_H - 60, edge - (tn.x0 - ROOM_W), ROOM_H + 80);
          ctx.clip();
        }
        this.drawToon(ctx, tn);
        if (ghost || thru) ctx.restore();
      }
      for (const r of this.rooms.values()) this.drawDesks(ctx, r, row);
    }
    // re-draw an open door's leaf + jamb ON TOP of the crew so a dev passing
    // through reads as behind it — the wall stands in front, not the dev.
    for (const r of this.rooms.values()) {
      if (r.built >= 1 && r.doorOpen > 0.01) this.drawDoor(ctx, r, "overlay");
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
    // font sized to fill each chip: capped by height, and by width / label length
    // (monospace ≈ 0.6em per glyph) so even "SELECTED DIR" fits its box
    const fitPx = (w: number, h: number, len: number) =>
      Math.max(4, Math.min(h * 0.42, (w * 0.68) / (len * 0.6)));
    for (const r of this.rooms.values()) {
      if (r.built < 0.95) continue;
      // top-row controls live in world space: sized and lettered against the
      // live zoom so they keep their proportion to the console (see topRects)
      const tr = this.topRects(r);
      // "+ DEV" on every room — drop an agent into this room's worktree
      const devHov = this.hov("addDev:" + r.name);
      this.drawRoomButton(ctx, tr.dev.x, tr.dev.y, tr.dev.w, tr.dev.h, "+ DEV",
        devHov ? "#aef5cf" : "#3ee089",
        `600 ${fitPx(tr.dev.w, tr.dev.h, 5).toFixed(1)}px 'Martian Mono', monospace`, devHov);
      // "USE DIR" just left of + DEV — mount this room's worktree in the Selected
      // Directory view. The room already mounted reads "SELECTED DIR" (green).
      const useHov = this.hov("useDir:" + r.name);
      const useLabel = tr.useDir.selected ? "SELECTED DIR" : "USE DIR";
      // the mounted room's button is disabled: muted grey text, no hover state
      const useColor = tr.useDir.selected
        ? "#6a7570"
        : (useHov ? "#cfe6ff" : "#5bb8ff");
      this.drawRoomButton(ctx, tr.useDir.x, tr.useDir.y, tr.useDir.w, tr.useDir.h, useLabel,
        useColor, `600 ${fitPx(tr.useDir.w, tr.useDir.h, useLabel.length).toFixed(1)}px 'Martian Mono', monospace`,
        tr.useDir.selected ? false : useHov);
      // ✕ — main nukes the whole directory, a worktree removes just itself
      const xHov = this.hov("remove:" + (r.isMain ? r.island : r.name));
      this.drawRoomButton(ctx, tr.close.x, tr.close.y, tr.close.w, tr.close.h, "✕",
        xHov ? "#ffd2ce" : "#ff6055", `bold ${fitPx(tr.close.w, tr.close.h, 1.4).toFixed(1)}px monospace`, xHov);
    }
    // ghost labels: +building (create a worktree room) vs +island (reserve a dir)
    for (const g of this.ghosts) {
      const s = this.screenOf(g.x0 + ROOM_W / 2, g.base - ROOM_H / 2);
      const building = g.kind === "building";
      ctx.fillStyle = building ? "rgba(190,245,210,0.95)" : "rgba(170,180,186,0.75)";
      ctx.font = `600 ${clamp(3 * this.cam.z, 8, 12)}px 'Martian Mono', monospace`;
      ctx.textAlign = "center";
      ctx.fillText(building ? "+ WORKTREE" : "+ PROJECT", s.x, s.y - 2);
      ctx.font = `${clamp(2.4 * this.cam.z, 7, 10)}px 'IBM Plex Mono', monospace`;
      // subtitle tracks its header: the "+ WORKTREE" green, a touch darker for
      // contrast; "+ PROJECT" keeps the neutral gray under its gray header
      ctx.fillStyle = building ? "rgba(150,200,170,0.9)" : "rgba(140,150,156,0.6)";
      ctx.fillText(building ? "new branch room" : "pick a directory", s.x, s.y + 11);
    }
    // toon labels + bubbles. Names are world-anchored: their font scales with the
    // live zoom (capped at the old 9px) so they shrink with the room when you zoom
    // out and you zoom in to read them. When devs converge on screen — zoomed out,
    // or many in one room — their labels would pile into a colliding mess. So we
    // DECLUTTER:
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
      const nameSize = clamp(3 * this.cam.z, 3, 9);
      const nameFont = `${nameSize}px 'IBM Plex Mono', monospace`;
      ctx.font = nameFont;
      const nw = ctx.measureText(tn.agent.name).width;
      // sub-agent badge sits to the LEFT of the name: [bot][count] gap name.
      // Reserve its width in the label box so the overlap test accounts for it.
      const subN = tn.agent.subagents && tn.agent.subagents > 0 ? tn.agent.subagents : 0;
      let badgeW = 0;
      if (subN) {
        ctx.font = "bold 8px 'IBM Plex Mono', monospace";
        badgeW = 8 /*icon*/ + 1 /*gap*/ + ctx.measureText(String(subN)).width + 3 /*gap to name*/;
        ctx.font = nameFont;
      }
      const box = { x0: s.x - nw / 2 - 2 - badgeW, x1: s.x + nw / 2 + 2, y0: s.y - 18, y1: s.y - 6 };
      if (sel || !nameOverlaps(box)) {
        claimed.push(box);
        const ext = tn.agent.external;
        const nameColor = sel ? "#ffb13d" : ext ? "rgba(150,162,170,0.7)" : "#ffffff";
        ctx.fillStyle = nameColor;
        ctx.fillText(tn.agent.name, s.x, s.y - 8);
        if (subN) this.drawSubagentBadge(s.x - nw / 2 - 3, s.y, subN, nameColor);
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
      if (this.debugOn) {
        // Tie tracker (debugLog only): which claude session this dev is bound to,
        // owned vs external, the launch id when it differs from the live session
        // (a /clear-drifted tie), and the terminal PID — the stable owned tie.
        const a = tn.agent;
        const sid = a.session ? a.session.slice(0, 4) : "----";
        const lid = a.launchId ? a.launchId.slice(0, 4) : null;
        const tag = `${sid}${a.external ? "·ext" : "·own"}${lid && lid !== sid ? "←" + lid : ""}${a.terminalPid ? "·t" + a.terminalPid : ""}`;
        ctx.save();
        ctx.font = "7px 'IBM Plex Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = a.external ? "rgba(150,162,170,0.9)" : "rgba(120,200,255,0.95)";
        ctx.fillText(tag, s.x, s.y + 7);
        ctx.restore();
      }
      const glyph = st === "waiting" ? "?" : st === "complete" ? "✓" : st === "error" ? "✗" : "";
      if (glyph) {
        const wait = st === "waiting";
        const bob = wait ? Math.sin(this.frame * 0.6 + tn.ph) * 2 : 0;
        const sz = wait ? 20 : 16; // bubble side: the question is bigger so it carries
        const bx = s.x, by = s.y - 32 + bob; // centered above the head
        const col = STATE_COLOR[st];
        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // a waiting "?" pulses with a glow so it's spottable from across the tower
        if (wait) {
          const pulse = 0.5 + 0.5 * Math.sin(this.frame * 0.18 + tn.ph);
          ctx.shadowColor = col;
          ctx.shadowBlur = 6 + pulse * 8;
        }
        const x0 = bx - sz / 2, y0 = by - sz / 2;
        ctx.fillStyle = "rgba(10,15,18,0.9)";
        ctx.fillRect(x0, y0, sz, sz);
        ctx.strokeStyle = col;
        ctx.lineWidth = wait ? 2 : 1.5;
        ctx.strokeRect(x0, y0, sz, sz);
        // a little tail under the bubble so it reads as a thought pointing at the dev
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(bx - 3, y0 + sz - 0.5);
        ctx.lineTo(bx + 3, y0 + sz - 0.5);
        ctx.lineTo(bx, y0 + sz + 4);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = col;
        ctx.font = `bold ${wait ? 15 : 12}px 'IBM Plex Mono', monospace`;
        ctx.fillText(glyph, bx, by + 1);
        ctx.restore();
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

  /** A small pixel "bot head" + count, drawn left of an agent's name to show how
   *  many sub-agents (Task/Agent tool calls) it currently has in flight. Passive
   *  indicator only — no hit-test. `rightX` is where the count's right edge ends
   *  (the name's left edge, minus a gap); `baseY` is the toon's label anchor. */
  private drawSubagentBadge(rightX: number, baseY: number, n: number, color: string) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = "bold 8px 'IBM Plex Mono', monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    const count = String(n);
    ctx.fillStyle = color;
    ctx.fillText(count, rightX, baseY - 8);
    // bot head: 8px wide, sitting just left of the count
    const ix = rightX - ctx.measureText(count).width - 1 - 8;
    const iy = baseY - 16;
    ctx.fillStyle = color;
    ctx.fillRect(ix + 2, iy, 3, 2); // antenna tip
    ctx.fillRect(ix + 3, iy + 2, 1, 1); // antenna stalk
    ctx.fillRect(ix, iy + 3, 8, 6); // head
    ctx.fillStyle = "rgba(12,17,20,0.9)"; // punch two dark eyes into the head
    ctx.fillRect(ix + 2, iy + 5, 1, 2);
    ctx.fillRect(ix + 5, iy + 5, 1, 2);
    ctx.restore();
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

    // left-wall mapper: t 0 near opening → 1 far wall; f 0 ceiling → 1 floor at
    // that depth. The bookshelf + shredder slant along it.
    const onWall = (t: number, f: number) => {
      const xL = x + (bw.x0 - x) * t;
      const yT = topY + (byT - topY) * t;
      const yB = base + (byB - base) * t;
      return { x: xL, y: yT + (yB - yT) * f };
    };
    // (the wall above the lift door is intentionally left blank: the token
    // leaderboard that used to hang here moved into the HUD leaderboard modal)

    // the skills library: a long bookshelf running the full left wall, slanted
    // to the wall's perspective, just below the window
    this.drawBookshelf(ctx, r, onWall);

    // the paper shredder a dev visits on /clear, stood against the left wall just
    // in front of the bookshelf's near end
    this.drawShredder(ctx, r, onWall);

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
    // perspective slant instead of floating on the floor. It swings open while a
    // dev walks through it (drawDoor reads r.doorOpen, driven in tick).
    this.drawDoor(ctx, r, "frame");

    // the elevator shaft rides the right side wall (the lift door above); devs
    // travel it between floors, so no internal staircase is drawn here.

    // vacant reserved rooms sit dark until a dev moves in
    if (!lit && r.path) {
      ctx.fillStyle = "rgba(8,11,14,0.45)";
      ctx.fillRect(x + 1.5, base - H, w - 3, H);
    }
    ctx.globalAlpha = 1;
  }

  /** The lift door on a room's right side wall. `mode` "frame" draws the whole
   *  door (the dark lift beyond, the frame, the swinging leaf) inside the room
   *  before the crew, so a dev walking out shows in the opening. "overlay"
   *  re-draws just the jamb + leaf AFTER the crew, so for a room a dev is
   *  passing through they read as standing IN FRONT of the dev — the wall, not
   *  the dev, wins the doorway. The leaf swings by r.doorOpen (0 shut..1 open),
   *  hinged on the near jamb with its free edge arcing out toward the viewer. */
  private drawDoor(ctx: CanvasRenderingContext2D, r: Room, mode: "frame" | "overlay") {
    const base = r.baseY, x = r.x0, w = ROOM_W;
    const g = doorGeom(x, base);
    const { dn, df, pn, pf } = g;
    const open = clamp(r.doorOpen, 0, 1);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    // the opening (the hole in the wall): near + far jamb feet, raised to a lintel
    const oNB = { x: dn.x, y: dn.y }, oNT = { x: dn.x, y: dn.y - 31 };
    const oFT = { x: df.x, y: df.y - 26 }, oFB = { x: df.x, y: df.y };

    if (mode === "frame") {
      // the dark lift lobby seen once the leaf swings clear
      ctx.fillStyle = "#0a0e12";
      ctx.beginPath();
      ctx.moveTo(oNB.x, oNB.y); ctx.lineTo(oNT.x, oNT.y);
      ctx.lineTo(oFT.x, oFT.y); ctx.lineTo(oFB.x, oFB.y); ctx.closePath(); ctx.fill();
      // a faint call-light glow on the back wall of the lobby
      if (open > 0.04) {
        ctx.fillStyle = "rgba(150,180,210,0.10)";
        ctx.fillRect(df.x, df.y - 19, Math.max(1, dn.x - df.x), 15);
      }
    }

    // frame: near jamb post + top lintel (drawn behind the leaf)
    ctx.fillStyle = "#3c2a18";
    ctx.fillRect(dn.x - 0.4, oNT.y, 2, oNB.y - oNT.y);
    ctx.beginPath();
    ctx.moveTo(oNT.x, oNT.y); ctx.lineTo(oFT.x, oFT.y);
    ctx.lineTo(oFT.x, oFT.y - 2.2); ctx.lineTo(oNT.x, oNT.y - 2.2); ctx.closePath(); ctx.fill();

    // the swinging leaf, hinged on the near jamb (pn); the free edge (pf) arcs
    // from flush-with-the-wall (shut) out toward the near corner (open)
    const nbC = { x: pn.x, y: pn.y - 1.5 }, ntC = { x: pn.x, y: pn.y - 29 };
    const fbC = { x: pf.x, y: pf.y - 1.5 }, ftC = { x: pf.x, y: pf.y - 24.5 };
    const fbO = { x: x + w - 1, y: base + 1 }, ftO = { x: x + w - 1, y: base - 23 };
    const fb = { x: lerp(fbC.x, fbO.x, open), y: lerp(fbC.y, fbO.y, open) };
    const ft = { x: lerp(ftC.x, ftO.x, open), y: lerp(ftC.y, ftO.y, open) };
    ctx.fillStyle = open > 0.02 ? "#79592f" : "#6e522f"; // inner face lifts a touch when ajar
    ctx.beginPath();
    ctx.moveTo(nbC.x, nbC.y); ctx.lineTo(ntC.x, ntC.y);
    ctx.lineTo(ft.x, ft.y); ctx.lineTo(fb.x, fb.y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#4a3520"; // shaded leading edge so the open leaf reads as a slab
    ctx.beginPath();
    ctx.moveTo(ft.x - 0.6, ft.y); ctx.lineTo(ft.x + 0.6, ft.y);
    ctx.lineTo(fb.x + 0.6, fb.y); ctx.lineTo(fb.x - 0.6, fb.y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#d9b34a"; // handle rides the free edge
    ctx.fillRect(fb.x - 1.1, lerp(pf.y - 14, fb.y - 12, open), 1.4, 1.6);
  }

  /** The room's stat-tracker TV on the far wall: a flat panel showing the branch
   *  plus live git stats (files changed, lines +/-). It glows when the worktree's
   *  files change (see the packets fired from the desks in tick). */
  /** Layout for the read-only indicators in the bottom band of the COMMITS cell.
   *  `push` (↑) shows when there are local commits ahead of upstream, `pull` (↓)
   *  when the branch is behind. These are status glyphs, not buttons — there's
   *  no hit-test or hover. Geometry must mirror drawBoard's cell layout.
   *  `synced` flags the all-clear state (nothing ahead or behind). */
  private commitButtons(r: Room): {
    push?: { x: number; y: number; w: number; h: number };
    pull?: { x: number; y: number; w: number; h: number };
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
    const y = b.y + b.h - 8.5, h = 7.5, slot = 8.5;
    let lx = cx - 0.5;
    const push = bd.unpushed > 0 ? { x: lx, y, w: slot, h } : undefined;
    if (push) lx += slot;
    const pull = bd.behind > 0 ? { x: lx, y, w: slot, h } : undefined;
    return { push, pull, synced: !push && !pull };
  }

  /** Rect of the open-in-GitHub (↗) button in a room's board PR cell, plus the
   *  PR url to open. Mirrors drawBoard's PR-cell layout. Null when there's no PR. */
  private prOpenButton(r: Room): { x: number; y: number; w: number; h: number; url: string } | null {
    const bd = r.boardShown ?? r.board;
    if (!bd || bd.missing || !bd.pr?.url) return null;
    const b = boardRect(r.x0, r.baseY);
    if (b.w < 20 || b.h < 14) return null;
    // x math mirrors drawBoard's PR cell: the ↗ sits right after the #number,
    // which sits right after the "PR" heading (and an optional DRAFT badge).
    const pad = 4;
    const innerL = b.x + pad;
    const innerR = b.x + b.w - pad;
    const prW = Math.min(96, (innerR - innerL) * 0.42);
    const gitR = innerR - prW - 4;
    const px = gitR + 4;
    const py = b.y + 12 + 3; // bodyTop + 3, the heading baseline
    const ctx = this.ctx;
    ctx.font = "3px 'IBM Plex Mono', monospace";
    let nx = px + ctx.measureText("PR").width + 3;
    if (bd.pr.draft) {
      ctx.font = "bold 2.8px 'Martian Mono', monospace";
      nx += ctx.measureText("DRAFT").width + 2;
    }
    ctx.font = "bold 3px 'Martian Mono', monospace"; // mirror drawBoard's PR-number size
    const x = nx + ctx.measureText(`#${bd.pr.number}`).width + 3;
    return { x, y: py - 5, w: 6, h: 6, url: bd.pr.url };
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
      // COMMITS cell bottom band: read-only ahead (↑) / behind (↓) indicators
      if (i === 2) {
        const btns = this.commitButtons(r);
        const sy = bodyBot - 1.5; // shared baseline for the row
        ctx.textAlign = "left";
        if (btns.push) {
          ctx.fillStyle = "#ffb13d"; // up = local commits ahead of upstream
          ctx.font = "bold 4px 'Martian Mono', monospace";
          ctx.fillText(`↑${bd.unpushed}`, btns.push.x + 0.5, sy);
        }
        if (btns.pull) {
          ctx.fillStyle = "#56c7ff"; // down = commits behind upstream
          ctx.font = "bold 4px 'Martian Mono', monospace";
          ctx.fillText(`↓${bd.behind}`, btns.pull.x + 0.5, sy);
        }
        if (btns.synced) {
          ctx.fillStyle = "rgba(120,200,255,0.5)";
          ctx.font = "3px 'IBM Plex Mono', monospace";
          ctx.fillText("synced", cx, sy);
        }
      }
    });

    /* ---- right: PR (heading · #number · ↗ grouped together, left-aligned) ---- */
    const px = gitR + 4;
    cellGlow(gitR + 2, innerR - gitR - 2, cp.pr);
    ctx.fillStyle = "rgba(120,150,170,0.14)";
    ctx.fillRect(gitR + 1, bodyTop, 0.7, bodyBot - bodyTop);
    let py = bodyTop + 3;
    ctx.textAlign = "left";
    ctx.font = "3px 'IBM Plex Mono', monospace";
    ctx.fillStyle = TEXT.heading; // readable PR-cell heading
    ctx.fillText("PR", px, py);
    // first GitHub lookup still in flight (per-board prReady, or the global first
    // poll) → spinner, never a premature "not connected"
    const loadingPr = !bd.pr && (!bd.prReady || this.prLoading);
    const pr = bd.pr;
    if (pr) {
      // number + ↗ sit right next to "PR" and share its baseline, instead of
      // floating off at the right edge (x math mirrored in prOpenButton).
      ctx.font = "3px 'IBM Plex Mono', monospace";
      let nx = px + ctx.measureText("PR").width + 3;
      if (pr.draft) { // draft badge between the label and the number
        ctx.font = "bold 2.8px 'Martian Mono', monospace";
        ctx.fillStyle = "rgba(180,190,198,0.85)";
        ctx.fillText("DRAFT", nx, py);
        nx += ctx.measureText("DRAFT").width + 2;
      }
      ctx.font = "bold 3px 'Martian Mono', monospace"; // match the "PR" heading size
      ctx.fillStyle = pr.draft ? "rgba(180,188,196,0.9)" : "#b98cff";
      ctx.fillText(`#${pr.number}`, nx, py);
      // open-in-GitHub button (↗) right after the number, centred on its line
      const ob = { x: nx + ctx.measureText(`#${pr.number}`).width + 3, y: py - 5, w: 6, h: 6 };
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
      if (pr.merged) {
        // merged: one celebratory badge replaces the checks/reviewers charts, so a
        // manual merge visibly lands on the TV before the PR clears off the board
        ctx.font = "bold 4.4px 'Martian Mono', monospace";
        const label = "✓ MERGED";
        const bw = ctx.measureText(label).width + 5;
        ctx.fillStyle = "rgba(163,113,247,0.22)"; // GitHub merged-purple chip
        ctx.fillRect(px, py - 4.2, bw, 6.4);
        ctx.fillStyle = "#c9a6ff";
        ctx.fillText(label, px + 2.5, py);
        ctx.restore();
        return;
      }
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
  private drawShredder(
    ctx: CanvasRenderingContext2D,
    r: Room,
    onWall: (t: number, f: number) => { x: number; y: number }
  ) {
    const eFurn = clamp((r.built - 0.6) / 0.4, 0, 1);
    if (eFurn <= 0) return;
    // remaining feed fraction if a dev is shredding into THIS room's bin (0 = idle)
    let feed = 0;
    for (const tn of this.toons.values()) {
      if (tn.shred?.phase === "feed" && this.rooms.get(tn.bkey ?? "") === r) {
        feed = Math.max(feed, clamp(tn.shred.t / SHRED_FEED, 0, 1));
      }
    }
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
    // The bin stands proud of the left wall exactly like the bookshelf: `front`
    // offsets a wall point toward the room (and down) by the SAME protrusion the
    // cabinet uses, so the shredder's faces slant on the wall's one-point
    // perspective and sit flush, parallel, and at the same angle right beside it.
    const front = (t: number, f: number, extra = 0) => {
      const p = onWall(t, f);
      const d = 6 * (1 - t * 0.5) + extra; // protrusion: bigger up front, smaller back
      return { x: p.x + d, y: p.y + d * 0.5 };
    };
    // body box: a t-band against the wall, centered in the open stretch between
    // the near opening and the shelf's near end (t0 = 0.4), running floor (f =
    // 1.0) up to fTop. Short floor cabinet standing well clear of the cabinet.
    const tN = 0.13, tF = 0.245, fTop = 0.74, fBot = 1.0;
    // contact shadow, a slanted quad hugging the floor under the front face
    quad(onWall(tN, fBot), onWall(tF, fBot), front(tF, fBot, 2.5), front(tN, fBot, 2.5), "rgba(0,0,0,0.3)");
    // near end cap (faces the front opening, catches the light)
    quad(onWall(tN, fTop), front(tN, fTop), front(tN, fBot), onWall(tN, fBot), "#2e343b");
    // front face (faces the room) + a shadow strip along its far edge
    quad(front(tN, fTop), front(tF, fTop), front(tF, fBot), front(tN, fBot), "#23282e");
    quad(front(tF - 0.02, fTop), front(tF, fTop), front(tF, fBot), front(tF - 0.02, fBot), "#171b20");
    // front-face local coords: u (0 near → 1 far), v (0 top → 1 floor)
    const fp = (u: number, v: number) =>
      front(tN + (tF - tN) * u, fTop + (fBot - fTop) * v);
    // window onto the collected shreds, with vertical spine-like strips
    quad(fp(0.18, 0.16), fp(0.82, 0.16), fp(0.82, 0.62), fp(0.18, 0.62), "#3a4148");
    for (let i = 0; i < 4; i++) {
      const ua = 0.24 + i * 0.14;
      quad(fp(ua, 0.21), fp(ua + 0.09, 0.21), fp(ua + 0.09, 0.57), fp(ua, 0.57), i % 2 ? "#cfc9b6" : "#b4ae9b");
    }
    // shredder head (motor unit) on top: a wider box that overhangs the body, so
    // its own t-band runs a touch past each end and it protrudes a little more.
    const tNh = tN - 0.012, tFh = tF + 0.006, fTh = 0.695, fBh = 0.745, eh = 1.6;
    const hf = (t: number, f: number) => front(t, f, eh);
    quad(onWall(tNh, fTh), hf(tNh, fTh), hf(tNh, fBh), onWall(tNh, fBh), "#2a2f35"); // near end cap
    quad(hf(tNh, fTh), hf(tFh, fTh), hf(tFh, fBh), hf(tNh, fBh), "#3a4046"); // front face
    quad(onWall(tNh, fTh), onWall(tFh, fTh), hf(tFh, fTh), hf(tNh, fTh), "#4a5158"); // top surface (highlight)
    // head front-face local coords, for the intake slot + status LED
    const hfp = (u: number, v: number) =>
      hf(tNh + (tFh - tNh) * u, fTh + (fBh - fTh) * v);
    quad(hfp(0.12, 0.36), hfp(0.88, 0.36), hfp(0.88, 0.62), hfp(0.12, 0.62), "#0f1318"); // intake slot
    const blink = this.frame % 6 < 3;
    quad(hfp(0.78, 0.1), hfp(0.93, 0.1), hfp(0.93, 0.32), hfp(0.78, 0.32),
      feed > 0 ? (blink ? "#ff5a52" : "#5a2522") : "#3ee089"); // status LED
    if (feed > 0) {
      // a sheet jutting up out of the intake slot, shrinking as it feeds through
      const top = fTh - 0.02 - feed * 0.05;
      const sa = tNh + (tFh - tNh) * 0.3, sb = tNh + (tFh - tNh) * 0.62;
      quad(hf(sa, top), hf(sb, top), hf(sb, fTh + 0.004), hf(sa, fTh + 0.004), "#e9e3d2");
      quad(hf(sa, top), hf(sb, top), hf(sb, top + 0.006), hf(sa, top + 0.006), "#cfc9b6");
      // confetti strips drifting down through the bin window
      for (let i = 0; i < 6; i++) {
        const u = 0.22 + i * 0.1;
        const v = 0.2 + ((this.frame * 0.9 + i * 4) % 8) / 18;
        quad(fp(u, v), fp(u + 0.05, v), fp(u + 0.05, v + 0.07), fp(u, v + 0.07), i % 2 ? "#e9e3d2" : "#d8d2bf");
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
      // the task TV the dev raises on the floor at the desk's left leg to track its checklist
      if (tn && tn.tvShow > 0.02) this.drawDeskTV(ctx, tn, dx, db);
    }
    ctx.globalAlpha = 1;
  }

  /** The status TV a dev deploys on the floor below its desk to track its
   *  Task-tool checklist: a small screen on a low floor base showing `done/total`
   *  over a progress bar, tucked into the under-desk gap. It rises/folds via
   *  `tn.tvShow`, and flashes when the dev slaps the desk button on a completion
   *  (`tn.tapAt`). Sits at the desk's left leg, clear of the dev (seated to the
   *  right) so it never occludes them. */
  private drawDeskTV(ctx: CanvasRenderingContext2D, tn: Toon, dx: number, db: number) {
    const tv = tn.agent.tasks;
    if (!tv || tv.total < 2) return;
    const sc = clamp(tn.tvShow, 0, 1);
    const done = Math.min(tv.done, tv.total);
    const allDone = done >= tv.total;
    const accent = allDone ? "#3ee089" : "#56c7ff";
    const tp = tn.tapAt !== undefined ? this.frame - tn.tapAt : 99; // frames since tap
    const tapping = tp >= 0 && tp < 6;

    // completion button on the desk, left of the stand — lit green on a press
    const lit = tapping ? 1 - tp / 6 : 0;
    ctx.fillStyle = "#1a1014";
    ctx.fillRect(dx + 1.2, db - 11.6, 3, 0.8); // button base shadow on the desk
    ctx.fillStyle = lit > 0 ? "#3ee089" : "#7a2c28";
    ctx.fillRect(dx + 1.6, db - 12.2 + lit * 0.4, 2.2, 1.4); // the button cap (sinks when pressed)
    ctx.fillStyle = lit > 0 ? "#bff7d6" : "#9c3a34";
    ctx.fillRect(dx + 1.6, db - 12.2 + lit * 0.4, 2.2, 0.4); // top highlight

    // a low floor unit at the desk's left leg (dx+3), the display tucked below the
    // desktop: a base on the floor with the screen rising into the under-desk gap
    const cx = dx + 3.5; // centered on the left leg
    const fullH = 8;
    const w = 7;
    const baseY = db - 0.8; // top of the floor base
    ctx.fillStyle = "#171c22";
    ctx.fillRect(cx - w / 2 - 0.3, baseY, w + 0.6, 0.8); // base on the floor

    // screen body unfolds upward from the base as tvShow rises — stays below the desk
    const h = fullH * sc;
    const top = baseY - h;
    const left = cx - w / 2;
    ctx.fillStyle = "#0c0f13";
    ctx.fillRect(left, top, w, h); // bezel
    if (sc < 0.55) return; // still folding out — no readable content yet
    const ca = ctx.globalAlpha;
    const fade = clamp((sc - 0.55) / 0.45, 0, 1);
    const sx = left + 0.9;
    const sy = top + 0.9;
    const sw = w - 1.8;
    const sh = h - 1.8;
    ctx.globalAlpha = ca * fade;
    ctx.fillStyle = "#10151b"; // dark screen
    ctx.fillRect(sx, sy, sw, sh);
    // power LED in the corner
    ctx.fillStyle = accent;
    ctx.fillRect(left + w - 1.5, top + 0.6, 0.7, 0.7);
    // done/total count
    ctx.fillStyle = "#dfe7ef";
    ctx.font = "3.4px 'Martian Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(`${done}/${tv.total}`, sx + sw / 2, sy + 3.2);
    // progress bar
    const barY = sy + sh - 1.8;
    const barW = sw - 1;
    const barX = sx + 0.5;
    ctx.fillStyle = "#1f2730";
    ctx.fillRect(barX, barY, barW, 1.2);
    ctx.fillStyle = accent;
    ctx.fillRect(barX, barY, barW * (done / tv.total), 1.2);
    // a press flashes the whole screen white briefly
    if (tapping) {
      ctx.fillStyle = `rgba(255,255,255,${0.55 * (1 - tp / 6)})`;
      ctx.fillRect(sx, sy, sw, sh);
    }
    ctx.globalAlpha = ca;
    ctx.textAlign = "left";
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
    // reading a fetched skill book at the desk: the dev looks DOWN at an open book
    // held in front of it, so the pages (and their text) face up toward its gaze.
    // A dev only reads while it's actually working a task — once idle/complete it
    // sets the book down and kicks back. The tick put-down clears booksInHand, but
    // gate on the working state here too so a parked frame can't strand the read.
    const working = st === "active" || st === "waiting";
    const reading = sitting && working && tn.booksInHand > 0 && !tn.agent.reviewOf;
    // idle/complete devs stay seated but recline back into the chair: the upper
    // body tips toward the backrest (to its right) and sinks a little, hands
    // laced behind the head. Reads as "kicked back", not hunched at the desk.
    const relaxed = sitting && !reading && !tn.agent.reviewOf && (st === "idle" || st === "complete");
    const lean = relaxed ? 2 : 0;     // upper body reclines toward the backrest
    const leanDrop = relaxed ? 1 : 0; // ...and dips as it tips back

    ctx.fillStyle = p.pants;
    if (relaxed) {
      // feet kicked up on the desk: the legs lift to desk height and stretch out
      // left toward the monitor, ankles crossed with the shoes angled up. Drawn
      // up at the surface so the desktop (painted afterwards) doesn't swallow
      // them; the torso is painted over their near ends, the monitor over the far.
      // shins stretch left across the desk toward the monitor, ankles crossed,
      // the crossed sneakers resting on the clear left end of the desktop. Kept
      // just above the surface line so the desktop (painted after) doesn't eat
      // them, with bright soles so they read against the dark monitor behind.
      const surf = base - 7.5; // the desk top surface sits ~7.5px above base
      ctx.fillRect(x - 11, surf - 3.4, 11, 1.7);  // upper shin
      ctx.fillRect(x - 10, surf - 1.9, 10, 1.6);  // lower shin, crossed under it
      ctx.fillStyle = "#2a2f35";                  // crossed shoes at the far end
      ctx.fillRect(x - 13.6, surf - 3.8, 3, 1.9);
      ctx.fillRect(x - 12.6, surf - 2.0, 3, 1.9);
      ctx.fillStyle = "#dfe3e8";                  // bright soles underneath
      ctx.fillRect(x - 13.8, surf - 2.2, 3.2, 0.7);
      ctx.fillRect(x - 12.8, surf - 0.4, 3.2, 0.7);
    } else if (sitting) {
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

    const ty = base - 12 + slump * 0.4 + leanDrop;
    ctx.fillStyle = p.shirt;
    ctx.fillRect(x - 3.2 + lean, ty, 6.4, 6.4);
    ctx.fillStyle = p.shirtDark;
    ctx.fillRect(x - 3.2 + lean, ty + 5.2, 6.4, 1.2);

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
    } else if (reading) {
      // reading the fetched skill book(s) at the desk: the forearms come up
      // here (below the head, so they stay behind it), but the open book itself
      // is drawn after the head further down so it reads as held up in front of
      // the face rather than tucked behind the skull
      ctx.fillStyle = p.shirt; // forearms up to the book
      ctx.fillRect(x - 2.4, ty + 1.4, 1.8, 1.8);
      ctx.fillRect(x + 2.2, ty + 1.4, 1.8, 1.8);
    } else if (relaxed) {
      // reclined in the chair: both hands laced behind the head, elbows out,
      // swaying gently (offset by `lean` so the arms follow the tipped torso)
      const ease = Math.sin(f * 0.06 + tn.ph) * 0.5;
      ctx.fillStyle = p.shirt;
      // upper arms out to the sides, elbows raised
      ctx.fillRect(x - 5.4 + lean, ty - 0.4, 2.2, 1.6);
      ctx.fillRect(x + 3.2 + lean, ty - 0.4, 2.2, 1.6);
      // forearms angle up from the elbows toward behind the head
      ctx.fillRect(x - 5.2 + lean, ty - 4.6 + ease, 1.6, 4.4);
      ctx.fillRect(x + 3.6 + lean, ty - 4.6 - ease, 1.6, 4.4);
      // hands tucked behind the head, peeking at its top corners
      ctx.fillStyle = handC;
      ctx.fillRect(x - 4.2 + lean, ty - 5.4 + ease, 1.6, 1.6);
      ctx.fillRect(x + 2.6 + lean, ty - 5.4 - ease, 1.6, 1.6);
    } else if (sitting) {
      // typing toward the keyboard/monitor on the left — but on a task completion
      // the near hand darts further down-left to slap the desk's done button
      const press = tn.tapAt !== undefined && this.frame - tn.tapAt < 6;
      if (press) {
        ctx.fillRect(x - 9.4, ty + 2.4, 4, 1.4); // forearm stretched to the button
        ctx.fillStyle = handC;
        ctx.fillRect(x - 10.5, ty + 2.9, 1.6, 1.6); // hand pressing down on it
        ctx.fillStyle = p.shirt;
        ctx.fillRect(x + 2.8, ty + 1.6, 1.4, 3.8); // far arm rests on the desk
      } else {
        const tap = f % 2 === 0 ? 0 : 0.8;
        ctx.fillRect(x - 6, ty + 2.2, 3.4, 1.4);
        ctx.fillStyle = handC;
        ctx.fillRect(x - 7, ty + 2 + tap, 1.4, 1.4);
        ctx.fillRect(x - 7, ty + 3.6 - tap, 1.4, 1.4);
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
      // not working (done, or off the clock): kicked back with both hands laced
      // behind the head, elbows out, swaying gently. Plays out up at head level
      // (above the desk, so it stays visible) and reads as "taking it easy"
      // rather than hunched over a phone.
      const ease = Math.sin(f * 0.06 + tn.ph) * 0.5; // slow relaxed sway
      ctx.fillStyle = p.shirt;
      // upper arms out to the sides, elbows raised
      ctx.fillRect(x - 5.4, ty - 0.4, 2.2, 1.6);
      ctx.fillRect(x + 3.2, ty - 0.4, 2.2, 1.6);
      // forearms angle up from the elbows toward behind the head
      ctx.fillRect(x - 5.2, ty - 4.6 + ease, 1.6, 4.4);
      ctx.fillRect(x + 3.6, ty - 4.6 - ease, 1.6, 4.4);
      // hands tucked behind the head, peeking at its top corners
      ctx.fillStyle = handC;
      ctx.fillRect(x - 4.2, ty - 5.4 + ease, 1.6, 1.6);
      ctx.fillRect(x + 2.6, ty - 5.4 - ease, 1.6, 1.6);
    } else {
      ctx.fillRect(x - 4.2, ty + 1.5, 1.4, 4);
      ctx.fillRect(x + 2.8, ty + 1.5, 1.4, 4);
    }

    const hy = ty - 6 + slump;
    const hx = x + lean; // the head rides the reclined torso when relaxed
    ctx.fillStyle = p.skin;
    ctx.fillRect(hx - 2.8, hy, 5.6, 5.6);
    ctx.fillStyle = p.hair;
    ctx.fillRect(hx - 3, hy - 1, 6, 2.2);
    ctx.fillRect(hx - 3, hy - 0.5, 1.2, 3.4);
    ctx.fillRect(hx + 1.8, hy - 0.5, 1.2, 2.4);
    if (p.acc === 2) {
      ctx.fillStyle = p.accColor;
      ctx.fillRect(hx - 3.2, hy - 1.6, 6.4, 1.8);
      ctx.fillRect(facingLeft ? hx - 4.6 : hx + 1.6, hy - 0.4, 3, 1);
    } else if (p.acc === 3) {
      ctx.fillStyle = p.accColor;
      ctx.fillRect(hx - 3.6, hy + 1.6, 1.2, 2.4);
      ctx.fillRect(hx + 2.4, hy + 1.6, 1.2, 2.4);
      ctx.fillRect(hx - 3.4, hy - 1.6, 6.8, 1);
    }
    const blink = (f + Math.floor(tn.ph * 7)) % 40 === 0;
    if (!blink) {
      ctx.fillStyle = "#14181b";
      const ey = hy + 2.4 + slump * 0.5;
      if (reading) {
        // both eyes lowered and centered, peering down at the open book below
        ctx.fillRect(hx - 1.5, ey + 0.8, 1.1, 1.1);
        ctx.fillRect(hx + 0.4, ey + 0.8, 1.1, 1.1);
      } else if (relaxed) {
        // gazing up, easy and unfocused, while reclined
        ctx.fillRect(hx - 1.6, ey - 0.6, 1.1, 1.1);
        ctx.fillRect(hx + 0.4, ey - 0.6, 1.1, 1.1);
      } else if (facingLeft || (walking && tn.targetX < tn.x)) {
        ctx.fillRect(hx - 2.2, ey, 1.1, 1.1);
        ctx.fillRect(hx - 0.2, ey, 1.1, 1.1);
      } else {
        ctx.fillRect(hx - 0.8, ey, 1.1, 1.1);
        ctx.fillRect(hx + 1.2, ey, 1.1, 1.1);
      }
    }
    if (p.acc === 1) {
      ctx.strokeStyle = "#23262a";
      ctx.lineWidth = 0.5;
      const ey = hy + 2.6;
      ctx.strokeRect(hx - 1.4, ey - 0.8, 1.9, 1.9);
      ctx.strokeRect(hx + 0.9, ey - 0.8, 1.9, 1.9);
    }

    // the open book is drawn after the head so it sits in front of the face
    // (the dev is holding it up to read), not occluded behind the skull; still
    // drawn within drawToon, so the desk/monitor edge occludes only its far corner
    if (reading) {
      // an open book held up in front of the face, pages turned toward the dev
      // (who faces its monitor on the left): the viewer sees the OUTSIDE covers,
      // not the text, so the page faces the reader rather than the screen. Drawn
      // as two cover panels meeting at a raised central spine, forming a shallow
      // V that opens away from us toward the dev's gaze.
      const bob = Math.sin(f * 0.16 + tn.ph) * 0.3;
      const sx = x - 0.5;                       // spine, held slightly toward the monitor
      const yT = ty - 1.8 + bob, yB = ty + 3.6 + bob; // top and bottom edges
      const wHalf = 3.6;
      const hue = BOOK_HUES[tn.booksShown % BOOK_HUES.length];
      const panel = (toX: number, fill: string) => {
        ctx.beginPath();
        ctx.moveTo(sx, yT); ctx.lineTo(toX, yT + 0.8);
        ctx.lineTo(toX, yB - 0.8); ctx.lineTo(sx, yB);
        ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
      };
      panel(sx - wHalf, `hsl(${hue} 44% 33%)`); // left cover (in shadow)
      panel(sx + wHalf, `hsl(${hue} 46% 43%)`); // right cover (lit)
      // the page block peeks along the top edge as a thin cream strip
      ctx.fillStyle = "#e9e3d2";
      ctx.fillRect(sx - wHalf, yT + 0.4, wHalf * 2, 0.7);
      // raised spine ridge down the middle
      ctx.fillStyle = `hsl(${hue} 52% 53%)`;
      ctx.fillRect(sx - 0.3, yT, 0.6, yB - yT);
      // hands cupping the lower corners
      ctx.fillStyle = handC;
      ctx.fillRect(sx - wHalf - 0.3, yB - 1.4, 1.5, 1.5);
      ctx.fillRect(sx + wHalf - 1.2, yB - 1.4, 1.5, 1.5);
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

    // what a dev carries on its /clear trip, held to its left (toward the bin and
    // shelf it is walking to). It leaves the desk with its context papers AND its
    // skill books: the papers thin as they feed into the shredder ("feed") and are
    // gone once it heads to the shelf; the books thin as they slot back ("place").
    // On the final "back" leg its arms are empty.
    if (tn.shred && tn.shred.phase !== "back") {
      const sh = tn.shred;
      const bx = x - 2.4;
      // skill books carried back to the shelf, held below the papers
      const booksLeft = sh.phase === "place"
        ? Math.ceil(clamp(sh.t / SHELF_PLACE, 0, 1) * sh.books)
        : sh.books;
      for (let k = 0; k < booksLeft; k++) {
        const hue = BOOK_HUES[k % BOOK_HUES.length];
        const by = ty + 3 - k * 1.4;
        ctx.fillStyle = `hsl(${hue} 45% 46%)`;
        ctx.fillRect(bx, by - 1.4, 4, 1.4);
        ctx.fillStyle = `hsl(${hue} 45% 56%)`;
        ctx.fillRect(bx, by - 1.4, 4, 0.4);
      }
      // context papers stacked on top of the books, only while shredder-bound
      const sheets = sh.phase === "out" ? 4
        : sh.phase === "feed" ? Math.ceil(clamp(sh.t / SHRED_FEED, 0, 1) * 4)
        : 0;
      const top = ty + 3 - booksLeft * 1.4; // rest the papers above the book stack
      for (let k = 0; k < sheets; k++) {
        const by = top - k * 1.2;
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
  setGithubConnected(connected: boolean | null | undefined) {
    this._instance?.setGithubConnected(connected);
  },
  setPrLoading(loading: boolean) {
    this._instance?.setPrLoading(loading);
  },
  setBoards(boards: Record<string, any>) {
    this._instance?.setBoards(boards);
  },
  setSelected(id: string | undefined) {
    this._instance?.setSelected(id);
  },
  setUsedDir(room: string | undefined) {
    this._instance?.setUsedDir(room);
  },
  onSelect(cb: (id: string) => void) {
    this._instance?.onSelect(cb);
  },
  onDeselect(cb: () => void) {
    this._instance?.onDeselect(cb);
  },
  onUseDir(cb: (room: string) => void) {
    this._instance?.onUseDir(cb);
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
  onOpenPr(cb: (url: string) => void) {
    this._instance?.onOpenPr(cb);
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
  focusAgent(id: string) {
    this._instance?.focusAgent(id);
  },
  zoomOutToAgentRoom() {
    return this._instance?.zoomOutToAgentRoom() ?? false;
  },
  setEco(on: boolean) {
    this._instance?.setEco(on);
  },
  setPerf(mode: string) {
    this._instance?.setPerf(mode);
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
