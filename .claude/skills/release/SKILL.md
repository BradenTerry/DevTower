---
name: release
description: Cut a DevTower release (patch/minor/major) or pre-release. Use when asked to "release", "cut a release", "ship a version", "publish the extension", "build a patch/minor/major release", or "publish a pre-release/beta". Regular releases push a plain vX.Y.Z tag; pre-releases run the workflow manually with the prerelease box ticked (plain version numbers, no suffix). ALWAYS derives the next version from the latest existing tag, never from package.json.
---

# Releasing DevTower

A release is cut by pushing a `vX.Y.Z` tag. That triggers
`.github/workflows/release.yml`, which sets the version from the tag, builds,
packages the `.vsix`, creates the GitHub release, and publishes to the public
VS Code Marketplace.

## Release vs pre-release channel (chosen per run, no suffix)

Versions are **one continuous line that always increments** - there is no
odd/even or separate numbering, and **no `-suffix`**. Every build, regular or
pre-release, just takes the next plain `vX.Y.Z` number above the latest tag. The
channel is an independent choice made at publish time:

- **Regular release** -> push a plain `vX.Y.Z` tag (the workflow's `push`
  trigger). Always the regular channel.
- **Pre-release** -> run the workflow manually (Actions tab -> **Release** ->
  **Run workflow**), enter the version and tick **prerelease**. That publishes
  `vsce publish --pre-release` and tags the commit. Publishing any pre-release is
  what makes the "Switch to Pre-Release Version" button show on the listing;
  users opt in per-install.

So a sequence might be `v1.0.0` (tag, regular), `v1.0.1` (manual run, prerelease
ticked), `v1.0.2` (tag, regular) - always climbing, channel picked per run.

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

2. **Compute the next version** from that latest tag (same bump for either
   channel - plain numbers, no suffix):
   - patch: bump Z (`v0.7.1` -> `v0.7.2`) - bug fixes, packaging, docs, screenshots
   - minor: bump Y, reset Z (`v0.7.1` -> `v0.8.0`) - new features
   - major: bump X (`v0.7.1` -> `v1.0.0`) - breaking changes

   Confirm the computed tag does not already exist
   (`git tag | grep -x vX.Y.Z` returns nothing).

3. **Make sure the release commit is ready on `main`.** The build must run
   against a commit already pushed to `origin/main`. Run `npm run typecheck` and
   `npm test` if the working tree changed. Sanity-check the package size with
   `npm run package` (see CLAUDE.md "Packaging hygiene" - a clean build is a
   few MB, not tens).

4. **Publish on the chosen channel.**

   - **Regular release** - tag and push (be sure the version is correct; this
     publishes to the public Marketplace):

     ```sh
     git tag -a vX.Y.Z -m vX.Y.Z
     git push origin vX.Y.Z
     ```

   - **Pre-release** - trigger the workflow manually with the prerelease box
     ticked (it tags the commit for you, so do NOT also push a tag):

     ```sh
     gh workflow run release.yml -f version=X.Y.Z -f prerelease=true
     ```

5. **Watch the workflow** and confirm it published.

   ```sh
   gh run watch "$(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')" --exit-status
   gh release view vX.Y.Z --json tagName,isPrerelease,assets -q '{tag:.tagName, prerelease:.isPrerelease, assets:[.assets[].name]}'
   ```

   A healthy run shows the `Publish to VS Code Marketplace` step green and a
   `DevTower.vsix` asset on the release.
