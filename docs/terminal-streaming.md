# Terminal streaming: replacing output polling with a WebSocket

Status: implemented for local terminals (plan steps 1-6 and 8); remote streaming through the SSH bridge (step 7) is a follow-up, and remote panes keep polling until then. Originally written October 6, 2026 from a code read of `main` at `e4a8861`; [results](#results) are measured.

## Problem

An open terminal pane polls `GET /api/terminals/output` in a loop: 32 ms after a response when output arrived in the last second, 120 ms otherwise (`poll()` in `agent_desk/static/terminals.js`). An idle pane therefore makes about 7 requests per second, nearly all returning zero bytes, around 600,000 a day per pane. `monitorTerminals` adds one more request per live terminal every 2 seconds. Every request also prints a line in the server log, which buries real events.

Each poll costs more than one HTTP request:

1. `TerminalOwners.get(id)` (`agent_desk/terminal_owners.py`) calls `client.list()` on every supervisor just to find which one owns the ID.
2. `TerminalManager.list()` (`agent_desk/terminals.py`) then lists the readouts directory, runs `usage()`, which spawns `ps -axo` (cached for 1 second, so roughly one `ps` per second while any pane is open), and builds `info()` for every session, which opens a SQLite mailbox for coordinator terminals.
3. A second supervisor RPC, `get`, and a third, `output`. Each RPC is a new Unix socket connection and a new supervisor handler thread.

Input takes the same `TERMINALS.get` path (`server.py`, `/api/terminals/input`). Each keystroke is its own POST, and the client serializes them through `view.queue` (`send()` in `terminals.js`), so typing pays a full HTTP and RPC round trip per key.

Remote panes are the worst case: every poll crosses the SSH stdio bridge (`bridge()` in `agent_desk/remote_node.py`), which serves request/response pairs from 8 worker threads.

## Options considered

**Long-polling.** The server holds `output` until bytes arrive or about 25 seconds pass. The smallest change, but each pane holds one HTTP/1.1 connection, and browsers allow 6 per origin. With 4 panes plus monitoring, every other fetch (agent refresh, coordinator refresh, input POSTs, resizes) queues behind 2 remaining connections. It only works if all terminals are multiplexed into one request, and input stays a POST per keystroke. Rejected as the end state.

**Server-Sent Events.** One multiplexed stream for all terminals avoids the connection limit and is easy on the standard library: a long chunked response on the existing `ThreadingHTTPServer`. It is one-way, so input and resize remain POSTs. `EventSource` cannot set the `X-Agent-Desk-Terminal` header, so authentication moves to a cookie or the URL. Fixes output, not input.

**WebSocket (recommended).** One socket per browser tab carries output, input, resize and exit for every pane, in order. WebSocket connections do not count against the 6 connection HTTP limit. The cost is that the standard library has no WebSocket server and the project has `dependencies = []`: either a hand-written RFC 6455 layer (about 200 lines covering the handshake, masking, framing, ping/pong and close) or a first dependency.

## Recommended design

### Wire protocol

One socket per tab at `/api/terminals/stream`. Messages are JSON text frames; output payloads stay base64 so the bytes and cursor semantics are unchanged.

- Client to server: `auth {token}` (must be the first frame), `subscribe {id, cursor}`, `unsubscribe {id}`, `input {id, data}`, `resize {id, cols, rows}`.
- Server to client: `output {id, data, cursor, truncated}`, `exit {id, exit_code}`, `activity {id, cursor}` for subscribed terminals without an open pane (replaces `monitorTerminals`), and `error {id?, message}`.

Cursors and `truncated` keep their current meaning. Reconnecting is: open a socket, authenticate, re-subscribe each pane with its last cursor. The server replays from the 2 MiB buffer exactly as `output(cursor)` does today, so terminal persistence, checkpoints and restore are untouched.

### Supervisor push

`TerminalSession.read()` already sees every chunk. Add a condition variable there and a new supervisor operation, for example `wait_output {id, cursor, timeout}`, that returns once the buffer passes `cursor` or the timeout expires. The web server runs one waiter thread per subscribed terminal and fans results out to sockets. A streaming operation that keeps the Unix connection open is an alternative; the bounded wait keeps the existing one-request, one-response protocol shape and its 30 second socket timeout.

Compatibility is the hard constraint. The supervisor outlives web-server restarts so terminals survive, its module docstring requires protocol changes to stay compatible with a running supervisor, and `VERSION` is checked for strict equality. So the new operation must be additive, the server must detect an older supervisor (via `hello`) and fall back to polling it, and the rollout must not require draining live terminals.

### Security

WebSockets are not covered by CORS. The handshake must enforce the same host and Origin checks as `terminal_authorized()`, and the socket must be closed if the first frame is not a valid `auth`. The token must not travel in the URL: the request log prints full paths.

### Remote environments

The SSH bridge needs a streaming reply type so a remote node can push frames tagged with the subscription ID, instead of tying up one of its 8 workers per waiting pane. Remote panes gain the most, but they can ship second: they keep polling behind the same fallback path until the bridge supports streaming.

## Independent fixes to do first

- `TerminalOwners.get` should not call `list()` on every lookup. Cache the owner per terminal ID and refresh on a miss. This probably accounts for most of today's server CPU and helps every terminal endpoint, regardless of transport.
- Override `log_message` so successful polls are not logged, leaving errors and non-polling requests visible.

## Plan

1. **Baseline.** With one idle pane, measure web-server and supervisor CPU, `ps` processes spawned per second, requests per second, and keystroke round-trip latency. Repeat with 4 panes and with one remote pane.
2. **Owner lookup fix and quiet logging.** Measure again. This separates the cost of the transport from the cost of the lookup bug.
3. **Supervisor `wait_output`** with tests in `tests/test_terminal_supervisor.py` and `tests/test_terminals.py`, including an old-supervisor fallback test.
4. **WebSocket endpoint** in `server.py` with handshake, Origin and auth tests in `tests/test_server.py`.
5. **Client.** Replace `poll()`, `send()`, `monitorTerminals` and the `terminal-attention.js` readers with subscriptions. Reconnect re-subscribes with saved cursors. Keep polling as the fallback when the socket cannot be opened.
6. **Browser checks.** Existing pane, restore and backend-restart checks must pass unchanged; add one that kills the socket mid-output and verifies no bytes are lost or duplicated.
7. **Remote streaming** through the SSH bridge.
8. **Measure again** against the baseline from step 1.

## Expected outcome

- Idle cost per pane goes from about 7 requests per second, each making 3 socket connections, to near zero.
- Output latency goes from up to 120 ms of polling delay to close to immediate.
- Typing goes from one POST plus three RPC calls per keystroke to one message on an open socket.
- Remote panes stop polling across SSH.

Out of scope: the other polled endpoints (`/api/agents`, workflows, coordinator, feedback, every 1.2 to 5 seconds). They could move onto the same socket later.

## Decisions

- **Hand-written WebSocket layer** (`agent_desk/websocket.py`), keeping `dependencies = []`. The server only needs the opening handshake, unmasking, fragmentation, ping/pong and close; text messages only, 1 MiB message limit.
- **Bounded `wait_output`.** An additive supervisor operation that answers like `output` once bytes pass the cursor, the process exits, or at most 20 seconds pass. `hello` advertises it in `features`; `VERSION` is unchanged. Against an older supervisor the backend polls `output` every 50 ms on the browser's behalf, so a running supervisor never has to be drained for this rollout.
- **Approval detection stays in the browser.** Hidden attention readers subscribe to the same output stream that panes use instead of paging `/api/terminals/output` every 2 seconds, so no separate `activity` message exists.

## Differences from the proposal

- Subscriptions carry a client-chosen `sub` key (`subscribe {sub, id, cursor}`, `unsubscribe {sub}`, and every reply echoes it). A pane and a background reader can follow the same terminal from different cursors, and a reply to an abandoned subscription is ignored rather than written twice.
- The backend runs one waiter thread per subscription rather than one per terminal with fan-out. Idle, each costs one supervisor RPC every 20 seconds.
- After subscribing, and after any reply with `truncated`, the server sends one empty `output` reply once caught up. Panes use it exactly as they used an empty poll: to end restoring and redraw.
- The browser asks `GET /api/terminals/stream` once per page load. A backend with the endpoint answers 426; anything else (an older backend, a fixture) keeps that tab on polling.

## Results

`ps` spawns were counted with a `PATH` shim; requests were counted in the browser; CPU is `ps` time over a 30 second idle window; keystroke latency is xterm input to the first echoed write, 40 samples. Local shells on an Apple Silicon Mac, one browser tab, `main` at `4f034a6` against this change. "Polling fallback" is this change with the stream endpoint hidden from the browser, which isolates the owner-lookup fix.

| Idle, open panes | Requests/s | Server log lines/s | Web CPU | Supervisor CPU | `ps`/s | Keystroke p50 / p90 / max |
| --- | --- | --- | --- | --- | --- | --- |
| `main`, 1 pane | 9.5 | 9.5 | 1.9% | 1.4% | 2.2 | 23 / 35 / 93 ms |
| Polling fallback, 1 pane | 10.0 | 0.2 | 1.9% | 0.7% | 1.4 | 14 / 36 / 122 ms |
| Streaming, 1 pane | 1.5 | 0.2 | 1.2% | 0.5% | 1.4 | 1 / 1 / 2 ms |
| `main`, 4 panes | 33.2 | 33.4 | 4.0% | 4.3% | 5.1 | 24 / 79 / 140 ms |
| Polling fallback, 4 panes | 35.4 | 0.2 | 3.2% | 1.3% | 1.4 | 18 / 37 / 41 ms |
| Streaming, 4 panes | 1.5 | 0.2 | 1.3% | 0.5% | 1.4 | 1 / 1 / 6 ms |

Terminal requests went from about 8 per pane per second to none; the remaining 1.5 requests per second are the other polled endpoints, unchanged by pane count. The owner-lookup fix removed most supervisor CPU and the per-pane `ps` spawns. The remaining 1.4 `ps` per second come from `/api/agents` and backend housekeeping that list terminals; they do not grow with panes and are outside this change. A remote pane was not measured: no remote environment was available, and remote panes still poll.
