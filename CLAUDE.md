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

## UI changes: always show before and after

Whenever a change affects what the app looks like (canvas rendering in
`src/webview/crew.ts`, colors, layout, fonts, icons, any visible UI), you MUST
demonstrate the result, not just describe it:

- Capture a **before** and an **after** of the affected view.
- Use a **still image (PNG)** for static changes.
- Use a **GIF** when the change involves motion (animations, transitions,
  beams, elevator cars, flashing columns) so the behavior is actually visible.
- Build first (`npm run build`) so the running app reflects the change before
  you capture the "after".

### Put the media in the PR description

The before/after must be embedded in the **PR description body** so it can be
viewed in the PR diff view without checking anything out. **Do NOT commit the
screenshots into git** - they are attached to the PR description instead, so the
repo and `.vsix` stay clean.

GitHub stores images dragged or pasted into a PR/issue body on its own
attachment CDN (`https://github.com/user-attachments/assets/<id>`); the file
never lands in the branch. There is no `gh`/API call that uploads to that CDN -
the upload happens in the browser (or by pasting into the web editor), so the
flow is:

1. Capture the before/after locally (PNG for static changes, GIF for motion -
   animations, transitions, beams, elevator cars). Keep them OUT of git: write
   them somewhere ignored (e.g. `screenshots/out/`), never under `docs/` or
   `media/`.
2. In the PR description editor, **drag-and-drop or paste each image**. GitHub
   uploads it and inserts a `https://github.com/user-attachments/assets/...`
   URL. (If a human is driving, hand them the local files to drop in.)
3. Lay them out side by side using those attachment URLs:

   ```markdown
   ## Before / After
   | Before | After |
   | --- | --- |
   | ![before](https://github.com/user-attachments/assets/<id-before>) | ![after](https://github.com/user-attachments/assets/<id-after>) |
   ```

   For an animated change, attach a `.gif` the same way.

Once the attachment URLs exist, set or update the body with
`gh pr edit <num> --body-file <file>` (or `gh pr create --body-file <file>`).

A UI PR without a before/after in its description is incomplete.

### Keep the README / marketplace media in sync

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
