---
name: code-review
description: "Review an agent's code changes in a local diff UI, collect anchored comments and suggestions, and apply verified corrections. Use when the user asks to review or annotate a working-tree or branch diff."
---

# Code review

Serve the diff GitHub-style, let the reviewer point at lines and suggest changes,
read submitted feedback, fix, and mark addressed.
Repeat until they say ship it. Review-only by design: they never edit code
on the page, they suggest; you apply.

## Submit feedback to the originating session

Read [the submission setup](references/submission.md) before launching the
preview. Pass the actual session display name with `--agent-name`. The
**Submit to <agent-name>** control uses Codex's native queue or Agent Desk when
the launch has one. Otherwise it delivers to a watcher, which works in any
harness: right after launching, start

```sh
python3 <skill-dir>/review_app.py <repo> --watch
```

as a background process whose output you are notified about, and treat each
`SUBMITTED` line as the reviewer's request. A harness without background
notifications runs `--wait` once per round instead. Submissions made before the
watcher starts wait and arrive when it does. A queued submission is not an
accepted or completed correction.

The skill was previously named `review-app`. The `review_app.py` entrypoint and
`~/.cache/review-app` note storage remain compatible.

## Host compatibility

Requires Python 3.10+, Git, and browser access to the local server. Resolve all
resources from this skill directory. For remote hosts, use a supported preview
or port-forwarding mechanism; a loopback URL on the host is not automatically
reachable from the reviewer's browser.

## Review boundaries

Work from the current feedback or the exact submitted revision. Preserve note IDs,
quoted targets, and unresolved disagreements. Re-read the target before applying
a suggestion; earlier line numbers may be stale. Report what changed and what
was actually checked. Addressed means implemented, not accepted by the reviewer.
Keep private annotation history out of Git. Promote lessons only from explicit
preferences or repeated evidence, and preserve their original scope.

Use the user's requested file, repository, and output location. Follow applicable
project instructions. Publishing or opening a PR needs authorization for that
action; submitting review feedback alone does not grant it.

## Workflow

`<skill-dir>` below is the directory that contains this SKILL.md (every harness gives you that location when it loads the skill).

1. Start the app on the repo (runs until killed, so background it):

   ```
   python3 <skill-dir>/review_app.py <repo>
   ```

   Default diff is the working tree (staged, unstaged, untracked) against
   HEAD, i.e. "what you just did". For a branch review use
   `--base main` (merge-base, working tree included). Add `--no-browser` if
   they already have a tab open, `--port N` if 8767 is taken. Tell them the URL
   in one line.
   Untracked files sit last under their own heading, marked U, and the
   reviewer can hide them; `--no-untracked` leaves them out altogether.

2. **Configure the originating session.** Use the shared submission setup
   above. The **Submit to <agent-name>** button saves the exact notes and queues
   a prompt containing that snapshot's path. Read that snapshot when it arrives.
   Without a native route, start `--watch` in the background right after
   launching (see above); it also prints `PR REQUESTED` lines. Skip the watcher
   when a native Codex or Agent Desk route is active.

3. On a submission, read the notes:

   ```
   python3 <skill-dir>/review_app.py <repo> --dump
   ```

   Each note has an id, a kind (`line` | `chunk` | `selection` | `pin` |
   `file` | `general`), the file and 1-indexed line range on a side (`new` =
   working tree, `old` = base), the exact quoted lines (capped at 14 in the
   dump), their comment, and optionally a ```suggestion``` block that is the
   replacement for exactly those lines (empty block = delete them). A
   `selection` also carries the exact phrase they highlighted; a `pin` carries
   its position in the file box and the nearest line.

4. Apply. For exact suggestions, let the tool do it and verify the match:

   ```
   python3 <skill-dir>/review_app.py <repo> --apply 3 5
   ```

   It only edits when the quoted lines still read exactly as they did when
   they commented; otherwise it says "apply by hand" and you do. Comments
   without a suggestion you address yourself, as usual. Run the project's
   tests/lint on what you touched.

5. **Reply to every note on the page**, then mark what you actually changed.
   One command does both, and the replies show up under each comment in
   the sidebar and inline thread, labelled with the supplied session name:

   ```
   python3 <skill-dir>/review_app.py <repo> --author "<session-name>" \
     --reply 3 "tightened to one call; the helper was only used here" \
     --reply 5 "left as is — snowpark has no public API for this, see chat" \
     --round-reply "round 2 applied: 117 tests pass, ruff clean" \
     --resolve 3 --proof "pytest tests/test_query.py: 14 passed"
   ```

   `--resolve` needs `--proof`: the check you ran for that fix and what it
   showed. Add `--proof-file shot.png` when a screenshot shows it better. The
   proof shows under the note, so they can see the fix was checked, not just
   claimed. A reply per note is not optional: it is how they review your work without
   leaving the page. Say what changed, or why you didn't change it. Follow the active project and user writing preferences. Keep replies short
   and state uncertainty plainly.
   `--apply` resolves what it applied. Never resolve a note the code didn't
   change for; a note you disagree with stays open with your reply under it.
   The page hot-reloads when the diff changes, with addressed threads
   greyed out, so they see the fix land in place.

6. Also say it in chat, shorter: one line per note. They press **Clear done**
   (or **Clear all**, both top of the sidebar) to archive the round and start
   the next; `--clear done|all` does the same from the CLI, `--delete ID…`
   drops notes without archiving.

**On `PR REQUESTED`:** the reviewer approved the change. Write the PR title and
body with the `pull-request-description-review` skill's format — conventional-commit
title with the ticket key, `## Why` / `## What` / `## Verified` body written from the
change and the review rounds, not from a template — and save them for review.
Do not commit or push yet:

```
python3 <skill-dir>/review_app.py <repo> --pr-title "fix(fees): clamp late fees at zero (LIB-12)" --pr-body-file body.md
```

The page shows it as a **Pull request description** card above the diff. The
reviewer comments on the title or on selected text in the body; those arrive as
`[pr title]` / `[pr body]` notes in the next submission, with the current draft
printed at the end of `--dump`. Revise and save again with the same command
(each save is a new rev). Repeat until the watcher prints `PR APPROVED`.

**On `PR APPROVED`:** commit only the reviewed, authorized changes on the current
branch (if it is `main`, branch first: `review/<short-slug>`), push, and open the
PR with exactly the approved title and body (`--pr-description` prints them). The
request carries a draft flag (default draft). Then record it so the page shows the link:

```
python3 <skill-dir>/review_app.py <repo> --pr-url https://github.com/org/repo/pull/123
```

and `--round-reply` a one-liner with the URL. Do not commit files the reviewer
left uncommitted on purpose (WIP they mentioned, secrets, `.env`); ask in the
round reply if the tree has anything that looks like it.

**Second-opinion notes are for you to triage, not obey.** They arrive with the
reviewer's name, e.g. `(Codex)` or `(Claude)`, on the `--dump` head line. Treat
each like a reviewer comment: fix it and reply, or reply why not and leave it
open for the reviewer to close. The **Second opinion** menu lists every coding
CLI found on PATH (Codex, Claude, Grok, OpenCode, Pi) plus all of them at once;
each runs read-only and leaves its own notes. `--second-opinion [codex|claude|grok|opencode|pi|all]`
runs the same review from the CLI (default codex; each CLI must be signed in).
`REVIEW_APP_CODEX_MODEL` / `REVIEW_APP_CLAUDE_MODEL` pick models,
`REVIEW_APP_CODEX_TIMEOUT` / `REVIEW_APP_CLAUDE_TIMEOUT` cap runs (default 900s).
One run per reviewer at a time; the button shows who is still reviewing.

They can reply back under any note (the `reply…` box). Those come through
in the next `--dump` as `↳ the reviewer: …` lines, so re-read the dump on every
submission rather than assuming a note's text is unchanged.

## What the reviewer can do on the page

| Action | Note kind | What you get |
|---|---|---|
| Click a line's code text (or its line number) | `line` | file, side, that line's text |
| Press a line number and drag (or shift-click another line) | `line` | the range, all lines quoted |
| Select a phrase, click the 💬 bubble | `selection` | the exact phrase (`selected:`) plus the line(s) it sits on |
| `¶` in the left gutter of a changed block (lights up the whole run on hover) | `chunk` | every line of that contiguous change, with a `(N changed lines)` label |
| Click a `@@ … @@` hunk header | `chunk` | the whole hunk's new-side lines |
| `± Suggest change` in the composer (line / selection / chunk, new side) | + `suggestion` | replacement text for the anchored lines, prefilled with the current ones |
| `Comment on file` in a file header | `file` | file-level note |
| `G` or **General note** | `general` | whole-change feedback |
| **Submit to <agent-name>** | — | saves exact feedback and queues it to the configured originating session |
| **✓ Approve & open PR** (shift-click: not a draft) | — | approves the change and records a PR request (it asks first while notes are still open); the watcher prints `PR REQUESTED`, you save a title and body for review, and **⇪ Approve description & open PR** on that card prints `PR APPROVED`, see below |
| **✦ Second opinion ▾** | notes authored by that reviewer | runs Codex, Claude, Grok, OpenCode or Pi (whichever are installed, or all) read-only on the current diff; comments land as line/file notes tagged `[bug]`/`[risk]`/`[nit]`/`[question]`, each summary as a round reply |
| Select text in the PR description card, or **Comment** on its title/body | `pr` | the part (`title`/`body`) and the selected text |
| **⇣ Pull GitHub reviews** (under the PR link, once `--pr-url` is recorded) | notes authored by each GitHub user | imports the PR's inline review comments (anchored to their lines; outdated ones as file notes, `[outdated]`), replies as thread replies, review summaries and conversation comments as general notes. Each GitHub item is imported once; `--pull-reviews` does the same from the CLI (needs `gh` signed in) |
| **↓ / ↑ / ↕** on a hunk header (and after the last hunk) | — | shows hidden unchanged lines, 20 at a time or all; **⤒** hides them again. Expanded lines take comments like any line |
| **«** at the top of the file list | — | collapses the file list to a narrow strip; remembered in the browser |

Chunk and selection notes are still anchored to a line range, so `--apply`
works on their suggestions too. A pin's `relX`/`relY` are fractions of the
file box; the nearest line is what to read, the position is for layout /
"this whole area" feedback.

Every note carries a reply thread (agent replies via `--reply`, theirs via
the `reply…` box); round-level replies sit at the top of the sidebar.
Sidebar notes autosave on edit; `done` / `reopen` / `delete` per note;
**Copy notes** puts the `--dump` text on his clipboard for when the
session is gone. Unified/Split toggle and light/dark persist in the
browser. `?file=<substring>` renders one file, `?view=split&theme=light`
force a view (handy for screenshots).

## Where things live

- Notes: `~/.cache/review-app/<repo>-<hash>.review.json`, outside the repo
  so `git status` stays clean. `--notes-path` prints it.
  `REVIEW_APP_HOME` overrides the directory.
- Archive of past rounds next to it as `.archive.json`;
  `history/annotations.jsonl` in this skill dir is the append-only corpus
  across every repo. Promote recurring corrections into `lessons.md`.
- `vendor/`: highlight.js + GitHub light/dark code themes
  (`vendor/VERSIONS.txt`). Stdlib-only Python otherwise.

## Rendering fidelity

Unified diff from `git diff -U3 --find-renames` plus `--no-index` for
untracked files, parsed in Python; the browser highlights each side's
*whole file* with highlight.js and splits the result per line so
multi-line strings and comments keep their colour. GitHub's colours for
add/del/hunk rows, line-number gutters, sticky file headers, `M/A/D/R`
badges, `+n −m` stats. Known gaps: no word-level intra-line diff
highlighting, no "expand context" arrows, binary files show a placeholder.

## Gotchas

- Record the server and watcher PIDs. Stop only those processes when the
  review is finished; choose another port if an unrelated review is running.
- **After editing `review_app.py`, restart the `--watch` monitor too**, not
  just the server. A running watcher keeps the old code, so a button it
  doesn't know about (this happened with Open PR) fires on the server and
  never reaches the session.
- `--apply` line numbers are the *new* side as of when they commented. If you
  edited above the range since, the quote check fails and it tells you;
  that is the point, not a bug. Re-read `--dump` and apply by hand.
- Suggestions on the `old` side (deleted lines) can't be auto-applied;
  they read as "put this back" and you do it by hand.
- Comments are anchored by file + line, so `git stash`/checkout of another
  branch makes the threads disappear from the page until the diff is back.
  The notes file is untouched.
- Headless check after UI changes: `--dump-dom` with `?probe=1` sets
  `document.title` to the geometry of the first file header/body; the
  header must start where the section starts, not 45px below it (that was
  the sticky-inside-`overflow:hidden` bug).


## Show this UI inside Agent Desk

When the user is working in Agent Desk and wants an embedded preview, locate its checkout (`<agent-desk-dir>`) and use its optional launcher:

```sh
python3 <agent-desk-dir>/scripts/skill_ui.py --skill review-app --target <file-or-repo>
```

Replace `<file-or-repo>` with the input this skill normally serves. The helper starts the existing UI without a browser, chooses a local port, and registers an `/apps/...` endpoint in Agent Desk. Add `--title "..."` and `--agent-id SESSION_ID` when useful; pass existing UI options after `--`. The skill still owns its server, watcher, input files, and feedback. Continue using this skill's existing dump/resolve/watch workflow. Do not claim that embedding changes who receives callbacks. If Agent Desk is unavailable, use the standalone launch instructions above. For an already-running UI, use `--url http://127.0.0.1:PORT` instead of launching again.
