# Code review

A local diff review UI for your coding agent. Comment on lines and ranges,
attach exact suggestions, and submit feedback back to the originating session.
The same Python tool works independently of the agent's harness.

Install through Ground Control's shared skills package. Requires Python 3.10+,
Git, and a browser. **Ask Codex** additionally needs an authenticated Codex CLI.

```sh
python3 <skill-dir>/review_app.py <repo> --agent-name "My agent"
python3 <skill-dir>/review_app.py <repo> --dump
python3 <skill-dir>/review_app.py <repo> --reply 1 "Corrected and verified" --author "My agent"
```

**Submit to My agent** saves an immutable feedback snapshot and queues a prompt
through the configured host adapter. It closes the feedback panel after a queue
acknowledgment. Manual mode offers **Save feedback** and **Copy prompt**.
See [submission setup](references/submission.md) for the exact session routing,
bridge protocol, environment variables, and failure behavior.

Use `--help` for the complete CLI. `--port` selects a port, `--base` selects the
branch comparison, and `REVIEW_APP_HOME` chooses the private notes directory.
Without a native route, run `--watch` in the background to receive submissions
and PR requests; skip it when a native adapter is already configured.
