# Bug: `start`/`complete` break git branch state

## Summary

`TaskWorkflowService::start()` and `complete_with_learnings()` assume jj-style
VCS semantics (bookmarks are cheap labels, detaching is normal). When the
backend is `GixBackend` (plain git), these operations silently hijack the user's
branch, auto-commit unrelated files, and leave HEAD detached.

## Reproduction

```
$ git checkout -b my-feature        # user creates branch
$ os task start <id>                # overseer switches to task/<id> branch
$ git branch                        # my-feature is abandoned
  * task/task_01KH6PNR16...         # <-- not what the user asked for
$ # ... user does work, commits ...
$ os task complete <id>
$ git status                        # HEAD detached at start SHA
  HEAD detached at cbf1eb9          # <-- stranded
$ git branch
  master
  my-feature                        # still at old commit, missing all work
```

Reflog proof (real session):

```
@{9}  checkout: native-ts-action → task/task_01KH6PNR16...   # start() hijacked
@{8}  commit on task branch                                   # work landed here
@{7}  checkout: task/task_01KH6... → cbf1eb970c9a             # complete() detached
@{6}  checkout: detached → native-ts-action                   # user manually recovers
```

## Root cause

### `start()` — `workflow_service.rs:40-100`

```rust
// 1. Creates a git branch the user never asked for
let bookmark = format!("task/{}", id);
self.vcs.create_bookmark(&bookmark, None);  // git branch task/<id>

// 2. Silently checks it out, abandoning user's current branch
self.vcs.checkout(&bookmark);               // git checkout task/<id>
```

In jj, `create_bookmark` + `checkout` just moves a label — no branch switch, no
working copy disruption. In git, `checkout` is a destructive branch switch.

### `complete_with_learnings()` — `workflow_service.rs:217-289`

```rust
// 1. Auto-commits everything (git add -A && git commit)
let msg = format!("Complete: {}\n\n{}", task.description, result);
self.vcs.commit(&msg);
// git.rs commit() runs: git add -A && git commit
// This stages ALL untracked files — not just task-related ones

// 2. Checks out raw SHA, detaching HEAD
let checkout_target = task.start_commit.clone();  // e.g. "cbf1eb970c9a"
self.vcs.checkout(target);                         // git checkout cbf1eb9 → DETACHED

// 3. Deletes the task branch
self.vcs.delete_bookmark(bookmark);                // git branch -D task/<id>
```

In jj, checking out a commit ID is normal (jj has no "detached HEAD" concept).
In git, `git checkout <sha>` detaches HEAD, orphaning subsequent commits.

## Three distinct problems

### 1. `start()` switches branches without consent

**Expected git behavior:** Record the current branch/commit as starting point.
Do not create or switch branches. The user manages their own branches.

**Current behavior:** Creates `task/<id>` branch, runs `git checkout task/<id>`,
silently abandoning whatever branch the user was on.

### 2. `complete()` runs `git add -A` indiscriminately

**Expected git behavior:** Do not auto-commit. The user commits their own work.
Record `commit_sha` from the current HEAD.

**Current behavior:** `git.rs:commit()` runs `git add -A && git commit`, staging
everything in the working tree — including unrelated files, editor configs,
build artifacts, etc.

### 3. `complete()` detaches HEAD and deletes branches

**Expected git behavior:** Leave HEAD where it is. Do not delete branches.

**Current behavior:** Checks out the raw start SHA (detaching HEAD), then
deletes the task branch. User is left stranded on a detached commit.

## Affected code

| File                                    | Lines        | Problem                                                                                  |
| --------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `overseer/src/core/workflow_service.rs` | 40-100       | `start()` creates+checks out task branch                                                 |
| `overseer/src/core/workflow_service.rs` | 217-289      | `complete_with_learnings()` auto-commits, detaches, deletes branch                       |
| `overseer/src/core/workflow_service.rs` | 335-440      | `complete_milestone_with_learnings()` same issues, plus deletes all descendant bookmarks |
| `overseer/src/vcs/git.rs`               | `commit()`   | Runs `git add -A && git commit` — stages everything                                      |
| `overseer/src/vcs/git.rs`               | `checkout()` | Checks out raw SHAs, causing detached HEAD                                               |

## Proposed fix

Make `start()`/`complete()` VCS-type-aware. When backend is git:

**`start()`:**

- Do NOT create a branch or checkout
- Record `current_commit_id()` as `start_commit`
- Record current branch name (via `git branch --show-current`) as `bookmark`
  (informational only — don't create it)
- Set `started_at`, bubble to ancestors — same as today

**`complete()`:**

- Do NOT run `git add -A && git commit`
- Record `current_commit_id()` as `commit_sha`
- Do NOT checkout start SHA
- Do NOT delete any branches
- DB updates + bubble completion — same as today

This means for git repos, Overseer is a pure task tracker — it records VCS state
but never mutates it. The user manages branches and commits. This is the correct
behavior for git, where branch operations are heavyweight and have real side
effects.

For jj repos, the current behavior is correct and should be preserved.
