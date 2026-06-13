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

### Always commit the bundle minified

`media/crew.js` (and `out/extension.js`) are checked-in build artifacts. Only
the production build minifies them (`minify: production` in `esbuild.js`);
`npm run watch` and `npm run compile` emit an UNMINIFIED bundle plus a
`.map`, which turns a one-line file into thousands of lines and a giant,
unreviewable git diff.

So after any change to `src/webview/crew.ts` (or other bundled source), and
before committing or handing work back:

1. Rebuild with the production build so the artifact is minified:
   `npm run build`
2. Confirm the artifact diff is tiny — `media/crew.js` stays a single line:
   `git diff --stat media/crew.js` should show ~`2 +-`, not thousands.
3. Don't commit a dev-build `.map`. `npm run build` doesn't emit one, so if a
   prior `watch`/`compile` left `media/crew.js.map` changed, restore it:
   `git checkout -- media/crew.js.map`

If you see a multi-thousand-line `media/crew.js` diff, that's an unminified dev
build leaking in — rerun `npm run build` before committing.

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
buttons, the PR billboard refresh, and the open-in-GitHub `↗` arrows). A
clickable control with no pointer and no hover feedback is a bug.

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
viewed without checking anything out. Reliable, scriptable steps:

1. Save the captures under `docs/screenshots/<branch-or-feature>/` and commit
   them on the PR branch.
2. Reference them in the PR body with their raw URLs so they render inline:
   `![before](https://raw.githubusercontent.com/BradenTerry/DevTower/<branch>/docs/screenshots/<feature>/before.png)`
3. Lay them out side by side, for example:

   ```markdown
   ## Before / After
   | Before | After |
   | --- | --- |
   | ![before](<raw-url>/before.png) | ![after](<raw-url>/after.png) |
   ```

   For an animated change, swap the `.png` for a `.gif`.

Set or update the PR body with `gh pr edit <num> --body-file <file>` (or
`gh pr create --body-file <file>`).

A UI PR without a before/after in its description is incomplete.
