#!/usr/bin/env bash
# Regenerate every image/GIF that the marketplace + GitHub markdown renders, from
# the screenshot harness, so the docs always match the current UI.
#
# Sources: readme.md, MARKETPLACE.md, changelog.md (via media/**). Each still maps
# to a Playwright "*.shot.ts" scenario; the animated cable GIF is assembled from a
# frame sequence with ffmpeg. Hand-made brand art (media/banner.png, media/icon.png)
# is NOT generated here.
#
# Usage:  npm run gen:media     (or)  bash scripts/gen-md-media.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT="screenshots/out"
MEDIA="media"

command -v ffmpeg >/dev/null 2>&1 || { echo "error: ffmpeg not found (brew install ffmpeg)"; exit 1; }

echo "==> Building bundles so the harness reflects current code"
npm run build >/dev/null

echo "==> Capturing scenarios"
# stills (campus/room/agent-panel/settings via capture.shot.ts; marketplace-room
# is its own shot) plus the agent-stream frame sequence.
npx playwright test -g "capture: (campus|room|agent-panel|settings|marketplace-room|agent-stream)"

echo "==> Assembling the cable-stream GIF"
ffmpeg -y -framerate 25 -i "$OUT/agentstream/frame-%03d.png" \
  -vf "scale=760:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  "$MEDIA/agent-stream.gif" >/dev/null 2>&1

echo "==> Copying stills into $MEDIA under their published names"
# src (screenshots/out)            -> dest (media, as referenced by the .md files)
copy() {
  local src="$OUT/$1" dest="$MEDIA/$2"
  [ -f "$src" ] || { echo "error: expected capture missing: $src"; exit 1; }
  cp "$src" "$dest"
  echo "    $1 -> $2"
}
copy campus.png          shot-campus.png         # readme + MARKETPLACE "campus at a glance"
copy room.png            room.png                # readme + MARKETPLACE room cutaway (PR cell)
copy agent-panel.png     shot-agent-panel.png    # readme + MARKETPLACE agent side-panel
copy marketplace-room.png shot-room.png          # MARKETPLACE single room w/ sub-agent badge
copy settings-github.png shot-settings-github.png # readme + MARKETPLACE GitHub access page

echo "==> Done. Review 'git diff -- media/' and commit the updated assets."
