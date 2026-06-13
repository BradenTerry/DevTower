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
