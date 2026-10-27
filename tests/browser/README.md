# Browser checks

With Node.js 22+, install the optional browser tooling:

```sh
npm ci
npx playwright install chromium
```

Start a separate server with disposable state (do not use your active workspace for browser tests):

```sh
AGENT_DESK_DATA_DIR="$(mktemp -d)" python3 -m agent_desk --port 4322
```

In another terminal:

```sh
AGENT_DESK_TEST_URL=http://127.0.0.1:4322 npm run test:browser
```

These checks cover coordinator panes, team selection, modal annotations, and feedback reconciliation. The remaining `.cjs` files can be run individually with the same environment. Some integration checks create local fixture terminals and workflows; they require an isolated server with process-launch permission. No paid agent CLI is needed for fixtures.

Always set `AGENT_DESK_TEST_URL` to the isolated server. `npm run test:browser` refuses to start if it is missing, non-loopback, or points to the live port 4310. Set `CHROME_PATH` to use an existing Chrome executable instead of Playwright's bundled Chromium. Screenshots are written to your operating system's temporary directory or the evidence path selected by the check.

`terminal-files.cjs` also starts its own disposable backend and raw fictional PTY. It checks browser text/long paste, mixed image/text payloads, Ctrl+V and Shift+Enter at 1280px and 480px, with no desktop upload handlers. It does not use the server selected by `AGENT_DESK_TEST_URL`; the same isolated-URL guard still applies. The desktop's native screenshot Paste and file-drop checks are `npm --prefix desktop run test:paste-drop`.

`backend-restart.cjs` additionally launches its own backend with a temporary data directory and dynamically allocated loopback port. It checks real graceful and forced backend exits, buffered output recovery, preserved pane identity, keyboard input, narrow layouts/reload and explicit Stop. It never restarts the server supplied in `AGENT_DESK_TEST_URL`. Set `AGENT_DESK_TEST_PYTHON` if Python 3.11+ is not on the default path (macOS defaults to `/opt/homebrew/bin/python3.12` when present). Its cleanup stops only fixture-owned terminals and drains that fixture supervisor. When stopping other isolated test instances, their supervised sessions now remain alive until explicitly stopped.
