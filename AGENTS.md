# Agent Desk contributor instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code organization and tests.

For macOS desktop work, also read [desktop/AGENTS.md](desktop/AGENTS.md) and [desktop setup](desktop/README.md). After dependency setup, launch from the repository root with `npm --prefix desktop start`. Desktop checks must use disposable profiles and fictional sessions.

When the user says they left annotations, read the current `data/feedback.json` (or the configured `AGENT_DESK_DATA_DIR`). Annotations made in Agent Desk Dev (`npm --prefix desktop start`) are in the desktop profile instead: `~/Library/Application Support/Agent Desk Dev/data/feedback.json`, or `$AGENT_DESK_PROFILE_DIR/data/feedback.json`. Ask which app the user annotated if it is unclear. Work from active notes or the exact submitted snapshot. Archived or cleared notes are historical, not new assignments.

For each feedback batch:

1. Keep the exact note text, ID, target text, selector, coordinates, viewport and page with the change.
2. Inspect the current UI before changing it, and capture a before screenshot when you can. Browser checks write screenshots to `AGENT_DESK_EVIDENCE_DIR` (default: the system temp dir).
3. Implement and validate the behavior at desktop and narrow widths, with the state transitions it touches.
4. Keep **implemented**, **verified** and **unresolved** distinct. Complete feedback changes after implementation and the relevant automated checks pass; no separate user acceptance is required. Record **accepted** or **rejected** only when the user explicitly gives that judgment.

Keep raw sessions, credentials, private conversations and annotation archives in ignored local state. Use focused fixtures, not real sessions, in screenshots and tests.
