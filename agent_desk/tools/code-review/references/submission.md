# Submit back to the originating harness

Launch the preview from the agent session that owns the work. The shared control
shows that destination. The reviewer expands **Submit feedback**, then submits;
a successful queue acknowledgment closes the panel. Failures keep the panel and
saved feedback available. Every harness gets a real submit button: a native
route where one exists, otherwise the watcher below.

All preview commands accept these options:

- `--harness NAME`: coding harness label.
- `--agent-name NAME`: actual session display name shown to the reviewer.
- `--session-id ID`: exact originating session identity, never a guessed name.
- `--feedback-adapter auto|codex|agent-desk|command|watch|manual`.
- `--watch`, or `--wait [--timeout S]`: receive this target's submissions (see below).

Resolve scripts relative to this skill directory. The defaults can also be set
with `GROUND_CONTROL_HARNESS`, `GROUND_CONTROL_AGENT_NAME`,
`GROUND_CONTROL_SESSION_ID`, and `GROUND_CONTROL_ADAPTER`.

## Any harness: the watcher

When the launch has no Codex thread, Agent Desk session, or host bridge, `auto`
selects `watch`. The button still reads **Submit to <agent-name>**, and no
session ID is needed. Each submission is appended to a private queue for that
skill and target. The agent that launched the preview receives it by running
the same script on the same target with `--watch`:

```sh
python3 <skill-dir>/<preview-script> <target> --watch
```

Run it as a background process whose output your harness reports to you, for
example a monitored or backgrounded shell command. Each submission prints one
line, `SUBMITTED <n> open note(s) for <skill>. <prompt with the snapshot path>`.
A harness that cannot be woken by a background process runs `--wait` as a
blocking command once per round instead.

Each submission is delivered exactly once. A cursor survives restarts, a
submission made while nobody watched arrives when the watcher starts, and only
one watcher per target runs (a second exits with status 3). The page says
**Queued for <agent-name>** only while a watcher is heartbeating. Otherwise it
says the agent isn't watching and keeps the prompt available to copy. Do not run
a watcher when a native Codex or Agent Desk route is active.

## Codex

A launch inheriting `CODEX_THREAD_ID` selects the native queue adapter when there
is no conflicting Claude marker or explicit harness override. Explicit form:

```sh
python3 <skill-dir>/<preview-script> <target> --feedback-adapter codex \
  --session-id <originating-thread-id> --agent-name "<session-display-name>"
```

The adapter calls `codex queue --thread ID --message TEXT`. It does not start a
second agent process or choose the most recent session. The installed CLI must
support this command. A zero exit records **queued**, not **implemented**.

## Agent Desk, for any harness it manages

Use `--feedback-adapter agent-desk --feedback-desk-url http://127.0.0.1:PORT`
and `--session-id` with the exact Agent Desk agent/coordinator ID. Set
`AGENT_DESK_TOKEN` in the server environment. Never include it in a document,
command argument, or feedback note. `AGENT_DESK_URL` and
`AGENT_DESK_AGENT_ID` / `AGENT_DESK_COORDINATOR_ID` support automatic selection.
The token stays server-side and is not stored in submission snapshots.

This uses Agent Desk's existing `submit-feedback` endpoint. For workers, use the
coordinator as required by that host. Embedding a preview is separate from
configuring its delivery route; it does not establish a recipient by itself.

## Other hosts, including standalone Claude Code and Cursor

A configured host bridge uses `--feedback-adapter command --session-id ID`
with `--feedback-command '["/absolute/path/to/bridge", "argument"]'`.
The process receives one JSON envelope on stdin with `submission_id`,
`destination`, `snapshot_path`, `message`, and the exact `annotations`.
It must deliver to that exact session and return JSON on stdout:

```json
{"accepted": true, "submission_id": "<same ID>", "session_id": "<same session>"}
```

This is an adapter interface, not a claim that every harness ships a callback
command. Use a host's supported session/channel integration. Do not substitute
`--resume --print`, spawn another agent, paste into an unknown terminal, or guess
an unsupported command. Standalone Claude Code and Cursor need no bridge; they
use the watcher. An adapter should deduplicate `submission_id`.

## Manual mode

Select `--feedback-adapter manual` to skip delivery entirely. The control then
says **Save feedback** and provides a prompt to copy back to the originating
conversation. It does not say sent.
The same JSON snapshot is preserved. The reviewer can keep working without
installing a plugin or changing harness permissions.

## Revisions, failures, and recovery

Snapshots include exact IDs, comments, quotes/coordinates, target, destination,
and a content hash for file targets. They live outside the project under
`~/.cache/ground-control/feedback/` (`GROUND_CONTROL_DATA_DIR` overrides it).
The database and snapshots are private local state, not skill package contents.

Identical notes for the same artifact revision and route reuse the prior
submission, including after restart. Edits produce a new submission. An
interrupted or timed-out delivery is uncertain: inspect the destination before
manually sending again. Clicking again does not automatically replay it.

Read the exact snapshot named in the received prompt, verify anchors against
current content, and resolve only notes actually addressed. Do not infer user
acceptance or permission to publish from a submitted note. Keep private raw
history out of Git.
