# Agent Desk guide

A local agent dashboard with precise UI feedback capture. Requires Python 3.11+, Node.js 18+, macOS/Linux, and a modern browser. Install and authenticate your chosen agent CLIs separately.

Python runs the local server and launches `node` subprocesses for terminal inspection and worker messaging helpers, including native Grok terminal observation. Both runtimes must be installed and available on your `PATH`; `pip install .` does not install Node.js or agent CLIs. The Python server uses the standard library. Runtime JavaScript libraries are bundled locally with their licenses, so no `npm install`, frontend build step, or CDN is needed to run the app. See [Requirements](../README.md#requirements) and [browser test setup](../tests/browser/README.md) for the separate development dependencies.

```sh
git clone https://github.com/dylan-murray/agent-desk.git
cd agent-desk
python3 -m agent_desk
```

Open http://127.0.0.1:4310. Use `--port 4311` if needed.

## What works

- Discover processes whose executable names are `codex`, `claude`, or `grok`. Discovery is intentionally conservative: wrappers, Node-based command lines, remote sessions, and arbitrary harnesses need an adapter.
- Discover each process’s working directory using a batched `lsof` lookup (or `/proc` on Linux). Resolve the nearest `.git` directory or worktree marker to show the repo name, full working path, and PID. Inaccessible folders are explicitly labeled unavailable.
- Receive authenticated events from any harness over a common API. Filter agents by status or search their names, tasks, projects, and harnesses. Select a session in the sidebar to see its task, questions, and recent events. Use the ＋ beside another session to add it to the workspace, up to 16 panes per desk. Cmd/Ctrl/Shift-click also adds a pane. Clicking an open session focuses it; clicking a different session replaces the focused pane.
- Explore a separate, explicitly labeled demo workspace.
- Drop numbered pins anywhere, including blank space, or select interface elements. Click a saved pin to edit its note. Use **Clear annotations** in Feedback or **Clear all** in the annotation toolbar to remove saved annotations after confirming the count. Deletions sync to disk and stay deleted when older tabs reconnect. Annotation mode stays active to add several pins in succession. Pins follow their containing element when scrolling or resizing and are shown only on their original page and demo/live workspace. Original capture coordinates remain unchanged. Notes include the page, demo/live mode, CSS selector, text, agent ID when available, element bounds, document and viewport click coordinates, normalized click coordinates, scroll offsets, viewport size, and device pixel ratio. Coordinates use CSS pixels.
- Notes automatically sync to `data/feedback.json`, readable by your local development agent, with browser local storage as a backup. Existing browser notes migrate on reload at the original origin/port. Failed syncs retry every five seconds. Notes merge by ID, and persisted deletion IDs prevent old tabs from restoring deleted notes. The Feedback tab shows save status. Copy Markdown, export all notes as Markdown, or export individual notes as JSON when needed. Annotations remain local unless you explicitly submit them to an agent. Screenshots are not captured yet.

## Who can reach a session

Agent Desk listens on 127.0.0.1 only. Three kinds of caller use the terminal API:

- **The desk page.** Its token is held in memory and given only to the desk's own page. It can do everything.
- **Local helpers** (`scripts/agent_control.py`, review tools). They read a separate token from the owner-only file `data/.terminal-token-PORT`. `/api/terminal-auth` no longer hands a token to `curl` or scripts.
- **An agent's own tools.** Run inside a pane, `agent_control.py` says which pane it is in, and the desk keeps it to that pane and the workers it started. Typing into, renaming or stopping any other session is refused. This keeps a confused agent on its own work; it is not a security boundary, because the pane is whatever the tool says it is and a tool that says nothing is treated as a helper.

The lock button in a pane's header **protects** that session, and is the boundary to rely on: only the desk page can read its output, type into it, rename or stop it. Helpers, agents and coordinators are refused, including feedback delivery, shutting down its desk, and a coordinator adopting, reading or messaging it. Locking a session on a remote machine is enforced by both desks. Use it for anything connected to production. Protected sessions are saved in `data/protected-panes.json` and stay protected across restarts.

A web pane's address is checked by the desk before it loads. If a public page redirects to this machine or a private network address, the desk refuses to follow it.

Requests a browser sends from another site or another localhost port are refused, the desk cannot be framed, and a strict content security policy blocks inline and injected scripts.

Limits: this stops other websites, and it stops an agent wandering into another session through the supported tools. A process running as your own user can still read the token file or attack the terminal supervisor directly, and a browser extension with localhost access can do whatever the page can. Run untrusted agents as another user or in a container.

## Adapter contract

The server prints a fresh adapter token on startup. Keep it local. Send it as a bearer token. Example, after setting `AGENT_DESK_TOKEN` to that value:

```sh
curl http://127.0.0.1:4310/api/events \
  -H "Authorization: Bearer $AGENT_DESK_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"frontend-1","name":"Frontend agent","harness":"claude","project":"agent-desk","task":"Refine the dashboard","status":"needs_input","question":"Which palette should I use?","message":"Waiting for a design decision"}'
```

Reuse the ID to update an agent. Supported states: `working`, `needs_input`, `idle`, `completed`, `error`, `unknown`. Optional numeric `pid` deduplicates the corresponding discovered process. Optional string fields: `name`, `harness`, `project`, `task`, `question`, `message`, `cwd` (absolute path). `id` and a valid event are required; omitted status defaults to `unknown`. The latest 100 events per agent are retained in memory. Restarting the server clears adapter sessions. State is the **last reported state**, not an inferred heartbeat; the last-update age is shown on each card.

The server binds to IPv4 loopback, validates Host headers, requires a token for writes, and exposes no cross-origin permissions. This is a local development tool, not a multiuser network service.

Process existence does not establish whether an agent is working, waiting, idle, or failed. Detected processes show `unknown` until a harness reports semantic state. Discovered processes remain observational. Sessions launched through Agent Desk have full terminal input and output.

## Interactive terminals

Use **New → Terminal** to start a shell, Codex, Claude Code, Grok, OpenCode, Pi, Cortex Code, or a custom executable in an absolute working directory. Extra arguments are supplied one per line and passed as an argument list; they are not interpreted as shell syntax. Once launched, type directly into the terminal, including approval responses, arrow keys, and Ctrl-C. Commands run with the local server user's permissions and environment.

Each desk's workspace holds up to 16 panes. Closing a pane leaves its session running; **Stop** confirms before ending it. Returning to the pane or reloading restores a per-tab screen checkpoint (including colors, cursor, modes, and dimensions), then reads output after its matching byte offset. Checkpoints keep up to 1,000 scrollback rows in session storage, with smaller fallbacks if storage is full. A checkpoint is never saved halfway through UTF-8 or a terminal control sequence. For sessions without a checkpoint, the app sizes the terminal before replay and requests a resize-driven redraw. Up to 16 managed terminals can run on each desk, including hidden ones; a terminal an agent starts without naming a desk counts on its parent's desk, and moving a terminal to another desk frees its place. Output is kept in a bounded 2 MiB memory buffer per session. Managed local terminal sessions survive web-server shutdowns and restarts; stop sessions explicitly when finished. At narrow widths, multiple panes stack vertically.

A process launched in another terminal app cannot be attached by PID alone. Its pane offers a new terminal in the same folder, which is a separate session. To continue the conversation there, use that harness's supported resume workflow. No keystrokes are injected into unrelated terminals. Working/waiting status still requires semantic harness events; a running PTY is labeled interactive without claiming the agent is actively working.

PTY supervision runs in a separate Python process so the threaded web server never forks itself. Each browser tab opens one WebSocket (`/api/terminals/stream`) that carries output, keystrokes and resizes for all of its local panes and background terminal observers; the supervisor wakes it as soon as a terminal writes, so idle panes make no requests. The socket checks the host and origin on connect and accepts the terminal token only as its first message, never in the URL. A reconnecting tab resumes each terminal from the last output cursor it received, so nothing is lost or repeated. Remote panes, and backends without the endpoint, use cursor-based output polling and authenticated input/resize requests instead; stop and rename always use requests. Terminal authentication is separate from the adapter token, requires a custom header, rejects foreign browser origins, and grants no CORS access. Rendered terminal output uses [xterm.js](https://xtermjs.org/docs/api/terminal/classes/terminal/) with its [fit addon](https://xtermjs.org/docs/guides/using-addons/). Terminal libraries and licenses are in `agent_desk/static/vendor/`.

### Pane layouts and resizing

The layout button at the left of the workspace toolbar shows five layouts as small drawings: **2 × 2** (the default), **Rows**, **Columns**, **3 × 2** and **Main + side**. A layout is a pattern, not a pane count. Panes fill it in order, and it repeats as more open: with **Rows**, a third pane goes below the first two. Until a screen is full, panes stretch to fill it. Beyond one screen, extra rows keep the layout's row height and the workspace scrolls. When panes are out of sight below, a **panes below** button appears; it scrolls the next one to the top. Opening a pane that would land off screen scrolls it into view. The layout choice is saved in this browser, for each desk.

To resize a pane, drag its right edge, bottom edge or bottom-right corner. Sizes snap to a 12-column grid whose row height is a twelfth of the workspace. An edge works like a split view: a pane that starts at the dragged edge, beside the pane you resize, gives up or takes the difference, so the row or column still fills the screen. The edge stops when that neighbour reaches three cells. A neighbour that would grow over another pane holds its place instead. Any other pane the resized pane now covers moves below it, and panes move up and left into space that frees up. Panes always fill the workspace: whatever space a resize, a closed pane or a new pane leaves empty, the panes beside it grow into, widening before they grow taller. Switching the agent a pane shows keeps that pane's place and size. If no pane can grow into a gap whole, the layout tiles afresh. Every terminal whose pane changed size is refitted once you release, and its program is told the new size; resizing the window refits them too. You can also focus a corner and resize one cell at a time with the arrow keys. Resizing marks the layout **Resized**. Sizes are kept with the open panes in this tab and survive a reload. Choosing a layout again, including the current one, resets every pane to it. Dragging a header still swaps two panes, and in a resized layout each takes the other's size and position. Narrow screens stack panes and do not offer resizing.

### Web pages

Use **New → Web page** to open a page in a workspace pane beside your terminals: a local dev server, documentation, or a dashboard. Type an address such as `localhost:3000` (local hosts and addresses with a port default to http, everything else to https); only http and https addresses are accepted. Recent addresses are suggested. A web page counts toward the 16 panes and moves, swaps and goes full screen like any other pane, but it is not an agent session: it never appears in the sidebar, the agent map or the agent counts. Browser panes are kept in this tab's pane state and survive a reload. The desktop app also restores web-page names, addresses and pane geometry after quitting and reopening. Closing the pane removes its saved page, and a session chosen from the sidebar never replaces a focused web page.

Click the pane title to rename it and the address line under it to load a different address. **Reload** returns the frame to that address; **Open in a new tab** opens it in the browser. Many sites (GitHub and Google among them) send `X-Frame-Options` or a `Content-Security-Policy` `frame-ancestors` rule that forbids framing. Agent Desk requests the page itself when it opens, and when the site refuses framing or cannot be reached the pane names the site and the reason in place of the browser's bare "refused to connect" page. That request carries no browser cookies, so a page behind a sign-in is judged by its sign-in response. Framed pages run sandboxed and cannot navigate Agent Desk itself.

### Readouts

Readouts are a row of labeled values under a pane's header, set by whatever runs in that pane: a job queue's backlog, a test run's pass count, an agent's current phase. Each set replaces everything shown, so a value that no longer applies doesn't linger. The row shows how long ago the values were set. With a TTL, they dim and are labeled **Stale** once that long passes without another set, so a loop that died does not look healthy. Up to 8 fields are allowed, with labels of up to 32 characters and values of up to 64. Tones `good`, `warn`, and `bad` color a value. Readouts live in memory with the terminal and end with it.

**From an agent.** Readouts are chosen per terminal. In the New terminal dialog, tick **Readouts** when starting Claude or Codex, and that agent is given one tool, `set_readouts(fields, ttl_seconds)`, for its pane. Other terminals don't get it, and nothing is written to your agent accounts: Agent Desk passes the tool server on that agent's command line (`--mcp-config` and an allow rule through `--settings` for Claude, so an unattended loop never stalls on a permission prompt; `-c mcp_servers.agent-desk.*` for Codex). It runs one cheap process for that session. Earlier versions registered the tool once per account; the main desk removes those registrations on its next start, and only the entries Agent Desk wrote.

The tool tells an agent how to set readouts, not what to show. Put that in the project's own instructions, for example in the command a loop runs every pass: "After each pass, call `set_readouts` with Jobs done, Queue length and Failure rate taken from the job runner's output, unchanged, with `ttl_seconds` 720." Have code compute the values and the agent pass them through, rather than asking the model to work them out.

**From a script or hook.** Every managed terminal also has `agent-desk-readout` on its `PATH`:

```sh
agent-desk-readout set 'Jobs done=412:good' Queue=4 'Last run=10:35' --ttl 15m
agent-desk-readout set --json <<'EOF'
{"fields": [{"label": "Jobs done", "value": "412", "tone": "good"}], "ttl_seconds": 900}
EOF
agent-desk-readout clear
```

Single-quote arguments that contain `$`, or use the quoted heredoc, so the shell cannot expand them. In the argument form, a value ending in `:good`, `:warn`, `:bad`, or `:neutral` sets its color; otherwise a colon is part of the value. Exit codes: `0` shown, `1` rejected with the reason printed, `2` not inside an Agent Desk pane.

**Codex sessions.** Codex can run sessions in a shared background service, which starts tool servers and commands with the environment of whichever terminal first started it, not the pane you are typing in. Agent Desk therefore starts interactive Codex sessions in its panes with `--no-daemon`, so their tools run inside the pane. If you type plain `codex` in a pane while that service is running, `set_readouts` and `agent-desk-readout` refuse to write and say to start Codex with `codex --no-daemon`, rather than updating some other pane.

**How it is delivered.** Each pane gets `AGENT_DESK_TERMINAL_ID`, `AGENT_DESK_URL`, `AGENT_DESK_READOUTS_DIR`, an `AGENT_DESK_PANE_TOKEN` that can write only to that pane, and `AGENT_DESK_PANE_PID`, the pane's root process. Before writing, the command line and the tool server check that they descend from that process. The command line sends readouts to Agent Desk over loopback HTTP. Sandboxes such as Codex's default `workspace-write` block that, so the command line and the tool server validate the values and hand them over through the desk's private folder under `/tmp/agent-desk-<uid>/`, which the pane shows on its next refresh. Codex starts tool servers with only a small environment allowlist, so its registration lists those variables in `env_vars`.

### Continue with a different harness

Choose **Continue from any harness** in the terminal launcher's Conversation menu. Pick the source conversation, select the destination agent/account, and enter what to continue. Claude, Codex and Grok histories can be imported. Messages and tool history are preserved in a private portable record; provider-private state and permissions stay with the source. See [conversation portability](conversation-portability.md) for the format, limits, and validation.

### Backend restarts and terminal supervision

The web backend and terminal supervisor have separate lifetimes. Restart the backend with the **same data directory and port** to reconnect to the same terminal IDs, processes, names, parent relationships, screen observers and output cursors. Agents keep running while the browser displays a connection interruption; panes reconnect automatically and recover buffered output. Keyboard input and API calls are unavailable during the interruption. Ambiguous writes are never automatically retried.

The backend allows 16 running terminals per desk. The supervisor keeps exited sessions until it holds 64 records, and 2 MiB of replay per session. Output beyond that buffer is reported as truncated and the browser requests a redraw. A machine reboot or supervisor exit still ends the processes; see [restoring terminals](#restoring-terminals-after-a-reboot). Remote connection tunnels, externally reported adapter sessions and in-flight coordinator planning are outside this guarantee. Interrupted coordinator turns pause for inspection and actions in progress remain uncertain; surviving workers are not marked missing or automatically relaunched. Command/app workflow workers already run independently and continue under their recorded process identities. Scheduling, polling and HTTP callbacks resume when the backend returns; a failed HTTP callback may need retrying.

On the **first upgrade from an older server**, its existing terminals still belong to that server and cannot be adopted by the new supervisor. Finish or save those sessions before the one-time transition. Do not kill an existing live server merely to install this change.

Backend-only updates take effect after a backend restart. The supervisor intentionally keeps its loaded version while sessions are alive. For changes to `terminal_supervisor.py`, `terminals.py`, terminal workers or screen observers, finish and explicitly stop its sessions, stop the backend, then drain the idle supervisor:

```sh
AGENT_DESK_DATA_DIR=/your/data/directory python3 -m agent_desk.terminal_supervisor --port 4310 --shutdown
```

This command refuses while any terminal is running. Restart Agent Desk afterward to start a supervisor with the updated code. A supervisor started before output streaming existed cannot wake the backend when a terminal writes; the backend polls it on the browser's behalf every 50 ms until that supervisor is drained. There is no implicit stop-all during an update. Tests and development instances must use their own data directory and port.

### Restoring terminals after a reboot

Desktop **Stop Work and Quit** uses the same supervisor teardown and restore behavior. Session records are preserved when the app stops; reopening the same desktop profile restores them as described below. Standalone restore records use JSON; coordinator conversations and saved worker metadata use SQLite.

Desktop quit also discovers coordinator workers' exact conversation IDs before stopping their terminals and keeps unfinished assignments for Resume. A conversation-lookup or save error leaves shutdown incomplete and terminals running; retry **Agent Desk → Finish Previous Shutdown** after resolving the error. Forced terminal cleanup requires a confirmed session checkpoint first.

When the supervisor ends with terminals still running (machine reboot, crash, or a stopped supervisor process), the next supervisor for the same data directory and port reopens them under their **original terminal IDs**, names, renamed titles and terminal parents, so open panes come back in place:

| Terminal | Restored as |
| --- | --- |
| Claude Code or Codex with a started conversation | The same CLI command, resuming that exact conversation (`claude --resume ID`, `codex resume ID`) |
| Claude Code or Codex before its first message | The same command, as a new session |
| A standalone agent that had exited to its shell | A new shell in the same folder |
| Plain shell (`zsh -l`, `bash`, …) | The same shell in the same folder |
| Any other command (SSH, dev servers, scripts) | A login shell in the same folder; the command is **never re-run** |

Each restored terminal starts with a dim line explaining what happened. Its output cursor continues past the previous process, so browser panes and CLI readers reset instead of mixing old and new screens. Only processes are new: scrollback from before the restart is not kept. If the original folder or executable is gone, the terminal opens a shell (in your home folder if needed) and says why. Explicitly stopped terminals and commands that exited are never restored.

The supervisor reads each agent's conversation from the CLI's own records every five seconds: Claude Code's per-process `sessions/PID.json` file and the rollout file a Codex process holds open. Nothing is inferred from folders or timestamps. If two agents in one terminal are equally plausible, none is recorded. A conversation started in the last few seconds before a crash may not be captured yet. Agents launched by typing a command inside a shell pane restore as that shell. Grok and custom executables restore without a conversation.

Coordinator terminals and coordinator workers are not restored this way. The coordinator keeps their saved conversations and offers **Resume** explicitly. Restore records are in `terminal-sessions-PORT.json` in the data directory (mode `0600`). They contain each terminal's command, folder, name and conversation ID. An unreadable record is moved aside as `terminal-sessions-PORT.unreadable-TIME.json`, not deleted. Restore results are logged to `terminal-supervisor-PORT.log`.

The private Unix socket is scoped to the resolved data directory and port, inside an owner-only `0700` directory under `/tmp/agent-desk-UID-HASH`; the socket and authentication token have mode `0600`. It is not an HTTP endpoint. Startup locks prevent competing supervisors, and protocol mismatches fail without replacing an active owner. Logs are in `terminal-supervisor-PORT.log` inside the data directory. Never remove a live supervisor's socket directory or kill its process to refresh the web backend.

## Checks

```sh
python3 -m unittest discover -s tests -v
node --check agent_desk/static/app.js
node --test tests/test_terminal_snapshots.cjs
```

## Feedback API

`GET /api/feedback` reads the persisted `{notes, deleted}` document. `POST /api/feedback` merges the same shape and requires `X-Agent-Desk: feedback`. Browser requests must be same-origin. This endpoint cannot submit harness events. Writes are serialized and atomically replace the workspace file; invalid notes do not replace saved data.


For a backend-only update, use the verified listener PID with `python -m scripts.restart_backend --pid PID --port 4310`. It checks the existing supervisor, records terminal identities, restarts only the HTTP process with `--attach-only`, and verifies the same terminal owner and PIDs. A missing live owner blocks replacement. The supervisor socket uses persistent state; reachable legacy sockets remain attachable. This does not repair sessions detached before these checks existed.

## Development tools and skills

### Embedded skill UIs

The **Tools** view hosts live skill interfaces at shareable local routes such as `/apps/code-review-…`. The skill launches its server and supplies the target file or repository; Agent Desk displays that UI and its context. These annotation skills are recognised by name once installed: `code-review`, `readme-review`, `document-builder`, `diagram-doc-creator`, `architecture-review` and `pull-request-description-review`. Any other skill becomes a tool by adding an `agent-desk-ui.json` manifest beside its `SKILL.md`. Launch one with:

```sh
python3 scripts/skill_ui.py --skill readme-review --target README.md
python3 scripts/skill_ui.py --skill document-builder --target /path/to/draft.md
python3 scripts/skill_ui.py --skill diagram-doc-creator --target /path/to/diagram.html
python3 scripts/skill_ui.py --skill code-review --target /path/to/repo
```

Use `--title`, `--agent-id`, or pass skill-specific arguments after `--`. Launching the same target reuses a reachable registered UI. Other skills can start their own server and register with `--skill NAME --url http://127.0.0.1:PORT`.

A `code-review` opened from a session is started with a feedback bridge (`scripts/tool_feedback.py`), so submitting in the review delivers the open comments to that session's prompt, each with its file and line. If the agent is busy, Agent Desk holds the submission until its prompt is ready.

`POST /api/skill-uis` requires the adapter bearer token and accepts `{id, title, skill, url, context?, agent_id?}`. `GET /api/skill-uis` lists registrations. URLs must use HTTP on localhost or 127.0.0.1 with an explicit port different from Agent Desk. Registrations persist in `data/skill-uis.json`. The launcher reads the current token from the permission-0600 `data/.adapter-token-PORT`, or `AGENT_DESK_TOKEN` when supplied.

Each UI runs in an iframe on its original local origin, preserving its assets, annotation endpoints, and existing callbacks. Use the skill's own annotation controls inside that frame. Agent Desk annotations target the surrounding dashboard. The skill still owns its server, files, feedback processing, and agent callbacks; closing the view does not stop the server. A new registration opens automatically when viewing Agents, and remains available in Tools otherwise. Saved registrations need their servers running after a restart.

Agents are the default view. The floating annotation button at the bottom left opens annotation tools, Feedback, and submission to an agent. Run `python3 -m agent_desk --production` to disable feedback tools and API routes. Existing annotation files remain intact.

**Build a skill** collects a name, purpose, trigger, instructions and optional examples. Preview the generated `SKILL.md`, then create it in `~/.agents/skills`. Existing names are never overwritten. **Find local skills** searches local folders and adds an existing `SKILL.md` folder to the shared library. Header actions wrap with consistent spacing.

**Skills** lists every skill any installed agent can load and shows, per agent, whether it actually can. Agent Desk reads the same folders each harness scans: Claude Code reads `$CLAUDE_CONFIG_DIR/skills` (`~/.claude/skills`, or the config folder of an account you added); Codex reads `~/.agents/skills` and `$CODEX_HOME/skills` (confirmed with `codex debug prompt-input`); Grok reads `~/.grok/skills`, `~/.agents/skills`, and `~/.claude/skills` unless `[compat.claude] skills = false`. Symlinks are followed and one folder reached through several roots is listed once. Each skill is marked **Explicit** when it only runs when named (`disable-model-invocation: true` for Claude, `allow_implicit_invocation: false` in `agents/openai.yaml` for Codex) and shows caveats that would make it behave differently between agents: a `~/.claude/skills` path, a Claude Code tool with no alternative, a hardcoded MCP tool name, or a `/skill` it depends on that is not installed. Select a skill, describe a task, and copy a prompt containing its local instructions path and the selected agent's working directory.

When any agent cannot see a skill, **Make every skill available to every agent** links it into that agent's skill folder. `python3 scripts/share_skills.py` previews the same change and `--apply` makes it. Nothing is copied: each link points at the skill's real folder, so supporting files stay beside the original `SKILL.md` and edits show up everywhere. An existing folder with the same name is never replaced; it is reported as a clash. Being visible is not the same as working identically. A skill that reads Slack, Notion, Datadog or Jira still needs that connector set up in each agent, and its instructions should say what to do when it is missing.

Discovery references: [Codex](https://learn.chatgpt.com/docs/build-skills), [Claude Code](https://code.claude.com/docs/en/skills).


Skills now opens a full page with search, a workflow list, and a task pane. Task drafts are retained per skill while the page is open. Selecting an agent from the sidebar returns to its terminal.

For a remote Claude session, the Connect panel includes a reverse SSH forwarding recipe for machines with existing SSH access. Forwarding transports adapter events; it does not automatically attach to a running Claude terminal. Do not register a remote PID as a local PID. Actual session connection still requires the user's remote access details and an event adapter.

**Saved connections.** Name a connection and press **Save connection** to keep its host, user, port and identity file in the workspace, so it is entered once rather than every time. Connecting saves it too. Saved connections live in the data directory (`remote-connections.json`), not in one browser, so they survive a new browser, a cleared cache and another machine pointed at the same data directory. Choosing one fills the form; **Remove** deletes it.

### Coordinators and workers on a remote machine

From **+ Coordinator → Connect remote…**, enter an SSH host that accepts key login from your local SSH agent. The connection type is **Coordinator environment**. Test verifies SSH, Python 3.11+, Node, and at least one installed harness. It does not make a paid model call or change harness logins. Connect installs the current Agent Desk runtime beneath `~/.local/share/agent-desk/remote-runtime/` and saves runtime state in `~/.local/share/agent-desk/remote-state/` on the remote machine.

The coordinator form then selects that environment. Choose one of the detected remote harnesses and enter a **remote** project directory. Model suggestions come from the remote environment. Existing environments remain in the execution-environment menu; reconnect through the SSH dialog if they show disconnected.

The coordinator, worker terminals, mailbox, context storage, and native session files stay remote. Your local UI sends authenticated API requests through an SSH stdio bridge. The runtime listens only on remote loopback with token authentication; no public service port or manually configured forwarding is needed. Each target has a stable namespace in the local UI, including worker parent links, so local and remote IDs cannot collide. Targets are scoped by host, user, port and identity file; reconnect with the same selection to reuse that local namespace.

Your local SSH keys establish the connection. Remote harnesses inherit the **remote login environment**, including API keys, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, PATH, and native saved logins. Agent Desk does not upload local harness credentials or apply accounts you added on your laptop. Variables set only in another shell or session are not automatically part of the SSH login environment; configure the remote CLI there first. Choose `claude`, `codex`, or `grok` as the coordinator harness; remote worker launch profiles support the same three. Local `-personal` profiles are intentionally unavailable remotely.

Closing the browser, local backend, or SSH bridge leaves the remote runtime and workers running. Reconnect the same host to retrieve reports and pick up saved coordinator conversations. Use the normal worker review/close and coordinator close controls to end work. Rebooting the remote machine terminates its processes; in-memory terminal replay cannot survive that. Conversation and native-session recovery depend on the remote state directory and harness session files remaining on persistent storage.

Remote account-remaining-quota adapters are not enabled: the UI says so rather than querying your laptop's account. Reported per-turn token usage still comes from the remote harness. Skills and app-port proxying are not included in this first remote-environment feature.

Reconnecting an unchanged runtime reuses its process and state. A different runtime bundle is not installed over running work: setup returns an explicit version-mismatch error. To upgrade, finish/close remote agents, stop the remote runtime using the PID in `~/.local/share/agent-desk/remote-state/node.json`, then reconnect. Do not stop the runtime while you intend its workers to continue. Runtime logs are in the same directory. Deployment never edits your shell files.

### Resume conversations

Codex, Claude Code, Grok, OpenCode, Pi, and Cortex Code panes offer **Resume conversation**, which prefills the harness and working folder. The launcher also exposes conversation choices whenever one of these harnesses is selected:

| Harness | Choose conversation | Latest in folder | Specific conversation |
| --- | --- | --- | --- |
| Codex | `codex resume` | `codex resume --last` | `codex resume ID_OR_NAME` |
| Claude Code | `claude --resume` | `claude --continue` | `claude --resume ID_OR_NAME` |
| Grok | Use latest or ID/title | `grok --continue` | `grok --resume ID_OR_TITLE` |
| OpenCode | Use latest or ID | `opencode --continue` | `opencode --session ID` |
| Pi | `pi --resume` | `pi --continue` | `pi --session ID` |
| Cortex Code | `cortex --resume` | `cortex --continue` | `cortex --resume ID` |

OpenCode and Pi launch, resume, return to a shell on exit, come back after a restart as new sessions, and share skills. A coordinator can plan with either one and assign work to either as a worker: follow-ups and review feedback wait for an empty prompt, and a finished worker's exact conversation is saved for resuming. Neither CLI can enforce a reply schema, so a coordinator planning with one of them relies on the model returning valid JSON; a malformed reply is rejected and no action runs. Controller agents (a terminal with **Coordinate other agents** ticked) and remote environments still run on Claude Code, Codex, or Grok only; such a controller can launch OpenCode and Pi workers and send them tasks.

Cortex Code launches, resumes, comes back after a restart as a new session, and shares skills. Cortex Code runs with its default Snowflake connection; to use another, save a Cortex Code account for it under **Accounts** (see below). A coordinator can assign work to Cortex Code as a worker, which starts with its task and reports back like the others, but cannot plan or read sources with it. Follow-ups and review feedback to a running Cortex Code worker are not sent yet: Agent Desk does not recognize its empty prompt, so it refuses rather than typing into a busy session. Cortex Code asks whether to trust a new folder before it starts; a worker in an untrusted folder shows that question as needing you.

The native picker runs inside the interactive pane. Session IDs refer to saved conversations, not process IDs. Resuming starts a new process with saved history; it does not stop the original terminal or automatically identify which conversation its PID belongs to. Custom harnesses can use their own resume command through the existing executable and argument fields. Remote histories must be resumed on their remote host through SSH.

These commands were checked against installed CLI help; [official OpenAI documentation](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-resume) also describes Codex resume and its folder-scoped latest option.

### Session controls and activity

The sidebar has a compact status menu with counts and shows adapter tasks or harness-provided terminal titles. A green pulsing dot means a reported working state or recent terminal output; gray means quiet. Terminal activity checks run every two seconds, including for terminals without an open pane. Quiet does not mean a task is finished, and output does not confirm reasoning progress. Exact task and input-request states require harness events. Reduced-motion preferences disable the pulse.

Use × beside a managed terminal to close it. Running terminals ask before stopping their command; exited terminals are dismissed immediately. Dismissals persist in this browser. The × in a pane header only hides that pane and keeps the terminal running. Terminal titles are saved with screen checkpoints so they survive refresh.

### Accounts

Every agent starts with one account: the login its CLI already uses. To use a second login, such as a personal subscription beside a work one, open **New → Terminal → Accounts**, pick the agent, name the account, and enter its config folder (for example `~/.claude-personal`). Agent Desk starts that agent's CLI with its folder variable set, so no shell alias or wrapper is needed: `CLAUDE_CONFIG_DIR` for Claude, `CODEX_HOME` for Codex, `GROK_HOME` for Grok, `PI_CODING_AGENT_DIR` for Pi and `XDG_DATA_HOME` for OpenCode. Sign in once from any terminal, for example `CLAUDE_CONFIG_DIR=~/.claude-personal claude` or `CODEX_HOME=~/.codex-personal codex login`.

OpenCode keeps its login in its data folder rather than its config folder, so an OpenCode account moves `XDG_DATA_HOME` for everything run in that terminal, and its skills and settings stay shared with your usual OpenCode. An account selects a saved login, not API keys: Agent Desk removes the Anthropic and OpenAI keys from an account's terminal, but a CLI that finds another provider's key in your shell environment, such as Pi or OpenCode, can still use it. A Cortex Code account is a saved Snowflake connection instead of a folder: name it and enter the connection name that `cortex connections list` shows, and Agent Desk starts `cortex --connection <name>`. Its conversations, settings and skills stay in your one `~/.snowflake/cortex`.

An added Claude or Codex account appears as its own choice in the terminal launcher, coordinators, automations, the model router, account quota, Skills and conversation import. An added Grok, OpenCode or Pi account appears in the terminal launcher, as a coordinator worker and planner, and in Skills (Grok and Pi), and a Cortex Code account in the terminal launcher and as a coordinator worker; its conversations are found for resuming, and an added Grok account's history can be imported. Account quota is not read for them, automations and skill tools still run on Claude or Codex, and a terminal coordinator on Grok uses its own login. Accounts are saved in `accounts.json` in the data directory. Removing one leaves its config folder alone; sessions saved under it can no longer be resumed until it is added again under the same name. Two accounts with the same name, one for each agent, go together: a coordinator on Claude · Personal launches Codex workers on Codex · Personal.

The sidebar preserves the chosen agent and account label across refreshes.

The Codex/Claude choices use an interactive login zsh, loading aliases and functions from the normal shell configuration. Choose bash if that is where your commands are defined, or executable directly for a binary or script. Enter only the command name or absolute path in Command; additional arguments go one per line. Resume options use the selected harness's arguments and keep the chosen account. Aliases defined only in another terminal's memory must first be saved in the shell startup configuration.

### Choosing a project

The terminal launcher discovers Git repositories and worktrees in common local project folders (`~/personal`, `~/projects`, `~/code`, and similar roots). Choose a project to fill its working directory, scan another absolute folder, or enter a path manually. Scans skip hidden/dependency/build folders and symlinked subdirectories, search up to four levels, and stop at a time or directory limit.

Choose **New directory**, enter its parent and name, then launch. The app creates an empty folder for the agent to work in; it does not initialize Git or invent a project setup. Existing folders are never overwritten. If the agent command fails to launch, the new folder remains selected for retry. Discovery and directory creation use the same authentication and origin checks as managed terminals.

The project field is a keyword search: type any part of a repository's name or path to narrow the list, move through it with ↑/↓, and choose with Enter or a click. The two directory choices, **Use a directory path** and **＋ New directory**, stay in the same list. Each row shows the repository name with its parent directory, including nested worktree folders. The launcher keeps command overrides, extra arguments, and custom project scans under **Launch settings**. **New → Terminal** is the primary interactive-session action.

### Controller agents

Click **Coordinator** beside **New**, choose a Codex or Claude account, or Grok, and enter an objective. The controller opens as an ordinary interactive terminal with initial instructions and access to `scripts/agent_control.py`. It can list sessions, read output, send tasks/responses, press keys, launch workers, interrupt commands, and stop managed terminals. Its normal harness permissions still apply. The default objective asks it to summarize running agents and wait for instructions.

The CLI uses the existing authenticated loopback terminal API, so this feature needs no server restart. It reports externally discovered sessions as `controllable: false`; resume those in Agent Desk before controlling them. Reads return bounded transcripts with byte cursors, not exact screen snapshots or inferred task states. Controllers should inspect output before/after input, coordinate file ownership, and avoid blind retries after ambiguous writes.

```sh
python3 scripts/agent_control.py list
python3 scripts/agent_control.py read terminal-ID --tail 16000
python3 scripts/agent_control.py send terminal-ID --text 'Run the relevant tests and report results' --submit
python3 scripts/agent_control.py key terminal-ID interrupt
python3 scripts/agent_control.py launch --cwd /absolute/project --name 'Test worker' -- codex 'Run the tests'
python3 scripts/agent_control.py stop terminal-ID
```

Use `--desk http://127.0.0.1:PORT` before the subcommand for another local instance. `send` uses bracketed paste; `--submit` sends Enter afterward. For longer tasks, use `--file /absolute/task.txt`. The controller's role/account label is remembered in this browser; its backend session name also starts with `Controller ·` for CLI discovery.

### Desks

A desk is a named set of sessions with its own sidebar, open panes and layout, like a herdr session, for example one desk per project. The switcher at the top of the sidebar shows the current desk. Click it to switch to any desk or choose **New desk**, type a name and press Enter; the new desk opens empty. Hover a desk in the menu (or focus it with the arrow keys) to rename or delete it. Deleting asks first and moves the desk's sessions to a desk you choose; they keep running.

Terminals, coordinators, SSH connections and automations you run by hand are placed by the server on the desk you started them from. Scheduled and event-triggered runs start on the first desk. Anything a session starts, such as a coordinator's workers or a terminal's subagents, follows that session to whatever desk it is on. A terminal an agent starts (`agent_control.py launch --parent`) opens as a pane on that desk while it is running, the first time each browser tab sees it, so the layout holds it like one opened from **New**. Closing its pane keeps it closed. A coordinator's workers stay in the coordinator pane. Right-click a session to move it to another desk or to a new one; right-click a folder header to move the whole folder. A session that moves leaves its folder; a folder that moves stays together. Sessions that were never placed, including everything from before desks existed, are on the first desk, called **Main** until you rename it.

To end everything on a desk at once, use the power button beside the desk's name. Hovering it outlines that desk's name in red. It asks first, in a dialog that names the desk, lists each of its sessions with what will happen to it, and names the desks that keep running. Terminals are stopped and closed. A coordinator's workers are saved first, so the coordinator can resume them. Coordinators are closed and saved, so you can reopen them from Coordinator sessions. Finished terminals are cleared from the sidebar. Sessions Agent Desk did not start, such as ones reported by an adapter, are listed as left running. Only the sessions shown in the dialog are stopped: one started on the desk while it is open, and anything on another desk, keeps running. If a session cannot be stopped, for example on a disconnected remote, the dialog stays open, names it and says why. The rest are still stopped. The desk itself stays. The button is disabled on a desk with nothing to shut down.

Switching desks puts the current desk's panes away and brings back the other desk's; the terminals behind them keep running. Each browser tab chooses its own desk and keeps it across reloads, and a new tab opens the last desk you used. Inbox, Automations, Run & Schedule, Tools and Skills are shared by every desk. A session on another desk that needs you still raises the alert: the switcher shows an amber count, the banner names the session's desk, and opening it from the banner or the Inbox switches to that desk. Desks and placements are stored in `desks.json` in the data directory (`desks-PORT.json` for a port other than 4310). An unreadable file is moved aside as `desks.json.unreadable-TIME`, not overwritten.

### Session organization

Controllers appear first in a separate sidebar group. Drag a session to reorder it within its group, or focus its row and use Alt+Up/Down.

To put sessions in a folder, drag one onto the middle of another; dropping near a row's top or bottom edge still just reorders. New folders are named Group 1, Group 2 and so on, taking the lowest free number. Drop a session on a folder's header to add it, or between two members to place it there; drop it beside an ungrouped session to take it out. A folder left with one session dissolves. Click a folder's header to collapse or expand it: collapsed, it previews its members and keeps showing the warning badge when one of them needs you, and a search or status filter opens every folder so matches are never hidden. Drag a header to move the whole folder. Right-click a header to rename, collapse or ungroup it (Enter saves a name, Escape cancels), or right-click a member to remove it from its folder. Alt+Up/Down steps a session out at a folder's edge and over a whole folder rather than into it; on a header it moves the folder. Folders only hold one kind of session, so coordinators and agents are never mixed. Folders are saved per browser beside the session order, with separate live/demo sets; closing a session does not by itself change them.

In the workspace itself, press and drag a pane's header row to move that pane in the grid, or focus its ⠿ move control and press ←/→ (Alt+arrow works too); the pane lifts and follows your cursor while the pane you hover slides into the slot you took it from — dropping swaps the two. Escape during a drag cancels it and eases everything back, and the order is saved with the rest of the pane state. Pane dragging uses pointer events, so it behaves the same in every browser; on touch the header still scrolls the stacked layout and the move control is the way to reorder. Ordering is saved per browser, with separate live/demo orders; filters and refreshes preserve it. The controller group always stays above workers. Processes discovered outside Agent Desk are hidden from the sidebar and cannot remain selected as panes. The controller CLI still identifies them as external/read-only when listing local activity.

### Returning delegated results

Controllers should use `dispatch WORKER_ID --controller CONTROLLER_ID --text 'task'` instead of plain `send` for delegated work. Dispatch appends a worker callback command and records a durable task ID in `data/control-mailbox.sqlite3`. The worker calls `reply TASK_ID --text 'result'` or `--file /absolute/result.txt`, with `--outcome blocked` or `failed` when appropriate.

New coordinators dispatch work and end their turn. A local relay watches the durable mailbox and batches worker replies into native harness events: Codex uses `codex queue` after its first turn registers the exact thread ID through a launch-scoped `notify` callback; Claude uses the `agentdesk-events` stdio MCP channel. Neither transport types into the terminal, presses Enter, or approves prompts. The coordinator reads `inbox --controller CONTROLLER_ID`, handles results, and calls `ack TASK_ID --controller CONTROLLER_ID`. The legacy `wait` command remains available for compatibility, but event coordinators must not use a polling loop.

The Inbox shows worker results and notification state separately from acknowledgement. A successful transport write is not proof that the model processed it. Claims are persisted before sending; ambiguous sends and relay crashes are never automatically retried. Inspect the coordinator before selecting **Retry notification**, which can cause duplicate delivery. **Mark handled** acknowledges a result manually. Replies remain available after sessions end; backend restarts reconnect to the same supervised terminals and preserve task routing. Exited terminals are not resurrected or silently replaced.

Claude custom channels require the research-preview `--dangerously-load-development-channels server:agentdesk-events` opt-in. This opts in only the bundled local channel; it does not bypass tool permissions or organization policy. Accept Claude's startup channel consent if shown. Organizations can block channels, and Claude may silently discard notifications; unacknowledged results remain visible in the Inbox. Codex requires a CLI with the native `queue` command and uses the coordinator's selected executable/alias and account settings for queue delivery. The launch-scoped `notify` override replaces any configured external notifier for that coordinator only; normal terminals and global configuration are unchanged. Existing coordinator sessions need to be relaunched for event delivery. Native harnesses serialize incoming events with their other work; this is not concurrent model turns in a single conversation. Worker permission prompts still use Agent Desk's existing Needs you detection; the event transport handles explicit completed/blocked/failed task replies.

Transport references: [Claude channel contract](https://code.claude.com/docs/en/channels-reference), [Codex notify callback](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications).

For retries, reuse `dispatch --task-id TASK_ID`: existing delegations are returned without resending. Ambiguous input failures are recorded as `send_uncertain` and require inspection. Existing untracked tasks must be recovered by reading the worker; the new protocol cannot invent a callback for an old message.

Terminal checkpoints also preserve saved cursor positions, scrolling margins, and mode state omitted by xterm's serialize addon. The adapter is tied to the vendored xterm version; `tests/browser/terminal-continuation.cjs` exercises resumed rendering with saved cursors, scroll regions, origin mode, alternate screens, and trimmed scrollback (requires Playwright and the local static server).

### Annotation tool workspaces

**Tools** is a launcher and workspace library. Open tools have separate persistent iframe tabs: switching tabs or visiting the library does not reload the tool or discard its unsaved form state. Closing a tab stops the tool it belongs to, so nothing keeps serving after you close it; **Reopen** in the library relaunches a stopped tool with the same target and ID, on a new port and with a fresh page. The old top-bar dropdown is removed. Managed tools can be stopped and relaunched; removing a stopped/external registration does not delete the tool's annotation files. Externally registered processes are never stopped by Agent Desk.

The catalog includes the annotation skills recognised by name and every skill with an `agent-desk-ui.json` manifest. Skills can continue using `scripts/skill_ui.py --skill NAME --target PATH --desk http://127.0.0.1:4310`. It uses the same lifecycle manager as the UI. By default the same skill/target reuses one running workspace; provide distinct `--id` values for intentionally separate instances. Each tool retains its own feedback workflow; the launcher does not assume that different tools share an annotation format or automatically relay their feedback.

For an additional Python annotation skill, add `agent-desk-ui.json` alongside its `SKILL.md`:

```json
{
  "runtime": "python-http",
  "title": "Prototype annotations",
  "description": "Pin feedback on a local prototype.",
  "entrypoint": "annotate.py",
  "target": "file",
  "args": ["{target}", "--port", "{port}", "--no-browser"]
}
```

The entrypoint must remain inside the skill directory. `target` is `file` or `directory`. The server must use Python's `socketserver.TCPServer`/`http.server` family, bind to `127.0.0.1` with the provided port, and remain in the foreground. The runtime reserves the socket and passes its open file descriptor to the Python wrapper; it never releases a candidate port and hopes the child acquires it. Concurrent launches cannot claim the same reserved port. A requested occupied port fails without contacting or registering the unrelated service. Startup is acknowledged by the exact child instance after it starts listening. New runtimes can be added later; other servers can register an existing local URL with `--url` today.

Write the skill's instructions to launch through this helper and return its `/apps/ID` endpoint. Store annotations beside the target or in a persistent workspace directory, and give the calling agent a concrete command to read or await submitted feedback. Tool process records and logs live in `data/tool-runtime`; process identity is checked before stopping a managed server. The app can recognize these processes after an Agent Desk server restart.

Terminal approval alerts recognize explicit Yes/No menus (including Claude and Codex approval prompts) and y/n confirmations from the rendered terminal screen. Waiting sessions appear as **Needs you**, with a persistent banner across pages and a browser-tab count; clicking the banner opens that session. Monitoring includes closed panes while Agent Desk is open. This is prompt recognition, not a universal harness state API: unfamiliar menus and free-form questions may need adapter events to report `needs_input`. The monitor never responds to prompts or sends terminal input.

## Special agents and review inbox

**Dismiss all** beside the Inbox filters clears everything in the current view at once. It follows the active filter and search, counts only items that can be dismissed, and never touches a session waiting on your answer. A confirmation names the exact scope first. Automation findings and workflow runs move to History and can be reopened from there; coordinator replies are marked handled, the same as **Mark handled** on the item itself.

The Special agents page saves reusable watcher, fixer, researcher, and custom roles with explicit scope, instructions, working directory, and harness/account command. **Run now** starts a managed terminal with the role instructions and an explicit callback to `scripts/special_agent.py`. **Delete** removes an automation after an in-app confirmation; it is refused while one of its runs is still going, or while a Run & Schedule launch configuration still uses it as a task. Deleting keeps the automation's past runs and the findings it already sent to your Inbox. Custom commands must accept the task prompt as their final argument. Roles use connectors already configured in their harness; saving a Slack watcher does not connect Slack.

Findings are deduplicated by role and source event key. Reports are durable and idempotent, and marking a finding reviewed does not allow a repeated observation to reopen it. The page keeps run history and marks runs interrupted when their terminal ends without a report. A role cannot launch another pass while its prior managed terminal is still running. Launching, reporting, and review APIs use the same local authentication as managed terminals. Data lives in `data/special-agents.sqlite3` with owner-only permissions.

Saved automations support manual, scheduled, and event-triggered DAG tasks through Run & Schedule, with an in-app review inbox. Event sources are described below. External notifications are not implemented. Keep explicit channel/repository scope and an allowed-action policy. Worker fixes should use isolated checkouts and attach validation and review-tool links to their handoff. Role prompts request read-only watchers and review-only local fixes; these instructions do not replace the harness's permission enforcement.

Annotation startup now fetches server deletion records before rendering or uploading browser-cached notes, preventing deleted pins from flashing back during reload. The browser keeps cached pins hidden if the workspace cannot be reached.

The former Agent roles page is now **Automations**, with an explicit Manual trigger label. **Inbox** is a separate destination combining live session requests and saved automation findings/reports. It includes attention/review/history filters, search, source links, session navigation, and review/dismiss/reopen actions. Opening a live request does not approve or dismiss it. The broader workflow and remaining reliability work are described in [workspace direction](docs/workspace-direction.md).

## Agent map and Run & Schedule

**Agent map** switches the Sessions workspace to a zoomable, scrollable DAG. Nodes open their corresponding sessions. Managed launches accept `parent_id`; controllers can record a spawn using `scripts/agent_control.py launch --parent TERMINAL_ID …`. Adapter events may also report `parent_id`, with cycles rejected. Existing sessions without recorded lineage stay independent; harness-internal subagents require their own adapter reports.

**Run & Schedule** manages launch configurations for local HTTP apps, finite commands, and saved automations. Choose a discovered project or enter its directory. Enter the executable and one argument per line; apps must include `{port}` where their strict port option belongs. The worker chooses an available port, also sets `PORT`, and checks that the launched process tree owns the listener and serves HTTP at `/`. A confirmed port conflict is retried up to three times. A fixed or independently chosen app port is not accepted as ready. Startup has a 30-second limit; ready apps persist until stopped. Commands have a configurable timeout. No dependencies are installed and no arbitrary project command is inferred or run merely by discovering a project.

Each configuration has **Delete** beside its Run, Schedule, Edit, and Logs actions. An in-app confirmation names the configuration and explains what remains. Deletion keeps named run history, logs, Inbox results, and any saved automation used by the configuration. It is refused while a run is queued or active, or while a saved workflow still uses the configuration; stop the run or remove those workflow references first. A stale editor cannot recreate a deleted configuration. The authenticated endpoint is `POST /api/workflows/delete-config` with `{"id":"CONFIG_ID"}`.

Build a workflow by adding configurations as tasks and selecting their upstream dependencies. The editor rejects cycles. Use **Run now**, a one-time UTC timestamp, or five-field numeric cron with an IANA timezone. The schedule table shows enable/pause state, next run, and last result. The DAG can show one workflow or all schedules and their tasks. **Run history** is a table of the most recent runs — status, workflow, task types, its tasks, when it started and how it ended — where each task links to its output or agent session and a running row offers Cancel. Click a run, or its workflow name, to open its details: when it started and finished, how long it took, what triggered it, and for each task its state, duration, the reason it gave, and links to its output, its agent session or its running app. Filter it by workflow, by task type (App, Task, Agent) or by status.

The SQLite scheduler atomically records each scheduled occurrence with its next due time. It starts downstream tasks only after upstream success (or app readiness), skips failed dependencies, prevents overlapping runs of a workflow/configuration, and allows four starting/running tasks at a time. Overlapping schedule occurrences are recorded as skipped. After sleep or downtime, one overdue occurrence is coalesced; missed ticks are not replayed in a burst. A local schedule requires Agent Desk running and the Mac awake. Supported cron syntax includes numeric lists, ranges, and steps; occurrence lookup is limited to the next year. One-time dates are entered in UTC; cron dates use the selected timezone, including DST transitions.

Workers for commands/apps run separately from the web server and retain their SQLite state, PID ownership marker, and bounded logs across a server restart. Interactive automation terminals belong to the persistent supervisor and continue across backend restarts. Automation tasks wait for the existing durable report callback; quiet output is not completion. Successful workflow-owned automation sessions close after reporting, allowing the next scheduled pass. Blocked sessions stay available to inspect. App and command results appear in Inbox; automation findings use their existing review handoff.

Files: `data/workflows.sqlite3`, an exclusive scheduler lock beside it, and owner-only logs under `data/workflow-logs/`. Tests use isolated databases and fixture processes; no real automation schedule is enabled during development checks.

### Event-driven workflows

Open **Run & Schedule → Event sources** in the header, add a source, then enable it. The source manager is also available through **Manage** beside the workflow source picker. Create a workflow using **Trigger → Event**, select the source, and choose a dotted payload field with **Equals**, **Contains text**, or **Exists**. Equals accepts JSON values (including quoted strings) or plain text; types matter. For example, payload `{"event":{"type":"message"}}` matches field `event.type` equal to `message`.

If a refreshed page is still connected to an older running backend, the Event sources dialog shows a restart message; source creation and the Event trigger remain unavailable until the backend is updated. Configuration deletion also reports that it needs a restart instead of silently removing the card. The first upgrade from a backend without persistent supervision still stops its old terminals; finish or save those sessions before that transition. Subsequent backend restarts preserve supervised local terminals.

Rules always save paused, including rules created through the API. Review their tasks and select **Enable** in the schedule list. Ordinary API clients cannot enable event rules: activation requires the authenticated, same-origin browser flow. This is a cooperative human activation gate within a local application, not isolation from a hostile process running as your OS user. Editing a rule or one of its launch configurations pauses the rule and discards its waiting events. A configuration runs directly as a one-task workflow; connect more tasks for a sequence or DAG. Saved automations receive the full event envelope in their prompt as untrusted data. Commands and apps receive that JSON in `AGENT_DESK_EVENT`; payloads are never interpolated into a shell command.

Each `(source ID, event ID)` can start at most one workflow, even across concurrent requests and server restarts. If multiple enabled rules match, the first rule in the saved list wins. Use one workflow with multiple tasks to fan out. A source ID is stable across edits and token rotations. Recreating a deleted source creates a new ID and namespace. Receipt metadata is retained permanently to preserve deduplication; event payloads leave the queue on dispatch or discard, and dispatched payloads remain with their run records.

Sources show their enable/pause state, last seen time, and latest delivery or observation error. **Recent events** shows ignored, waiting, dispatched, expired, and discarded events, with links to runs. No enabled matching rule means the event is recorded as ignored; enabling a rule later does not replay it. Pausing a source or rule discards events still waiting for it, while runs already created continue. Source edits pause the source. Source deletion requires removing references from rules first and preserves past receipts and runs. Webhook tokens can be replaced from the source row; only their hashes are stored.

**Queue and downtime policy.** Up to 256 matched events wait durably across all sources. An event waits for the current workflow and every configuration it uses to finish, so ready persistent apps also hold the queue until stopped. Queue entries expire 24 hours after the source's `occurred_at`, or receipt time when omitted. A full queue returns HTTP 429 without consuming the ID: retry that same ID later. While the server is down, webhook senders retain and retry their events. The local bus cannot receive or run work while its host is asleep. Polling sources compare the latest observable state when the host wakes; intermediate changes cannot be reconstructed. Resuming a paused polling source establishes a fresh baseline, skipping changes made while paused.

- **Webhook:** the existing loopback-only server accepts `POST /api/event-bus/webhook/SOURCE_ID`, authenticated with that source's bearer token. The one-time connection dialog supplies the URL, token, and copyable curl example. Desktop mode also shows the real workspace address and Unix socket; adapters authenticate with only their source token and ingestion returns 409 while desktop shutdown is paused. This is separate from the session-status adapter endpoint `/api/events`, which still starts nothing. Requests need JSON with only `id`, `payload`, and optional `occurred_at` (Unix seconds). IDs contain 1–200 letters, digits, or `. _ : @ / -`; payload is an object. The body is limited to 32 KiB and payload nesting to 12 levels. Unknown sources, bad tokens, malformed/unknown envelope fields, non-finite JSON numbers, and browser-origin webhook requests are rejected. Events older than 24 hours are rejected with 410; paused sources return 409. Accepted deliveries return 202; previously accepted IDs return 200 with `duplicate: true` and their current state/run ID.
- **File or directory:** supply an existing absolute path. Every five seconds, compare file metadata (type, modification time, size, inode) or a recursive directory snapshot, up to 2,000 entries, without following directory symlinks. Initial observation sets the baseline. Creations, modifications and deletions emit `path`, `kind`, `change`, `paths` (first 50 changed relative paths), and `changed_count`. File contents are not read. Filesystems that preserve all compared metadata can conceal a content change. Errors and queue pressure retain the old baseline and retry with backoff; intervening changes coalesce.
- **GitHub PR or URL:** runs in the existing `coordinator_watches` polling thread, reusing GitHub fetching/fingerprinting. Enabled sources check every three minutes, with backoff on failure. A PR emits `state`, `head`, `review_decision`, `checks` (first 30), `url`, and a fingerprint covering relevant checks/reviews/comments. It uses the existing `gh` login. A URL compares HTTP status and the SHA-256 of up to 1 MiB of response content and emits `url`, `status`, and `sha256`. First checks set baselines. Source watches continue until paused; existing in-run coordinator monitors retain their original idle/24-hour stopping behavior.

In desktop mode, copy the exact socket path from the connection dialog:

```sh
curl --unix-socket '/absolute/private/path/backend.sock' \
  'http://app/api/event-bus/webhook/SOURCE_ID' \
  -H "Authorization: Bearer $SOURCE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"id":"upstream-event-id","payload":{"type":"message"}}'
```

The workspace address (`agent-desk://WORKSPACE_ID`) identifies the backend workspace; the app window origin is separate. Browser mode keeps its loopback HTTP URL.

Any external process can post events to a webhook source. Use the upstream system's stable event ID as `id` and place its event object inside `payload`. Keep upstream credentials, event cursors, and any retry spool in that process. Set the source token in its environment, and post locally:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $AGENT_DESK_SOURCE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"id":"event-example","payload":{"event":{"type":"message","text":"Inspect this"}}}' \
  http://127.0.0.1:4322/api/event-bus/webhook/SOURCE_ID
```

Use the URL from the source dialog for your instance. Reuse the original ID and occurrence time on retry. The source token authorizes event admission only; it cannot create rules, enable them, or launch arbitrary configurations. This release provides the adapter boundary, not a hosted Slack subscription or a Slack credential setup flow.

The authenticated management API is `GET /api/event-bus` and `POST /api/event-bus/{save-source,toggle-source,rotate-token,delete-source}`. Rules use `/api/workflows/save` with `trigger: "event"` and `event: {source_id, predicate: {field, op, value}}`; omit `value` for `exists`. The event queue, permanent dedupe receipts, and workflow creation share the same SQLite transaction. A crash before commit creates neither a run nor a dispatched receipt; a crash after commit resumes the already-recorded execution instead of creating another.

### Saved terminal executables

In **New → Terminal → Custom executable**, enter a command, shell mode, and arguments, then name it under **Save this executable** and select **Save as new**. It appears under **Saved executables** in the agent selector. Select a preset to restore its defaults, use **Update saved** to change it, or save a different name to keep multiple configurations (for example, separate accounts or config directories). Removing a preset does not stop existing sessions. Presets and the last selected preset persist in this browser's local storage, like the existing launcher settings; they are not yet shared across browsers or devices. Saving a preset never launches its executable. Generic presets do not infer harness-specific resume flags or controller support.

Tool tabs now have close buttons, visible tab shapes, and arrow-key navigation. Closing a tab hides its frame without stopping the tool or deleting its feedback; reopening it from **Your tools** restores the same frame and unsaved draft during the current page visit. Closing the final tab returns to **Tools library**. Stop remains a separate action on the tool card. The sidebar groups are labeled **Coordinators — Assign and track work** and **Agents & shells — Run tasks directly**.

Selecting a coordinator temporarily brings its descendant workers to the top of **Agents & shells** and highlights its team using recorded parent IDs. Selecting an unrelated agent clears the focus; saved drag order is unchanged. In **Agent map**, click a coordinator to show only it and its descendants, use **Open coordinator** to enter its terminal, or **Show all agents** to restore the complete map. Nested coordinators can be focused independently.

Use **Rename** in a managed terminal's pane header to set its display name. Names survive page refreshes and are shared with other browser tabs while the session exists. The original launch name, terminal ID, parent relationship and callback routing remain stable. Renaming does not rename the harness's saved conversation; supervised local sessions and their names survive backend restarts.

Claude coordinators now install launch-scoped `SubagentStart` and `SubagentStop` observer hooks. Harness-internal subagents appear in the sidebar and team map under their hosting terminal, labeled **Claude internal · read-only**, with their latest final response and **Open parent session**. This ownership edge identifies the hosting terminal; the hooks do not establish deeper nesting between native subagents. They have no independent PTY and cannot receive `send`, `dispatch`, or `stop` commands. A stopped response is not proof of task success; missing final events after a parent ends show Unknown. Existing sessions need relaunching to install these hooks, and already-running native subagents cannot be reconstructed from the new hooks. Coordinator prompts explicitly prefer managed terminal workers for delegated work. This observer currently covers Claude coordinators, not arbitrary externally launched Claude sessions or Codex native subagents.

Grok coordinators open the installed Grok CLI directly, preserving its native TUI, arguments, authentication, and permission controls. A passive Node.js process uses the vendored xterm renderer to observe the current screen; it never responds to terminal queries. Agent Desk delivers a bracketed-paste notification only after recognizing a stable, empty Grok prompt with paste mode enabled, at least five seconds after user input. Busy, approval, draft, unrecognized, and incomplete redraw states leave replies queued. This also works with the browser closed. Ctrl+C or Esc pauses delivery; submitting your next message at the native prompt resumes it. Notifications are claimed before terminal input and never automatically retried after uncertain delivery. Results still require an explicit coordinator acknowledgement. No permissions are automatically granted. Node.js is required for Grok coordination; ordinary Grok terminals do not need the observer. Screen recognition is conservative and can require updates after Grok UI changes.

Internal subagents are nested immediately below their hosting agent with an explicit parent label. Finished subagents and those whose parents are no longer running are hidden by default; **Show finished subagents** reveals their retained results. They are not deleted. The native hook status records a finished response, not verified task success.

Claude startup output reporting that channels are blocked by organization policy now sets an explicit Needs you / delivery-blocked state; unacknowledged replies remain in Inbox and retry is disabled for the blocked transport. A connected MCP server is not proof that channel events are accepted. An administrator must enable Claude channels for automatic delivery; the app does not bypass the policy. The user can ask the coordinator to read its inbox manually in the meantime.


### Dedicated coordinator conversations

The **Coordinator** button opens a coding-agent-style conversation with a multiline prompt, tool activity, expandable output, native worker links, and slash commands (`/help`, `/workers`, `/pause`, `/new`). Enter sends; Shift+Enter inserts a line; Escape pauses coordination. Drafts stay in this browser across refreshes. Conversations, queued turns, actions, and worker results are stored locally in `data/coordinators.sqlite3`. Reasoning can use Claude Work/Personal, Codex Work/Personal, or Grok through their installed native CLIs. Calls are bounded and return validated structured coordinator actions. You can optionally select a model. Workers may use Claude, Codex, or Grok and retain their own terminal and permission UI.

The runtime validates and executes launch/send/read/ask actions. It reserves a callback before starting each worker. Results are committed to the coordinator transcript before being acknowledged, and then queued for the next reasoning turn. User messages stay accepted while a turn is active; queued messages are batched, and request IDs prevent duplicate submissions. Pausing stops the coordinator turn, leaving native workers running. A restart preserves the conversation; interrupted actions are marked uncertain and are not replayed automatically. Missing worker callbacks create an explicit attention item instead of implying success. Claude and Codex workers have launch-scoped turn-end observers that save provisional progress separately from task results. A turn ending never completes a task or triggers a coordinator turn, even when background-job status is unavailable. Only an explicit callback supplies the final outcome; a worker exit without one requests attention. Later explicit replies cannot be blocked by provisional observations. Legacy automatic results are demoted to progress, with their transcript history relabeled as interim. Grok workers currently use the supplied callback. Native terminal coordinators remain available through **New → Terminal → Coordinate other agents**.

Dedicated coordinators prefer `send` for follow-up work on an existing worker’s worktree. Each follow-up gets a fresh callback ID. Sending requires a prior explicit result, no outstanding task for that worker, and a recognizable empty native prompt (Node.js required). Busy, draft, and unrecognized prompts keep the message queued as **Waiting to deliver**, with a **Cancel** button. A passive screen observer follows output and resizes from launch, independently of the bounded replay history. The runtime checks queued deliveries once per second without creating model turns and sends only after recognizing a stable empty prompt. Approval controls and user drafts remain untouched. New assignments also wait for the prior explicit final report. A `nudge` clarifies the current assignment without creating another callback; a final report cancels an undelivered nudge. Pausing the coordinator suspends delivery. Exited, foreign, and failed screen observers require inspection. Ambiguous writes are never automatically retried or replaced with a new worker. Queued actions are persisted, but a backend restart still requires restoring any exited worker session; they are not blindly redirected to a different terminal. The observer applies to terminals launched after the backend upgrade.

Coordinator worker results show **✓ Ready for review** with a **Review & close** action after an explicit completed report. Confirmation saves the native conversation ID, launch account, directory, task history, and a terminal-output snapshot before stopping the process. **Saved sessions → Resume** starts the same native conversation in a new terminal; it never picks the latest conversation by folder. Claude/Codex hooks capture IDs automatically; workers without a captured ID require the exact native ID before retirement. Keep the native harness history and worktree on disk: Agent Desk stores resume metadata, not a portable replacement for the harness session files. Duplicate resume requests reuse the live resumed terminal, and uncertain launches require inspection instead of automatic retries.

The **Coordinator** button lists prior conversations as well as **New coordinator**. Opening one restores its transcript without submitting a model turn. Worker launch/account/directory/conversation links are checkpointed while the server runs and at shutdown; after a restart, missing terminals appear under **Saved sessions**. The coordinator’s reasoning context includes its original goal, durable task ledger, and saved worker links in addition to recent messages. Its `resume` action reopens a specific prior worker; unfinished assignments keep their original callback IDs. Workers without captured native IDs remain listed for manual linking, and are never replaced with an arbitrary latest session. Before upgrading an older server without checkpoint support, `python3 scripts/checkpoint_live_workers.py --save` can capture live coordinator-worker links; it reads exact launch arguments and uniquely matching native history without sending terminal input.

Coordinator provider adapters live in `coordinator_planners.py`. Claude uses print mode with tools and MCP disabled. Codex uses ephemeral `exec`, a JSON output schema, read-only sandbox, disabled shell/subagent/app/hook features, and disabled user-configured MCP servers. Grok uses headless mode with a JSON schema, an empty built-in tool list, deny-all tool permissions, and no subagents or web tools. No adapter adds permission-bypass flags or alters saved CLI logins. Provider failures appear in the conversation and do not execute returned actions. Model preferences persist with each coordinator; its worker account choices remain independent.

The sidebar also shows a green checkmark and **Ready for review** for workers whose latest task explicitly completed and have no outstanding task. Approval requests still take priority; a new assignment clears the completion state. Internal harness subagents remain distinct from these explicit task results, with branch lines and parent names in the sidebar. The **speaker icon** toggles optional two-tone alert sounds (and previews the completion tone when enabled). It gates two alerts from one preference and one audio context: a rising chime when a worker reports a finished task, and a falling one when a session moves into **Needs you**. Keep Agent Desk open in a browser tab and interact with it after reloading to unlock browser audio. Existing reports load silently; repeated polls do not replay them. A session only sounds once it has been seen settled in another state, so an approval prompt that was already on screen before the page loaded, or before a terminal observer caught up with its scrollback, is recorded silently; a lost and regained connection does not re-alert. Sessions waiting on you also carry an amber alert-triangle badge in the list, whose space is reserved on every row so it cannot shift the layout when it appears. This is browser audio, not an operating-system background notification service.

Dedicated coordinators expose a **Usage** disclosure above the footer. It tracks new planning attempts and provider-reported input/output/cache tokens in SQLite, deduplicated by turn ID. Claude cache reads/writes are included in normalized input totals; Codex uses its JSON turn-completed usage. Grok counts are accepted only if its CLI returns a recognized usage envelope. Missing counts remain unknown. Interrupted/nonzero-exit CLI calls may consume tokens without reporting them; the meter is not an invoice or an account-wide usage total, and excludes native worker terminals. No historical usage is backfilled.

Planning context is rebuilt for each event, with a 96,000-byte task-context budget and a 128,000-byte assembled-prompt guard. Session rosters contain identities and state instead of terminal dumps/launch metadata. Under pressure, older result excerpts, conversation entries, action history, and completed assignments are trimmed in that order; the original goal, latest user instruction, recent messages, pending assignment entries, and worker/session identities are retained. Full stored history is unchanged. If the essential context cannot fit, the coordinator pauses before invoking a CLI. This is deterministic excerpting, not an AI-generated summary. The UI's prompt token estimate uses UTF-8 bytes divided by four; it is approximate and excludes CLI-added instructions and internal reasoning. Byte limits are not model context-window or billing limits. Workers retain their harness-specific context management. Existing event-driven waiting and bounded inspection follow-ups avoid model polling while workers run.

Coordinators can use **nudge** to clarify an unfinished worker assignment or request its missing final report. It preserves the original task ID, launches no new worker, and uses the same empty-prompt/draft/approval checks as follow-up sending. An ambiguous delivery is reserved as `nudge_uncertain` and cannot be retried automatically; a real worker reply remains accepted. A nudge does not mark completion or unlock **Review & close**. Monitoring instructions distinguish interim terminal updates from the single final mailbox reply, which belongs after the stop condition and background-monitor shutdown.

### Context & memory

Each dedicated coordinator has a **Context & memory** button above its footer after the backend is restarted. The panel exposes pinned notes, searchable conversation history, saved report artifacts, optional reader settings, and deterministic PR monitors. The server must be running for retrieval and monitoring; none of these changes automatically restart a server or migrate live terminal watchers.

Planning now sends the most recent 12 messages plus the latest user message if it fell outside that window, the original goal, eight recent user-directive excerpts, compact durable notes, all pending task entries, and the latest 12 completed task entries. Large outputs are represented by excerpts and local artifact references instead of repeated full reports. Session identities remain available for exact resumes. The existing 96 KB context / 128 KB supplied-prompt guards remain. The full conversation and task records are not deleted or rewritten. Codex/Grok planning input no longer duplicates the system rules and schema already supplied via native flags.

The coordinator's `remember` action saves a small note with a source-message reference; it uses the current planning turn, not an extra summarization call. Notes total at most 12 KB and cite existing user/coordinator messages. Worker reports cannot become instruction sources. These are advisory summaries, not new approvals. User-pinned notes are protected against model overwrite. Notes can be inspected, edited, and removed in the panel; history remains searchable after removal.

`recall` searches the complete saved conversation by literal phrase (12 matches per page), or reads a `message:ID`, `task:ID`, or `artifact:HASH` reference in 6,000-character pages. References are scoped to the selected coordinator. Large reports and retrieved outputs live in private, content-addressed files under `data/coordinator-artifacts` (directory mode 700, files 600) with SQLite metadata. The panel uses authenticated requests and renders retrieved text safely, including clickable links and code blocks.

The optional reader is **disabled until you select a provider and explicit model**. It uses the existing native CLI planning adapters, with tools disabled/restricted as for coordinators, to answer broad read-only questions about up to eight visible UTF-8 source files inside the coordinator project (64 KB per file, 80 KB total). Hidden/credential paths and paths resolving outside that project are rejected. Source summaries do not replace exact source inspection before editing. No global read interception or Portal plugin is installed. Cache keys cover the coordinator, root, account profile, model/connection, reader instructions, question, paths, and exact contents. Unchanged requests reuse an artifact; source/model/question changes miss the cache. A single-flight lock avoids duplicate concurrent model calls. Reader calls are included in coordinator usage totals; cache hits show reused input bytes, not claimed billed-token savings. Native worker usage remains outside this meter.

Native workers receive an optional helper in new launch/follow-up instructions:

```sh
python3 scripts/agent_context.py --coordinator COORDINATOR_ID search "review decision"
python3 scripts/agent_context.py --coordinator COORDINATOR_ID read message:123 --offset 0
python3 scripts/agent_context.py --coordinator COORDINATOR_ID analyze --question "Which module handles reconnects?" --paths src/session.py src/terminal.py
```

Use an absolute script path when running outside Agent Desk. Reader files resolve relative to the coordinator's selected project, not an arbitrary worker worktree. If the reader is disabled, workers should use targeted local reads.

PR monitors use the existing `gh` login and read-only `pr view` / `api` requests. They aim to check about every three minutes, tracking head commit, check status, review decisions, and recent PR/review/inline comment changes. Unchanged polls make no model call. Changes generate durable coordinator events, with full snapshots in artifacts; pauses keep model turns queued. Monitors stop on merge/close, two hours without relevant changes, an explicit stop, or a 24-hour lifetime. Failures notify once per failure streak and back off to 30 minutes. Inline comments are bounded to the latest 100 edited entries. Observation windows are not an exhaustive audit log. There are at most 32 active monitors. Merge observations never finalize worker tasks, stop worker terminals, post GitHub messages, or merge a PR. Existing LLM watchers require an explicit handoff before replacement.

Authenticated coordinator POST routes: `context`, `retrieve`, `save-memory`, `delete-memory`, `configure-reader`, `analyze`, `watch-pr`, and `stop-watch`. `analyze` may take up to a CLI planning timeout; `scripts/agent_context.py` uses a longer request timeout than ordinary UI operations.

### Account quota

Each coordinator shows **Account quota** percentages inline in its footer, with reset and update times on hover. It shows the selected harness account's remaining allowance, reset countdowns, and last successful reading. This is shared account quota, not a per-worker token budget. Each account is queried separately. Codex model-specific quota buckets appear individually when reported.

The backend shares one request per profile across coordinator panes, caches readings for two minutes, and marks failed refreshes or readings past their reset time as stale. Missing quota is unavailable, never zero. Reading quota does not submit a prompt or type into a terminal.

- Codex uses the installed CLI's `app-server` and `account/rateLimits/read`; it never starts a thread or model turn.
- Claude reads the selected saved OAuth login (the profile-specific macOS Keychain item, or that profile's credentials file) and makes a GET to the same internal `/api/oauth/usage` endpoint used by `/usage`. This endpoint is not a public API contract and may change. Agent Desk never refreshes Claude tokens or modifies authentication files; expired or unsupported logins show an unavailable state. Credential values remain in the backend and are never included in responses or quota caches.
- Grok currently shows that account quota is unsupported.

The authenticated `POST /api/coordinators/quota` route accepts a coordinator `id`; the backend chooses its saved profile.

The bottom-left annotation button stays available in the workspace and in dialogs. Click it to drop pins or select elements, then click again (or press Escape) to finish. While annotating, clicks on application buttons create feedback instead of executing the action. The annotation editor's Escape closes only the editor; Escape from annotation mode leaves the underlying app dialog open. Pins follow the active dialog and retain their element selector and exact click coordinates.

Use **Send to agent** in the floating annotation tool to select notes and a recipient. The picker includes saved coordinators and live standalone coding terminals. Coordinators queue the request in their existing conversation; assigned workers receive follow-up work through their coordinator. Standalone terminals use the same empty-prompt guard as worker follow-ups, so busy prompts, drafts, and permission menus are not overwritten.

Submissions save an immutable snapshot of the selected notes, including coordinates, selectors, and viewport details. Coordinators retrieve that snapshot through their context artifacts; terminal agents receive its local JSON path. Sent notes remain in Feedback and are unchecked by default the next time you send. Request IDs prevent duplicate delivery on retries; an ambiguous terminal write requires inspecting the session before submitting again. The authenticated `/api/coordinators/submit-feedback` endpoint requires a backend restart when upgrading an existing server.

Worker review displays the full saved report with readable headings, lists, and code blocks. Opening a review automatically looks for the native conversation in captured callbacks, the worker registry, or a unique Claude/Codex user-history match for the exact task in that terminal's launch command. Ambiguous or missing matches leave the terminal open; the UI provides Retry rather than requiring an ID to be pasted. Account quota percentages are displayed inline in the coordinator footer, with reset/update times available on hover. The Agent map button beside the workspace launch buttons toggles between the map and terminal panes.

Click a terminal or coordinator pane title to rename it in place. Enter saves, Escape cancels, and background refreshes preserve the edit. Coordinator names are stored with the conversation; existing servers require a restart to enable coordinator renaming. Report instructions request inline code for commands/paths and language-tagged code fences. Existing `Action: <shell command>; <explanation>` report paragraphs render the command as a bash block while preserving the explanation.


### Coordinator models and saved closing

Choose or type a model when creating a coordinator. Claude aliases and the selected Codex profile's cached model IDs are offered as suggestions; account availability is still determined by the CLI. The footer always shows **Model: …**, including **CLI default** when no model is pinned. Click it or use `/model` to change the model for the next coordinator turn without replacing the conversation. An in-flight turn and existing workers keep their models.

Coordinators can pass an explicit `model` with each worker launch. When omitted, a worker of the same provider inherits the coordinator's pinned model; other providers use their own CLI default. Send, nudge, and resume retain the existing worker model. Launch receipts record the requested model.

Use **Close coordinator**, `/close`, or the sidebar close button to pause and save a coordinator. Its history and worker references remain available in **Coordinator sessions**. Worker terminals continue running, and their reports are retained while the coordinator is closed. Reopening displays the saved conversation without starting a model call; send a message to continue.

Account quota is separate from model selection. Codex labels describe shared account buckets, not the active model. Claude Work spending allowances and Claude subscription windows are displayed when returned. **Refresh** requests a new reading, subject to a 15-second minimum between attempts. A Grok remaining allowance adapter is not implemented; the footer explains this rather than guessing percentages or substituting session token use.


### Model router

A coordinator can ask a model router which model fits each worker task, then open the harness that runs that model: GPT, o-series and Codex models open Codex, Claude models open Claude Code, and Grok models open Grok. Agent Desk speaks a simple model router service contract: it sends `POST /v1/decide` with the task text, the configured model IDs and a preference (`auto`, `auto-fast` or `auto-cheap`), plus `Authorization: Bearer <key>` when a key is saved. The router only recommends. Provider credentials and worker output are never sent, and the worker uses your saved CLI login.

Open **Router settings** (or **Set up router**) from either coordinator launcher. Enter the router URL, an optional API key, the preference, and one model ID per line. Each model shows the harness that runs it and an account choice: **Same account as coordinator** follows the coordinator's account, while choosing an account pins it, for example when a model is only available on one Codex account. **Save and test** routes a sample task and shows the chosen model, task bucket, reason and decision ID. Settings live in `data/model-router.json` (mode 600). The key is write-only in the UI and never returned by the API. Remote routers must use https; plain http is accepted only on loopback. Redirects are refused so the key is never replayed to another URL.

- **Dedicated coordinators:** check **Pick worker models with the model router** when creating one, or later from **Model: … ▾** in the footer, which then reads **· workers routed**. Agent Desk calls the router on each `launch` whose model the coordinator left empty. The router call runs outside the runtime lock, so other coordinators keep working while it answers. A model the coordinator names explicitly skips routing; a profile it names limits routing to that harness and keeps that profile's account. The launch receipt records the routed model, harness, router reason and decision ID.
- **Terminal controllers:** check **Pick each worker's model with the model router** under the objective. The controller is told to launch workers with `agent_control.py launch --parent ID --cwd DIR --name NAME --route-task 'task'` (or `--route-file`), optionally limited with `--harness codex|claude|grok`, and then to `dispatch` the task as usual. The JSON result includes `routing`, `profile` and a one-line `summary`.

The router must return one of the offered model strings verbatim. Anything else, a 4xx/5xx, a timeout, an unreachable router or an unconfigured router launches nothing: the launch fails with the router's message and no task callback is reserved. Turning routing on requires a configured router. Routing runs on this computer; remote SSH coordinators keep choosing worker models themselves. Routing chooses a model, not quota or availability: if a routed model is not enabled on the selected account, the CLI reports that in its terminal.

### Annotation history and UI learning

Saving a note closes its box; annotation mode stays on so you can add another. **Send to agent** opens a searchable list using the same names as Sessions, with open panes first. Refresh updates the list. Read-only sessions explain why delivery is unavailable, and worker entries identify their coordinator as the recipient. A successful send closes the dialog; failed sends retain the notes for retry.

Annotation saves now retain validated revisions in the local `feedback-history.sqlite3` beside `feedback.json`. Edits preserve the earlier wording and target metadata; clearing removes active pins and records tombstones without deleting the historical revisions. Repeated syncs are deduplicated, and cleared notes remain cleared. This archive is private, ignored local state, not an automatic screenshot capture or an acceptance record.

### Coordinator hooks

Type `/hooks` in a coordinator pane to add, edit, enable, disable, or delete event instructions. Write an open-ended **When** condition and choose the tool to launch, for example: “When a worker finishes a code change, review its diff before reporting back.”

Choose an installed **Tool / skill UI** to launch through the coordinator, or keep **Coordinator instruction only**. Tool targets can be files, the project directory, or another worktree belonging to the same Git repository.

Supported triggers are the before-publish checkpoint, coordinator creation, reopening a saved coordinator, a user message, an explicit worker report, and a worker exiting without a report. Open-ended conditions are evaluated in each normal coordinator turn and included in worker handoffs; matching tool launches are tracked so the same target can reuse its UI. **Advanced timing** optionally restricts a condition to a specific event. Those events are deterministic; natural-language matching is performed by the coordinator. Conditions do not create extra polling model calls. These are event instructions, not arbitrary shell hooks or cron schedules. They retain normal permission and review requirements.

Select **Edit default hooks** to configure hooks inherited by every coordinator in this environment. Enabled defaults are evaluated on each turn/event, including in existing sessions; edits, disabling and deletion apply without recreating a coordinator. Session hooks are additional local settings. Exact legacy copies are retained for audit but excluded from evaluation to avoid firing twice. Distinct customized session hooks are preserved. Local and remote environments maintain their own defaults. Individual coordinator hooks persist across backend restarts and saved-session reopening.

Hooks are queued atomically with their source event and deduplicated on repeated delivery. They join the normal planning turn rather than creating a separate polling model. Paused and closed coordinators do not execute queued work; reopening preserves pause until you send a message. Disabling or deleting a hook affects future events, not instructions already queued. Recent hook events and transcript entries show delivery, not proof that the requested work completed. Only hooks attached to the active turn are supplied as active instructions; historical hook records do not retrigger work.


#### Review locally before a PR

In `/hooks`, choose **Review locally before a PR**, then **Save hook**. The preset selects **Before pushing or opening a PR** and **Code review**. Save it under defaults if new coordinators should inherit it.

The coordinator supplies workers with a `publish-check` command on launch, follow-up, and nudge. Workers finish changes and checks, then call it with their actual worktree and intended PR base. It launches the installed code-review using the shared reserved-port launcher, registers its embedded Tools page, and returns `allowed: false` (CLI exit 3) until local approval is recorded. Startup errors also block the checkpoint. The worker reports ready for review and ends its turn instead of polling.

**Send to Claude** in the review UI delivers feedback to this coordinator, regardless of the coordinator's harness. The coordinator reuses the worker to apply fixes and reply on the review page. **Open PR** records your publication request and requested draft state, waking the coordinator to continue. A changed diff or new feedback invalidates approval at the next check. Old submissions from before the tool was connected are not replayed as fresh approval. Review event polling is local, deterministic, and makes no model calls until new feedback or a PR request arrives.

This is a cooperative workflow checkpoint, not a universal interception of native harness shell commands. A worker that ignores its instructions can still run `git push` directly. It does not retrofit instructions into already-running assignments; send a follow-up or nudge to apply the current policy. Other skill UIs can be launched through hooks, but retain their own feedback mechanisms. Embedded remote skill UI forwarding is not implemented, so this tool workflow currently requires a local coordinator.

Coordinator tool activity is grouped into collapsed **Activity** rows. After four inspection turns, one final summary turn explains findings and uncertainty without starting more inspections. Grok worker session discovery matches the exact dispatched task in native user history; ambiguous matches remain unresolved.

A coordinator resume request for one of its already-running workers reuses that terminal without launching another process. An exited, unsaved worker must first have its exact native conversation saved; unknown IDs and workers belonging to another coordinator produce distinct errors. Memory validation identifies the actual rejected message type rather than labeling every invalid source as worker output.

For a coordinator that manages another repository, use **/hooks → Review projects → Allow project** with its absolute Git repository path. The grant includes Git worktrees sharing its canonical common directory, applies only to that coordinator, and can be removed. Unrelated repositories remain blocked. Saved workers open from **Saved sessions · N** in a separate dialog.

Running tools appear as tabs automatically. Closing a tab leaves its tool running; polling does not reopen a tab you closed. Coordinator-owned hook tools are linked above the conversation. Managed code-review UIs use “Send to coordinator”; their submissions and publication requests are delivered through Agent Desk’s review adapter. Standalone skills retain their original UI and other skill integrations remain tool-specific.

Tools lists agent-launched sessions in a table. Coordinator-owned code reviews offer **Second opinion…** for one to three Claude, Codex or Grok worker profiles. Independent review-only workers report findings to the owning coordinator. This does not approve publication or automatically insert inline notes. Repeated requests reuse their launch records rather than duplicating workers.


Coordinator follow-ups resolve old worker IDs through saved/resumed conversations. If the exact saved conversation is closed, sending a follow-up reopens it with its original account and model. A queued delivery follows that conversation; it is not a started task until delivery succeeds. Actual drafts, busy prompts, and uncertain writes still prevent input. Missing native session identities require recovery rather than a replacement worker.

Local review approval can also be recorded by a direct coordinator message: `we already reviewed locally`, `I already reviewed locally`, `approve all pending local reviews`, or `local reviews approved`. These exact confirmations apply to the latest review for each target and enabled before-publish hook in that coordinator. The system message lists the affected targets; unavailable reviews remain blocked. A generic request to push does not grant review approval. Approval records the current diff and feedback counters and is invalidated by subsequent changes. Reusing a message request ID does not approve a newer diff.

Publish checks consume pending Open PR events immediately, without waiting for the periodic poll. Simultaneous feedback keeps the review blocked. Review identity uses the canonical target path and resolved base commit, so equivalent Git refs reuse the same review. A bare PR base such as `main` prefers the locally fetched `origin/main`; use `refs/heads/main` to explicitly select the local branch. Different commits never share approval. Agent Desk does not fetch Git refs during this check.


Stopping a coordinator worker from the terminal list records an intentional closure before stopping its process. Unfinished assignments and queued input are cancelled; they are not recorded as completed work, and do not generate missing-report errors. Available native session links and terminal history are saved. If a worker never established a native conversation, the saved entry requires an exact conversation ID before it can resume. Coordinators can use `close_worker` when the user explicitly asks to close workers, including workers without final reports. Unexpected exits continue to surface missing reports.


Coordinator `launch` actions accept `cwd`: the existing absolute directory for the worker’s actual project or Git worktree. Empty or omitted `cwd` retains the coordinator’s directory. Paths are resolved before launch, displayed in its result, and saved with the native session. Follow-ups and resumes retain that directory and profile. Independent code reviewers launch directly in the reviewed worktree. This does not change CLI trust settings or approve trust prompts; a new directory/profile can still require native approval.


### Report document structure

Inbox reports are stored as the plain Markdown the reporting agent wrote and rendered into a document by the local renderer; raw HTML in a report body is never inserted into the page. The reading view renders one `#` title, `##` sections (numbered titles keep their number as a quiet chip), `###` and `####` subsections, `-`/`1.` lists with indented sub-bullets, `| pipe | tables |` with the alignment row honoured, `>` blockquotes as callouts, `---` as a thematic break, `**bold**`, `*italics*`, `` `inline code` `` and fenced code blocks. A report that opens with a bolded short label, such as `**Short version:**`, gets that paragraph promoted as the document's summary, and a whole-line italic note is rendered as a quiet aside. Legacy plaintext reports keep their existing treatment: capitalised section titles, divider lines and short lines that introduce a list still become headings.

Tables scroll horizontally inside the reading measure rather than widening it. Everything is built as DOM nodes with text content, so report text is never markup: `html-diagram` fences below remain the only path for real HTML. Refreshing the page loads the renderer; the prompt guidance that asks agents to write this structure needs a backend restart.

### HTML diagrams in Inbox reports

Agents can embed a diagram directly in a saved report, alongside its Markdown explanation:

````markdown
## How the handoff works

The worker reports its result before the coordinator requests review.

```html-diagram
<title>Worker handoff</title>
<style>
.flow { display:flex; flex-wrap:wrap; align-items:center; gap:16px; }
.step { padding:16px; border:1px solid #93b8da; border-radius:8px; }
</style>
<div class="flow" aria-label="Worker to coordinator to Inbox">
  <div class="step">Worker</div><span>→</span>
  <div class="step">Coordinator</div><span>→</span>
  <div class="step">Inbox review</div>
</div>
```
````

Use the usual report/reply command with a UTF-8 file containing the Markdown; no separate upload or port is needed. The Inbox and its standalone document view render `html-diagram` fences as isolated previews with Expand/Collapse and HTML source controls. Ordinary `html` fences stay code. Multiple diagrams are supported (12 previews per report, up to 200,000 characters each; larger blocks remain source).

Use self-contained responsive HTML/CSS or inline SVG, with descriptive titles and a brief text explanation. Native details/summary provides collapsible detail. Scripts, external assets, navigation, forms and access to Agent Desk are disabled. Each preview scrolls independently if needed. Original source remains in the report; only the preview is filtered. This is an embedded diagram view, not a tool UI with app capabilities.

Automation and coordinator-worker prompt guidance encourages diagrams where useful. Backend restart loads new prompt guidance; refreshing the page loads the renderer. Existing saved reports are not rewritten.

Successful automation passes now save their terminal history and any discoverable native conversation ID before closing the terminal automatically. This applies to manual and scheduled runs. A background cleanup loop retries missed cleanup independently of an open browser or workflow worker; the next automation launch also checks for completed terminals. The Inbox report remains available for review. Blocked, failed, and unfinished runs stay open for investigation. Native CLI histories are retained; automation archive metadata lives in the private `run_terminals` table in `special-agents.sqlite3` (a dedicated automation-resume UI is not yet provided). Coordinator workers retain their existing Confirm & close/save/resume flow.

Claude automation launches explicitly use `--permission-mode auto`, including added accounts and direct/login-shell commands. This selects Claude’s classifier-backed mode; it does not bypass permissions or organization policy. Codex and custom executable arguments are unchanged. Existing running terminals keep their original mode; new launch behavior requires the backend to load the change.

The coordinator footer reports its runtime activity: Planning next actions with elapsed turn time, Next turn queued, Waiting for worker results with pending report count, or Ready. Active actions, queued deliveries, pause, user input, errors and lost connection have distinct labels. Elapsed time is based on a persisted server turn-start timestamp, not the last assistant message or page load. Waiting for reports does not imply continuous model calls.

Coordinator `launch_tool` opens an installed UI by catalog ID without requiring a configured hook. `launch_hook_tool` continues to require an enabled hook policy ID. Both preserve target/project validation. A directly launched code review does not satisfy a separate before-publish hook. Tool-selection errors rejected before launching and optional memory-validation errors permit bounded replanning; ambiguous execution failures still stop for inspection.

Completed coordinator workers now automatically save and close after an explicit completed mailbox report and a short acknowledgment grace. Unfinished, blocked, or queued-follow-up workers remain open. Saved sessions include Open report (a standalone Inbox document) and Resume; the coordinator can also send follow-up work to the saved conversation. Exact task lookup keeps local reports accessible beyond the recent-events list. If native session discovery fails, the report/history is still saved and the UI offers Link session & resume. Closing a terminal does not approve its work or bypass publication review. This supersedes the previous default of requiring Confirm & close for every successful worker.


A coordinator can adopt an existing unassigned Agent Desk agent terminal with `attach_worker` (`worker_id` from its `attachable_workers` context). For example: “Attach to my Existing research session and continue that work.” This retains the process, native conversation, account, and working directory; attachment itself sends no input and invents no completed assignment. The coordinator can read the screen and use `send` for its first tracked assignment. Busy prompts and drafts use the same queued-delivery protections as other workers. Explicit reports then feed the existing save/close/resume lifecycle.

Owned workers, automation terminals, native controller terminals, exited sessions and ordinary shells are excluded. Sessions in another terminal application cannot be adopted through this action; resume their native conversation in Agent Desk first. A native conversation ID may remain unknown until the first tracked task appears in harness history; existing recovery UI requires an exact ID if discovery is unavailable. Attachment does not change CLI permission modes.

Schedule shortcuts reopen an existing workflow for the selected task. When multiple workflows use it, choose Edit on the appropriate schedule row. New schedule explicitly creates another workflow. Delete removes a schedule and future triggers while preserving launch configurations, existing runs and history; cancel an active run separately if needed.


### Send README annotations

README annotators launched inside Agent Desk offer **Send to coordinator** or
**Send to agent**. The button sends open notes to the session linked at launch,
including quoted text, source lines, and the document path. It saves pending
comment edits first and shows delivery errors beside the button. Notes stay open
until the requested changes are addressed. A sent badge acknowledges delivery.
Each submission includes a completion command for the worker to run after making
the change; it marks the matching notes done without waiting for user acceptance.
The command refuses an unchanged document, a replaced annotation round, or notes
edited since submission. Repeating an unchanged submission, even in another tab,
uses the same delivery ID.

Launchers should pass `skill_ui.py --agent-id <managed-session-id>` or inherit
`AGENT_DESK_AGENT_ID` / `AGENT_DESK_COORDINATOR_ID`. Relaunching the same tool keeps
its recorded owner unless explicitly overridden. Use the owning coordinator for
assigned workers. An unlinked tool shows “No launching session linked”; external
Codex conversations are not automatically equivalent to Agent Desk terminals.
The annotator server forwards to Agent Desk's authenticated feedback API, so the
button also works when opened directly in a separate Chrome tab. Browser requests
use a per-server annotator token and loopback/origin checks; the Agent Desk token
stays on the server. Completion snapshots live in the ignored readme-feedback
data directory and are checked against the current saved notes before resolving.

## Remote SSH connections

**New → Terminal → Remote → SSH** accepts an SSH host or `~/.ssh/config` alias, optional user, port and identity file. Save a named template to reuse it. It needs OpenSSH only. A successful connection test is tied to the selected configuration and expires after five minutes; changing the target invalidates it. Default port 22 leaves an SSH alias's configured port in effect. New host keys use OpenSSH's `accept-new`; changed keys are rejected.

Choose **Coordinator environment** to run the coordinator and workers remotely. It checks Python, Node and an installed agent CLI before deploying the existing remote runtime. It requires SSH-key login; passwords and interactive key-passphrase prompts cannot be used by the coordinator bridge.

## Feedback delivery and existing agents

**Send to agent** records queued, delivered, failed, cancelled and uncertain states separately. Reopen the Send dialog to inspect or cancel a waiting delivery. Queued feedback waits for an empty agent prompt. Codex's dim empty-composer hint is recognized; drafts, approvals and busy screens still block input. Existing screen observers retain their loaded detector until replaced; updating the web backend alone does not patch them.

A coordinator's worker strip offers **Add existing agent…** for supported unassigned managed agents. Attachment preserves the conversation and sends no input. Automations, external terminals and agents already owned by another coordinator are excluded.

## A shell after a standalone agent exits

New manually launched Claude, Codex and Grok terminals return to your login shell in the same working directory when the CLI exits, including after Ctrl+C causes it to quit. Every Claude and Codex account is supported. Ctrl+C retains the CLI's normal behavior while it is running. Type `exit` at the shell to end the terminal.

Existing sessions keep their original lifecycle. Controllers and automation workers keep their managed lifecycle. Automatic task/feedback delivery is disabled after a wrapped agent exits, including if you manually start another CLI from its shell. Launch a new agent pane for automatic delivery.

## Automation run context

Each new run saves its exact automation instructions and triggering event, uses a separate private report directory, and starts Claude with a unique session ID and automatic memory disabled. Editing an automation after a run starts does not change that run's saved instructions. The authenticated `/api/special-agents/context` endpoint accepts `run_id` and returns that snapshot; older runs without a snapshot are reported explicitly. New terminals remove inherited caller conversation and annotation-owner identifiers.


## macOS desktop app

Agent Desk also has a macOS desktop app for Apple Silicon on macOS 14+. For source development, use Python 3.11+ and Node.js 24, matching desktop CI and the bundled Node runtime, and complete the dependency installation in [desktop setup](../desktop/README.md#development). Then launch from the repository root:

```sh
npm --prefix desktop start
```

Packaged desktop builds bundle Python and Node 24. Desktop mode uses Unix sockets instead of a localhost listener; browser mode starts with `python3 -m agent_desk`. Installed apps default to `~/Library/Application Support/Agent Desk`; source/debug apps use `~/Library/Application Support/Agent Desk Dev`. Persistent state lives in `data/`, with separate `browser/`, `runtime/`, and `logs/` folders. Legacy hashed `runtimes/` directories are left untouched. Set `AGENT_DESK_PROFILE_DIR` to select another desktop profile. Desktop diagnostic logs expire after 14 days, rotate at 5 MiB and daily, and share a 50 MiB budget; cleanup runs on backend startup and while logging. Session history and terminal/tool output are retained separately. Agent CLIs are installed and authenticated separately; their integrations and your development servers may still use ports.

The desktop traffic lights and logo share a compact header aligned with the workspace toolbar. Drag empty header space to move the window, or click the logo to return to Sessions. In fullscreen, the logo centers within the sidebar. Expanding one pane in a regular window hides the traffic lights to leave its title clear; exiting or closing the expanded pane restores them.

**Agent Desk → About Agent Desk** shows the app version, with **Development build · <commit>** or **Release build · <commit>** on a separate line. Full build metadata, including the UTC build date and whether source changes were uncommitted, is in `build-info.json` under **Agent Desk → Open Local Diagnostics**. Packaged builds embed these details and do not need Git installed. Desktop releases use tags such as `desktop-0.1.0` matching the shared project version. Updates remain manual: download the new DMG and replace the app. See [desktop releases](../desktop/README.md#desktop-ci-and-automatic-github-releases) for the release process.

Closing the window keeps work running; click the Dock icon to reopen it. The app uses no extra menu bar icon. Cmd+Q offers Keep Running, Stop Work and Quit, and Cancel when terminals, tools, jobs, enabled schedules, coordinator planning, queued turns or deliveries, or active PR monitors exist. Idle saved coordinators alone do not trigger confirmation. Shutdown blocks launches and scheduling, waits for tool launches underway, and stops managed local work including command children, the supervisor and backend. After a short graceful timeout it force-stops remaining verified owners without another prompt, then confirms exit. A successful shutdown reopens with launches enabled. If a stop cannot be confirmed, the app remains available and reopening preserves the paused state. Temporary desktop disconnections retry automatically with increasing delays up to 30 seconds; returning to the app or waking the computer retries immediately when disconnected. Drafts and open panes stay in place, and failed actions are not replayed. The existing Retry button and Agent Desk menu remain available for retry, resume, shutdown, and local diagnostics. Automatic retries stop for setup/authentication/identity errors and during shutdown. Remote and unrelated processes remain running.

See [desktop setup, checks, compatibility, and packaging](../desktop/README.md). Local and current GitHub builds use an ad-hoc signature. Developer ID signing and notarization are a separate optional macOS build mode, enabled with `AGENT_DESK_APPLE_SIGNING=1` and Apple credentials.

To upgrade the installed app, finish **Stop Work and Quit**, wait for the app to exit completely, replace the app, then restart. The changed runtime is copied and verified in `<profile>/runtime/` only after old managed owners exit; saved data remains intact. Startup refuses a changed installed app while old managed processes remain. There is no automatic upgrade handoff. Same-build crash recovery continues to reconnect existing terminals.

Source runs (`npm --prefix desktop start`) have no compile step and read the checkout directly, like browser mode. Use **View → Reload** after frontend edits and **Agent Desk → Restart Backend** after Python edits; terminals keep running. Supervisor changes still need Stop Work and Quit. Source runs also enable the annotation tools, saving notes to the desktop profile's `data/feedback.json`; installed apps keep them off. A docked tool's pop-out button opens the tool in its own desktop window, without access to Agent Desk. See [Editing the source](../desktop/README.md#editing-the-source).
