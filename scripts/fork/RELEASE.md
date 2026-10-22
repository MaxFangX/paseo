# Fork releases (maxfangx)

Personal builds of the desktop app, published as GitHub Releases on
[MaxFangX/paseo](https://github.com/MaxFangX/paseo/releases). macOS arm64
only for now. Builds are ad-hoc signed (no Developer ID cert), so recipients
must right-click → Open on first launch; the release notes say so.

Releases are named `maxfangx-<branch>-<YYYY_MM_DD>` (UTC). A leading
`maxfangx-` on the branch is not doubled: branch `main` releases as
`maxfangx-main-2026_08_13`, branch `maxfangx-v0.4.0` as
`maxfangx-v0.4.0-2026_08_13`. The release name is also the git tag.

## Cutting a release

Locally, from the branch to release (see the script header for flags and for
why it packages the dmg/zip itself):

```bash
./scripts/fork/release-macos-arm64.sh              # real release
./scripts/fork/release-macos-arm64.sh --dry-run    # build + smoke only
./scripts/fork/release-macos-arm64.sh --draft      # draft release
```

The branch must be pushed to the fork first — the release tags its head
commit on GitHub.

Via CI: Actions → `fork-release-macos` → Run workflow, picking the branch.
`is_dry_run` skips publishing (the dmg lands as a workflow artifact),
`is_draft` publishes a draft. Pushing to `release-test/fork-macos` runs an
automatic dry run.

## Releasing an upstream release + our commits

To ship upstream release `vX.Y.Z` with the fork's commits on top:

```bash
git fetch upstream --tags
jj git import
jj bookmark create maxfangx-vX.Y.Z -r "$(git rev-parse 'vX.Y.Z^{commit}')"
just -g workspace add maxfangx-vX.Y.Z
cd ~/dev/workspaces/maxfangx-vX.Y.Z
jj duplicate <fork stack change IDs, bottom to top> -d maxfangx-vX.Y.Z
jj bookmark set maxfangx-vX.Y.Z -r <duplicated tip>
jj git push --remote origin --bookmark maxfangx-vX.Y.Z
npm install
./scripts/fork/release-macos-arm64.sh
```

`git rev-parse 'vX.Y.Z^{commit}'` matters: upstream tags are annotated, and
jj can't resolve the tag object id.

If a duplicated commit conflicts because upstream shipped its own version of
the change, don't text-merge: pin the commit's files back to its parent
(`jj restore --from <parent> --into <commit> <paths>`), keep only what
upstream still lacks, and rename the commit to match what's left — or drop
the commit entirely once nothing worth keeping remains. The same applies when
rebasing `main` onto upstream. This already happened once: the relay
low-order-key fix was superseded by upstream's own version (PR #3669, first
shipped in 0.5.0) and was eventually dropped from the fork.

## After the release

Install it and retire what the release leaves behind. Nothing here can break
the running app: home-manager's `copyApps` installs a real copy under
`~/Applications/Home Manager Apps`, so the live process holds no file in a
worktree or the nix store.

```bash
cd ~/.dotfiles && just update paseo-app && hms   # pin the new tag, install
```

Relaunch Paseo at a quiet moment. Until then the window still runs the bundle
it loaded at launch while the daemon has already picked up the new files; the
relaunch restarts the daemon on 6767 and every agent it manages.

Once the new build is running, remove the previous release's worktree. Its
branch, tag, and zip stay on GitHub:

```bash
just -g workspace remove ~/dev/workspaces/maxfangx-vOLD
```

The script already deletes its ~900MB of build output after publishing. Old
builds in the nix store are freed by expiring home-manager generations and
running `nix-collect-garbage`.
