# Webview visual preview

Standalone harness that renders the real webview bundles (`media/crew.js`,
`media/console.js`, `media/console.css`) outside of VS Code, driven by the
same mock PR data the extension falls back to when `gh` is unavailable. Useful
for eyeballing the PR board, the review-requested billboard, the review
dispatch card, and the open-in-GitHub (↗) buttons without launching the
Extension Development Host.

## Run

```sh
npm i -D playwright && npx playwright install chromium
node demo/shoot.mjs
```

Outputs three screenshots into `demo/`:

| File | Shows |
| --- | --- |
| `01-overview.png` | a room PR board (#142) + the "PRs TO REVIEW" billboard |
| `02-billboard.png` | the review-requested billboard, camera focused |
| `03-dispatch.png` | the review dispatch card for a PR |

`harness.html` stubs the VS Code webview API and replays `state`/`prs`
messages; the mock data mirrors `MOCK_CREW_PRS` / `MOCK_REVIEW_PRS` in
`src/prs.ts`. Open `harness.html` directly in a browser to poke at it live.
