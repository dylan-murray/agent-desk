# Contributing

## Development setup

Install Python 3.11+ and Node.js 22+ on macOS or Linux, with `python3` and `node` available on your `PATH`. Development uses Node.js 22+, as CI does: Playwright requires 20+ and `tests/test_observer_refresh.cjs` uses Node's built-in `WebSocket`. The application runtime supports Node.js 18+. Python launches Node helpers as subprocesses. Installing the Python package does not install Node.js or your agent CLIs.

From the repository root:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e .
python -m agent_desk
```

There is no frontend build step. Edit assets in `agent_desk/static/` and refresh the browser. Restart the web server for backend Python changes. Managed local terminals now belong to a persistent supervisor and survive backend exits and crashes. If the supervisor itself ends, its next start restores those terminals and resumes agent conversations. The first upgrade from an older server still stops its old terminals: finish or save those before that one-time transition. Supervisor changes require draining its sessions first; see [restart behavior](docs/guide.md#backend-restarts-and-terminal-supervision).

Set `AGENT_DESK_DATA_DIR` to a temporary directory when running a separate development instance. Local databases, credentials, logs, and generated artifacts must stay out of Git.

## Checks

```sh
python -m unittest discover -s tests
node --test tests/test_*.cjs
```

The Python suite exercises real loopback HTTP servers and local terminal processes. It needs permissions to open sockets and create PTYs. Tests use fixtures rather than calling model services.

Browser checks live in `tests/browser/`. See [their instructions](tests/browser/README.md) for isolated server setup. Packaging can be checked with `python -m pip wheel --no-deps .`.

## Code organization

- Put application logic in `agent_desk/`, using absolute `agent_desk.*` imports.
- Keep HTTP routing in `agent_desk/server.py` and domain behavior in the corresponding runtime module.
- Put browser code and styles in `agent_desk/static/`; retain vendor license files when updating bundled libraries.
- Keep worker-facing command-line entry points in `scripts/`. They must work when invoked by absolute path from another project's working directory.
- Add regression coverage for behavior changes, especially mailbox delivery, session ownership, authentication, and terminal replay.
- Document user-visible behavior in `docs/guide.md`.

Keep changes focused and describe the problem, resulting behavior, and validation when proposing a change.
