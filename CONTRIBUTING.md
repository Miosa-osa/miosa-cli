# Contributing

This repo (miosa-cli, the developer CLI) follows the MIOSA platform-wide development flow.

**Canonical guide:** https://github.com/Miosa-osa/miosa/blob/main/CONTRIBUTING.md

TL;DR:
- Cut a short-lived branch from `main`, one concern per branch.
- Open a PR, squash-merge — the branch auto-deletes.
- `main` is protected (PR required, no direct push).
- Version bumps: never by hand. `node scripts/release.mjs --dry-run`, then `--apply`; the number is derived from the commits.

## Releasing

The version number is derived, never typed.
`scripts/release.mjs` reads the conventional-commit history since the last release tag and computes exactly one step: a `!` or `BREAKING CHANGE` footer gives a major, any `feat` gives a minor, everything else gives a patch.
It refuses to run when `package.json` disagrees with the version published on npm, so the repository and the registry cannot drift apart.

1. Merge the pull requests for the release into `main` with conventional-commit subjects (`feat(scope): ...`, `fix(scope): ...`).
2. On a clean checkout of `main`, run `node scripts/release.mjs --dry-run` and read the derived version and the generated changelog section.
3. Run `node scripts/release.mjs --apply`.
   It updates `package.json` and `package-lock.json`, prepends the section to `CHANGELOG.md`, commits `chore(release): @miosa/cli X.Y.Z` and creates the annotated tag `vX.Y.Z`.
4. Push the branch and the tag. The publish workflow verifies the tag against `package.json` and publishes.

Do not edit the `version` field or `CHANGELOG.md` by hand.
The `Version policy` workflow fails any pull request that changes the version outside a release commit, or whose new version is not the derived next step, or whose changelog top section does not match.
If the changelog is missing the section for the current published version, `node scripts/release.mjs --backfill --apply` generates it from the commits between the previous and current tags.

