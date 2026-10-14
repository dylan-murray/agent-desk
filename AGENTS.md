# Agent Desk contributor instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code organization and tests.

When the user says they left annotations, read the current `data/feedback.json` (or the configured `AGENT_DESK_DATA_DIR`). Work from active notes or the exact submitted snapshot. Archived or cleared notes are historical, not new assignments.

For each feedback batch:

1. Keep the exact note text, ID, target text, selector, coordinates, viewport and page with the change.
2. Inspect the current UI before changing it, and capture a before screenshot when you can. Browser checks write screenshots to `AGENT_DESK_EVIDENCE_DIR` (default: the system temp dir).
3. Implement and validate the behavior at desktop and narrow widths, with the state transitions it touches.
4. Keep **implemented**, **verified**, **accepted**, **rejected** and **unresolved** distinct. A passing test, a commit or a cleared pin is not acceptance.

Keep raw sessions, credentials, private conversations and annotation archives in ignored local state. Use focused fixtures, not real sessions, in screenshots and tests.
