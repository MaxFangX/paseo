# FORK.md — maxfangx downstream fork

This checkout is a **personal downstream fork of Paseo** (owner: maxfangx). Our
changes are not merged upstream; instead, every downstream commit is
**continually rebased onto each new upstream Paseo release**. Optimize every
change to survive that rebase with as few conflicts as possible.

## Architect for rebasability

A conflict can only happen where our commits touch lines that an upstream release
also changed. So shrink that surface:

- **Prefer new files over editing upstream files.** A file upstream doesn't have
  can never conflict. Put as much logic as possible in new modules; reach into
  upstream code only through a thin hook.
- **Make unavoidable upstream edits additive and minimal.** Insert lines; don't
  rewrite, reflow, or rename existing ones. Restructuring a function to fit your
  change turns a clean insertion into a guaranteed conflict.
- **Tag every upstream hook site `PATCH(<feature>)`** (mirroring the repo's own
  `COMPAT(...)` convention). After any rebase, `rg "PATCH\("` lists every place
  our patches touch upstream — the full re-verification checklist.
- **Stay within upstream's lint/complexity caps without restructuring.** Keep a
  hook complexity-neutral so a later upstream change to that same function can't
  push it over a threshold and force a refactor — that's a fresh conflict every
  release.
- **Document downstream behavior here or in the downstream module, never in
  upstream docs.** Editing an upstream doc both conflicts and misdescribes stock
  Paseo (which doesn't have our behavior).

## One commit per concern

Keep each downstream feature in its own self-contained commit so each replays
cleanly during a rebase. Keep **all** customizations to agent instructions
(root `CLAUDE.md`, package `AGENTS.md`/`CLAUDE.md`) in a single dedicated
fork-instructions commit — the same one that carries this file and the pointer to
it at the top of the root `CLAUDE.md`. New instruction tweaks go into that commit.

## Canonical example

`packages/server/src/utils/worktree-branch-cleanup.ts` holds all the logic for
"delete the merged branch when a worktree is archived"; the only upstream edit is
two `PATCH(delete-branch-on-archive)` hooks in `paseo-worktree-archive-service.ts`
— additive and complexity-neutral, 16 inserted lines in one file.
