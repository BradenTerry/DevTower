---
name: release
description: Cut a DevTower release (patch/minor/major) by pushing a version tag. Use when asked to "release", "cut a release", "ship a version", "publish the extension", or "build a patch/minor/major release". ALWAYS derives the next version from the latest existing tag, never from package.json.
---

# Releasing DevTower

A release is cut by pushing a `vX.Y.Z` tag. That triggers
`.github/workflows/release.yml`, which sets the version from the tag, builds,
packages the `.vsix`, creates the GitHub release, and publishes to the public
VS Code Marketplace.

## The version lives in the git tag, not package.json

The tag is the single source of truth. The workflow injects it into
`package.json` at build time. The committed `package.json` `version` is a
stale placeholder (it has sat at `0.4.0` across many releases). **Never** read
the next version from `package.json`, and never hand-edit it to "bump".

## Steps

1. **Find the latest released version.** Do this first, every time. Do not
   assume or reuse a number from earlier in the conversation.

   ```sh
   git fetch --tags
   git tag --sort=-v:refname | head -3   # newest tags
   gh release list -L 3                  # cross-check the published latest
   ```

   Use the higher of the two if they ever disagree.

2. **Compute the next version** from that latest tag:
   - patch: bump Z (`v0.7.1` -> `v0.7.2`) - bug fixes, packaging, docs, screenshots
   - minor: bump Y, reset Z (`v0.7.1` -> `v0.8.0`) - new features
   - major: bump X (`v0.7.1` -> `v1.0.0`) - breaking changes

   Confirm the computed tag does not already exist
   (`git tag | grep -x vX.Y.Z` returns nothing).

3. **Make sure the release commit is ready on `main`.** The tag must point at a
   commit already pushed to `origin/main`. Run `npm run typecheck` and
   `npm test` if the working tree changed. Sanity-check the package size with
   `npm run package` (see CLAUDE.md "Packaging hygiene" - a clean build is a
   few MB, not tens).

4. **Tag and push.** Pushing the tag publishes to the public Marketplace, so be
   sure the version is correct first.

   ```sh
   git tag -a vX.Y.Z -m vX.Y.Z
   git push origin vX.Y.Z
   ```

5. **Watch the workflow** and confirm it published.

   ```sh
   gh run watch "$(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')" --exit-status
   gh release view vX.Y.Z --json tagName,assets -q '{tag:.tagName, assets:[.assets[].name]}'
   ```

   A healthy run shows the `Publish to VS Code Marketplace` step green and a
   `DevTower.vsix` asset on the release.
