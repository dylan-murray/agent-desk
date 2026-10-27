# Agent Desk for macOS

The desktop app targets Apple Silicon and macOS 14+. Packaged builds bundle Python and Node 24; source development uses your local interpreters. Install and authenticate your agent CLIs separately. The normal browser command, `python3 -m agent_desk`, remains supported with its localhost HTTP/WebSocket server.

Desktop HTTP requests use native `fetch()` through `agent-desk://app` and a private Unix socket. Terminal events use one Electron message-port adapter over the existing socket transport. Agent Desk and compatible managed visual tools do not need TCP listening ports. Agent CLIs, login callbacks, MCP integrations, and development servers you run may use ports independently.

## Development

Use Python 3.11+ and Node 24, matching desktop CI and the bundled Node runtime. For the first launch, start in the repository root:

```sh
npm ci
cd desktop
npm ci
npx install-electron --no
npm start
```

After setup, launch from the repository root with:

```sh
npm --prefix desktop start
```

This runs the same command as `npm start` inside `desktop/`. The remaining npm commands in this guide run from `desktop/`.

The start command prepares a cached, locally signed development bundle named Agent Desk Dev with its own Dock label and profile. It still loads the current checkout, and Forge’s restart command remains available. The bundle is rebuilt when Electron or the icon changes; `node_modules` and the installed app are not modified.

About shows **Version 0.1.0** (using the shared version from `../pyproject.toml`) with a separate **Development build · <commit>** or **Release build · <commit>** line. Running from source always shows Development build, including at a release-tagged commit. Full metadata, including the UTC build date and uncommitted-change flag, is saved to `logs/build-info.json`, available through **Agent Desk → Open Local Diagnostics**. Desktop source package manifests deliberately omit a separate version; packaging derives it from the project version.

`AGENT_DESK_PYTHON` and `AGENT_DESK_NODE` select development interpreters. Packaged builds always use their bundled runtimes. Source development does not require signing credentials.

### Editing the source

There is no compile step for the app code. `npm start` serves `agent_desk/static/` and runs `agent_desk/` straight from your checkout; only the cached Agent Desk Dev wrapper is built, and only when Electron or the icon changes. The browser workflow, `python3 -m agent_desk`, is unchanged and uses the same files.

| You changed | Browser (`python3 -m agent_desk`) | Agent Desk Dev (`npm --prefix desktop start`) |
| --- | --- | --- |
| Frontend (`agent_desk/static/`) | Reload the page | **View → Reload** |
| Backend Python (`agent_desk/`) | Restart the server | **Agent Desk → Restart Backend** (terminals keep running) |
| Terminal supervisor or worker code | Stop sessions, then restart | **Stop Work and Quit**, then start again |
| Electron shell (`desktop/src/`) | — | Quit and start again |
| Installed `Agent Desk.app` | — | Rebuild and reinstall (`npm run package`); it runs its own bundled copy |

A source edit therefore reaches both the browser and Agent Desk Dev after the step above. If a backend edit fails to start, fix it and press Retry: the restarted backend reattaches to the surviving terminals, as browser mode does. Quit refuses to close while terminals are running and the backend cannot start, so it never leaves them unmanaged.

Agent Desk Dev turns on development tools, including the annotation launcher, Feedback page and **Send to agent**, as browser mode does by default. Installed apps keep them off. Annotations are saved to the profile, `~/Library/Application Support/Agent Desk Dev/data/feedback.json` (or `$AGENT_DESK_PROFILE_DIR/data/feedback.json`), not to the checkout's `data/`. Browser mode and each desktop profile keep separate notes. Notes are only notes: an agent must implement them before the code changes. **Send to agent** gives the agent the absolute path of the submitted notes.

Installed apps default to `~/Library/Application Support/Agent Desk/`. Source/debug runs default to `~/Library/Application Support/Agent Desk Dev/`, so both can run independently:

```text
Agent Desk/
├── data/       # Databases, accounts, sessions, window state and shutdown state
├── browser/    # Chromium storage
├── runtime/    # Verified bundled Python, Node and application code
└── logs/       # Desktop backend/bootstrap diagnostics and startup timing
```

Set `AGENT_DESK_PROFILE_DIR` to choose a separate desktop profile. The desktop launcher sets its backend's `AGENT_DESK_DATA_DIR` to the profile's `data/` directory; an inherited web-mode `AGENT_DESK_DATA_DIR` does not select a desktop profile. Browser mode keeps its existing data-directory behavior. This prerelease layout starts directly in the new folders and does not migrate old profiles. **Agent Desk → Open Browser Workspace…** instead points the backend at a browser data folder: the choice is saved in `<profile>/workspace.json`, and the backend runs with `--browser-port PORT`. It keeps that port's state files and terminal supervisor, and it also listens on `127.0.0.1:PORT`. Running agents carry that address in `AGENT_DESK_URL`. Startup is refused while a browser server still holds the port. **Use Desktop Workspace** removes the choice. Either switch stops only the backend (as Restart Backend does) and relaunches the app. Window state, logs and runtime stay in the profile. Unix sockets live in a private, stable directory under `~/.agent-desk/run/`. `AGENT_DESK_SOCKET_ROOT` can select a shorter root for isolated tests.

Desktop diagnostic logs rotate at 5 MiB and daily, expire after 14 days, and have a shared 50 MiB budget. Cleanup runs when a backend starts and while it writes logs; an app that is not running cleans up on its next start. Startup timings are overwritten per launch. Open the folder with **Agent Desk → Open Local Diagnostics**. Saved conversations, terminal/tool output and workflow history in `data/` are not deleted by diagnostic-log retention.

## Screenshots and file drops

In a local desktop terminal, **⌘V** or **Edit → Paste** saves an image-only clipboard payload as PNG and inserts its quoted absolute path at the terminal cursor. Nonempty plain text takes precedence, including when the clipboard also contains an image. Ordinary and long text paste, native Ctrl+V and Shift+Enter keep their existing behavior. Text already queued for transmission finishes in its original terminal when its pane is hidden.

Drop files into a terminal to insert their original absolute paths, separated by spaces. Each file insertion ends with a space so consecutive drops and screenshot pastes stay separate. Originals are never copied or deleted. A dropped image without a filesystem path uses the screenshot-saving flow; other pathless drops are rejected. The target pane highlights while dragging, and saving/errors appear in its existing status area. File input waiting to be sent stays with that pane and is cancelled if it closes or becomes unavailable. Once transmission starts, the current paste finishes; uncertain input is never retried.

Generated images are stored in `<desktop profile>/data/pasted-images/screenshot-<UUID>.png`, including when the desktop opens a browser workspace. The directory and files are private to your user. Captured bytes and the normalized PNG must each fit within 20 MiB. Completed images remain indefinitely across pane closes, terminal stops, quits, restarts and upgrades. There is no automatic cleanup or retention setting; remove images manually when no longer needed.

Agent Desk uses xterm's bracketed-paste support and adds no Enter, image labels or terminal styling. Claude/Codex keep their native prompts; whether a path turns into a colored image chip depends on the CLI. Known remote panes reject file input, and transfers into SSH sessions started manually inside a local terminal are unsupported. Browser text paste is unchanged; browser uploads and remote transfers are not provided.

## Closing, quitting, and recovery

Closing the window hides it; agents and schedules keep running. Reopen it from the Dock. The app uses no extra menu bar icon; the standard Agent Desk menu provides diagnostics, recovery controls and Quit. Cmd+Q offers Keep Running, Stop Work and Quit, or Cancel while local terminals, tools, jobs, enabled schedules, coordinator planning, queued turns or deliveries, or active PR monitors exist. Idle saved coordinators alone do not trigger confirmation.

Stop Work and Quit blocks new launches and scheduling, waits for tool launches already underway, cancels local planner turns, stops managed workflow workers and their command children, stops managed terminals and tools, and drains the supervisor and backend. Processes get a short graceful-stop timeout, followed by forced cleanup of verified owners without another prompt. Success requires confirmed exit. It leaves unrelated and remote work running. After a confirmed shutdown, reopening enables launches and scheduling normally. An unconfirmed stop keeps the app open and records an incomplete shutdown; reopening preserves that pause until recovery. Same-build crash recovery reconnects to existing owners without replacing live terminals.

Desktop quit uses the shared terminal supervisor's existing teardown and restore behavior. Session records survive stopping and reopening the app: agents resume captured Claude/Codex conversations, shells reopen in the same folder, and other commands open a shell instead of running again. Previous terminal scrollback is not saved. Coordinator conversations and saved worker metadata remain in SQLite; standalone terminal restore records use `data/terminal-sessions-WORKSPACE_ID.json`.

Before stopping terminals, desktop quit discovers and saves coordinator workers' exact conversation IDs without cancelling their assignments. If conversation lookup or saving fails, shutdown remains incomplete and the terminals keep running. Retry **Finish Previous Shutdown** after resolving the error. Forced terminal cleanup starts only after the supervisor confirms its session checkpoint succeeded.

Temporary connection failures retry automatically after 1, 2, 5, 10, then 30 seconds between attempts, capped at 30 seconds until recovery. Returning to the app or waking the computer retries immediately when disconnected. The existing Retry button and Retry Connection menu item can also start an attempt immediately. Authentication, incompatible runtime/connection metadata, and setup failures require manual recovery. Retries pause during quit/shutdown and remain stopped after an incomplete shutdown. Use the Agent Desk menu to finish a shutdown, resume scheduling, or open local diagnostics. A live but unreachable owner is not replaced. Force Stop Backend requires a native confirmation and verified process identity; it leaves the terminal supervisor running. Never remove a live socket directory to recover a workspace.

## Updating the installed app

1. In the running app, choose **Stop Work and Quit** and wait for it to exit completely.
2. Replace the installed app.
3. Start it again. The launcher verifies and replaces the stable runtime after confirming the old managed work has exited. Saved application data is preserved.

Closing the window or choosing Keep Running does not complete shutdown. If startup reports an old owner, finish shutdown in the previous app first. An incomplete shutdown remains paused and can be finished from the Agent Desk menu. Same-build backend crash recovery keeps its existing behavior. Source runs follow [Editing the source](#editing-the-source) instead.

If the backend exits before it is ready, Quit and Finish Previous Shutdown close the app once no managed terminals, tools or workers remain. If they do remain, the app restarts the backend so Stop Work and Quit can stop them; if it cannot, the app stays open.

## Webhook adapters

The event source connection dialog shows the real workspace address, private Unix socket, bearer token, and a copyable curl example. The workspace address is `agent-desk://WORKSPACE_ID`; it is distinct from the app window's `agent-desk://app` origin. A local adapter can submit using only its source token:

```sh
curl --unix-socket '/absolute/private/path/backend.sock' \
  'http://app/api/event-bus/webhook/SOURCE_ID' \
  -H "Authorization: Bearer $SOURCE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"id":"upstream-event-id","payload":{"type":"message"}}'
```

Use the exact socket path from the dialog. Webhooks are rejected while shutdown is paused. Browser mode continues to show its loopback HTTP URL.

## Checks

```sh
npm test
npm run test:transport
npm run test:startup
npm run test:quit-preparation
npm run test:quit
npm run test:backend-lifecycle
npm run test:webhooks
npm run test:smoke
npm run test:paste-drop
npm run test:development-workflow
npm run package
npm run test:packaged
npm run make
npm run test:dmg
```

Run the repository's Python and Node suites too. `test:smoke` launches a real Electron window with a fictional shell and visual tool, tests report windows, streaming, backend-crash recovery and web-pane restoration after a full app process restart, and writes desktop/narrow screenshots to `AGENT_DESK_EVIDENCE_DIR` or the system temp directory. It uses the root Playwright development dependency. `test:packaged` launches the actual `.app` with host Python/Node removed from PATH, checks the bundled runtime, second-launch reuse, a real fixture PTY, no TCP listeners across the app process tree, and confirmed shutdown. `test:dmg` verifies and mounts the DMG read-only and repeats the packaged-app check from the mounted volume. `test:development-workflow` covers source-run annotations (save, reload, edit, delete, send) in the desktop profile, Restart Backend and post-edit crash recovery with a surviving terminal, tool pop-out isolation, and Quit after a failed backend start. None of these checks calls model services or uses real conversations. Failed fixtures retain private local diagnostics under the system temporary directory.

`test:paste-drop` uses raw fictional PTYs and disposable files to check native screenshot Paste, filesystem paths, exact bracketed input, cancellation, failures and persistence across a full app restart. It writes `agent-desk-file-{drag,error}-{1280,480}.png` to the evidence directory. Hosts without a functioning system pasteboard report native Paste as unverified and still exercise DOM paste through the real bridge. The fixture asserts the exact quoted paths delivered to the PTY; CLI-specific image chips and colors are outside its coverage.

## Visual tool compatibility

The six recognized review/annotation integrations use the inherited-listener adapter in `scripts/serve_skill_ui.py`. Third-party manifests opt in with `"transports": ["unix-http-v1"]` alongside `"runtime": "python-http"`. A compatible entry point accepts `--port 0 --no-browser` and creates one standard-library loopback HTTP server; the adapter substitutes its inherited Unix socket without binding TCP. Explicit TCP binds in that process are rejected. This is a compatibility adapter, not an OS sandbox for arbitrary skill code. A docked tool's pop-out button opens it in a separate desktop window limited to that tool's address, with no preload, desk APIs or native IPC; the tool cannot open further windows or navigate to the workspace.

Each tool receives a separate internal origin and no desktop preload bridge. Electron authorizes proxy requests using browser frame metadata, rather than trusting renderer-supplied Origin headers. Existing tool script policies are preserved. Additional tool roots can be configured through `AGENT_DESK_TOOL_ROOTS`, separated by the platform path separator.

The automated visual check exercises a focused fixture. Real installed skill entry points still need compatibility verification before being advertised as supported.

## Packaging and release

```sh
npm run make
```

This downloads checksum-pinned arm64 runtimes from `runtime-lock.json` at build time, copies an allowlisted application payload, builds `out/Agent Desk-darwin-arm64/Agent Desk.app`, and creates `out/make/Agent-Desk-arm64.dmg`. Local and automated GitHub builds use an ad-hoc signature without Developer ID hardened-runtime enforcement; these artifacts are not Developer ID signed or notarized. Developer ID builds enable hardened runtime.

Internal runtimes are signed first; their final hashes are then sealed into the app. Runtime symlinks are preserved across packaging and installation. On startup the app verifies its signature and stages a verified runtime into `<profile>/runtime/`. Existing content-hashed `runtimes/` directories are left untouched during this transition. Application data stays in `data/`.

Packaging generates `.build/build-info.json` with the shared app version, short commit, dirty flag, validated release tag (or null), and UTC packaging timestamp, then embeds it in the signed app's resources. Installed apps read this file without Git. Dirty detection includes staged, unstaged, and untracked source changes and respects Git's ignore rules; `.build/`, `out/`, dependency caches, and generated metadata are excluded. Forge uses the shared version for the macOS bundle and packaged package.json. The bundled Python source includes `pyproject.toml` so its runtime version stays consistent; installed Python wheels use distribution metadata.

### Desktop CI and automatic GitHub releases

[The desktop workflow](../.github/workflows/desktop.yml) runs on macOS 15 for pull requests that change desktop code, application code, relevant fixtures/tests, packaging manifests, or the workflow. Its manual **Run workflow** trigger performs validation only, even when a desktop tag is selected. Ordinary branch pushes do not run this workflow.

Pushing a tag such as `desktop-0.1.0` builds the exact tagged commit. Tags must use `desktop-MAJOR.MINOR.PATCH`, without a `v`, and match `[project].version` in `pyproject.toml`. CI rejects invalid or mismatched tags, a dirty release checkout, or a tag pointing to a different commit before packaging. After all desktop tests, app packaging, packaged-app checks, DMG creation, and read-only mounted-DMG checks pass, the workflow computes a SHA-256 checksum and saves the tested DMG and checksum as the `desktop-release` Actions artifact. A separate job verifies the checksum again, prepares a GitHub Release as a draft, attaches `Agent-Desk-arm64.dmg` and `Agent-Desk-arm64.dmg.sha256`, and automatically publishes it. There is no manual publishing step. Tagged CI packages show the app version and **Release build · <commit>** in About. PRs, manual validation runs, and local packages show **Development build · <commit>**. A Git tag selects release identity; it does not enable Apple signing.

The project version can stay at `0.1.0` across many commits to `main`. Change it only when preparing a new release; commit hashes distinguish development builds. For a release:

1. Finish validation and choose the release commit.
2. If this version has already been published, bump `[project].version` in `pyproject.toml` (patch for fixes, minor for features or breaking changes during `0.x`) and commit the change.
3. Tag that commit, for example `git tag desktop-0.1.0`, and push it with `git push origin desktop-0.1.0`.
4. Verify the GitHub Release, downloaded DMG, and checksum. Subsequent changes on `main` can retain the version until the next release.

Each published version is immutable: use a new version and tag for changed release contents. The version and tag convention is shared across desktop platforms; only macOS packaging is implemented today.

Runs for the same tag are serialized. The publishing job validates its clean tagged checkout before downloading the tested assets, then verifies their checksum before any GitHub release changes. Rerunning a failed workflow resumes an incomplete draft and replaces its asset pair before publishing. A release that is already published is left unchanged, including its assets. If the Actions artifact has expired, rerun all jobs to rebuild and validate it.

The build has read-only repository permissions. Only the publishing job gets `contents: write`, using the built-in `GITHUB_TOKEN` and the repository running the workflow. Actions must be enabled and repository policies must permit release writes. After this workflow is merged upstream, pushing an upstream desktop tag publishes an upstream release; tags pushed to forks publish independent releases in those forks.

These downloads require Apple Silicon and macOS 14+. CI keeps `AGENT_DESK_APPLE_SIGNING` disabled and uses the existing ad-hoc signing for the app and bundled runtimes, without Apple credentials or notarization. Tags do not enable Developer ID signing. Downloads can be checked from the directory containing both assets:

```sh
shasum -a 256 -c Agent-Desk-arm64.dmg.sha256
```

Use the tagged workflow's result and published assets/checksum as evidence of GitHub publication. Local builds and fixtures provide packaging and workflow coverage. Updates remain manual; the app has no update checks, update notices, or automatic installation. Finish Stop Work and Quit before replacing the app. If managed processes from the old code remain, startup refuses the update until shutdown finishes. After shutdown, the changed runtime is copied and verified before launch. There is no upgrade handoff or cross-version work preservation.

### Optional local Developer ID builds

To make a separately signed and notarized local build, install your Developer ID Application certificate and a `notarytool` keychain profile, then run:

```sh
AGENT_DESK_APPLE_SIGNING=1 APPLE_SIGNING_IDENTITY='Developer ID Application: Your Team' APPLE_NOTARY_PROFILE=agent-desk-notary npm run make
```

Signing credentials remain outside Git. Setting `AGENT_DESK_APPLE_SIGNING=1` requires signing, notarization, stapling, and signature verification. Packaging scripts do not publish artifacts; the GitHub publishing job is separate.

## Shell startup and native header

The macOS window first displays a near-black loading screen with a centered 48px logo, muted status text, and a blue dot. It says “Opening your workspace…” or “Setting up Agent Desk…” while staging a first installation. Reduce Motion keeps the dot static. Native traffic lights and window dragging remain available. A failure shows a short explanation and one Retry button; diagnostics remain in the native menu.

Runtime signature/integrity verification and staging run in a worker. Once verification and backend readiness finish, the same window loads the shared workspace. The launcher obtains real configuration over the Unix socket before navigation and serves that exact snapshot to the first blocking `/config.js` script. Development controls are enabled in source runs and disabled in installed apps. Later configuration requests proxy normally. There is no placeholder configuration or account hydration step.

Ordinary API requests preserve methods, query strings, application headers, byte bodies, HTTP statuses and streamed responses. The main process selects the Unix socket, supplies authentication, and refuses lifecycle API requests from renderers. Chromium frame/window metadata authorizes each request; embedded tools have separate origins and cannot obtain application authority. Cancelling a fetch or response reader closes its socket request. Uploads are framed with Content-Length for the existing Python server.

After the initial workspace load, automatic or manual retries reconnect the existing document. Drafts and live terminals stay in place; disconnected mutations fail without being queued or replayed. Concurrent retries share one attempt. Closing hides the window; quitting during preparation prevents a later backend launch.

Traffic lights and the full-size logo share a 60px header aligned with the workspace toolbar. Native 14 × 16px button frames sit 14px from the left and 22px from the top, with a 20px gap before the logo. Empty header space drags the window; the logo returns to Sessions. Fullscreen centers the logo within the sidebar. Narrow windows keep the same control spacing on their own header row. Desktop pane selection, geometry and web-page names and addresses persist across app restarts; closing a web pane removes its saved page. Window position and normal bounds are clamped to available displays.

Expanding one pane to fill a regular window hides the traffic lights so they do not overlap its title. Escape, collapsing or closing that pane, and leaving Sessions restore the controls. The whole window's native fullscreen behavior is preserved.

Additional focused checks:

```sh
npm run test:startup
npm run test:about
node test/quit-preparation.cjs
node test/browser-header.cjs
npm run branding
```

Branding generation uses the existing SVG with local Chrome and macOS iconutil; generated PNG/ICNS resources ship with the app. The browser header fixture also uses local Chrome.
