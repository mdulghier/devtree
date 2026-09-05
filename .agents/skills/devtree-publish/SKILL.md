---
name: devtree-publish
description: Publish stable or preview versions of this Devtree repository through GitHub Actions, monitor releases, and recover failed publishing runs.
---

# Publish Devtree

Package: `@mdulghier/devtree`. Repository: `mdulghier/devtree`.
All npm publication goes through `.github/workflows/npm-publish.yml` and npm trusted publishing. Never run `npm publish` or `pnpm publish` locally, and never create or push release tags manually. A request to configure publishing is not a request to publish a version.

## Trigger from the repository root

Requires Node.js 24+, pnpm, and GitHub CLI authenticated with access to the repository (`gh auth status`). The updated workflow must be on GitHub's default branch before its first dispatch; preview branches must also contain the updated workflow.

- Stable: `pnpm release` from `main`. Prepares the Release Please PR, waits for its verification, squash-merges it, and publishes the resulting version to `latest`. One command performs the entire release.
- Preview: `pnpm release:preview` from the current branch. Publishes a unique version such as `0.5.0-preview.123.1.gabc1234` to `preview`.

Both commands require a clean checkout whose HEAD matches that branch on GitHub. Commit and push the intended changes first; the commands do not commit or push local changes, or publish locally. The stable command merges the generated release PR on GitHub. They send the exact expected commit SHA; Actions refuses if the branch moved before dispatch resolved it.

## Versioning and changelogs

Release Please maintains a pull request with `package.json`, `.release-please-manifest.json`, and `CHANGELOG.md` updates after pushes to main. `pnpm release` handles preparation, verification, and merging automatically; do not ask the user to run a preparation command or manually merge the PR. A request to publish a stable version authorizes merging the generated release PR. Repository protections still apply; never bypass required reviews, checks, or a merge queue. Do not manually bump versions or write a competing changelog. The manifest starts at the last published version, `0.4.0`, even though the working package was already bumped to `0.5.0` before this automation.

Use conventional commit messages (or squash PR titles): `fix:` for fixes, `feat:` for features, and `feat!:` / `BREAKING CHANGE:` for incompatible changes. While below 1.0, breaking changes and features bump the minor version; fixes bump the patch. Non-conventional messages can be omitted from generated notes, so review the first release PR against changes since v0.4.0, including the existing 0.5 breaking changes. For an intentional version override, use Release Please's `Release-As: x.y.z` commit footer rather than editing only package.json.

Release Please is a job in `npm-publish.yml`, alongside verification and publication. It runs after successful verification on pushes to main, or as the first phase of `pnpm release`. The repository must allow GitHub Actions to create pull requests (Settings → Actions → General). No personal access token is needed: the workflow explicitly dispatches verification for its generated PR because PRs created with GITHUB_TOKEN do not automatically trigger Actions.

## What Actions does

Checks types, runs tests, builds, packs, and smoke-tests a fresh install of the tarball. Only stable and preview manual dispatches publish; pull requests only verify, while pushes to main also prepare the next release PR. Pushing a tag no longer triggers publication.

Stable versions must be plain `major.minor.patch`, unpublished, newer than npm's `latest`, and have no existing release tag. After npm succeeds, Actions creates the matching `v<version>` tag and GitHub release at the dispatched commit. The GitHub release body comes from the committed Release Please changelog. The workflow marks the merged Release Please PR as released so the next version can be prepared.

Previews leave the committed version, Git tags, GitHub releases, and npm `latest` untouched. Their versions include the run number, attempt, and commit SHA. All branches share the `preview` npm tag; use the exact version from the run summary when reproducibility matters. Active publications are not automatically cancelled. GitHub concurrency serializes each channel; a newer request can replace an older pending request, so do not queue batches of releases.

## Monitor and report

The commands wait for their Actions runs and print their URLs. Dispatches carry a unique request ID so simultaneous releases are not confused. To resume monitoring a printed run:

```sh
gh run watch <run-id> --repo mdulghier/devtree --exit-status
gh run view <run-id> --repo mdulghier/devtree
```

Dispatch acceptance is not publication success. After the command succeeds, confirm npm metadata and report the version, run URL, and install command:

```sh
npm view @mdulghier/devtree dist-tags --json
pnpm add -D @mdulghier/devtree@<exact-version>
```

Consumers can also use `@preview` or `@latest`. After a stable release, update the clean local main with `git pull --ff-only` to include the generated release commit. If main advances between merging the release PR and dispatching publication, the SHA check stops publication; inspect the new commits before retrying.

## Failure recovery

Inspect `gh run view <run-id> --repo mdulghier/devtree --log-failed` before retrying. npm versions are immutable. If npm succeeded but GitHub release creation failed, rerun only failed jobs (`gh run rerun <run-id> --repo mdulghier/devtree --failed`); do not rerun the successful publish job. If a publish step failed after possibly reaching npm, first check that exact version in the registry. Do not overwrite, unpublish, move tags, or bypass Actions to recover. If registry state and the run disagree, stop and report the state before taking another release action.

For a corrected preview, commit/push the fix and dispatch a new run. Each new run gets a new version. If marking the Release Please PR as released fails, rerun failed jobs; do not republish npm.
