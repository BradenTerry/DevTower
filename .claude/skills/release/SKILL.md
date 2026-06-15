---
name: release
description: Cut a DevTower release (patch/minor/major) or pre-release by pushing a version tag. Use when asked to "release", "cut a release", "ship a version", "publish the extension", "build a patch/minor/major release", or "publish a pre-release/beta". A "-" suffix on the tag picks the channel (plain = regular, vX.Y.Z-pre = pre-release). ALWAYS derives the next version from the latest existing tag, never from package.json.
---

# Releasing DevTower

A release is cut by pushing a `vX.Y.Z` tag. That triggers
`.github/workflows/release.yml`, which sets the version from the tag, builds,
packages the `.vsix`, creates the GitHub release, and publishes to the public
VS Code Marketplace.

## Release vs pre-release channel (a "-" suffix on the tag decides)

Versions are **one continuous line that always increments** - there is no
odd/even or separate numbering. Every release, regular or pre-release, just
takes the next number above the latest tag. A `-` suffix on the tag is the only
thing that decides which channel that version lands on:

- **Plain** `vX.Y.Z` (`v1.0.0`) -> **regular** release channel.
- **`-` suffix** `vX.Y.Z-<anything>` (`v1.0.1-pre`, `v1.0.1-beta`) ->
  **pre-release** channel (`vsce publish --pre-release`). This is what makes the
  "Switch to Pre-Release Version" button show on the listing; users opt in
  per-install.

The Marketplace version can't contain `-`, so the workflow **strips the suffix**
before publishing (`v1.0.1-pre` publishes as `1.0.1`); the suffix only flips the
channel and names the git tag/GitHub release. So a normal sequence might be
`v1.0.0` (regular), `v1.0.1-pre` (pre-release), `v1.0.2` (regular),
`v1.0.3-pre` (pre-release) - always climbing, channel decided per tag.

## The version lives in the git tag, not package.json

The tag is the single source of truth. The workflow injects it into
`package.json` at build time. The committed `package.json` `version` is a
stale placeholder (it has sat at `0.4.0` across many releases). **Never** read
the next version from `package.json`, and never hand-edit it to "bump".

## Steps

1. **Find the latest tag across both channels.** Versions are one continuous
   line, so the next number is above the highest existing tag whether it was a
   regular or a pre-release. Do this first, every time. Do not assume or reuse a
   number from earlier in the conversation.

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

   For a **pre-release** build, bump the same way but add a `-` suffix to the
   tag (see the channel rule above): e.g. latest is `v1.0.0` -> tag `v1.0.1-pre`.
   The workflow strips the suffix and publishes `1.0.1` to the pre-release
   channel.

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
