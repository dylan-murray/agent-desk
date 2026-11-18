"""Ground Control feedback transport. Bundled into each independently installable skill."""

from __future__ import annotations

from contextlib import contextmanager

import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import tempfile
import time
from urllib.parse import urlparse
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from urllib.error import HTTPError

try:
    import fcntl
except ImportError:
    fcntl = None

WATCHER_STALE_SECONDS = 6.0


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def add_arguments(parser):
    parser.add_argument(
        "--harness",
        default=os.environ.get("GROUND_CONTROL_HARNESS"),
        help="Name of the originating coding harness",
    )
    parser.add_argument(
        "--session-id",
        default=os.environ.get("GROUND_CONTROL_SESSION_ID"),
        help="Exact originating session ID",
    )
    parser.add_argument(
        "--agent-name",
        default=os.environ.get("GROUND_CONTROL_AGENT_NAME"),
        help="Display name of the originating agent",
    )
    parser.add_argument(
        "--feedback-adapter",
        choices=("auto", "codex", "agent-desk", "command", "watch", "manual"),
        default=os.environ.get("GROUND_CONTROL_ADAPTER", "auto"),
    )
    parser.add_argument(
        "--feedback-command",
        default=os.environ.get("GROUND_CONTROL_COMMAND"),
        help="JSON argv array for a host bridge; receives an envelope on stdin",
    )
    parser.add_argument(
        "--feedback-desk-url",
        default=os.environ.get("AGENT_DESK_URL"),
        help="Loopback Agent Desk URL",
    )
    options = parser._option_string_actions
    if "--watch" not in options:
        parser.add_argument(
            "--watch",
            action="store_true",
            help="print one line per feedback submission for this target, until stopped",
        )
    if "--wait" not in options:
        parser.add_argument(
            "--wait",
            action="store_true",
            help="block until the next feedback submission for this target, then exit",
        )
    if "--timeout" not in options:
        parser.add_argument(
            "--timeout",
            type=float,
            default=None,
            help="with --watch/--wait: give up after N seconds",
        )


def data_root():
    root = (
        Path(
            os.environ.get(
                "GROUND_CONTROL_DATA_DIR",
                Path.home() / ".cache" / "ground-control" / "feedback",
            )
        )
        .expanduser()
        .resolve()
    )
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root


def channel(skill, target):
    key = f"{skill}\0{Path(target).resolve()}"
    return hashlib.sha256(key.encode()).hexdigest()[:24]


def watch_paths(skill, target):
    folder = data_root() / "watch"
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    name = channel(skill, target)
    return {
        "queue": folder / f"{name}.queue.jsonl",
        "cursor": folder / f"{name}.cursor",
        "watcher": folder / f"{name}.watcher.json",
        "lock": folder / f"{name}.lock",
    }


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, TypeError, ValueError):
        return False
    return True


def watcher_alive(skill, target):
    try:
        info = json.loads(watch_paths(skill, target)["watcher"].read_text())
    except (OSError, ValueError):
        return False
    return (
        isinstance(info, dict)
        and time.time() - float(info.get("beat", 0)) < WATCHER_STALE_SECONDS
        and pid_alive(info.get("pid"))
    )


def write_private(path, text):
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + "-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def watch_feedback(skill, target, once=False, timeout=None, extra=None, out=None):
    out = out or sys.stdout
    paths = watch_paths(skill, target)
    target = Path(target).resolve()
    lock = open(paths["lock"], "a+")
    if fcntl:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            try:
                other = json.loads(paths["watcher"].read_text()).get("pid")
            except (OSError, ValueError):
                other = "unknown"
            print(
                f"Another watcher (pid {other}) already receives feedback for {target}.",
                file=sys.stderr,
                flush=True,
            )
            lock.close()
            return 3
    started = time.time()
    try:
        offset = int(paths["cursor"].read_text() or 0)
    except (OSError, ValueError):
        offset = 0
    db_path = data_root() / "submissions.sqlite3"
    print(f"Watching for feedback on {target} ({skill}).", file=sys.stderr, flush=True)
    try:
        while True:
            write_private(
                paths["watcher"],
                json.dumps({"pid": os.getpid(), "beat": time.time(), "started": started}),
            )
            delivered = False
            if paths["queue"].exists():
                with open(paths["queue"], "rb") as f:
                    f.seek(offset)
                    for raw in f:
                        if not raw.endswith(b"\n"):
                            break
                        offset += len(raw)
                        try:
                            event = json.loads(raw)
                        except ValueError:
                            continue
                        print(
                            f"SUBMITTED {event['notes']} open note(s) for {skill}. {event['message']}",
                            file=out,
                            flush=True,
                        )
                        write_private(paths["cursor"], str(offset))
                        if db_path.exists():
                            connection = sqlite3.connect(db_path, timeout=20)
                            try:
                                with connection:
                                    connection.execute(
                                        "UPDATE submissions SET state='queued',error=NULL WHERE id=? AND state='waiting'",
                                        (event["submission_id"],),
                                    )
                            finally:
                                connection.close()
                        delivered = True
                        if once:
                            break
            for line in (extra() if extra else []):
                print(line, file=out, flush=True)
                delivered = True
            if delivered and once:
                return 0
            if timeout and time.time() - started > timeout:
                print("No feedback before the timeout.", file=sys.stderr, flush=True)
                return 1
            time.sleep(0.5)
    except KeyboardInterrupt:
        return 0
    finally:
        try:
            if json.loads(paths["watcher"].read_text()).get("pid") == os.getpid():
                paths["watcher"].unlink()
        except (OSError, ValueError):
            pass
        lock.close()


def destination(args):
    mode = args.feedback_adapter
    if mode == "auto":
        if args.feedback_command:
            mode = "command"
        elif args.feedback_desk_url and (
            args.session_id
            or os.environ.get("AGENT_DESK_AGENT_ID")
            or os.environ.get("AGENT_DESK_COORDINATOR_ID")
        ):
            mode = "agent-desk"
        elif (
            os.environ.get("CODEX_THREAD_ID")
            and not os.environ.get("CLAUDECODE")
            and (not args.harness or args.harness.casefold() == "codex")
        ):
            mode = "codex"
        else:
            mode = "watch"
    sid = args.session_id or ""
    if not sid:
        if mode == "codex":
            sid = os.environ.get("CODEX_THREAD_ID") or os.environ.get(
                "CODEX_SESSION_ID", ""
            )
        elif mode == "agent-desk":
            sid = os.environ.get("AGENT_DESK_AGENT_ID") or os.environ.get(
                "AGENT_DESK_COORDINATOR_ID", ""
            )
    harness = args.harness or (
        "Codex"
        if mode == "codex"
        else "Agent Desk"
        if mode == "agent-desk"
        else "coding agent"
    )
    argv = None
    if mode == "command":
        try:
            argv = json.loads(args.feedback_command or "null")
        except ValueError as exc:
            raise ValueError("--feedback-command must be a JSON argv array") from exc
        if (
            not isinstance(argv, list)
            or not argv
            or any(not isinstance(v, str) or not v or "\0" in v for v in argv)
        ):
            raise ValueError(
                "--feedback-command must be a nonempty JSON array of strings"
            )
    if mode not in ("manual", "watch") and not sid:
        raise ValueError("An exact --session-id is required for feedback delivery")
    if mode == "agent-desk":
        u = urlparse(args.feedback_desk_url or "")
        if (
            u.scheme != "http"
            or u.hostname not in ("127.0.0.1", "localhost", "::1")
            or not u.port
            or u.username
            or u.password
            or u.path not in ("", "/")
            or u.query
            or u.fragment
        ):
            raise ValueError(
                "Agent Desk feedback requires an explicit loopback HTTP URL and port"
            )
    return {
        "adapter": mode,
        "harness": harness,
        "session_id": sid,
        "name": args.agent_name or harness,
        "command": argv,
        "desk_url": args.feedback_desk_url,
    }


class Feedback:
    def __init__(self, args, skill, target, notes_path, load_notes, on_submit=None, answer=None):
        self.destination = destination(args)
        self.skill = skill
        # How the agent replies on each note, when the tool has a way; it is the last sentence of the prompt.
        self.answer = answer
        self.target = Path(target).resolve()
        self.notes_path = Path(notes_path).resolve()
        self.load_notes = load_notes
        self.on_submit = on_submit
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.root = data_root()
        self.db_path = self.root / "submissions.sqlite3"
        with self.db() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,skill TEXT,target TEXT,destination TEXT,state TEXT,snapshot TEXT,prompt TEXT,error TEXT,created REAL)"
            )
        self.db_path.chmod(0o600)

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.db_path, timeout=20)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def public_destination(self):
        return {
            k: self.destination[k] for k in ("adapter", "harness", "session_id", "name")
        }

    def public(self, row):
        return {
            "id": row[0],
            "state": row[4],
            "snapshot": row[5],
            "prompt": row[6],
            "error": row[7],
            "destination": self.public_destination(),
        }

    def status(self):
        with self.db() as db:
            row = db.execute(
                "SELECT * FROM submissions WHERE skill=? AND target=? AND destination=? ORDER BY created DESC LIMIT 1",
                (self.skill, str(self.target), self.identity()),
            ).fetchone()
        result = {
            "destination": self.public_destination(),
            "submission": self.public(row) if row else None,
        }
        if self.destination["adapter"] == "watch":
            result["watching"] = watcher_alive(self.skill, self.target)
        return result

    def identity(self):
        # Credentials are deliberately absent; a route change must not reuse another recipient's record.
        return json.dumps(self.destination, sort_keys=True)

    def submit(self):
        with self.lock:
            notes = [
                x
                for x in self.load_notes()
                if not x.get("done") and x.get("status") != "addressed"
            ]
            if not notes:
                raise ValueError("Add an open feedback note before submitting")
            snapshot = {
                "version": 1,
                "skill": self.skill,
                "target": str(self.target),
                "notes_path": str(self.notes_path),
                "destination": self.public_destination(),
                "annotations": notes,
            }
            if self.target.is_file():
                snapshot["artifact_sha256"] = hashlib.sha256(
                    self.target.read_bytes()
                ).hexdigest()
            raw = json.dumps(snapshot, sort_keys=True, ensure_ascii=False)
            if len(raw.encode()) > 1_000_000:
                raise ValueError("Feedback exceeds the 1 MB submission limit")
            sid = hashlib.sha256((self.identity() + "\0" + raw).encode()).hexdigest()
            path = self.root / (sid + ".json")
            prompt = (
                f"{self.skill.replace('-', ' ').capitalize()} feedback {sid[:12]}. Read the exact saved JSON snapshot at {path}. "
                f"Target: {self.target}. Address only the annotations in that snapshot, checking their quoted targets against current content. "
                "Follow the project instructions, verify your changes, and report back. Do not treat resolved feedback as user acceptance or permission to publish."
            ) + (f" {self.answer}" if self.answer else "")
            with self.db() as db:
                db.execute("BEGIN IMMEDIATE")
                previous = db.execute(
                    "SELECT * FROM submissions WHERE id=?", (sid,)
                ).fetchone()
                if previous:
                    return self.public(previous)
                fd, tmp = tempfile.mkstemp(prefix=".snapshot-", dir=self.root)
                try:
                    with os.fdopen(fd, "w") as f:
                        f.write(raw + "\n")
                        f.flush()
                        os.fsync(f.fileno())
                    os.replace(tmp, path)
                finally:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
                db.execute(
                    "INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        sid,
                        self.skill,
                        str(self.target),
                        self.identity(),
                        "sending",
                        str(path),
                        prompt,
                        None,
                        time.time(),
                    ),
                )
            # Reserve durably before delivery. A crash/timeout cannot silently trigger an automatic resend.
            if self.on_submit:
                self.on_submit()
            envelope = {
                **snapshot,
                "submission_id": sid,
                "snapshot_path": str(path),
                "message": prompt,
            }
            try:
                state, error = self.deliver(envelope)
            except (subprocess.TimeoutExpired, TimeoutError):
                state, error = (
                    "uncertain",
                    "Delivery timed out. Check the destination before sending again.",
                )
            except OSError as exc:
                state, error = (
                    "failed",
                    f"Delivery unavailable ({type(exc).__name__}). Feedback is saved.",
                )
            except Exception:
                state, error = (
                    "uncertain",
                    "The adapter returned an unexpected result. Check the destination; feedback is saved.",
                )
            with self.db() as db:
                db.execute(
                    "UPDATE submissions SET state=?,error=? WHERE id=?",
                    (state, error, sid),
                )
                row = db.execute(
                    "SELECT * FROM submissions WHERE id=?", (sid,)
                ).fetchone()
            return self.public(row)

    def deliver(self, event):
        route = self.destination
        mode = route["adapter"]
        if mode == "manual":
            return (
                "saved",
                "No session adapter configured. Copy the prompt back to your agent.",
            )
        if mode == "watch":
            paths = watch_paths(self.skill, self.target)
            record = {
                "submission_id": event["submission_id"],
                "snapshot_path": event["snapshot_path"],
                "notes": len(event["annotations"]),
                "message": event["message"],
                "created": time.time(),
            }
            fd = os.open(paths["queue"], os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, "a") as f:
                f.write(json.dumps(record) + "\n")
                f.flush()
                os.fsync(f.fileno())
            if watcher_alive(self.skill, self.target):
                return "queued", None
            return (
                "waiting",
                f"{route['name']} isn't watching right now. Your feedback is saved and "
                "will be delivered when its watcher starts, or copy the prompt back.",
            )
        if mode == "codex":
            exe = shutil.which("codex")
            if not exe:
                return "failed", "Codex CLI is not on PATH. Feedback is saved."
            p = subprocess.run(
                [
                    exe,
                    "queue",
                    "--thread",
                    route["session_id"],
                    "--message",
                    event["message"],
                ],
                capture_output=True,
                text=True,
                timeout=12,
                cwd=self.target if self.target.is_dir() else self.target.parent,
            )
            return (
                ("queued", None)
                if p.returncode == 0
                else (
                    "uncertain",
                    f"Codex queue exited {p.returncode}. Check the session; feedback is saved.",
                )
            )
        if mode == "command":
            p = subprocess.run(
                route["command"],
                input=json.dumps(event),
                capture_output=True,
                text=True,
                timeout=12,
                cwd=self.target if self.target.is_dir() else self.target.parent,
            )
            if p.returncode:
                reason = (p.stderr.strip().splitlines() or [""])[-1][:300]
                return (
                    "uncertain",
                    f"{reason or f'The host bridge exited {p.returncode}.'} Feedback is saved.",
                )
            try:
                ack = json.loads(p.stdout)
            except ValueError:
                return (
                    "uncertain",
                    "The host bridge did not return a delivery acknowledgment.",
                )
            if (
                not isinstance(ack, dict)
                or ack.get("accepted") is not True
                or ack.get("submission_id") != event["submission_id"]
                or ack.get("session_id") != route["session_id"]
            ):
                return (
                    "uncertain",
                    "The host bridge did not acknowledge this submission and session.",
                )
            return "queued", None
        token = os.environ.get("AGENT_DESK_TOKEN")
        if not token:
            return "failed", "AGENT_DESK_TOKEN is required. Feedback is saved."
        payload = {
            "request_id": event["submission_id"],
            "target_id": route["session_id"],
            "notes": [{"id": event["submission_id"], "note": event["message"]}],
        }
        req = Request(
            route["desk_url"].rstrip("/") + "/api/coordinators/submit-feedback",
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + token,
            },
        )
        try:
            with build_opener(ProxyHandler({}), NoRedirect()).open(req, timeout=12) as response:
                ack = json.load(response)
        except HTTPError as exc:
            return (
                "uncertain",
                f"Agent Desk returned HTTP {exc.code}. Check the destination; feedback is saved.",
            )
        if ack.get("sent") is True and ack.get("target_id") == route["session_id"]:
            return "queued", None
        return "uncertain", "Agent Desk did not confirm the destination."

    def handle(self, handler):
        path = urlparse(handler.path).path
        if path not in ("/_ground-control/status", "/_ground-control/submit"):
            return False
        code = 200
        try:
            if handler.headers.get("X-Ground-Control-Token") != self.token:
                raise PermissionError("Open this review page to access feedback")
            if handler.command == "GET" and path.endswith("/status"):
                result = self.status()
            elif handler.command == "POST" and path.endswith("/submit"):
                length = int(handler.headers.get("Content-Length", "0"))
                if not 0 <= length <= 1024:
                    raise ValueError("Unexpected submission body")
                handler.rfile.read(length)
                result = self.submit()
            else:
                code, result = 405, {"error": "Method not allowed"}
        except PermissionError as exc:
            code, result = 403, {"error": str(exc)}
        except (ValueError, sqlite3.Error) as exc:
            code, result = 400, {"error": str(exc)}
        body = json.dumps(result).encode()
        handler.send_response(code)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
        return True

    def decorate(self, page):
        config = json.dumps(
            {"token": self.token, "destination": self.public_destination()}
        ).replace("<", "\\u003c")
        early = TRACKER.replace("__GC_CONFIG__", config)
        page = (
            page.replace("<head>", "<head>" + early, 1)
            if "<head>" in page
            else early + page
        )
        return (
            page.replace("</body>", WIDGET + "</body>")
            if "</body>" in page
            else page + WIDGET
        )


def local_host(handler):
    try:
        host = urlparse("http://" + handler.headers.get("Host", "")).hostname
    except ValueError:
        host = None
    if host not in ("127.0.0.1", "localhost", "::1"):
        handler.send_error(403, "Loopback host required")
        return False
    return True


def wrap_handler(base, feedback):
    class Routed(base):
        def do_GET(self):
            if not local_host(self):
                return
            if not feedback.handle(self):
                super().do_GET()

        def do_POST(self):
            if not local_host(self):
                return
            with feedback.lock:
                if not feedback.handle(self):
                    super().do_POST()

        def _send(self, code, body, ctype="application/json"):
            if (
                code == 200
                and ctype.startswith("text/html")
                and urlparse(self.path).path == "/"
            ):
                body = feedback.decorate(body.decode()).encode()
            super()._send(code, body, ctype)

    return Routed


TRACKER = r"""<script>
window.GC_CONFIG=__GC_CONFIG__;
window.GC_PENDING=new Set();window.GC_SAVE_ERROR=false;
const gcOriginalFetch=window.fetch.bind(window);
window.fetch=function(input,init){
 const url=typeof input==='string'?input:input.url;
 const isSave=init&&init.method==='POST'&&!url.includes('_ground-control');
 const promise=gcOriginalFetch(input,init);
 if(isSave){window.GC_PENDING.add(promise);promise.then(r=>{if(!r.ok)window.GC_SAVE_ERROR=true;},()=>{window.GC_SAVE_ERROR=true;}).finally(()=>window.GC_PENDING.delete(promise));}
 return promise;
};
</script>"""

WIDGET = r"""<style>
#gc-feedback{position:fixed;bottom:12px;right:12px;z-index:1000;max-width:calc(100vw - 24px);width:340px;box-sizing:border-box;background:#101923;color:#e6edf3;border:1px solid #415263;border-radius:10px;box-shadow:0 4px 20px #0004;padding:10px;font:13px/1.4 system-ui,sans-serif}
#gc-feedback summary{cursor:pointer;display:flex;align-items:center;gap:8px;list-style:none}#gc-feedback summary strong{flex:1}
#gc-feedback button{font:inherit;border:1px solid #526475;border-radius:5px;padding:6px 10px;background:#203346;color:#fff;cursor:pointer}#gc-feedback button:disabled{opacity:.5;cursor:wait}
#gc-feedback p{margin:8px 0;overflow-wrap:anywhere}#gc-feedback textarea{width:100%;box-sizing:border-box;min-height:80px;background:#0b1119;color:#dce8f1;font:12px/1.4 monospace;border:1px solid #526475}
#gc-feedback .gc-actions{display:flex;gap:8px}#gc-feedback small{color:#aebdca}
body:has(#gc-feedback){padding-bottom:72px}
#gc-inline [hidden]{display:none!important}#gc-inline{margin:8px 0 0;font-size:12px;line-height:1.4;color:var(--fg-muted,#8b949e)}#gc-inline p{margin:0 0 6px;overflow-wrap:anywhere}#gc-inline textarea{width:100%;box-sizing:border-box;min-height:80px;margin-top:6px;font:12px/1.4 monospace}
@media print{#gc-feedback{display:none}}
</style>
<details id="gc-feedback"><summary><strong id="gc-destination">Feedback</strong><span>⌃</span></summary>
<p id="gc-status" role="status">Ready</p><div class="gc-actions"><button id="gc-submit" type="button">Submit back</button><button id="gc-copy" type="button" hidden>Copy prompt</button></div><textarea id="gc-prompt" readonly hidden aria-label="Feedback prompt"></textarea></details>
<script>
(()=>{
 const box=document.getElementById('gc-feedback'),button=document.getElementById('gc-submit'),status=document.getElementById('gc-status'),copy=document.getElementById('gc-copy'),prompt=document.getElementById('gc-prompt'),dest=GC_CONFIG.destination;
 document.getElementById('gc-destination').textContent='Submit feedback → '+dest.name;
 button.textContent=dest.adapter==='manual'?'Save feedback':'Send to '+dest.name;
 const headers={'X-Ground-Control-Token':GC_CONFIG.token,'Content-Type':'application/json'};
 const endpoint=name=>new URL('./_ground-control/'+name,location.href).href;
 let current=null,busy=false;
 let poll=null;
 function show(s){current=s;status.textContent=s.state==='queued'?'Queued for '+dest.name+'.':s.state==='sending'?'Delivery was interrupted. Check the destination before resending.':s.error||'Feedback saved.';copy.hidden=false;prompt.value=s.prompt;clearTimeout(poll);if(s.state==='waiting')poll=setTimeout(refresh,3000);}
 function idle(s){status.textContent=dest.adapter==='manual'?'Save feedback, then copy it back to your agent.':dest.adapter==='watch'?(s.watching?dest.name+' is watching for feedback.':dest.name+' isn\u2019t watching yet. Submitting saves your notes for when it starts.'):'';}
 function refresh(){return fetch(endpoint('status'),{headers}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(s=>{if(busy)return;if(s.submission)show(s.submission);else idle(s);}).catch(()=>{status.textContent='Could not load delivery status.';}).finally(()=>{if(dest.adapter==='watch'){clearTimeout(poll);poll=setTimeout(refresh,4000);}});}
 async function send(){if(busy)return;busy=true;const own=document.getElementById('send');button.disabled=true;if(own)own.disabled=true;box.open=true;status.textContent='Sending…';
 try{
  // Existing annotation editors debounce saves by 400ms. Let them flush, then await the requests.
  await new Promise(r=>setTimeout(r,500));await Promise.allSettled([...GC_PENDING]);
  if(GC_SAVE_ERROR)throw Error('An annotation save failed. Reload and verify the note before submitting.');
  const response=await fetch(endpoint('submit'),{method:'POST',headers,body:'{}'});if(!response.ok)throw Error('Submission failed (HTTP '+response.status+'). Your notes are preserved.');const result=await response.json();show(result);if(result.state==='queued'&&box.isConnected){box.open=false;document.getElementById('gc-destination').textContent='Feedback queued → '+dest.name;}
 }catch(e){status.textContent=e.message;}finally{busy=false;button.disabled=false;if(own)own.disabled=false;}}
 button.onclick=send;
 copy.onclick=async()=>{try{await navigator.clipboard.writeText(current.prompt);status.textContent='Prompt copied. Paste it into '+dest.name+'.';}catch{prompt.hidden=false;prompt.select();}};
 refresh();
 // A tool with its own submit button keeps it. A tool that also gives the status a place
 // (#gc-inline) gets it there and loses the floating box, which would only repeat the button.
 const oldStatus=document.getElementById('sent');if(oldStatus)oldStatus.hidden=true;
 const legacy=document.getElementById('send');if(legacy){legacy.textContent=button.textContent;legacy.title='Send the open notes to '+dest.name;legacy.onclick=send;
  const slot=document.getElementById('gc-inline');if(slot){copy.className=legacy.className.replace(/\b(primary|wide)\b/g,'').trim();slot.append(status,copy,prompt);box.remove();}}
})();
</script>"""
