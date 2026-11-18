# Feedback hosts

Use [the shared submission setup](submission.md). Codex's native queue and Agent
Desk deliver directly. Every other harness receives submissions through
`--watch` (or `--wait` once per round), which prints one `SUBMITTED` line per
submission and `PR REQUESTED` lines for Open PR. A cursor delivers each
submission exactly once, including ones made before the watcher started. Only
one watcher per repository runs at a time. Do not also run a watcher when a
native route is active; that could give the agent the same assignment twice.

The optional **Ask Codex** second-opinion feature is independent of the originating
harness and requires an authenticated Codex CLI. It is never used to deliver
submitted feedback.
