# DevTower

A VS Code extension: a pixel office tower for your coding agents. Watch Claude
sessions work, stack floors, spawn devs into worktrees, review diffs and PRs.

- Extension host code: `src/*.ts` (compiled to `out/extension.js`).
- Webview UI: `src/webview/crew.ts`, bundled to `media/crew.js`. The scene is
  drawn on a `<canvas>`, so most UI is `ctx.fill*` calls, not DOM/CSS.

## Commands

| Task | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Test | `npm test` |
| Build (production) | `npm run build` |
| Watch/rebuild | `npm run watch` |
| Package vsix | `npm run package` |

Run `npm run typecheck` and `npm test` before handing work back.

## Debugging: use the verbose debug log

When a behavior is hard to reproduce or reason about (camera focus, agent/session
binding, toon spawn/leave, board sync, hit-tests), **add debug-log instrumentation
rather than guessing**. The repo has a built-in verbose log that captures these
events with the data you choose.

- **Enable it:** the `devtower.debugLog` setting (toggled live from the Settings
  overlay's Debug tab, or in VS Code settings). When on, events are written to
  `debug.log` in the extension's global storage dir (path via `debugLogPath()` in
  `src/debugLog.ts`; the Debug tab links straight to it). Errors always log to
  `errors.log`; the verbose `debug.log` is gated on the setting.
- **From the extension host (`src/*.ts`):** call `dlog("dotted.event", { ...data })`.
- **From the canvas scene (`src/webview/crew.ts`):** call
  `this.dbg("dotted.event", { ...data })`. It is a no-op unless `devtower.debugLog`
  is on, and is forwarded to the host and written as `scene.<event>`.
- **From the console webview (`media/console.js`):** guard on the local `debug`
  flag and `vscode.postMessage({ type: "debug", event: "dotted.event", data })`;
  the host writes it as `scene.<event>` too.
- **Naming:** use dotted event names (e.g. `cam.newDevSelect`, `bind.adopt`) so a
  repro can be sliced with `grep '"cam.' debug.log`. Keep payloads to the few
  fields that disambiguate which branch ran.

Leave useful instrumentation in place when it documents a tricky path; it costs
nothing while the setting is off. When asked to "add debugging", prefer wiring
these `dlog`/`dbg` events into the suspect code path over ad-hoc `console.log`.

## Packaging hygiene: keep the .vsix lean

The published `.vsix` must contain ONLY what is required to run the extension
plus what the marketplace listing renders. Never let dev artifacts inflate it.

- **Ships:** `out/extension.js`, `media/**` runtime assets (canvas bundle,
  hooks, icons, and the README/CHANGELOG images), `package.json`, `readme.md`,
  `changelog.md`, `LICENSE.txt`.
- **Never ships:** screen recordings or videos (`*.mov`, `*.mp4`, `*.webm`),
  `screenshots/`, `docs/`, `demo/`, `.devtower/`, `test/`, `test-results/`,
  `src/`, sourcemaps, and anything else not loaded at runtime. These belong in
  `.vscodeignore`.
- An image is only "required" if `readme.md` or `changelog.md` references it
  (those render on the marketplace page). Marketplace images live in `media/`;
  keep `screenshots/` and `docs/` out of the package. Before excluding an image
  folder, grep `readme.md`/`changelog.md` to confirm nothing points at it.
- After `npm run package`, check the printed size and file tree. A clean build
  is a few MB. If it is tens of MB, something dev-only leaked in - add it to
  `.vscodeignore` rather than shipping it.

## UI conventions: clickable controls

Every control a user can click MUST signal that it is clickable:

- **Pointer cursor.** On hover it shows `cursor: pointer`. For DOM controls use
  CSS. For canvas-drawn controls (the scene in `src/webview/crew.ts`), the
  pointer-move hit-test must set `container.style.cursor = "pointer"` when the
  cursor is over the control's rect.
- **Hover animation.** Hovering produces a visible change, not a static target:
  a brightened fill, a glow, a slight scale, or a background tint. For DOM use a
  CSS `:hover` transition. For canvas controls, track the hovered control and
  redraw it in a highlighted state.

This applies to both DOM HUD/overlay buttons and the canvas buttons in the scene
(for example: `+ DEV`, a room's `✕` close, the COMMITS push/pull/refresh
buttons, and the open-in-GitHub `↗` arrows). A clickable control with no
pointer and no hover feedback is a bug.

## Keep the README / marketplace media in sync

The marketplace listing (`MARKETPLACE.md`, the `--readme-path` used by
`npm run package`), the GitHub `readme.md`, and `changelog.md` render images
from `media/**` (`shot-campus.png`, `room.png`, `shot-agent-panel.png`,
`shot-room.png`, `shot-settings-github.png`, and the `agent-stream.gif` cable
animation). These are **generated from the screenshot harness**, not hand-edited.

Whenever a UI change alters what any of those images show (scene rendering, HUD,
boards, the agent panel, settings, the cable/beam animation), you MUST
regenerate and commit them in the same change:

1. Run **`npm run gen:media`** — it builds the bundles, runs the matching
   `screenshots/*.shot.ts` scenarios, assembles `agent-stream.gif` with ffmpeg,
   and copies every still into `media/` under its published name (mapping lives
   in `scripts/gen-md-media.sh`).
2. `git diff -- media/` to confirm only the intended images changed, then commit.
3. If you add or remove a doc image, update both the markdown reference AND the
   mapping/scenario in `scripts/gen-md-media.sh` (and add a `*.shot.ts` if new).

Hand-made brand art (`media/banner.png`, `media/icon.png`) is NOT generated by
the script — leave it alone unless the brand itself changes. A doc image that
still shows removed or outdated UI is a bug, same as a stale before/after.
