#!/usr/bin/env python3
"""Local GitHub-style code review app for the current working tree.

Serves the repo's diff rendered the way a GitHub pull request renders it
(file list, unified or split view, syntax highlighting via a vendored
highlight.js, light and dark), and lets the human reviewer work the way they would on
GitHub, review-only: comment on a line or a range of lines, attach a
```suggestion``` replacement, leave file-level or general notes. They cannot edit
the files from the page. They suggest changes; their coding agent applies them.

The **Submit feedback** button persists a submission in the notes file.
A running `--watch` (or `--wait`) process reports new submissions. Delivery
to an agent depends on the host; saving feedback does not prove it was received.

Notes live OUTSIDE the repo, under ~/.cache/review-app/, so nothing shows up
in `git status`. The page hot-reloads when the diff changes (i.e. after the agent
edits a file), keeping notes anchored by quoted text.

    python review_app.py [REPO] [--base REF] [--port 8767] [--no-browser]
    python review_app.py [REPO] --dump              # open notes, for an agent
    python review_app.py [REPO] --watch             # print a line per feedback submission, forever
    python review_app.py [REPO] --wait [--timeout S]# block until the next feedback submission
    python review_app.py [REPO] --apply 3 5         # apply exact suggestions, mark addressed
    python review_app.py [REPO] --resolve 3 5       # mark addressed
    python review_app.py [REPO] --notes-path        # where the JSON lives

Default diff is the working tree (staged + unstaged + untracked) against HEAD.
`--base main` reviews everything on the branch since its merge-base with main,
working tree included. Stdlib only.
"""

from __future__ import annotations

from ground_control_feedback import Feedback, add_arguments, watch_feedback, wrap_handler

import argparse
import contextlib
import hashlib
import html
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

SKILL_DIR = Path(__file__).resolve().parent
VENDOR = SKILL_DIR / "vendor"
NOTES_ROOT = Path(os.environ.get("REVIEW_APP_HOME", Path.home() / ".cache" / "review-app"))
REVIEWER_ENV = "REVIEW_APP_USER"
PROOF_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
PROOF_LIMIT = 5_000_000


def reviewer_name(repo: Path) -> str:
    """Display name for the human's notes: --user, $REVIEW_APP_USER, else git user.name."""
    name = os.environ.get(REVIEWER_ENV) or git(repo, "config", "user.name", check=False).strip()
    return (name.split()[0] if name else "You")


def notes_path_for(repo: Path) -> Path:
    # A file name, not a signature: kept sha1 so notes saved by earlier versions are still found.
    digest = hashlib.sha1(str(repo).encode()).hexdigest()[:8]  # nosemgrep: python.lang.security.insecure-hash-algorithms.insecure-hash-algorithm-sha1
    return NOTES_ROOT / f"{repo.name}-{digest}.review.json"


# --------------------------------------------------------------------------
# git
# --------------------------------------------------------------------------


def git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=False
    )
    if check and result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout


def repo_root(path: Path) -> Path:
    return Path(git(path, "rev-parse", "--show-toplevel").strip())


def diff_base(repo: Path, base: str | None) -> str:
    """Commit the review diffs against. HEAD for 'my uncommitted work';
    merge-base for a branch review so upstream commits don't show up."""
    if not base:
        return "HEAD"
    return git(repo, "merge-base", base, "HEAD").strip()


def untracked_files(repo: Path) -> list[str]:
    return [rel.strip() for rel in git(repo, "ls-files", "--others", "--exclude-standard").splitlines() if rel.strip()]


def raw_diff(repo: Path, base: str, untracked: bool = True, head: str | None = None) -> str:
    """The working tree against base, or with head, a commit against base (another branch's pull request)."""
    if head:
        return git(repo, "diff", base, head, "--no-color", "--no-ext-diff", "-U3", "--find-renames", "--", check=False)
    text = git(
        repo, "diff", base, "--no-color", "--no-ext-diff", "-U3", "--find-renames", "--",
        check=False,
    )
    if untracked:
        for rel in untracked_files(repo):
            piece = git(
                repo, "diff", "--no-color", "--no-ext-diff", "-U3", "--no-index",
                "--", "/dev/null", rel, check=False,
            )
            text += piece
    return text


_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")


def parse_diff(text: str) -> list[dict]:
    """Unified diff text -> [{path, old_path, status, binary, hunks:[{header, lines}]}].

    Each line: {t: ' '|'+'|'-', old: n|None, new: n|None, text}."""
    files: list[dict] = []
    cur: dict | None = None
    hunk: dict | None = None
    old_n = new_n = 0
    for line in text.splitlines():
        if line.startswith("diff --git "):
            m = re.match(r'^diff --git (?:"?a/(.*?)"?) (?:"?b/(.*?)"?)$', line)
            old_p, new_p = (m.group(1), m.group(2)) if m else (line, line)
            cur = {
                "path": new_p, "old_path": old_p, "status": "modified", "binary": False,
                "hunks": [], "additions": 0, "deletions": 0,
            }
            files.append(cur)
            hunk = None
            continue
        if cur is None:
            continue
        if line.startswith("new file mode"):
            cur["status"] = "added"
        elif line.startswith("deleted file mode"):
            cur["status"] = "deleted"
        elif line.startswith("rename from "):
            cur["status"] = "renamed"
        elif line.startswith("Binary files") or line.startswith("GIT binary patch"):
            cur["binary"] = True
        elif line.startswith("--- ") or line.startswith("+++ "):
            if line.startswith("+++ b/"):
                cur["path"] = line[6:]
            elif line.startswith("--- a/"):
                cur["old_path"] = line[6:]
            elif line == "--- /dev/null":
                cur["status"] = "added"
            elif line == "+++ /dev/null":
                cur["status"] = "deleted"
        elif line.startswith("@@"):
            m = _HUNK.match(line)
            if not m:
                continue
            old_n, new_n = int(m.group(1)), int(m.group(3))
            hunk = {"header": line, "lines": []}
            cur["hunks"].append(hunk)
        elif hunk is not None and line[:1] in (" ", "+", "-"):
            tag, body = line[0], line[1:]
            if tag == " ":
                hunk["lines"].append({"t": " ", "old": old_n, "new": new_n, "text": body})
                old_n += 1
                new_n += 1
            elif tag == "+":
                hunk["lines"].append({"t": "+", "old": None, "new": new_n, "text": body})
                new_n += 1
                cur["additions"] += 1
            else:
                hunk["lines"].append({"t": "-", "old": old_n, "new": None, "text": body})
                old_n += 1
                cur["deletions"] += 1
        elif line.startswith("\\ No newline"):
            continue
    for f in files:
        if f["path"].startswith("/dev/null") and f["old_path"]:
            f["path"] = f["old_path"]
    return files


def file_text(repo: Path, base: str, rel: str, side: str, head: str | None = None) -> str:
    """Full contents of one side of a file, for whole-file syntax highlighting."""
    if side == "new" and head:
        return git(repo, "show", f"{head}:{rel}", check=False)
    if side == "new":
        target = repo / rel
        try:
            return target.read_text(errors="replace")
        except OSError:
            return ""
    return git(repo, "show", f"{base}:{rel}", check=False)


def diff_digest(repo: Path, base: str, text: str) -> str:
    """Changes when the diff, its base or the branch does, so the page redraws its header too."""
    branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD", check=False).strip()
    return hashlib.sha256(f"{branch}\0{base}\0{text}".encode(errors="replace")).hexdigest()[:12]


def diff_model(repo: Path, base: str, untracked: bool, head: str | None = None, branch: str | None = None) -> dict:
    text = raw_diff(repo, base, untracked, head)
    files = parse_diff(text)
    if untracked and not head:
        loose = set(untracked_files(repo))
        for f in files:
            if f["status"] == "added" and f["path"] in loose:
                f["untracked"] = True
    digest = diff_digest(repo, base, text)
    branch = branch or git(repo, "rev-parse", "--abbrev-ref", "HEAD", check=False).strip()
    return {
        "repo": str(repo), "branch": branch, "base": base, "digest": digest, "checked_out": not head,
        "files": files,
        "additions": sum(f["additions"] for f in files),
        "deletions": sum(f["deletions"] for f in files),
    }


# --------------------------------------------------------------------------
# notes
# --------------------------------------------------------------------------


class Notes:
    def __init__(self, path: Path, repo: Path):
        self.path = path
        self.repo = repo
        self.archive_path = Path(str(path).replace(".json", ".archive.json"))
        self._lock = threading.Lock()

    def _read(self) -> dict:
        if not self.path.exists():
            return {}
        try:
            data = json.loads(self.path.read_text())
            return data if isinstance(data, dict) else {}
        except (json.JSONDecodeError, OSError):
            return {}

    def _write(self, d: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(d, indent=2) + "\n")

    def load(self) -> list[dict]:
        return self._read().get("annotations", [])

    def round(self) -> int:
        return int(self._read().get("round", 1))

    def submission(self) -> dict:
        d = self._read()
        return {"n": int(d.get("submission", 0)), "at": d.get("submitted_at")}

    def save(
        self,
        items: list[dict],
        rnd: int | None = None,
        submission: dict | None = None,
        round_replies: list[dict] | None = None,
    ) -> None:
        prev = self._read()
        sub = submission or {"n": int(prev.get("submission", 0)), "at": prev.get("submitted_at")}
        rr = round_replies if round_replies is not None else prev.get("round_replies", [])
        if rnd is not None and rnd != int(prev.get("round", 1)):
            rr = []
        carry = {k: prev[k] for k in ("pr_request", "pr", "pr_draft") if k in prev}
        payload = {
            "_help": (
                "Review comments from the review app. Each is anchored to a file and a "
                "1-indexed line range on the given side ('new' = working tree, 'old' = "
                "base); 'quote' is the exact text of those lines when commented on. "
                "'suggestion' (when present) is the replacement for exactly those lines "
                "-- apply it with `--apply ID` if it still matches, otherwise by hand. "
                "Address each note, then mark it with `--resolve ID`. Never resolve a "
                "note the code didn't change for. Reply to a note with `--reply ID TEXT` (shows "
                "under it in the UI) and to the round with `--round-reply TEXT`. kind is line | chunk | selection | pin | file | "
                "general; chunk/selection carry the same line anchoring as line (selection also "
                "has the exact phrase); pin has relX/relY within the file box plus the nearest line."
            ),
            "repo": str(self.repo),
            "round": rnd if rnd is not None else int(prev.get("round", 1)),
            "submission": sub["n"],
            "submitted_at": sub["at"],
            "round_replies": rr,
            **carry,
            "annotations": items,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(payload, indent=2) + "\n")

    def add(self, item: dict) -> dict:
        with self._lock:
            items = self.load()
            item.setdefault("author", Handler.user)
            item["id"] = max((i.get("id", 0) for i in items), default=0) + 1
            item["created"] = time.strftime("%Y-%m-%d %H:%M:%S")
            item["status"] = "open"
            items.append(item)
            self.save(items)
            return item

    def update(self, ann_id: int, comment: str | None, suggestion: str | None, has_suggestion: bool) -> None:
        with self._lock:
            items = self.load()
            for i in items:
                if i.get("id") == ann_id:
                    if comment is not None:
                        i["comment"] = comment
                    if has_suggestion:
                        i["suggestion"] = suggestion
                    i["edited"] = time.strftime("%Y-%m-%d %H:%M:%S")
            self.save(items)

    def reply(self, ann_id: int, author: str, text: str) -> bool:
        with self._lock:
            items = self.load()
            for i in items:
                if i.get("id") == ann_id:
                    i.setdefault("replies", []).append(
                        {"author": author, "text": text, "at": time.strftime("%Y-%m-%d %H:%M:%S")}
                    )
                    self.save(items)
                    return True
            return False

    def round_replies(self) -> list[dict]:
        return self._read().get("round_replies", [])

    def round_reply(self, author: str, text: str) -> None:
        with self._lock:
            d = self._read()
            rr = d.get("round_replies", [])
            rr.append({"author": author, "text": text, "at": time.strftime("%Y-%m-%d %H:%M:%S")})
            self.save(self.load(), round_replies=rr)

    def proof_dir(self) -> Path:
        return self.path.parent / (self.path.stem + "-proof")

    def keep_proof(self, ann_id: int, source: Path) -> str:
        """Copy a screenshot the agent offers as proof beside the notes, so the page can show it after the file moves."""
        if source.suffix.lower() not in PROOF_TYPES:
            raise ValueError(f"proof files must be images ({', '.join(sorted(PROOF_TYPES))})")
        data = source.read_bytes()
        if len(data) > PROOF_LIMIT:
            raise ValueError("proof files must be under 5 MB")
        name = f"{ann_id}-{hashlib.sha256(data).hexdigest()[:12]}{source.suffix.lower()}"
        self.proof_dir().mkdir(parents=True, exist_ok=True)
        (self.proof_dir() / name).write_bytes(data)
        return name

    def resolve(self, ids: list[int], delete: bool = False, reopen: bool = False, proof: dict | None = None) -> int:
        with self._lock:
            items = self.load()
            hit = 0
            if delete:
                keep = [i for i in items if i.get("id") not in ids]
                hit = len(items) - len(keep)
                items = keep
            else:
                for i in items:
                    if i.get("id") in ids:
                        i["status"] = "open" if reopen else "addressed"
                        if proof and not reopen:
                            i["proof"] = proof
                        hit += 1
            self.save(items)
            return hit

    def pr_request(self) -> dict:
        d = self._read()
        return d.get("pr_request") or {"n": 0}

    def request_pr(self, draft: bool, stage: str = "describe") -> dict:
        """describe: the change is approved, the agent drafts the title and body for review.
        open: the reviewer approved that draft, the agent commits, pushes and opens it."""
        with self._lock:
            d = self._read()
            prev = d.get("pr_request") or {"n": 0}
            req = {"n": int(prev.get("n", 0)) + 1, "at": time.strftime("%Y-%m-%d %H:%M:%S"), "draft": draft, "stage": stage}
            if stage == "open":
                if not d.get("pr_draft"):
                    raise ValueError("there is no PR description to approve yet")
                req["rev"] = d["pr_draft"]["rev"]
            else:
                d.pop("pr_draft", None)
            d["pr_request"] = req
            d.pop("pr", None)
            self._write(d)
            return req

    def pr_draft(self) -> dict | None:
        return self._read().get("pr_draft")

    def set_pr_draft(self, title: str, body: str) -> dict:
        with self._lock:
            d = self._read()
            prev = d.get("pr_draft") or {"rev": 0}
            draft = {"rev": int(prev.get("rev", 0)) + 1, "at": time.strftime("%Y-%m-%d %H:%M:%S"),
                     "title": title.strip(), "body": body.strip()}
            d["pr_draft"] = draft
            self._write(d)
            return draft

    def pr(self) -> dict | None:
        return self._read().get("pr")

    def set_pr(self, url: str, title: str | None = None) -> None:
        with self._lock:
            d = self._read()
            d["pr"] = {"url": url, "at": time.strftime("%Y-%m-%d %H:%M:%S"), **({"title": title} if title else {})}
            self._write(d)

    def submit(self) -> dict:
        with self._lock:
            items = self.load()
            sub = self.submission()
            sub = {"n": sub["n"] + 1, "at": time.strftime("%Y-%m-%d %H:%M:%S")}
            self.save(items, submission=sub)
            return sub

    def _log_to_history(self, rnd: int, moved: list[dict]) -> None:
        try:
            log = SKILL_DIR / "history" / "annotations.jsonl"
            log.parent.mkdir(exist_ok=True)
            with log.open("a") as fh:
                for a in moved:
                    fh.write(json.dumps({
                        "repo": str(self.repo), "round": rnd,
                        "logged": time.strftime("%Y-%m-%d %H:%M:%S"),
                        "kind": a.get("kind"), "file": a.get("file", ""),
                        "quote": a.get("quote", ""), "comment": a.get("comment", ""),
                        "suggestion": a.get("suggestion"), "status": a.get("status"),
                    }) + "\n")
        except OSError:
            pass

    def clear(self, which: str = "all") -> int:
        with self._lock:
            items = self.load()
            keep = [i for i in items if i.get("status") != "addressed"]
            moved = items if which == "all" else [i for i in items if i not in keep]
            if not moved:
                return 0
            archive = []
            if self.archive_path.exists():
                try:
                    archive = json.loads(self.archive_path.read_text()).get("rounds", [])
                except (json.JSONDecodeError, OSError):
                    archive = []
            rnd = self.round()
            archive.append({
                "round": rnd, "archived": time.strftime("%Y-%m-%d %H:%M:%S"),
                "annotations": moved,
            })
            self.archive_path.write_text(json.dumps({"rounds": archive}, indent=2) + "\n")
            self._log_to_history(rnd, moved)
            self.save([] if which == "all" else keep, rnd=rnd + 1)
            return len(moved)


def dump(notes: Notes, show_all: bool = False) -> str:
    items = notes.load()
    open_items = [i for i in items if i.get("status") != "addressed"]
    shown = items if show_all else open_items
    sub = notes.submission()
    lines = [
        f"{notes.repo.name}  round {notes.round()}  {len(open_items)} open, "
        f"{len(items) - len(open_items)} addressed"
        + (f"  (submission #{sub['n']} at {sub['at']})" if sub["n"] else ""),
        f"notes: {notes.path}",
        "",
    ]
    if not shown:
        lines.append("(no open notes)" if not show_all else "(no notes)")
        return "\n".join(lines)
    for a in shown:
        status = "" if a.get("status") != "addressed" else "  [addressed]"
        if a.get("author") and a.get("author") not in (Handler.user, "You"):
            status = f"  ({a['author']})" + status
        if a.get("kind") == "general":
            head = f"#{a['id']} [general]{status}"
        elif a.get("kind") == "pr":
            head = f"#{a['id']} [pr {a.get('part', 'body')}] on the PR description draft{status}"
        elif a.get("kind") == "file":
            head = f"#{a['id']} [file] {a.get('file')}{status}"
        else:
            where = f"L{a.get('start')}" if a.get("start") else ""
            if a.get("end") and a.get("end") != a.get("start"):
                where += f"-{a['end']}"
            side = "" if a.get("side", "new") == "new" else " (old side)"
            kind = a.get("kind", "line")
            loc = f"{a.get('file')}:{where}" if where else f"{a.get('file')}"
            head = f"#{a['id']} [{kind}] {loc}{side}{status}"
            if kind == "chunk" and a.get("label"):
                head += f"  ({a['label']})"
            if kind == "pin":
                head += f"  pin at {round(a.get('relX', 0) * 100)}% across, {round(a.get('relY', 0) * 100)}% down the file box"
                if where:
                    head += ", nearest line below"
        lines.append(head)
        if a.get("kind") == "selection" and a.get("selection"):
            lines.append(f'  selected: "{a["selection"]}"')
        if a.get("quote"):
            qlines = a["quote"].splitlines()
            shown = qlines if len(qlines) <= 14 else qlines[:12] + [f"… (+{len(qlines) - 12} more lines)"]
            for q in shown:
                lines.append(f"  > {q}")
        for ln in (a.get("comment") or "").strip().splitlines() or [""]:
            lines.append(f"  {ln}")
        if a.get("suggestion") is not None:
            lines.append("  ```suggestion")
            for s in a["suggestion"].splitlines() or [""]:
                lines.append(f"  {s}")
            lines.append("  ```")
        for r in a.get("replies") or []:
            first, *rest = (r.get("text") or "").strip().splitlines() or [""]
            lines.append(f"  ↳ {r.get('author')}: {first}")
            for ln in rest:
                lines.append(f"    {ln}")
        lines.append("")
    draft = notes.pr_draft()
    if draft:
        lines.append(f"PR description draft rev {draft['rev']} ({draft['at']}):")
        lines.append(f"  title: {draft['title']}")
        for ln in draft["body"].splitlines():
            lines.append(f"  | {ln}")
        lines.append("")
    rr = notes.round_replies()
    if rr:
        lines.append("round replies:")
        for r in rr:
            lines.append(f"  ↳ {r.get('author')} ({r.get('at')}): {(r.get('text') or '').strip()}")
    return "\n".join(lines).rstrip()


def apply_suggestions(notes: Notes, ids: list[int]) -> list[str]:
    """Apply exact-match suggestions to the working tree. Returns report lines.

    Only touches a file when the anchored lines still read exactly like the
    quote the note was made against; anything else is left for a human (or
    Claude) so a stale line number can never clobber unrelated code."""
    report: list[str] = []
    applied: list[int] = []
    for a in notes.load():
        if a.get("id") not in ids:
            continue
        if a.get("kind") not in ("line", "chunk", "selection") or a.get("suggestion") is None or a.get("side", "new") != "new":
            report.append(f"#{a['id']}: no new-side suggestion to apply")
            continue
        target = notes.repo / a["file"]
        try:
            lines = target.read_text().splitlines(keepends=True)
        except OSError as exc:
            report.append(f"#{a['id']}: cannot read {a['file']}: {exc}")
            continue
        start, end = int(a["start"]), int(a.get("end") or a["start"])
        current = "".join(lines[start - 1:end]).rstrip("\n")
        if current != (a.get("quote") or "").rstrip("\n"):
            report.append(
                f"#{a['id']}: {a['file']}:{start}-{end} no longer matches the quoted lines; apply by hand"
            )
            continue
        trailing = lines[end - 1].endswith("\n") if end - 1 < len(lines) else True
        replacement = a["suggestion"]
        if replacement and not replacement.endswith("\n") and trailing:
            replacement += "\n"
        new_lines = lines[:start - 1] + ([replacement] if replacement else []) + lines[end:]
        target.write_text("".join(new_lines))
        applied.append(a["id"])
        n_new = len(replacement.splitlines()) if replacement else 0
        report.append(f"#{a['id']}: applied to {a['file']}:{start}-{end} ({end - start + 1} -> {n_new} lines)")
    if applied:
        notes.resolve(applied)
    return report


# --------------------------------------------------------------------------
# second opinion (Codex, Claude)
# --------------------------------------------------------------------------

CODEX_MODEL = os.environ.get("REVIEW_APP_CODEX_MODEL", "")
CODEX_TIMEOUT = int(os.environ.get("REVIEW_APP_CODEX_TIMEOUT", "900"))
CLAUDE_MODEL = os.environ.get("REVIEW_APP_CLAUDE_MODEL", "")
CLAUDE_TIMEOUT = int(os.environ.get("REVIEW_APP_CLAUDE_TIMEOUT", "900"))
MAX_DIFF_CHARS = 250_000

REVIEW_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "comments"],
    "properties": {
        "summary": {"type": "string", "description": "2-4 sentence overall assessment"},
        "comments": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["file", "start", "end", "severity", "comment", "suggestion"],
                "properties": {
                    "file": {"type": "string", "description": "path exactly as it appears in the diff"},
                    "start": {"type": "integer", "description": "first NEW-side line number (post-change), 0 for a file-level comment"},
                    "end": {"type": "integer", "description": "last NEW-side line number, >= start"},
                    "severity": {"type": "string", "enum": ["bug", "risk", "nit", "question", "praise"]},
                    "comment": {"type": "string"},
                    "suggestion": {
                        "type": ["string", "null"],
                        "description": "exact replacement for lines start..end, or null",
                    },
                },
            },
        },
    },
}

REVIEW_PROMPT = """You are a second code reviewer on a local change that another coding agent \
made and a human reviewer is going over. Review the unified diff below the way a careful \
senior engineer reviews a pull request: correctness first, then risk, then clarity. You are \
in the repository, read-only; open surrounding files when the diff alone is not enough to \
judge a change. Do not run tests or modify anything.

Rules for comments:
- Anchor every comment to NEW-side (post-change) line numbers of the diff's `+` or context \
  lines. Use start=end=0 with the file path for a file-level remark.
- Prefer few, specific, high-value comments over many. Skip style nits unless they hide a bug.
- A `suggestion` must be the exact replacement text for lines start..end (same indentation), \
  or null. Only include one when you are confident.
- `severity`: bug (wrong behaviour), risk (could break under realistic conditions), \
  nit, question (you need the author to answer), praise (rare; only when it teaches something).
- Be direct and brief. No preamble.

Repository: {repo}   Branch: {branch}   Diff base: {base}

```diff
{diff}
```"""


class SecondOpinion:
    """Runs one reviewer CLI once on the current diff and turns its structured
    review into notes authored by that reviewer. Serialised per reviewer."""

    def __init__(self, author: str, command: str, ask, env: dict | None = None) -> None:
        # env picks the account: the variable that points the CLI at one login's config folder.
        self.author, self.command, self.ask, self.env = author, command, ask, env or {}
        self._lock = threading.Lock()
        self.running = False
        self.started: str | None = None
        self.finished: str | None = None
        self.added = 0
        self.error: str | None = None
        self.summary: str | None = None

    def status(self) -> dict:
        import shutil

        return {
            "author": self.author, "harness": self.command, "available": bool(shutil.which(self.command)),
            "running": self.running, "started": self.started, "finished": self.finished,
            "added": self.added, "error": self.error, "summary": self.summary,
        }

    def start(self, repo: Path, base: str, untracked: bool, notes: Notes, view: dict | None = None) -> bool:
        with self._lock:
            if self.running:
                return False
            self.running, self.error, self.added, self.summary = True, None, 0, None
            self.started = time.strftime("%Y-%m-%d %H:%M:%S")
            self.finished = None
        threading.Thread(target=self._run, args=(repo, base, untracked, notes, view), daemon=True).start()
        return True

    def run_blocking(self, repo: Path, base: str, untracked: bool, notes: Notes) -> dict:
        self.running = True
        self.started = time.strftime("%Y-%m-%d %H:%M:%S")
        self._run(repo, base, untracked, notes)
        return self.status()

    def _run(self, repo: Path, base: str, untracked: bool, notes: Notes, view: dict | None = None) -> None:
        try:
            if view:
                with pr_checkout(repo, view["head"]) as tree:
                    review = self.ask(tree, view["base"], False, self.env)
                model = diff_model(repo, view["base"], False, view["head"], view["branch"])
            else:
                review = self.ask(repo, base, untracked, self.env)
                model = diff_model(repo, base, untracked)
            self.added = add_reviewer_notes(notes, model, review, self.author, view["url"] if view else None)
            self.summary = review.get("summary")
        except Exception as exc:  # noqa: BLE001 -- surfaced on the page, never crashes the server
            self.error = f"{type(exc).__name__}: {exc}"[:400]
        finally:
            self.running = False
            self.finished = time.strftime("%Y-%m-%d %H:%M:%S")


@contextlib.contextmanager
def pr_checkout(repo: Path, head: str):
    import tempfile

    with tempfile.TemporaryDirectory(prefix="review-app-pr-") as tmp:
        tree = Path(tmp) / "tree"
        git(repo, "worktree", "add", "--detach", str(tree), head)
        try:
            yield tree
        finally:
            git(repo, "worktree", "remove", "--force", str(tree), check=False)
            git(repo, "worktree", "prune", check=False)


def review_prompt(repo: Path, base: str, untracked: bool) -> str:
    diff = raw_diff(repo, base, untracked)
    if not diff.strip():
        raise RuntimeError("nothing to review: the diff is empty")
    if len(diff) > MAX_DIFF_CHARS:
        diff = diff[:MAX_DIFF_CHARS] + "\n... (diff truncated for the prompt; open files for the rest)\n"
    branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD", check=False).strip()
    return REVIEW_PROMPT.format(repo=repo.name, branch=branch, base=base, diff=diff)


def parse_review(text: str, who: str) -> dict:
    try:
        review = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            raise RuntimeError(f"{who} returned non-JSON output: {text[:200]!r}")
        review = json.loads(m.group(0))
    if not isinstance(review, dict) or "comments" not in review:
        raise RuntimeError(f"{who} review missing 'comments'")
    return review


def ask_codex(repo: Path, base: str, untracked: bool, env: dict | None = None) -> dict:
    import shutil
    import tempfile

    if not shutil.which("codex"):
        raise RuntimeError("codex CLI not found on PATH (brew install codex, then `codex login`)")
    prompt = review_prompt(repo, base, untracked)
    with tempfile.TemporaryDirectory(prefix="review-app-codex-") as tmp:
        schema = Path(tmp) / "schema.json"
        out = Path(tmp) / "review.json"
        schema.write_text(json.dumps(REVIEW_SCHEMA))
        cmd = [
            "codex", "exec", "-C", str(repo), "-s", "read-only", "--ephemeral",
            "--skip-git-repo-check", "--color", "never",
            "--output-schema", str(schema), "-o", str(out),
        ]
        if CODEX_MODEL:
            cmd += ["-m", CODEX_MODEL]
        cmd.append(prompt)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=CODEX_TIMEOUT, check=False, env=with_account(env))  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-tainted-env-args.dangerous-subprocess-use-tainted-env-args
        if not out.exists():
            tail = (result.stderr or result.stdout or "").strip()[-600:]
            raise RuntimeError(f"codex exec exited {result.returncode} without a review: {tail}")
        text = out.read_text().strip()
    return parse_review(text, "codex")


def ask_claude(repo: Path, base: str, untracked: bool, env: dict | None = None) -> dict:
    """`claude -p` limited to read-only tools, with the same schema as Codex."""
    import shutil

    if not shutil.which("claude"):
        raise RuntimeError("claude CLI not found on PATH (install Claude Code, then sign in)")
    prompt = review_prompt(repo, base, untracked)
    cmd = [
        "claude", "-p", "--output-format", "json", "--json-schema", json.dumps(REVIEW_SCHEMA),
        "--tools", "Read", "Grep", "Glob", "--allowedTools", "Read", "Grep", "Glob",
        "--no-session-persistence", "--strict-mcp-config",
    ]
    if CLAUDE_MODEL:
        cmd += ["--model", CLAUDE_MODEL]
    result = subprocess.run(cmd, input=prompt, cwd=repo, capture_output=True, text=True, timeout=CLAUDE_TIMEOUT, check=False, env=with_account(env))  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-tainted-env-args.dangerous-subprocess-use-tainted-env-args
    try:
        reply = json.loads(result.stdout)
    except json.JSONDecodeError:
        tail = (result.stderr or result.stdout or "").strip()[-600:]
        raise RuntimeError(f"claude exited {result.returncode} without a review: {tail}") from None
    if reply.get("is_error"):
        raise RuntimeError(f"claude failed: {str(reply.get('result') or reply.get('subtype'))[:400]}")
    review = reply.get("structured_output")
    if isinstance(review, dict) and "comments" in review:
        return review
    return parse_review(str(reply.get("result") or ""), "claude")


def add_reviewer_notes(notes: Notes, model: dict, review: dict, author: str, pr: str | None = None) -> int:
    """Turn a structured review into notes. Line comments are anchored to the
    NEW side and quoted from the diff so threads render and `--apply` works;
    anything that doesn't map onto the diff becomes a file-level note."""
    by_path = {f["path"]: f for f in model["files"]}
    added = 0
    for c in review.get("comments") or []:
        f = by_path.get(c.get("file", ""))
        start, end = int(c.get("start") or 0), int(c.get("end") or 0)
        severity = (c.get("severity") or "").strip()
        comment = c.get("comment", "").strip()
        if severity:
            comment = f"[{severity}] {comment}"
        item: dict = {"kind": "file", "file": c.get("file", ""), "comment": comment, "author": author}
        if pr:
            item["pr"] = pr
        if f and start > 0:
            end = max(end, start)
            lines = [
                l for h in f["hunks"] for l in h["lines"]
                if l["t"] != "-" and l["new"] is not None and start <= l["new"] <= end
            ]
            if lines:
                item.update({
                    "kind": "line", "side": "new", "start": start, "end": end,
                    "quote": "\n".join(l["text"] for l in lines),
                    "suggestion": c.get("suggestion"),
                })
        elif not f:
            item["kind"] = "general"
            item["comment"] = f"{c.get('file', '')}: {comment}" if c.get("file") else comment
        notes.add(item)
        added += 1
    summary = (review.get("summary") or "").strip()
    if summary:
        notes.round_reply(author, summary)
    return added


TEXT_REVIEW_RULES = (
    "\n\nReply with only a JSON object, no prose and no code fence, matching this JSON Schema:\n"
    + json.dumps(REVIEW_SCHEMA)
)


def with_account(env: dict | None) -> dict | None:
    return {**os.environ, **env} if env else None


def run_review_cli(cmd: list[str], repo: Path, who: str, stdin: str | None = None, env: dict | None = None) -> dict:
    """Run a headless harness in the repo and read a review out of its output:
    a structured_output field when the CLI has one, else the JSON in its text."""
    result = subprocess.run(cmd, input=stdin, cwd=repo, capture_output=True, text=True,
                            timeout=CLAUDE_TIMEOUT, check=False, env=with_account(env))
    text = re.sub(r"\x1b\[[0-9;]*m", "", result.stdout or "").strip()
    if not text:
        tail = (result.stderr or "").strip()[-600:]
        raise RuntimeError(f"{who} exited {result.returncode} without a review: {tail}")
    try:
        reply = json.loads(text)
    except json.JSONDecodeError:
        reply = None
    if isinstance(reply, dict):
        if reply.get("type") == "error" or reply.get("is_error"):
            raise RuntimeError(f"{who} failed: {str(reply.get('message') or reply.get('result'))[:400]}")
        if isinstance(reply.get("structured_output"), dict):
            return reply["structured_output"]
        if "comments" in reply:
            return reply
        if isinstance(reply.get("result"), str):
            return parse_review(reply["result"], who)
    return parse_review(text, who)


def ask_grok(repo: Path, base: str, untracked: bool, env: dict | None = None) -> dict:
    prompt = review_prompt(repo, base, untracked)
    return run_review_cli(["grok", "-p", prompt, "--json-schema", json.dumps(REVIEW_SCHEMA),
                           "--permission-mode", "plan"], repo, "grok", env=env)


def ask_opencode(repo: Path, base: str, untracked: bool, env: dict | None = None) -> dict:
    prompt = review_prompt(repo, base, untracked) + TEXT_REVIEW_RULES
    return run_review_cli(["opencode", "run", "--agent", "plan", prompt], repo, "opencode", env=env)


def ask_pi(repo: Path, base: str, untracked: bool, env: dict | None = None) -> dict:
    prompt = review_prompt(repo, base, untracked) + TEXT_REVIEW_RULES
    return run_review_cli(["pi", "-p", "--no-session", "--tools", "read,grep,find,ls", prompt], repo, "pi", env=env)


# Each runs read-only: Codex's read-only sandbox, Claude's read tools, Grok's
# plan mode, OpenCode's plan agent, Pi's read/grep/find/ls tools.
ASK = {"codex": ask_codex, "claude": ask_claude, "grok": ask_grok, "opencode": ask_opencode, "pi": ask_pi}
REVIEWERS = {
    "codex": SecondOpinion("Codex", "codex", ask_codex),
    "claude": SecondOpinion("Claude", "claude", ask_claude),
    "grok": SecondOpinion("Grok", "grok", ask_grok),
    "opencode": SecondOpinion("OpenCode", "opencode", ask_opencode),
    "pi": SecondOpinion("Pi", "pi", ask_pi),
}
# The variables an account may set, each pointing its CLI at one login's folder. Nothing else is accepted.
ACCOUNT_VARIABLES = {"CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "XDG_DATA_HOME", "PI_CODING_AGENT_DIR"}


def use_reviewers(text: str) -> None:
    """Offer the reviewers a host lists, one per account it has, in place of one per CLI."""
    rows = json.loads(text)
    if not isinstance(rows, list) or not rows or len(rows) > 30:
        raise ValueError("--reviewers is a list of up to 30 reviewers")
    chosen = {}
    for row in rows:
        env = (row.get("env") or {}) if isinstance(row, dict) else None
        if (not isinstance(row, dict) or row.get("harness") not in ASK or not re.fullmatch(r"[a-z][a-z0-9-]{0,59}", str(row.get("id")))
                or not isinstance(row.get("label"), str) or not 1 <= len(row["label"]) <= 60 or not isinstance(env, dict)
                or not set(env) <= ACCOUNT_VARIABLES or not all(isinstance(v, str) and v.startswith("/") for v in env.values())):
            raise ValueError(f"not a reviewer: {str(row)[:120]}")
        chosen[row["id"]] = SecondOpinion(row["label"], row["harness"], ASK[row["harness"]], env)
    REVIEWERS.clear()
    REVIEWERS.update(chosen)


# --------------------------------------------------------------------------
# reviews left on the opened PR in GitHub
# --------------------------------------------------------------------------

def pr_coordinates(url: str) -> tuple[str, str, int]:
    m = re.match(r"https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)", url or "")
    if not m:
        raise RuntimeError(f"not a GitHub pull request URL: {url!r}")
    return m.group(1), m.group(2), int(m.group(3))


def gh_pages(path: str) -> list:
    import shutil

    if not shutil.which("gh"):
        raise RuntimeError("gh CLI not found on PATH (install it, then `gh auth login`)")
    result = subprocess.run(["gh", "api", "--paginate", "--slurp", path], capture_output=True, text=True, timeout=120, check=False)
    if result.returncode:
        raise RuntimeError(f"gh api {path} failed: {(result.stderr or result.stdout).strip()[-300:]}")
    return [item for page in json.loads(result.stdout or "[]") for item in page]


def fetch_github_reviews(url: str) -> dict:
    owner, name, number = pr_coordinates(url)
    base = f"repos/{owner}/{name}"
    return {
        "comments": gh_pages(f"{base}/pulls/{number}/comments"),
        "reviews": gh_pages(f"{base}/pulls/{number}/reviews"),
        "conversation": gh_pages(f"{base}/issues/{number}/comments"),
    }


def branch_pr(repo: Path) -> dict | None:
    """The checked-out branch's open GitHub pull request and the commit its changes start from, or None."""
    import shutil

    if not shutil.which("gh"):
        return None
    try:
        result = subprocess.run(["gh", "pr", "view", "--json", "url,state,baseRefName,title"], cwd=repo, capture_output=True, text=True,
                                timeout=30, check=False, stdin=subprocess.DEVNULL)
        data = json.loads(result.stdout) if result.returncode == 0 else {}
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    if data.get("state") != "OPEN" or not str(data.get("url", "")).startswith("https://"):
        return None
    name = str(data.get("baseRefName") or "")
    refs = git(repo, "for-each-ref", "--format=%(refname:short)", f"refs/remotes/*/{name}", check=False).split() if name else []
    ref = next((r for r in sorted(refs, key=lambda r: not r.startswith("origin/")) + [name] if r and git(repo, "rev-parse", "--verify", "--quiet", r + "^{commit}", check=False).strip()), None)
    base = git(repo, "merge-base", ref, "HEAD", check=False).strip() if ref else ""
    return {"url": data["url"], "base": base or None, "title": str(data.get("title") or "") or None, "base_name": name if base else None}


def github_remotes(repo: Path) -> dict:
    """This repository's GitHub remotes by owner/name (lowercase), so a pull request can be matched to one."""
    found = {}
    for line in git(repo, "remote", "-v", check=False).splitlines():
        parts = line.split()
        m = re.search(r"github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", parts[1]) if len(parts) > 1 else None
        if m:
            found.setdefault(f"{m.group(1)}/{m.group(2)}".lower(), parts[0])
    return found


def other_pr(repo: Path, url: str) -> dict:
    """Another of this repository's open pull requests, with its head and base commits fetched if they
    are missing. Nothing is checked out: the review reads the PR from Git."""
    owner, name, _ = pr_coordinates(url)
    remote = github_remotes(repo).get(f"{owner}/{name}".lower())
    if not remote:
        raise RuntimeError("that pull request is in another repository")
    result = subprocess.run(["gh", "pr", "view", url, "--json", "number,title,state,url,headRefName,headRefOid,baseRefName,baseRefOid"],
                            cwd=repo, capture_output=True, text=True, timeout=30, check=False, stdin=subprocess.DEVNULL)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip()[-300:] or "gh pr view failed")
    data = json.loads(result.stdout)
    if data.get("state") != "OPEN":
        raise RuntimeError(f"#{data.get('number')} is {str(data.get('state', '')).lower()}")
    head, base_oid = str(data.get("headRefOid") or ""), str(data.get("baseRefOid") or "")
    if not re.fullmatch(r"[0-9a-f]{40}", head) or not re.fullmatch(r"[0-9a-f]{40}", base_oid):
        raise RuntimeError("GitHub did not say which commits the pull request compares")
    have = lambda oid: subprocess.run(["git", "-C", str(repo), "cat-file", "-e", oid + "^{commit}"], capture_output=True, check=False).returncode == 0
    if not (have(head) and have(base_oid)):
        git(repo, "fetch", "--quiet", "--no-tags", remote, f"pull/{data['number']}/head", "refs/heads/" + str(data.get("baseRefName") or ""))
    base = git(repo, "merge-base", base_oid, head).strip()
    return {"url": data["url"], "number": data["number"], "title": str(data.get("title") or "")[:200], "branch": str(data.get("headRefName") or ""),
            "head": head, "base": base, "base_name": str(data.get("baseRefName") or "") or None}


VIEW_LOCK = threading.Lock()


def in_view(item: dict) -> bool:
    """Notes belong to what they were made on: another PR's notes show only while that PR is reviewed."""
    view = Handler.view
    if view:
        return item.get("pr") == view["url"]
    return item.get("pr") in (None, (Handler.notes.pr() or {}).get("url"))


def current_model() -> dict:
    view = Handler.view
    if view:
        return diff_model(Handler.repo, view["base"], False, view["head"], view["branch"])
    return diff_model(Handler.repo, Handler.base, Handler.untracked)


def select_pr(url: str | None) -> dict | None:
    """Review another pull request, or the checked-out work again with url None."""
    view = other_pr(Handler.repo, url) if url else None
    if view and view["branch"] == git(Handler.repo, "rev-parse", "--abbrev-ref", "HEAD", check=False).strip():
        view = None
    with VIEW_LOCK:
        Handler.view = view
        if Handler.feedback:
            Handler.feedback.answer = Handler.answer + (
                f" These notes are on pull request #{view['number']} (branch {view['branch']}), which is not checked out in "
                f"{Handler.repo}: check that branch out, or work in a worktree of it, before changing code." if view else "")
    if view:
        try:
            import_github_reviews(Handler.notes, current_model(), fetch_github_reviews(view["url"]), view["url"])
        except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as exc:
            print(f"could not pull reviews: {exc}", file=sys.stderr, flush=True)
    return view


def follow_pr(notes: Notes, repo: Path, interval: float) -> None:
    """Once the branch has a pull request, review all of it rather than only uncommitted work, so GitHub's
    line comments land on their lines, and keep bringing its new review comments in. While another of the
    terminal's pull requests is shown, keep that one current instead."""
    while True:
        view = Handler.view
        if view:
            try:
                fresh = other_pr(repo, view["url"])
                with VIEW_LOCK:
                    if Handler.view and Handler.view["url"] == fresh["url"]:
                        Handler.view = fresh
                import_github_reviews(notes, current_model(), fetch_github_reviews(fresh["url"]), fresh["url"])
            except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as exc:
                print(f"could not refresh #{view['number']}: {exc}", file=sys.stderr, flush=True)
        else:
            pr = branch_pr(repo)
            if pr:
                known = notes.pr() or {}
                if (known.get("url"), known.get("title")) != (pr["url"], pr["title"]):
                    notes.set_pr(pr["url"], pr["title"])
                Handler.base = pr["base"] or Handler.base
                Handler.base_name = pr["base_name"]
                try:
                    import_github_reviews(notes, current_model(), fetch_github_reviews(pr["url"]), pr["url"])
                except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as exc:
                    print(f"could not pull reviews: {exc}", file=sys.stderr, flush=True)
        time.sleep(interval)


def github_text(body: str | None) -> str:
    """GitHub bodies are Markdown with some HTML (bot badges, <details>); keep the words."""
    text = re.sub(r"<!--.*?-->", "", body or "", flags=re.S)
    text = re.sub(r"<picture>.*?</picture>", "", text, flags=re.S | re.I)
    text = re.sub(r"</?(?:details|summary|picture|source|img|br|strong|em|sub|sup|p|div|span)\b[^>]*>", "", text, flags=re.I)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def import_github_reviews(notes: Notes, model: dict, data: dict, pr: str | None = None) -> dict:
    """Turn a PR's GitHub review comments, review summaries and conversation into
    notes authored by each GitHub user. Each GitHub item is imported once, marked
    with the PR it came from so it shows only while that PR is reviewed."""
    by_path = {f["path"]: f for f in model["files"]}
    when = lambda c: (c.get("created_at") or c.get("submitted_at") or "")[:19].replace("T", " ")
    counts = {"comments": 0, "replies": 0, "reviews": 0, "conversation": 0, "approvals": 0}
    with notes._lock:
        items = notes.load()
        seen = {i["gh_id"] for i in items if i.get("gh_id")} | {r["gh_id"] for i in items for r in i.get("replies") or [] if r.get("gh_id")}
        thread = {i["gh_id"]: i for i in items if i.get("gh_id")}
        next_id = max((i.get("id", 0) for i in items), default=0)

        def add(item: dict, gh_id: str, c: dict) -> dict:
            nonlocal next_id
            next_id += 1
            item.update({"id": next_id, "gh_id": gh_id, "gh_url": c.get("html_url"), "author": (c.get("user") or {}).get("login", "github"),
                         "created": when(c) or time.strftime("%Y-%m-%d %H:%M:%S"), "status": "open"})
            if pr:
                item["pr"] = pr
            items.append(item)
            thread[gh_id] = item
            seen.add(gh_id)
            return item

        for c in sorted(data.get("comments") or [], key=lambda c: c.get("id", 0)):
            gh_id = f"comment-{c.get('id')}"
            if gh_id in seen:
                continue
            body = github_text(c.get("body"))
            parent = thread.get(f"comment-{c.get('in_reply_to_id')}") if c.get("in_reply_to_id") else None
            if parent:
                parent.setdefault("replies", []).append({"author": (c.get("user") or {}).get("login", "github"), "text": body, "at": when(c), "gh_id": gh_id})
                seen.add(gh_id)
                counts["replies"] += 1
                continue
            path, f = c.get("path", ""), by_path.get(c.get("path", ""))
            side = "old" if c.get("side") == "LEFT" else "new"
            end = c.get("line")
            start = c.get("start_line") or end
            item: dict = {"kind": "file", "file": path, "comment": body if end else f"[outdated] {body}"}
            if f and end:
                lines = [
                    l for h in f["hunks"] for l in h["lines"]
                    if (l["old"] if side == "old" else l["new"]) is not None and l["t"] != ("+" if side == "old" else "-")
                    and start <= (l["old"] if side == "old" else l["new"]) <= end
                ]
                if lines:
                    item.update({"kind": "line", "side": side, "start": start, "end": end,
                                 "quote": "\n".join(l["text"] for l in lines), "suggestion": None})
            elif not f:
                item = {"kind": "general", "comment": f"{path}: {item['comment']}" if path else item["comment"]}
            add(item, gh_id, c)
            counts["comments"] += 1
        for r in data.get("reviews") or []:
            gh_id = f"review-{r.get('id')}"
            if gh_id in seen:
                continue
            state = (r.get("state") or "").lower().replace("_", " ")
            if r.get("state") == "APPROVED":
                counts["approvals"] += 1
            if not github_text(r.get("body")):
                seen.add(gh_id)
                continue
            add({"kind": "general", "comment": f"[{state}] {github_text(r.get('body'))}"}, gh_id, r)
            counts["reviews"] += 1
        for c in data.get("conversation") or []:
            gh_id = f"issue-{c.get('id')}"
            if gh_id in seen or not github_text(c.get("body")):
                continue
            add({"kind": "general", "comment": github_text(c.get("body"))}, gh_id, c)
            counts["conversation"] += 1
        notes.save(items)
    return counts


# --------------------------------------------------------------------------
# page
# --------------------------------------------------------------------------

PAGE = r"""<!doctype html>
<html><head><meta charset="utf-8"><title>__TITLE__</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="./vendor/github.min.css" id="hl-light">
<link rel="stylesheet" href="./vendor/github-dark.min.css" id="hl-dark" disabled>
<style>
/* The review in Agent Desk's own register: its dark surfaces, quiet controls and colours, so it reads as part of
   the side panel. A PR row and the tabs stay on top, each file opens in place, and the actions stay at the bottom. */
:root{color-scheme:dark;
 --fg:#f5f5f4;--fg-2:#c3c2b7;--fg-muted:#8a8880;--bg:#0f0f11;--canvas:#141416;--surface:#161617;--raised:#1d1d1f;
 --border:rgba(255,255,255,.09);--border-strong:rgba(255,255,255,.16);
 --accent:#3987e5;--accent-bg:rgba(57,135,229,.14);--amber:#d9a34c;--good:#199e70;
 --add:#5fb98e;--del:#e07a7a;--mod:#d9a34c;
 --add-bg:#5fb98e12;--add-num:#5fb98e1f;--add-word:#5fb98e33;--del-bg:#e07a7a12;--del-num:#e07a7a1f;--del-word:#e07a7a33;
 --hunk-bg:#3987e50f;--hunk-fg:#6f8fb8;--done:#6e7681;--danger:#e66767;--ok:#5fb98e;
 --btn-bg:transparent;--btn-hover:#ffffff0d;--shadow:rgba(0,0,0,.5);--sel:#3987e526;
 --mono:"SFMono-Regular",ui-monospace,Menlo,Consolas,monospace;--prrow:34px;--tabs:38px;--barh:46px}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:12.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;padding-bottom:var(--barh)}
button,textarea,input{font:inherit;color:inherit}
a{color:#a9c4ea;text-decoration:none}a:hover{text-decoration:underline}
.mono{font-family:var(--mono)}
svg.i{display:block;flex-shrink:0;width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
[hidden]{display:none!important}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:#ffffff1a;border-radius:4px}

/* ---------- buttons ---------- */
.btn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:1px solid var(--border-strong);border-radius:7px;background:none;color:var(--fg-2);font-size:12px;white-space:nowrap;cursor:pointer}
.btn:hover{border-color:#ffffff38;color:var(--fg)}
.btn:disabled{opacity:.5;cursor:default}
.btn.small{height:22px;padding:0 8px;font-size:11.5px}
.btn.on{background:var(--accent-bg);border-color:var(--accent);color:#cfe0f7}
.btn.danger:hover{border-color:var(--danger);color:var(--danger)}
.btn.primary{height:28px;padding:0 12px;border-color:#4d8fe0;background:linear-gradient(#3f8be6,#2f74c9);color:#fff;font-weight:500;box-shadow:inset 0 1px 0 #ffffff26}
.btn.primary:hover{filter:brightness(1.08);color:#fff}
.btn.primary:disabled{background:#ffffff0f;border-color:var(--border-strong);color:var(--fg-muted);box-shadow:none;filter:none}
.btn kbd{font:600 10px/1 var(--mono);padding:2px 4px;border:1px solid var(--border-strong);border-radius:4px;color:var(--fg-muted)}
.ib{display:grid;place-items:center;width:26px;height:26px;border:0;border-radius:6px;background:none;color:var(--fg-muted);cursor:pointer}
.ib:hover{background:#ffffff0d;color:var(--fg)}.ib.on{background:var(--accent-bg);color:#cfe0f7}
.tlink{border:0;background:none;padding:0 4px;color:var(--fg-muted);font-size:11.5px;cursor:pointer;white-space:nowrap}.tlink:hover{color:var(--fg)}
.stat-add{color:var(--add)}.stat-del{color:var(--del)}

/* ---------- PR row ---------- */
#top{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:7px;height:var(--prrow);padding:0 8px 0 12px;background:#0d0f13;border-bottom:1px solid #ffffff0b;color:var(--fg-2);font-size:12px;white-space:nowrap;overflow:hidden}
#top svg.i{width:13px;height:13px;color:var(--fg-muted)}
#meta{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--fg-2)}
#stats{flex:none}
#stats{font:11px var(--mono)}
/* The branch gives way first; the PR and its comments stay whole. */
#prstate{display:flex;align-items:center;gap:7px;flex:1 1 auto;min-width:0}
#prstate .prlink{display:flex;align-items:baseline;gap:6px;min-width:0;color:var(--fg);text-decoration:none}#prstate .prlink:hover .prtitle{text-decoration:underline;text-underline-offset:2px}
#prstate .prtitle{min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:500;color:var(--fg)}#prstate .prnum{flex:none;color:var(--fg-muted);font-variant-numeric:tabular-nums}
#prstate .sp{flex:1 1 0;min-width:4px}#branch:hover #meta b{color:var(--fg)}
#prstate .sync{display:inline-flex;align-items:center;gap:5px;flex:none;height:22px;padding:0 7px;border:1px solid transparent;border-radius:6px;background:none;color:var(--fg-muted);font-size:11.5px;font-variant-numeric:tabular-nums;cursor:pointer}
#prstate .sync:hover{border-color:var(--border-strong);color:var(--fg)}#prstate .sync svg.i{display:block;width:12px;height:12px;color:currentColor}#prstate .sync .rf{margin-left:1px}#prstate .sync:disabled .rf{animation:spin 1s linear infinite}
#prstate .sep{width:1px;height:14px;background:var(--border-strong)}
#prstate svg.i{color:#b9b0f5}
#prstate .ghc{color:var(--fg-muted)}
#prstate .newc{height:20px;padding:0 8px;border:0;border-radius:10px;background:#d9a34c26;color:var(--amber);font-size:11px;font-weight:600;cursor:pointer}
#prstate .newc:hover{background:#d9a34c3a}
#prstate .pending{color:var(--fg-muted);overflow:hidden;text-overflow:ellipsis}
#prstate .ready{border:0;background:none;color:#a9c4ea;cursor:pointer;padding:0}
#prstate .ready:hover{text-decoration:underline}
#prstate .prpick{display:inline-grid;place-items:center;width:20px;height:20px;margin-left:-4px;padding:0;border:0;border-radius:5px;background:none;color:var(--fg-muted);cursor:pointer}
#prstate .prpick:hover,#prstate .prpick[aria-expanded=true]{background:#ffffff12;color:var(--fg)}
#prstate .prpick svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.6}
#meta.away{color:var(--amber)}
#pr-menu{position:fixed;z-index:60;width:330px;max-width:calc(100vw - 16px);padding:5px;border:1px solid var(--border-strong);border-radius:10px;background:var(--raised);box-shadow:0 14px 40px #000a}
#pr-menu[hidden]{display:none}
#pr-menu .mh{padding:6px 8px 7px;color:var(--fg-muted);font-size:11px}
#pr-menu button{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 8px;border:0;border-radius:6px;background:none;color:inherit;font-size:12.5px;text-align:left;cursor:pointer}
#pr-menu button:hover,#pr-menu button:focus-visible{background:#ffffff0d;outline:0}
#pr-menu .ck{display:inline-grid;place-items:center;flex:none;width:14px;color:var(--accent)}
#pr-menu .num{flex:none;color:var(--fg-muted);font:11.5px var(--mono)}
#pr-menu .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pr-menu .st{flex:none;color:var(--fg-muted);font-size:11px}
#pr-menu .st.amb{color:var(--amber)}

/* ---------- tabs ---------- */
#tabs{position:sticky;top:var(--prrow);z-index:49;display:flex;align-items:flex-end;gap:2px;height:var(--tabs);padding:0 6px 0 10px;background:var(--bg);border-bottom:1px solid #ffffff0b}
#tabs>[role=tab]{display:flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:0;border-radius:7px 7px 0 0;background:none;color:#8f8f97;font-size:12.5px;cursor:pointer}
#tabs>[role=tab]:hover{color:var(--fg)}
#tabs>[role=tab][aria-selected=true]{background:var(--canvas);color:var(--fg);box-shadow:inset 0 1px 0 #ffffff12,inset 1px 0 0 #ffffff0b,inset -1px 0 0 #ffffff0b}
#tabs .n{font:10.5px var(--mono);color:var(--fg-muted)}#tabs .n.amb{color:var(--amber)}
#tabs .sp{flex:1}
#tabs .tools{display:flex;align-items:center;gap:2px;align-self:center}
body.tab-notes #tabs .tools .changes-only{display:none}
.vseg{display:inline-flex;padding:2px;margin-right:4px;border:1px solid var(--border);border-radius:7px;background:#0a0a0b}
.vseg button{height:20px;padding:0 8px;border:0;border-radius:5px;background:none;color:#8f8f97;font-size:11px;cursor:pointer}
.vseg button[aria-pressed=true]{background:#ffffff12;color:var(--fg);box-shadow:inset 0 0 0 1px var(--border-strong)}

/* ---------- layout: diff, and notes beside it when there is room ---------- */
#wrap{display:flex;align-items:flex-start}
#main{flex:1;min-width:0}
#side{display:none;padding:12px}
body.tab-notes #main{display:none}
body.tab-notes #side{display:block;width:100%;max-width:860px;margin:0 auto}
@media(min-width:1000px){
 body:not(.tab-notes) #side{display:block;position:sticky;top:calc(var(--prrow) + var(--tabs));width:300px;flex:none;height:calc(100vh - var(--prrow) - var(--tabs) - var(--barh));overflow:auto;border-left:1px solid #ffffff0b}
 body:not(.tab-notes) #side .filters,body:not(.tab-notes) #side #roundreplies{display:none}
}

/* ---------- files: one row each, opening in place ---------- */
.file{position:relative;border-bottom:1px solid #ffffff0b}
.file>header{position:sticky;top:calc(var(--prrow) + var(--tabs));z-index:5;display:flex;align-items:center;gap:7px;height:34px;padding:0 8px 0 8px;background:var(--bg);color:var(--fg-2);font-size:12.5px;cursor:pointer;user-select:none}
.file>header:hover{background:#151517;color:var(--fg)}
.file:not(.collapsed)>header{background:var(--canvas);color:var(--fg);border-bottom:1px solid #ffffff0b}
.file>header .chev{width:11px;height:11px;color:var(--fg-muted);transition:transform .15s}
.file:not(.collapsed)>header .chev{transform:rotate(90deg)}
.file>header .ficon{color:#6ea8d8}
.file>header .path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file>header .path .dir{color:var(--fg-muted);font-size:11.5px;margin-left:6px}
.file>header .sp{flex:1}
.file>header .end{display:flex;align-items:center;gap:8px;flex-shrink:0}
.file>header .lines{font:10.5px var(--mono)}
.file>header .st{font:600 10px var(--mono);color:var(--mod)}.file>header .st.A{color:var(--add)}.file>header .st.D{color:var(--del)}.file>header .st.U{color:var(--fg-muted)}
.untracked-head{display:flex;align-items:baseline;gap:8px;margin:18px 0 8px;padding:0 10px;color:var(--fg-muted);font-size:12px}.untracked-head b{color:var(--fg);font-weight:600}.untracked-head span{flex:1;min-width:0}
.untracked-head button{flex:none;padding:2px 8px;border:1px solid var(--border);border-radius:5px;background:none;color:var(--fg-muted);font:inherit;cursor:pointer}.untracked-head button:hover{color:var(--fg)}
.file>header .cnt{display:inline-flex;align-items:center;gap:3px;color:var(--amber);font-size:11px}.file>header .cnt svg.i{width:11px;height:11px}
.bars{display:inline-flex;gap:1px}.bars i{width:4px;height:8px;border-radius:1px;background:#ffffff1c}.bars i.a{background:var(--add)}.bars i.d{background:var(--del)}
.viewed{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border:1px solid var(--border);border-radius:6px;background:none;color:var(--fg-muted);font-size:10.5px;cursor:pointer}
.viewed svg.i{width:11px;height:11px}
.viewed:hover{border-color:var(--border-strong);color:var(--fg-2)}
.viewed.on{border-color:#199e7055;color:#5fc9a0}
.file.seen>header .path,.file.seen>header .ficon{opacity:.55}
.file>header [data-filenote]{opacity:0}.file>header:hover [data-filenote],.file>header [data-filenote]:focus-visible{opacity:1}
.file.collapsed .body{display:none}
.file .body{animation:open .15s ease-out}
@keyframes open{from{opacity:0}to{opacity:1}}

/* ---------- the diff ---------- */
table.diff{width:100%;border-collapse:collapse;font:12px/20px var(--mono);tab-size:4}
table.diff td{padding:0;vertical-align:top;white-space:pre-wrap;word-break:break-all;font-family:inherit}
table.diff .num{width:1%;min-width:40px;padding:0 6px;text-align:right;color:#55555c;user-select:none;cursor:pointer;position:relative;z-index:1}
table.diff .num:hover{color:var(--accent)}
table.diff .code{padding:0 8px 0 4px;position:relative;cursor:pointer}
table.diff td.chunk{width:18px;min-width:18px;padding:0;text-align:center;user-select:none;position:relative}
table.diff td.chunk .para{display:none;color:var(--accent);cursor:pointer;font-size:12px;line-height:20px}
tr.hot td{filter:brightness(1.2)}
tr.hot td.chunk .para{display:block}
tr.hunk td{cursor:pointer}
button.exp{font:11px/16px var(--mono);min-width:22px;margin:0 6px 0 0;padding:0 6px;border:1px solid var(--border-strong);border-radius:4px;background:none;color:var(--fg-muted);cursor:pointer;vertical-align:1px}
button.exp:hover{color:var(--accent);border-color:var(--accent)}
tr.expander td{background:var(--hunk-bg);color:var(--hunk-fg);padding:3px 8px 3px 12px;font-size:11px}tr.expander .exp-n{margin-left:2px}
tr.hunk:hover td{filter:brightness(1.3)}
.pin{position:absolute;z-index:4;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:var(--danger);color:#fff;font:600 11px/22px sans-serif;text-align:center;box-shadow:0 1px 3px var(--shadow);cursor:pointer;pointer-events:auto}
.pin.done{background:var(--done)}
#bubble{position:absolute;z-index:70;display:none;padding:4px 10px;border-radius:6px;background:var(--raised);border:1px solid var(--border-strong);color:var(--fg);font-size:12px;cursor:pointer;box-shadow:0 6px 18px var(--shadow)}
table.diff .sign{display:inline-block;width:14px;user-select:none;color:#55555c}
tr.add td{background:var(--add-bg)} tr.add .num{background:var(--add-num);color:#6fae8c} tr.add .sign{color:#6fae8c}
tr.del td{background:var(--del-bg)} tr.del .num{background:var(--del-num);color:#b97a7a} tr.del .sign{color:#b97a7a}
tr.hunk td{background:var(--hunk-bg);color:var(--hunk-fg);padding:3px 8px 3px 12px;font-size:11px}
tr.sel td{background:var(--sel)!important}
tr.commented .num.new::before,tr.commented.del .num.old::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--amber)}
.plus{position:absolute;right:-8px;top:2px;z-index:2;width:16px;height:16px;border-radius:4px;background:var(--accent);color:#fff;font:600 12px/16px sans-serif;text-align:center;display:none;cursor:pointer}
tr:hover .num.click .plus{display:block}
body.line-drag,body.line-drag *{user-select:none!important;cursor:pointer}
.split td.code{width:50%}
.split td.num{min-width:36px}
.split tr.pair td.l{border-right:1px solid var(--border)}
tr.pair td.empty{background:#ffffff04}
.binary{padding:16px;color:var(--fg-muted);font-size:12px}
.hljs{background:none!important}

/* ---------- a note's thread, in the diff ---------- */
tr.thread td{background:var(--bg)!important;padding:6px 12px 8px 46px;white-space:normal;word-break:normal;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.thread-box{max-width:860px;border:1px solid var(--border-strong);border-radius:10px;background:var(--surface);overflow:hidden;font-size:12.5px}
.thread-box .th{display:flex;align-items:center;gap:8px;min-height:32px;padding:6px 12px;border-bottom:1px solid var(--border);background:#ffffff05;font-size:11.5px;color:var(--fg-muted)}
.thread-box .th .loc{flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:11.5px var(--mono);color:var(--fg-2)}
.thread-box .th{cursor:pointer;user-select:none}
.thread-box .th:hover{background:#ffffff09}
.thread-box .th .id{flex:none}
.thread-box .th .tchev{flex:none;width:12px;height:12px;transform:rotate(90deg);transition:transform .12s}
.thread-box .th .sum{display:none;flex:1 1 0;min-width:0;align-items:center;gap:7px;overflow:hidden}
.thread-box .th .sum .av{width:18px;height:18px;font-size:9.5px}
.thread-box .th .sum .st{flex:1 1 0;width:0;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--fg-2);font-size:12px}
.thread-box .th .sum .st b{color:var(--fg);font-weight:600}
.thread-box .th .sum .nr{flex:none;color:var(--fg-muted)}
.thread-box.folded .th{border-bottom:0}
.thread-box.folded .th .tchev{transform:none}
.thread-box.folded .th .sum{display:flex}
.thread-box.folded>:not(.th){display:none}
@media (max-width:560px){.thread-box.folded .th .loc{display:none}}
.thread-box .th .id{color:var(--fg-muted);font:11px var(--mono)}
.cm{display:flex;gap:10px;padding:11px 12px}
.cm+.cm{border-top:1px solid #ffffff0b}
.av{flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:hsl(var(--h,210) 38% 34%);color:#fff;font-size:11.5px;font-weight:600}
.av.claude{background:#c96442}.av.codex{background:#e6e6e6;color:#111}.av.grok{background:#7a5ce0}.av.opencode{background:#2a8a7d}.av.pi{background:#b37a26}
.cb{flex:1;min-width:0}
.ch{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 7px;line-height:20px}
.ch .an{color:var(--fg);font-size:13px;font-weight:600}
.ch .bot{align-self:center;padding:0 6px;border:1px solid var(--border-strong);border-radius:9px;color:var(--fg-muted);font-size:10px;line-height:15px}
.ch .at,.ch .gh{color:var(--fg-muted);font-size:11.5px}
.ch .gh:hover{color:var(--fg-2)}
.ct{margin-top:3px;color:var(--fg);font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.ct i{color:var(--fg-muted)}
.cb .sug{margin:9px 0 2px}
.thread-box>.proof{margin:0 12px 11px 46px}
.thread-box .replybox{padding:8px 12px 8px 46px}
.thread-box.done{border-color:#199e7055}
.thread-box.done .th::after{content:"Addressed";margin-left:auto;padding:1px 7px;border-radius:9px;background:#199e7024;color:#5fc9a0;font-size:10.5px;font-weight:500}
.proof{margin:2px 12px 10px;padding:7px 10px;border:1px solid #199e7040;border-left:2px solid var(--good);border-radius:7px;background:#199e700d;font-size:11.5px;color:var(--fg-2)}
.proof .ph{color:var(--fg-muted);font-size:11px;margin-bottom:3px}
.proof pre{margin:0;white-space:pre-wrap;max-height:12em;overflow:auto;font:11px var(--mono);color:#a7dcc3}
.proof img{display:block;max-width:100%;max-height:220px;margin-top:6px;border:1px solid var(--border);border-radius:5px}
.sug{margin:2px 12px 10px;border:1px solid var(--border-strong);border-radius:7px;overflow:hidden;font-size:12px}
.sug .sh{padding:4px 10px;background:#ffffff06;border-bottom:1px solid var(--border);color:var(--fg-muted);font-size:11px}
.sug pre{margin:0;padding:0;font:12px/20px var(--mono);white-space:pre-wrap;word-break:break-all}
.sug .l{padding:0 10px 0 22px;position:relative}
.sug .l::before{position:absolute;left:8px;color:var(--fg-muted)}
.sug .l.d{background:var(--del-bg)}.sug .l.d::before{content:"-"}
.sug .l.a{background:var(--add-bg)}.sug .l.a::before{content:"+"}
.reply{display:flex;gap:8px;padding:8px 12px;border-top:1px solid #ffffff0a;font-size:12px}
.reply .txt{white-space:pre-wrap;flex:1;color:var(--fg-2)}
.reply .at{color:var(--fg-muted);font-size:10.5px;flex:none}
.who{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:6px;background:#ffffff10;color:var(--fg);font-size:11px;font-weight:600}
.who.claude{background:#d977572e;color:#f0a98a}.who.codex{background:#ffffff14;color:#dcdcdc}
.who.grok{background:#8b6cf02e;color:#c6b6ff}.who.opencode{background:#2f9e8f2e;color:#8fdccf}.who.pi{background:#c98a2e2e;color:#f0c27a}
.replybox{display:flex;gap:6px;padding:8px 12px;border-top:1px solid #ffffff0a;background:#ffffff03}
.replybox input{flex:1;height:26px;padding:0 9px;border:1px solid var(--border);border-radius:7px;background:#0a0a0b;color:var(--fg);font-size:12px;outline:0}
.replybox input:focus{border-color:var(--accent)}

/* ---------- composer ---------- */
#composer{position:fixed;z-index:60;width:520px;max-width:calc(100vw - 24px);border:1px solid var(--border-strong);border-radius:10px;background:var(--raised);box-shadow:0 14px 40px #000a;display:none}
#composer.inline{position:static;width:auto;max-width:760px;box-shadow:none}
tr.composer-row td{background:var(--bg)!important;padding:8px 12px 10px 46px;white-space:normal;word-break:normal;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#composer .hd{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px;color:var(--fg-muted)}
#composer .hd b{color:var(--fg)}
#composer .hd .sp{flex:1}
#composer textarea{width:100%;min-height:74px;border:0;outline:0;padding:10px 12px;resize:vertical;background:transparent;color:var(--fg);font-size:13px}
#composer textarea.code{font:12px/20px var(--mono);background:#0a0a0b;border-top:1px solid var(--border);min-height:60px;white-space:pre;overflow:auto}
#composer .sugwrap{display:none}
#composer .sugwrap.on{display:block}
#composer .sugwrap .lbl{font-size:11px;color:var(--fg-muted);padding:6px 12px 0;display:flex;gap:6px;align-items:center}
#composer .ft{display:flex;gap:6px;align-items:center;padding:8px 12px;border-top:1px solid var(--border)}
#composer .ft .sp{flex:1}
#composer .ft .hint{font-size:11px;color:var(--fg-muted)}

/* ---------- notes ---------- */
.noteshead{display:flex;align-items:center;gap:6px;margin:0 0 10px}
.noteshead h3{margin:0;color:var(--fg-muted);font-size:10px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;white-space:nowrap}
.noteshead .sp{flex:1}
.filters{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 12px}
.filters button{height:24px;padding:0 9px;border:1px solid var(--border);border-radius:12px;background:none;color:var(--fg-2);font-size:11.5px;cursor:pointer}
.filters button[aria-pressed=true]{background:#ffffff12;border-color:var(--border-strong);color:var(--fg)}
#roundreplies{margin:0 0 10px}
#roundreplies .reply{border:1px solid var(--border);border-radius:8px;margin-bottom:6px}
#roundreplies .reply .txt{max-height:4.6em;overflow:hidden}
#roundreplies .reply.open .txt{max-height:none}
#roundreplies .more{font-size:11px;color:var(--fg-muted);cursor:pointer;margin:-2px 0 8px;display:block;background:none;border:0;padding:0}
.note{margin-bottom:8px;border:1px solid var(--border);border-radius:9px;background:var(--surface);font-size:12px;overflow:hidden}
.note:hover{border-color:var(--border-strong)}
.note .nh{display:flex;align-items:center;gap:6px;padding:7px 10px 0;cursor:pointer}
.note .nh .k{font-size:10px;padding:0 6px;border-radius:8px;background:#ffffff0a;color:var(--fg-muted)}
.note .nh .k.claude{background:#d977572e;color:#f0a98a}.note .nh .k.codex{background:#ffffff14;color:#dcdcdc}
.note .nh .k.grok{background:#8b6cf02e;color:#c6b6ff}.note .nh .k.opencode{background:#2f9e8f2e;color:#8fdccf}.note .nh .k.pi{background:#c98a2e2e;color:#f0c27a}
.note .nh .w{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:11px var(--mono);color:var(--fg-muted)}
.note .nq{margin:6px 10px 0;padding:4px 8px;border-left:2px solid var(--border-strong);color:var(--fg-muted);font:11px var(--mono);white-space:pre-wrap;max-height:60px;overflow:hidden}
.note textarea{width:100%;border:0;outline:0;padding:6px 10px;resize:vertical;background:transparent;color:var(--fg-2);min-height:36px;font-size:12.5px}
.note .ns{font-size:11px;color:var(--fg-muted);padding:0 10px 4px}
.note .nf{display:flex;gap:4px;padding:6px 10px;border-top:1px solid #ffffff0a}
.note .nf .btn{height:22px;padding:0 8px;font-size:11px}
.note .replybox{padding:6px 10px}
.note.done{border-color:#199e7040}
.note.done .nh .w{text-decoration:line-through}
/* A checked fix stays readable: the proof is what the reviewer looks at next. */
.note.done:not(:has(.proof)){opacity:.6}
.empty{padding:40px;text-align:center;color:var(--fg-muted)}

/* ---------- the action bar ---------- */
#bar{position:fixed;left:0;right:0;bottom:0;z-index:55;display:flex;align-items:center;gap:8px;height:var(--barh);padding:0 10px;background:#121214;border-top:1px solid #ffffff12}
#branch{display:flex;flex:0 1 auto;align-items:center;gap:7px;min-width:0;overflow:hidden;white-space:nowrap;color:var(--fg-muted);font-size:12px}
#branch svg.i{width:13px;height:13px;flex:none;color:var(--fg-muted)}
#branch-pop{position:fixed;z-index:120;display:flex;align-items:center;gap:6px;max-width:calc(100vw - 12px);padding:5px 5px 5px 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--raised);box-shadow:0 8px 24px #0000008c;color:var(--fg);font-size:12px}
#branch-pop[hidden],#hover-tip[hidden]{display:none}
#hover-tip{position:fixed;z-index:120;display:grid;gap:3px;max-width:260px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--raised);box-shadow:0 8px 24px #0000008c;color:var(--fg-muted);font-size:11.5px;line-height:1.4;pointer-events:none}#hover-tip b{color:var(--fg);font-weight:600}#branch-pop code{font:12px var(--mono);overflow-wrap:anywhere;user-select:all}#branch-pop .ib{width:24px;height:24px;flex:none}#branch-pop svg.i{width:13px;height:13px}#branch-pop small{color:var(--amber);font-size:11px;white-space:nowrap}
#branch #meta{display:flex;min-width:0;overflow:hidden}#branch #meta b{flex:0 1000000 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:500;color:var(--fg-2)}#branch #meta .base{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;margin-left:.35em}#send{gap:0}#send .gc-to{margin-left:.3em}#branch #meta.away b{color:var(--amber)}
#gc-inline{display:flex;flex:0 1000000 auto;align-items:center;gap:6px;min-width:0;margin:0 auto 0 0!important;font-size:11.5px!important;color:var(--fg-muted)}
#gc-inline p{margin:0!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gc-inline p:empty{display:none}
#gc-inline textarea{position:fixed;left:10px;right:10px;bottom:calc(var(--barh) + 8px);width:auto!important;z-index:56;background:#0a0a0b;color:var(--fg-2);border:1px solid var(--border-strong);border-radius:8px;padding:8px}
.opinion{position:relative;display:flex}
#codex .spark{width:13px;height:13px;opacity:.85}
#codex svg{width:10px;height:10px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;opacity:.7}
#codex .spin,#opinion-menu .spin{width:9px;height:9px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#opinion-menu{position:absolute;bottom:calc(100% + 8px);right:0;z-index:20;width:250px;padding:5px;border:1px solid var(--border-strong);border-radius:10px;background:var(--raised);box-shadow:0 14px 40px #000a}
#opinion-menu[hidden]{display:none}
#opinion-menu .mh{padding:6px 8px 7px;color:var(--fg-muted);font-size:11px}
#opinion-menu button{display:flex;align-items:center;gap:9px;width:100%;height:32px;padding:0 8px;border:0;border-radius:6px;background:none;color:inherit;font-size:12.5px;text-align:left;cursor:pointer}
#opinion-menu button:hover:not(:disabled),#opinion-menu button:focus-visible{background:#ffffff0d;outline:0}
#opinion-menu button:disabled{cursor:default}#opinion-menu button:disabled .who-name{opacity:.5}
#opinion-menu .av{display:grid;place-items:center;flex-shrink:0;width:20px;height:20px;border-radius:6px;font-size:10.5px;font-weight:700;color:#fff;background:var(--av,#6e7781)}
#opinion-menu button:disabled .av{opacity:.4}
#opinion-menu .who-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#opinion-menu .st{display:inline-flex;align-items:center;gap:5px;flex-shrink:0;color:var(--fg-muted);font-size:11px}
#opinion-menu .st.bad{color:var(--danger)}
#opinion-menu hr{margin:5px 2px;border:0;border-top:1px solid var(--border)}
#opinion-menu .all{color:var(--accent)}

/* ---------- PR description review ---------- */
#prdraft{margin:12px;border:1px solid var(--accent);border-radius:10px;background:var(--surface);overflow:hidden}
#prdraft[hidden]{display:none}
#prdraft>header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--accent-bg)}
#prdraft>header b{font-size:13px}#prdraft>header .rev{color:var(--fg-muted);font-size:12px}#prdraft>header .sp{flex:1}
#prdraft .part{padding:12px 14px;border-bottom:1px solid var(--border);position:relative}
#prdraft .part:last-of-type{border-bottom:0}
#prdraft .part>small{display:block;color:var(--fg-muted);font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px}
#prdraft .prt{font-size:16px;font-weight:600;line-height:1.35}
#prdraft .prb{white-space:pre-wrap;font-size:13px;line-height:1.55;max-height:420px;overflow:auto;color:var(--fg-2)}
#prdraft .part .cmt{position:absolute;top:8px;right:10px}
#prdraft .prnotes{padding:4px 14px 12px}#prdraft .prnotes .thread-box{margin:8px 0}

#toast{position:fixed;left:50%;bottom:calc(var(--barh) + 12px);transform:translateX(-50%);padding:6px 12px;border:1px solid var(--border-strong);border-radius:8px;background:var(--raised);color:var(--fg);font-size:12px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:99;max-width:calc(100vw - 24px)}
#toast.show{opacity:1}
@media(max-width:560px){
 #stats{display:none}
 #tabs .vseg{display:none}
 .file>header .lines,.file>header .path .dir{display:none}
 .viewed span{display:none}
 #codex .lbl{display:none}
 #send .gc-to{display:none}
}
@media(max-width:440px){#branch .branch-ico,#branch .base{display:none}}
@media(prefers-reduced-motion:reduce){.file .body{animation:none}.file>header .chev{transition:none}}
</style></head>
<body>
<div id="top">
  <span id="prstate"></span>
  <button class="btn small" id="openpr" hidden title="Approve this change and ask the agent to commit, push and open a draft PR. The agent writes the title and body for you to review here first. Shift-click for ready-for-review.">Approve &amp; open PR</button>
</div>
<div id="tabs" role="tablist" aria-label="Review">
  <button role="tab" id="tab-changes" aria-selected="true">Changes <span class="n" id="nfiles"></span></button>
  <button role="tab" id="tab-notes" aria-selected="false">Notes <span class="n" id="nopen"></span></button>
  <span class="sp"></span>
  <span class="tools">
    <span class="vseg changes-only" id="viewseg"><button data-view="unified" aria-pressed="true">Unified</button><button data-view="split" aria-pressed="false">Split</button></span>
    <button class="ib changes-only" id="togglethreads" hidden></button>
    <button class="ib changes-only" id="toggleall" title="Expand every file · Alt-click a file does the same"></button>
    <button class="ib" id="general" title="Note on the whole change · G"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H7.5L4.5 13.5V11H3c-.6 0-1-.4-1-1V4c0-.6.4-1 1-1Z"/></svg></button>
  </span>
</div>
<div id="wrap">
  <div id="main"></div>
  <aside id="side">
    <div class="noteshead"><h3 id="cnt">Notes</h3><span class="sp"></span>
      <button class="tlink" id="copy" title="Copy the notes as text (same as --dump)">Copy</button>
      <button class="tlink" id="cleardone" title="Archive addressed notes, keep the open ones">Clear done</button>
      <button class="tlink" id="clearall" title="Archive every note and start a new round">Clear all</button></div>
    <div class="filters" id="filters"></div>
    <div id="roundreplies"></div>
    <div id="notes"></div>
  </aside>
</div>
<div id="bar">
  <span id="branch"><svg class="i branch-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6M11.5 6.5c0 3-4 2.5-7 4.5"/></svg><span id="meta"></span><span id="stats"></span></span>
  <div id="gc-inline"></div>
  <div id="sent" hidden></div>
  <div class="opinion"><button class="btn" id="codex" aria-haspopup="menu" aria-expanded="false" aria-label="Second opinion: ask another coding agent to review this diff"><svg class="spark" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8 6.7 6.7Z"/></svg><span class="lbl">Second opinion</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
    <div id="opinion-menu" role="menu" hidden></div></div>
  <button class="btn primary" id="send" title="Save this round for the agent to retrieve; automatic delivery depends on your host">Send feedback</button>
</div>
<div id="composer">
  <div class="hd"><span id="cwhere"></span><span class="sp"></span>
    <button class="btn" id="csug" title="Suggest a replacement for the selected lines">± Suggest change</button></div>
  <textarea id="ctext" placeholder="Leave a comment"></textarea>
  <div class="sugwrap" id="csugwrap">
    <div class="lbl">Suggested replacement for the selected lines (edit freely; empty = delete them)</div>
    <textarea id="csugtext" class="code" spellcheck="false"></textarea>
  </div>
  <div class="ft"><span class="hint">⌘/Ctrl+Enter to save · Esc to cancel</span><span class="sp"></span>
    <button class="btn" id="ccancel">Cancel</button><button class="btn on" id="csave">Add comment</button></div>
</div>
<div id="bubble">💬 Comment on selection</div>
<div id="toast"></div>
<div id="pr-menu" role="menu" aria-label="Pull requests" hidden></div>
<script src="./vendor/highlight.min.js"></script>
<script>
const $=s=>document.querySelector(s);
const PARAMS=new URLSearchParams(location.search);const USER=__USER__;
let model=null, notes=[], digest=null, view=PARAMS.get('view')||localStorage.getItem('ra-view')||'unified';
let sel=null; // {file, side, start, end, quote}
let lastNotesKey='';
let composing=null; // {kind, file, side, start, end, quote}
let hlCache={},rawCache={},expandState={};

/* ---------- the desk is dark, and the review is part of it ---------- */
document.documentElement.dataset.theme='dark';$('#hl-light').disabled=true;$('#hl-dark').disabled=false;
const ICONS={
 chev:'<svg class="i chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
 file:'<svg class="i ficon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 2.2h4.9l3 3v8c0 .4-.3.6-.6.6H4.2c-.4 0-.6-.2-.6-.6V2.8c0-.4.2-.6.6-.6Z"/><path d="M9 2.3v2.9h2.9"/></svg>',
 note:'<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H7.5L4.5 13.5V11H3c-.6 0-1-.4-1-1V4c0-.6.4-1 1-1Z"/></svg>',
 check:'<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8.4 2.6 2.6L12 5.4"/></svg>',
 expand:'<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6.5 3-3 3 3M5 9.5l3 3 3-3"/></svg>',
 collapse:'<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3.5 3 3 3-3M5 12.5l3-3 3 3"/></svg>',
 foldthreads:'<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H7.5L4.5 13V10.5H3c-.6 0-1-.4-1-1v-6c0-.6.4-1 1-1Z"/><path d="m6 7.5 2-2 2 2"/></svg>',
 unfoldthreads:'<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H7.5L4.5 13V10.5H3c-.6 0-1-.4-1-1v-6c0-.6.4-1 1-1Z"/><path d="m6 5.5 2 2 2-2"/></svg>',
 pr:'<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="4" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="12" r="1.5"/><path d="M4.5 5.5v5M11.5 10.5V7c0-1.1-.9-2-2-2H7.5M9 3.5 7.5 5 9 6.5"/></svg>'
};
// Like GitHub: up to five blocks, one per five lines changed, split between added and removed.
function bars(a,d){const t=a+d,f=Math.min(5,Math.ceil(t/5)),g=t?Math.round(f*a/t):0;return `<span class="bars" aria-hidden="true">${[0,1,2,3,4].map(i=>`<i class="${i<g?'a':i<f?'d':''}"></i>`).join('')}</span>`;}
function toast(m){const t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),1600);}
const esc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------- highlighting: whole file, then split per line keeping spans open ---------- */
const LANG={py:'python',js:'javascript',ts:'typescript',tsx:'typescript',jsx:'javascript',rb:'ruby',go:'go',
 rs:'rust',java:'java',kt:'kotlin',sh:'bash',bash:'bash',zsh:'bash',yml:'yaml',yaml:'yaml',json:'json',
 md:'markdown',html:'xml',xml:'xml',css:'css',scss:'scss',sql:'sql',toml:'ini',ini:'ini',tf:'hcl',
 dockerfile:'dockerfile',makefile:'makefile',c:'c',h:'c',cpp:'cpp',cs:'csharp',php:'php',swift:'swift',
 lua:'lua',pl:'perl',r:'r',scala:'scala',diff:'diff',txt:''};
function langFor(path){const base=path.split('/').pop().toLowerCase();
 if(base==='dockerfile'||base.startsWith('dockerfile.'))return 'dockerfile';
 if(base==='makefile')return 'makefile';const ext=base.includes('.')?base.split('.').pop():'';
 return LANG[ext]===undefined?'':LANG[ext];}
function splitHighlighted(htmlStr){
 // Walk the hljs output, break at newlines, re-open the span stack on each new line.
 const out=[];let stack=[],cur='';const re=/<span class="([^"]*)">|<\/span>|\n|[^<\n]+|</g;let m;
 while((m=re.exec(htmlStr))!==null){const tok=m[0];
  if(tok==='\n'){out.push(cur+'</span>'.repeat(stack.length));cur=stack.map(c=>`<span class="${c}">`).join('');}
  else if(tok.startsWith('<span')){stack.push(m[1]);cur+=tok;}
  else if(tok==='</span>'){stack.pop();cur+=tok;}
  else cur+=tok;}
 out.push(cur+'</span>'.repeat(stack.length));return out;}
async function highlightedLines(path,side){
 const key=side+':'+path+':'+digest;if(hlCache[key])return hlCache[key];
 let text='';try{text=await (await fetch('./file?path='+encodeURIComponent(path)+'&side='+side)).text();}catch(e){}
 rawCache[key]=text.split('\n');
 const lang=langFor(path);let lines;
 if(lang&&hljs.getLanguage(lang)){try{lines=splitHighlighted(hljs.highlight(text,{language:lang,ignoreIllegals:true}).value);}catch(e){lines=null;}}
 if(!lines)lines=text.split('\n').map(esc);
 hlCache[key]=lines;return lines;}

/* ---------- render ---------- */
/* Which files are open is kept across reloads of the diff. The first look opens the files with open notes. */
let openFiles=null;
function initialOpen(){const noted=new Set(notes.filter(a=>a.status!=='addressed'&&a.file).map(a=>a.file));
 const open=new Set(model.files.map(f=>f.path).filter(p=>noted.has(p)));if(!open.size&&model.files.length)open.add(model.files[0].path);return open;}
/* Viewed is remembered per file and version: a file that changes again comes back unviewed, as on GitHub. */
function fileStamp(f){let h=0;const t=JSON.stringify(f.hunks);for(let i=0;i<t.length;i++)h=(h*31+t.charCodeAt(i))|0;return String(h);}
function viewedMap(){try{return JSON.parse(localStorage.getItem('ra-viewed:'+model.repo)||'{}');}catch(e){return {};}}
const isSeen=f=>viewedMap()[f.path]===fileStamp(f);
function setViewed(path,on){const m=viewedMap(),f=model.files.find(x=>x.path===path);if(on&&f)m[path]=fileStamp(f);else delete m[path];try{localStorage.setItem('ra-viewed:'+model.repo,JSON.stringify(m));}catch(e){}}
function applyOpen(){if(!model)return;
 for(const sec of document.querySelectorAll('section.file')){const f=model.files.find(x=>x.path===sec.dataset.path);if(!f)continue;
  sec.classList.toggle('collapsed',!openFiles.has(f.path));const seen=isSeen(f);sec.classList.toggle('seen',seen);
  const v=sec.querySelector('.viewed');if(v){v.classList.toggle('on',seen);v.title=seen?'Viewed · click to unmark':'Mark as viewed; it closes, and comes back if the file changes';}}
 const all=model.files.length>0&&openFiles.size>=model.files.length,t=$('#toggleall');
 t.innerHTML=all?ICONS.collapse:ICONS.expand;t.title=(all?'Collapse every file':'Expand every file')+' · Alt-click a file does the same';
 decoratePins();}
function setAllOpen(open){openFiles=new Set(open?model.files.map(f=>f.path):[]);applyOpen();}
$('#togglethreads').onclick=()=>{const boxes=[...document.querySelectorAll('#main .thread-box')];setFolded(boxes.map(b=>+b.dataset.id),!boxes.every(b=>b.classList.contains('folded')));};
$('#toggleall').onclick=()=>setAllOpen(!(openFiles.size>=model.files.length));
document.addEventListener('click',e=>{
 const v=e.target.closest('[data-viewed]');
 if(v){e.stopPropagation();const on=!v.classList.contains('on');setViewed(v.dataset.viewed,on);if(on)openFiles.delete(v.dataset.viewed);applyOpen();return;}
 const h=e.target.closest('section.file>header');if(!h||e.target.closest('[data-filenote]'))return;
 const path=h.closest('section.file').dataset.path;
 if(e.altKey)setAllOpen(!(openFiles.size>=model.files.length));
 else{openFiles.has(path)?openFiles.delete(path):openFiles.add(path);applyOpen();}
},true);
/* ---------- tabs ---------- */
function setTab(t){document.body.classList.toggle('tab-notes',t==='notes');$('#tab-changes').setAttribute('aria-selected',String(t!=='notes'));$('#tab-notes').setAttribute('aria-selected',String(t==='notes'));if(t==='notes')markGhSeen();}
$('#tab-changes').onclick=()=>setTab('changes');$('#tab-notes').onclick=()=>setTab('notes');
for(const b of document.querySelectorAll('#viewseg button'))b.onclick=async()=>{if(view===b.dataset.view)return;view=b.dataset.view;localStorage.setItem('ra-view',view);await render();renderNotes();};
function fileAnchor(p){return 'f-'+p.replace(/[^a-zA-Z0-9]/g,'_');}
function statusBadge(f){return f.untracked?'U':{added:'A',deleted:'D',renamed:'R',modified:'M'}[f.status]||'M';}
/* Untracked files are new files git has not been told about: often the agent's new work, sometimes local setup that
   was never meant for the branch. They sit last under their own heading and can be put away. */
const untrackedKey=()=>'ra-untracked:'+model.repo;
const untrackedHidden=()=>{try{return localStorage.getItem(untrackedKey())==='hide';}catch(e){return false;}};
function untrackedHead(n,hidden){return `<div class="untracked-head"><b>${n} untracked file${n===1?'':'s'}${hidden?' hidden':''}</b><span>New files git is not tracking, so not on the branch or in its pull request.</span><button type="button" id="untracked-toggle">${hidden?'Show':'Hide'}</button></div>`;}
document.addEventListener('click',async e=>{if(!e.target.closest('#untracked-toggle'))return;
 try{untrackedHidden()?localStorage.removeItem(untrackedKey()):localStorage.setItem(untrackedKey(),'hide');}catch(err){}
 await render();renderNotes();});
const branchPop=document.createElement('div');branchPop.id='branch-pop';branchPop.setAttribute('role','tooltip');branchPop.hidden=true;document.body.append(branchPop);
let branchPopTimer=0;
function showBranchPop(){if(!model)return;clearTimeout(branchPopTimer);const r=$('#branch').getBoundingClientRect();
 branchPop.innerHTML=`<code>${esc(model.branch)}</code><button type="button" class="ib" id="branch-copy" title="Copy branch name" aria-label="Copy branch name"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5c0-.8-.7-1.5-1.5-1.5H4c-.8 0-1.5.7-1.5 1.5v5c0 .8.7 1.5 1.5 1.5h.5"/></svg></button>${model.checked_out===false?'<small>not checked out here</small>':''}`;
 branchPop.hidden=false;const w=branchPop.offsetWidth;branchPop.style.left=Math.max(6,Math.min(r.left,innerWidth-w-6))+'px';branchPop.style.top=(r.top-branchPop.offsetHeight-6>4?r.top-branchPop.offsetHeight-6:r.bottom+6)+'px';
 $('#branch-copy').onclick=async()=>{try{await navigator.clipboard.writeText(model.branch);toast('Copied '+model.branch);}catch(e){toast('Could not copy the branch name');}};}
function hideBranchPop(){clearTimeout(branchPopTimer);branchPopTimer=setTimeout(()=>{branchPop.hidden=true;},150);}
$('#branch').addEventListener('mouseenter',showBranchPop);$('#branch').addEventListener('mouseleave',hideBranchPop);
branchPop.addEventListener('mouseenter',()=>clearTimeout(branchPopTimer));branchPop.addEventListener('mouseleave',hideBranchPop);
async function render(){
 parkComposer();const main=$('#main');
 $('#meta').innerHTML=`<b>${esc(model.branch)}</b><span class="base">${esc(model.checked_out===false?' · not checked out here':` · vs ${model.base==='HEAD'?'HEAD (working tree)':model.base_name||model.base.slice(0,10)}`)}</span>`;
 $('#meta').classList.toggle('away',model.checked_out===false);{const b=$('#meta b');b.style.minWidth='';b.style.minWidth=Math.min(b.scrollWidth,48)+'px';}
 $('#stats').innerHTML=`<span class="stat-add">+${model.additions}</span> <span class="stat-del">−${model.deletions}</span>`;
 $('#nfiles').textContent=model.files.length;
 for(const b of document.querySelectorAll('#viewseg button'))b.setAttribute('aria-pressed',String(b.dataset.view===view));
 if(!openFiles)openFiles=initialOpen();
 if(!model.files.length){main.innerHTML='<section id="prdraft" hidden></section><div class="empty">No changes against '+esc(model.base)+'. Edit something and this page reloads on its own.</div>';renderPrDraft();applyOpen();return;}
 const parts=[];const only=PARAMS.get('file');
 const loose=model.files.filter(f=>f.untracked).length,hideLoose=loose>0&&untrackedHidden();let headed=false;
 for(const f of model.files){if(only&&!f.path.includes(only))continue;
  if(f.untracked&&!headed){headed=true;parts.push(untrackedHead(loose,hideLoose));}
  if(f.untracked&&hideLoose)continue;
  const hlNew=f.binary||f.status==='deleted'?[]:await highlightedLines(f.path,'new');
  const hlOld=f.binary||f.status==='added'?[]:await highlightedLines(f.old_path||f.path,'old');
  const dir=f.path.includes('/')?f.path.slice(0,f.path.lastIndexOf('/')+1):'';const base=f.path.slice(dir.length);
  let body='';
  if(f.binary)body='<div class="binary">Binary file not shown</div>';
  else body=view==='split'?renderSplit(f,hlOld,hlNew):renderUnified(f,hlOld,hlNew);
  parts.push(`<section class="file" id="${fileAnchor(f.path)}" data-path="${esc(f.path)}"><header title="${esc(f.path)} · click to open or close · Alt-click for every file">${ICONS.chev}${ICONS.file}<span class="path">${esc(base)}<span class="dir">${esc(dir.replace(/\/$/,''))}</span></span><span class="sp"></span><span class="end"><span class="cntslot"></span><span class="lines"><span class="stat-add">+${f.additions}</span> <span class="stat-del">−${f.deletions}</span></span>${bars(f.additions,f.deletions)}<span class="st ${statusBadge(f)}" title="${f.untracked?'untracked: a new file git is not tracking yet':f.status}${f.status==='renamed'?' from '+esc(f.old_path):''}">${statusBadge(f)}</span>${f.kind==='file'?'':`<button class="ib" data-filenote="${esc(f.path)}" title="Note on this file">${ICONS.note}</button>`}<button class="viewed" data-viewed="${esc(f.path)}">${ICONS.check}<span>Viewed</span></button></span></header><div class="body">${body}</div></section>`);
 }
 main.innerHTML='<section id="prdraft" hidden></section>'+parts.join('');
 renderPrDraft();
 decorateThreads();
 applyOpen();
}
function codeHtml(line,hlOld,hlNew){
 const src=line.t==='-'?hlOld:hlNew;const n=line.t==='-'?line.old:line.new;
 const h=src&&src[n-1]!==undefined?src[n-1]:esc(line.text);return h===''?'&nbsp;':h;}
let runSeq=0;
function tagRuns(lines){
 // A "run" is a contiguous stretch of changed lines: the chunk a ¶ handle comments on.
 let cur=null;for(const l of lines){if(l.t===' '){cur=null;l.run=null;continue;}if(cur===null)cur=++runSeq;l.run=cur;}}
/* Hidden unchanged lines between hunks, revealed on request as GitHub does. */
function hunkRange(h){const m=/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h.header)||[];
 const os=+m[1]||0,oc=m[2]===undefined?1:+m[2],ns=+m[3]||0,nc=m[4]===undefined?1:+m[4];return {oe:os+oc-1,ns,ne:ns+nc-1};}
function fileGaps(f){
 if(f.binary||f.status==='added'||f.status==='deleted'||!f.hunks.length)return null;
 const raw=rawCache['new:'+f.path+':'+digest]||[];const total=raw.length&&raw[raw.length-1]===''?raw.length-1:raw.length;
 const out=[];let po=0,pn=0;
 for(const h of f.hunks){const r=hunkRange(h);out.push({o:po+1,n:pn+1,len:Math.max(0,r.ns-pn-1),top:pn>0});po=r.oe;pn=r.ne;}
 out.push({o:po+1,n:pn+1,len:Math.max(0,total-pn),top:true,tail:true});return out;}
function gapState(f,gi){return (expandState[f.path]||{})[gi]||{a:0,b:0};}
function gapLines(f,g,from,count){const raw=rawCache['new:'+f.path+':'+digest]||[];const out=[];
 for(let k=from;k<from+count&&k<g.len;k++)out.push({t:' ',old:g.o+k,new:g.n+k,text:raw[g.n+k-1]??'',run:null});return out;}
function gapParts(f,gaps,gi){const g=gaps&&gaps[gi];if(!g||!g.len)return {top:[],bottom:[],exp:''};
 const st=gapState(f,gi),a=Math.min(st.a,g.len),b=Math.min(st.b,g.len-a),left=g.len-a-b;
 const btn=(d,label,title)=>`<button type="button" class="exp" data-path="${esc(f.path)}" data-gap="${gi}" data-dir="${d}" title="${title}">${label}</button>`;
 const step=20;let exp='';
 if(left>0)exp=left<=step?btn('all','↕',`Show ${left} hidden line${left>1?'s':''}`)
  :(g.top?btn('down','↓',`Show ${step} more lines below`):'')+(g.tail?'':btn('up','↑',`Show ${step} more lines above`))+btn('all','↕',`Show all ${left} hidden lines`);
 if(a+b>0)exp+=btn('collapse','⤒',`Hide the ${a+b} expanded line${a+b>1?'s':''} again`);
 return {top:gapLines(f,g,0,a),bottom:gapLines(f,g,g.len-b,b),exp,left};}
function lineRow(l,first,hlOld,hlNew){const cls=l.t==='+'?'add':l.t==='-'?'del':'ctx';const side=l.t==='-'?'old':'new';const n=l.t==='-'?l.old:l.new;
 return `<tr class="${cls}" data-side="${side}" data-n="${n}"${l.run!==null?` data-run="${l.run}"`:''}><td class="chunk">${first?`<span class="para" title="comment on this chunk">¶</span>`:''}</td><td class="num old ${l.t==='-'?'click':''}" data-side="old" data-n="${l.old||''}">${l.old||''}${l.t==='-'?'<span class="plus">+</span>':''}</td><td class="num new ${l.t!=='-'?'click':''}" data-side="new" data-n="${l.new||''}">${l.new||''}${l.t!=='-'?'<span class="plus">+</span>':''}</td><td class="code"><span class="sign">${l.t===' '?'':l.t}</span>${codeHtml(l,hlOld,hlNew)}</td></tr>`;}
function tailRows(f,gaps,row){const p=gapParts(f,gaps,f.hunks.length);const rows=p.top.map(row);
 if(p.exp)rows.push(`<tr class="expander"><td colspan="4">${p.exp}${p.left?`<span class="exp-n">${p.left} more line${p.left>1?'s':''}</span>`:''}</td></tr>`);return rows;}
function renderUnified(f,hlOld,hlNew){
 let rows=[];const gaps=fileGaps(f);const ctx=l=>lineRow(l,false,hlOld,hlNew);
 for(const [hi,h] of f.hunks.entries()){tagRuns(h.lines);const p=gapParts(f,gaps,hi);
  rows.push(...p.top.map(ctx));
  rows.push(`<tr class="hunk" data-hunk="${hi}"><td colspan="4">${p.exp}${esc(h.header)}</td></tr>`);
  rows.push(...p.bottom.map(ctx));
  let prevRun=null;
  for(const l of h.lines){
   const first=l.run!==null&&l.run!==prevRun;prevRun=l.run;
   rows.push(lineRow(l,first,hlOld,hlNew));}}
 rows.push(...tailRows(f,gaps,ctx));
 return `<table class="diff unified">${rows.join('')}</table>`;}
function renderSplit(f,hlOld,hlNew){
 let rows=[];const gaps=fileGaps(f);const ctx=l=>pairRow(l,l,hlOld,hlNew);
 for(const [hi,h] of f.hunks.entries()){const p=gapParts(f,gaps,hi);rows.push(...p.top.map(ctx));
  rows.push(`<tr class="hunk"><td colspan="4">${p.exp}${esc(h.header)}</td></tr>`);rows.push(...p.bottom.map(ctx));
  const lines=h.lines;let i=0;
  while(i<lines.length){const l=lines[i];
   if(l.t===' '){rows.push(pairRow(l,l,hlOld,hlNew));i++;continue;}
   const dels=[],adds=[];while(i<lines.length&&lines[i].t==='-'){dels.push(lines[i]);i++;}
   while(i<lines.length&&lines[i].t==='+'){adds.push(lines[i]);i++;}
   const n=Math.max(dels.length,adds.length);
   for(let k=0;k<n;k++)rows.push(pairRow(dels[k]||null,adds[k]||null,hlOld,hlNew));}}
 rows.push(...tailRows(f,gaps,ctx));
 return `<table class="diff split">${rows.join('')}</table>`;}
document.addEventListener('click',async e=>{const b=e.target.closest('button.exp');if(!b)return;e.stopPropagation();e.preventDefault();
 const per=expandState[b.dataset.path]||(expandState[b.dataset.path]={});const gi=+b.dataset.gap;const st=per[gi]||(per[gi]={a:0,b:0});
 if(b.dataset.dir==='down')st.a+=20;else if(b.dataset.dir==='up')st.b+=20;else if(b.dataset.dir==='collapse'){st.a=0;st.b=0;}else st.a=1e9;
 const y=b.getBoundingClientRect().top;await render();renderNotes();
 const again=document.querySelector(`button.exp[data-path="${CSS.escape(b.dataset.path)}"][data-gap="${gi}"]`);if(again)scrollBy(0,again.getBoundingClientRect().top-y);},true);
function pairRow(o,n,hlOld,hlNew){
 const left=o?`<td class="num old click l" data-side="old" data-n="${o.old}">${o.old}<span class="plus">+</span></td><td class="code l ${o.t==='-'?'d':''}">${codeHtml(o.t==='-'?o:{...o,t:'-'},hlOld,hlNew)}</td>`:`<td class="num empty"></td><td class="code empty"></td>`;
 const right=n?`<td class="num new click" data-side="new" data-n="${n.new}">${n.new}<span class="plus">+</span></td><td class="code">${codeHtml(n.t==='+'?n:{...n,t:'+'},hlOld,hlNew)}</td>`:`<td class="num empty"></td><td class="code empty"></td>`;
 const cls=o&&o.t==='-'&&n&&n.t==='+'?'pair chg':o&&o.t==='-'?'pair del':n&&n.t==='+'?'pair add':'pair ctx';
 return `<tr class="${cls}" data-side="${n?'new':'old'}" data-n="${n?n.new:o.old}">${left}${right}</tr>`;}

/* ---------- threads (inline comments) ---------- */
function proofHtml(a){const p=a.status==='addressed'&&a.proof;if(!p)return '';
 return `<div class="proof"><div class="ph">Checked by ${esc(p.author||'Agent')} <span class="at">${esc((p.at||'').slice(5,16))}</span></div><pre>${esc(p.text||'')}</pre>${p.file?`<a href="./proof/${encodeURIComponent(p.file)}" target="_blank" rel="noopener"><img src="./proof/${encodeURIComponent(p.file)}" alt="Screenshot ${esc(p.author||'Agent')} attached as proof"></a>`:''}</div>`;}
const AGENTS=['Codex','Claude','Grok','OpenCode','Pi'];
function when(at){if(!at)return '';const d=new Date(String(at).replace(' ','T'));return isNaN(d)?String(at):d.toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}
function avatarHtml(name){const n=String(name||'?'),agent=AGENTS.includes(n),hue=[...n].reduce((h,c)=>(h*31+c.charCodeAt(0))%360,7);
 return `<span class="av${agent?' '+n.toLowerCase():''}"${agent?'':` style="--h:${hue}"`} aria-hidden="true">${esc((n.trim()[0]||'?').toUpperCase())}</span>`;}
function commentHtml(author,at,body,extra,url){const name=author||USER;
 return `<div class="cm">${avatarHtml(name)}<div class="cb"><div class="ch"><span class="an">${esc(name)}</span>${AGENTS.includes(name)?'<span class="bot">agent</span>':''}${at?`<span class="at">${esc(when(at))}</span>`:''}${url?`<a class="gh" href="${esc(url)}" target="_blank" rel="noopener">on GitHub</a>`:''}</div><div class="ct">${body}</div>${extra||''}</div></div>`;}
function repliesHtml(a){return (a.replies||[]).map(r=>commentHtml(r.author,r.at,esc(r.text))).join('');}
function threadHtml(a){
 const done=a.status==='addressed';let sug='';
 if(a.suggestion!==null&&a.suggestion!==undefined){
  const oldL=(a.quote||'').split('\n'),newL=a.suggestion===''?[]:a.suggestion.split('\n');
  sug=`<div class="sug"><div class="sh">Suggested change</div><pre>${oldL.map(x=>`<div class="l d">${esc(x)||' '}</div>`).join('')}${newL.map(x=>`<div class="l a">${esc(x)||' '}</div>`).join('')}</pre></div>`;}
 const tag=a.kind==='pr'?`<span class="id">PR ${esc(a.part||'body')}${a.quote?` · “${esc(a.quote.length>60?a.quote.slice(0,60)+'…':a.quote)}”`:''}</span>`:a.kind==='chunk'?`<span class="id">chunk · ${esc(a.label||'')}</span>`:a.kind==='selection'?`<span class="id">“${esc(a.selection||'')}”</span>`:'';
 return `<div class="thread-box ${done?'done':''}${isFolded(a)?' folded':''}" data-id="${a.id}"><div class="th" role="button" tabindex="0" aria-expanded="${!isFolded(a)}" title="Click to collapse or expand">${ICONS.chev.replace('class="i chev"','class="i tchev"')}${a.file?`<span class="loc">${esc(a.file)}${a.start?(a.end&&a.end!==a.start?` · lines ${a.start}–${a.end}`:` · line ${a.start}`):''}</span>`:''}<span class="id">#${a.id}</span>${tag}${foldSummary(a)}</div>${commentHtml(a.author,a.created,esc(a.comment||'')||'<i>(no comment)</i>',sug,a.gh_url)}${repliesHtml(a)}${proofHtml(a)}<div class="replybox"><input data-reply="${a.id}" placeholder="Reply…"></div></div>`;}
function foldMap(){try{return JSON.parse(localStorage.getItem('ra-threads:'+(model?model.repo:''))||'{}');}catch(e){return {};}}
function saveFolds(m){try{localStorage.setItem('ra-threads:'+(model?model.repo:''),JSON.stringify(m));}catch(e){}}
function isFolded(a,m){m=m||foldMap();return a.id in m?!!m[a.id]:a.status==='addressed';}
function setFolded(ids,on){const m=foldMap();for(const id of ids)m[id]=on;saveFolds(m);
 for(const id of ids)document.querySelectorAll(`.thread-box[data-id="${id}"]`).forEach(b=>{b.classList.toggle('folded',on);b.querySelector('.th').setAttribute('aria-expanded',String(!on));});updateThreadToggle();}
function updateThreadToggle(){const t=$('#togglethreads');if(!t)return;const boxes=[...document.querySelectorAll('#main .thread-box')];t.hidden=!boxes.length;
 const all=boxes.length&&boxes.every(b=>b.classList.contains('folded'));t.innerHTML=all?ICONS.unfoldthreads:ICONS.foldthreads;t.title=all?'Expand every comment':'Collapse every comment';t.setAttribute('aria-label',t.title);}
function foldSummary(a){const r=a.replies||[];const first=(a.comment||'').split('\n')[0];
 return `<span class="sum">${avatarHtml(a.author||USER)}<span class="st"><b>${esc(a.author||USER)}</b> ${esc(first)}</span>${r.length?`<span class="nr">${r.length} repl${r.length>1?'ies':'y'}</span>`:''}</span>`;}
document.addEventListener('click',e=>{const th=e.target.closest('.thread-box .th');if(!th||e.target.closest('a,button,input'))return;
 const box=th.closest('.thread-box');setFolded([+box.dataset.id],!box.classList.contains('folded'));});
document.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const th=e.target.closest&&e.target.closest('.thread-box .th');if(!th||e.target!==th)return;
 e.preventDefault();const box=th.closest('.thread-box');setFolded([+box.dataset.id],!box.classList.contains('folded'));});
function decorateThreads(){
 const drafts={};document.querySelectorAll('tr.thread input[data-reply]').forEach(i=>{if(i.value)drafts[i.dataset.reply]=i.value;});
 const focused=document.activeElement&&document.activeElement.closest&&document.activeElement.closest('tr.thread input[data-reply]')?document.activeElement.dataset.reply:null;
 document.querySelectorAll('tr.thread').forEach(r=>r.remove());
 document.querySelectorAll('tr.commented').forEach(r=>r.classList.remove('commented'));
 for(const a of notes){if(!['line','chunk','selection'].includes(a.kind))continue;
  const sec=document.getElementById(fileAnchor(a.file));if(!sec)continue;
  const rows=[...sec.querySelectorAll('tr[data-side]')];
  const side=a.side||'new';const end=a.end||a.start;
  let last=null;for(const r of rows){const n=+r.dataset.n;const s=r.dataset.side;
   const hit=view==='split'?rowCovers(r,side,a.start,end):(s===side&&n>=a.start&&n<=end);
   if(hit){r.classList.add('commented');last=r;}}
  if(!last)continue;const tr=document.createElement('tr');tr.className='thread';
  tr.innerHTML=`<td colspan="${view==='split'?4:4}">${threadHtml(a)}</td>`;last.after(tr);
  const inp=tr.querySelector('input[data-reply]');if(drafts[a.id])inp.value=drafts[a.id];if(focused===String(a.id))inp.focus();}
 if(composing){markSel();placeComposer();}
 updateThreadToggle();decoratePins();}
function decoratePins(){
 document.querySelectorAll('.pin').forEach(p=>p.remove());
 for(const a of notes){if(a.kind!=='pin')continue;const sec=document.getElementById(fileAnchor(a.file));if(!sec)continue;
  const el=document.createElement('div');el.className='pin'+(a.status==='addressed'?' done':'');el.textContent=a.id;el.title=a.comment||'';
  el.style.left=(a.relX*sec.clientWidth)+'px';el.style.top=(a.relY*sec.clientHeight)+'px';el.dataset.jump=a.id;sec.appendChild(el);}}
function rowCovers(r,side,start,end){const cell=r.querySelector(`td.num.${side}`);if(!cell||!cell.dataset.n)return false;const n=+cell.dataset.n;return n>=start&&n<=end;}

/* ---------- line selection + composer ---------- */
function rowOf(el){return el.closest('tr[data-side]');}
function rowsIn(sec){return [...sec.querySelectorAll('tr[data-side]')];}
function rangeOfRows(rows,side){const ns=rows.map(r=>{const c=r.querySelector(`td.num.${side}`);return c&&c.dataset.n?+c.dataset.n:null;}).filter(n=>n!==null);return ns.length?{start:Math.min(...ns),end:Math.max(...ns)}:null;}
function selectRows(file,side,start,end,kind,anchor,extra){sel={file,side,start,end};markSel();openComposer(kind||'line',{...sel,...(extra||{})},anchor);}
/* drag along the line-number gutter to select a range (like GitHub's press-and-drag) */
let drag=null, suppressClick=false;
function cellFor(row,side){const c=row.querySelector(`td.num.${side}`);return c&&c.dataset.n?c:null;}
document.addEventListener('mousedown',e=>{
 const num=e.target.closest('td.num.click');if(!num||e.button!==0)return;
 e.preventDefault();getSelection().removeAllRanges();document.body.classList.add('line-drag');const sec=num.closest('section.file');
 drag={file:sec.dataset.path,side:num.dataset.side,anchor:+num.dataset.n,start:+num.dataset.n,end:+num.dataset.n,el:num,moved:false,shift:e.shiftKey};
 if(!(e.shiftKey&&sel&&sel.file===drag.file&&sel.side===drag.side)){sel={file:drag.file,side:drag.side,start:drag.start,end:drag.end};markSel();}});
document.addEventListener('mousemove',e=>{
 if(!drag)return;const row=rowOf(e.target);if(!row||row.closest('section.file')?.dataset.path!==drag.file)return;
 const c=cellFor(row,drag.side);if(!c)return;const n=+c.dataset.n;if(n===drag.end&&n===drag.start)return;
 drag.moved=true;drag.start=Math.min(drag.anchor,n);drag.end=Math.max(drag.anchor,n);drag.el=c;
 sel={file:drag.file,side:drag.side,start:drag.start,end:drag.end};markSel();});
document.addEventListener('mouseup',e=>{
 if(!drag)return;const d=drag;drag=null;document.body.classList.remove('line-drag');getSelection().removeAllRanges();
 if(d.moved){suppressClick=true;setTimeout(()=>suppressClick=false,0);openComposer('line',{file:d.file,side:d.side,start:d.start,end:d.end},d.el,d.shift);}});
document.addEventListener('click',e=>{
 if(suppressClick){suppressClick=false;return;}
 if(e.target.closest('#composer,#side,#top,#tabs,#bar,#bubble,.thread-box'))return;
 const secEl=e.target.closest('section.file');
 const para=e.target.closest('td.chunk .para');
 if(para){const r=rowOf(para);const run=r.dataset.run;const rows=rowsIn(secEl).filter(x=>x.dataset.run===run);
  const hasNew=rows.some(x=>x.classList.contains('add'));const side=hasNew?'new':'old';const rg=rangeOfRows(rows,side);
  if(rg)selectRows(secEl.dataset.path,side,rg.start,rg.end,'chunk',para,{label:`${rows.length} changed line${rows.length===1?'':'s'}`});return;}
 const hunk=e.target.closest('tr.hunk');
 if(hunk){const hi=+hunk.dataset.hunk;const f=model.files.find(x=>x.path===secEl.dataset.path);const lines=f.hunks[hi].lines;
  const news=lines.filter(l=>l.new!==null&&l.new!==undefined&&l.t!=='-').map(l=>l.new);
  if(news.length)selectRows(secEl.dataset.path,'new',Math.min(...news),Math.max(...news),'chunk',hunk,{label:'whole hunk '+f.hunks[hi].header.split('@@')[1].trim()});return;}
 const num=e.target.closest('td.num.click');
 if(num){const side=num.dataset.side,n=+num.dataset.n;const file=secEl.dataset.path;
  if(e.shiftKey&&sel&&sel.file===file&&sel.side===side){sel.start=Math.min(sel.start,n);sel.end=Math.max(sel.end,n);}
  else sel={file,side,start:n,end:n};
  markSel();openComposer('line',sel,num,e.shiftKey);return;}
 const code=e.target.closest('td.code');
 if(code&&!window.getSelection().toString()){const r=rowOf(code);if(!r)return;const side=r.dataset.side,n=+r.dataset.n;const file=secEl.dataset.path;
  if(e.shiftKey&&sel&&sel.file===file&&sel.side===side){sel.start=Math.min(sel.start,n);sel.end=Math.max(sel.end,n);}
  else sel={file,side,start:n,end:n};
  markSel();openComposer('line',sel,code,e.shiftKey);return;}
 const fb=e.target.closest('[data-filenote]');
 if(fb){openComposer('file',{file:fb.dataset.filenote},fb);return;}
});
document.addEventListener('mouseover',e=>{const r=rowOf(e.target);document.querySelectorAll('tr.hot').forEach(x=>x.classList.remove('hot'));
 if(!r||!r.dataset.run)return;const sec=r.closest('section.file');rowsIn(sec).filter(x=>x.dataset.run===r.dataset.run).forEach(x=>x.classList.add('hot'));});
/* text selection -> bubble -> selection note */
document.addEventListener('mouseup',e=>{setTimeout(()=>{
 const s=window.getSelection();const text=s?s.toString().trim():'';const b=$('#bubble');
 if(!text||!s.rangeCount){b.style.display='none';return;}
 const rg=s.getRangeAt(0);const a=rg.startContainer.nodeType===1?rg.startContainer:rg.startContainer.parentElement;
 const z=rg.endContainer.nodeType===1?rg.endContainer:rg.endContainer.parentElement;
 const ra=a&&a.closest('td.code')?rowOf(a):null,rz=z&&z.closest('td.code')?rowOf(z):null;
 if(!ra||!rz||ra.closest('section.file')!==rz.closest('section.file')){b.style.display='none';return;}
 const rect=rg.getBoundingClientRect();b.style.left=(rect.left+scrollX)+'px';b.style.top=(rect.top+scrollY-34)+'px';b.style.display='block';
 const side=ra.dataset.side;const sec=ra.closest('section.file');const rows=rowsIn(sec);const i1=rows.indexOf(ra),i2=rows.indexOf(rz);
 const span=rows.slice(Math.min(i1,i2),Math.max(i1,i2)+1);const range=rangeOfRows(span,side)||rangeOfRows(span,side==='new'?'old':'new');
 b.onclick=()=>{b.style.display='none';if(!range)return;selectRows(sec.dataset.path,side,range.start,range.end,'selection',ra,{selection:text});window.getSelection().removeAllRanges();};
},0);});
function markSel(){document.querySelectorAll('tr.sel').forEach(r=>r.classList.remove('sel'));if(!sel)return;
 const sec=document.getElementById(fileAnchor(sel.file));if(!sec)return;
 for(const r of sec.querySelectorAll('tr[data-side]')){const cell=r.querySelector(`td.num.${sel.side}`);if(!cell||!cell.dataset.n)continue;const n=+cell.dataset.n;if(n>=sel.start&&n<=sel.end)r.classList.add('sel');}}
function quoteFor(s){const f=model.files.find(x=>x.path===s.file);if(!f)return '';const byN={};
 for(const h of f.hunks)for(const l of h.lines){const n=s.side==='old'?l.old:l.new;if(n===null||n===undefined)continue;
  if(s.side==='old'&&l.t==='+')continue;if(s.side==='new'&&l.t==='-')continue;if(n>=s.start&&n<=s.end)byN[n]=l.text;}
 // Expanded context lines are not in the diff; their text comes from the file.
 const raw=rawCache[s.side+':'+(s.side==='old'?(f.old_path||f.path):f.path)+':'+digest]||[];const out=[];
 for(let n=s.start;n<=s.end;n++){if(n in byN)out.push(byN[n]);else if(raw[n-1]!==undefined)out.push(raw[n-1]);}
 return out.join('\n');}
function parkComposer(){const c=$('#composer');if(c.parentElement!==document.body)document.body.appendChild(c);c.classList.remove('inline');document.querySelectorAll('tr.composer-row').forEach(r=>r.remove());}
function placeComposer(){
 const c=$('#composer');const sec=composing&&['line','chunk','selection'].includes(composing.kind)&&composing.start?document.getElementById(fileAnchor(composing.file)):null;
 const last=sec&&[...sec.querySelectorAll('tr.sel')].pop();if(!last){parkComposer();return false;}
 let at=last;while(at.nextElementSibling&&at.nextElementSibling.classList.contains('thread'))at=at.nextElementSibling;
 let row=c.closest('tr.composer-row');if(!row){row=document.createElement('tr');row.className='composer-row';row.innerHTML='<td colspan="4"></td>';}
 if(at.nextElementSibling!==row){const focused=c.contains(document.activeElement)?document.activeElement:null;row.firstElementChild.appendChild(c);at.after(row);if(focused)focused.focus({preventScroll:true});}
 c.classList.add('inline');c.style.top=c.style.left='';return true;}
function openComposer(kind,where,anchorEl,extending){
 const draft=extending&&composing&&composing.file===where.file&&composing.side===where.side?$('#ctext').value:'';
 composing={kind,...where};if(['line','chunk','selection','pin'].includes(kind)&&where.start)composing.quote=quoteFor(where);
 const lines=where.start?`line${where.start!==where.end?'s '+where.start+'–'+where.end:' '+where.start}${where.side==='old'?' (old side)':''}`:'';
 const head=kind==='pr'?`<b>PR ${esc(where.part)}</b>${where.selection?` · “${esc(where.selection.length>60?where.selection.slice(0,60)+'…':where.selection)}”`:''}`
  :kind==='general'?'<b>General note</b> on the whole change'
  :kind==='file'?`<b>${esc(where.file)}</b> · file-level`
  :kind==='chunk'?`<b>${esc(where.file)}</b> · chunk · ${esc(where.label||'')} · ${lines}`
  :kind==='selection'?`<b>${esc(where.file)}</b> · selection “${esc(where.selection.length>60?where.selection.slice(0,60)+'…':where.selection)}” · ${lines}`
  :kind==='pin'?`<b>${esc(where.file)}</b> · pin${lines?' near '+lines:''}`
  :`<b>${esc(where.file)}</b> · ${lines}<span style="margin-left:6px">shift-click or drag line numbers to extend</span>`;
 const c=$('#composer');$('#cwhere').innerHTML=head;
 $('#csug').style.display=['line','chunk','selection'].includes(kind)&&where.side==='new'?'':'none';
 $('#csugwrap').classList.remove('on');$('#csug').classList.remove('on');$('#csugtext').value=composing.quote||'';
 $('#ctext').value=draft;c.style.display='block';
 if(placeComposer()){$('#ctext').focus({preventScroll:true});c.scrollIntoView({block:'nearest'});return;}
 const r=anchorEl.getBoundingClientRect();let top=r.bottom+6,left=Math.min(r.left,innerWidth-540);
 if(top+260>innerHeight)top=Math.max(52,r.top-260);c.style.top=top+'px';c.style.left=Math.max(12,left)+'px';
 $('#ctext').focus();}
function closeComposer(){$('#composer').style.display='none';parkComposer();composing=null;sel=null;markSel();$('#bubble').style.display='none';}
$('#csug').onclick=()=>{$('#csugwrap').classList.toggle('on');$('#csug').classList.toggle('on');if($('#csugwrap').classList.contains('on'))$('#csugtext').focus();};
$('#ccancel').onclick=closeComposer;
$('#csave').onclick=saveComposer;
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'&&composing){closeComposer();return;}
 if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&composing){saveComposer();return;}
 if(e.target.tagName==='TEXTAREA'||e.target.tagName==='INPUT')return;
 if(e.key==='g'||e.key==='G'){openComposer('general',{},$('#general'));}
});
$('#general').onclick=()=>openComposer('general',{},$('#general'));
async function saveComposer(){
 if(!composing)return;const comment=$('#ctext').value.trim();const withSug=$('#csugwrap').classList.contains('on');
 const suggestion=withSug?$('#csugtext').value.replace(/\n$/,''):null;
 if(!comment&&suggestion===null){toast('write a comment or a suggestion');return;}
 const body={...composing,comment,suggestion};
 await fetch('./annotate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 closeComposer();await refresh(true);toast('comment added');}

/* ---------- sidebar ---------- */
let submittingFeedback=false;
let noteFilter='all';
const FILTERS=[['all','All',a=>true],['open','Open',a=>a.status!=='addressed'],['done','Addressed',a=>a.status==='addressed'],['gh','GitHub',a=>!!a.gh_id]];
function renderNotes(){
 const open=notes.filter(a=>a.status!=='addressed');
 $('#cnt').textContent='Notes';
 $('#send').disabled=submittingFeedback||!open.length;
 $('#nopen').textContent=open.length?`${open.length} open`:'';$('#nopen').classList.toggle('amb',open.length>0);
 for(const sec of document.querySelectorAll('section.file')){const n=open.filter(a=>a.file===sec.dataset.path).length,slot=sec.querySelector('.cntslot');
  if(slot)slot.innerHTML=n?`<span class="cnt" title="${n} open note${n===1?'':'s'}">${ICONS.note}${n}</span>`:'';}
 if(!FILTERS.some(([k])=>k===noteFilter))noteFilter='all';
 $('#filters').innerHTML=notes.length?FILTERS.map(([k,l,f])=>{const c=notes.filter(f).length;return k!=='all'&&!c?'':`<button data-filter="${k}" aria-pressed="${noteFilter===k}">${l} ${c}</button>`;}).join(''):'';
 const keep=FILTERS.find(([k])=>k===noteFilter)[2];
 $('#notes').innerHTML=notes.filter(keep).map(a=>{const done=a.status==='addressed';
  const where=a.kind==='pr'?`PR ${a.part||'body'}`:a.kind==='general'?'whole change':a.kind==='file'?a.file:a.kind==='pin'&&!a.start?`${a.file} (pin)`:`${a.file}:${a.start}${a.end&&a.end!==a.start?'-'+a.end:''}${a.side==='old'?' (old)':''}`;
  const who=a.author&&a.author!==USER?`<span class="k ${a.author.toLowerCase()}">${esc(a.author)}</span>`:'';
  return `<div class="note ${done?'done':''}" data-id="${a.id}"><div class="nh" data-jump="${a.id}">${who}<span class="k">${a.kind}${a.suggestion!==null&&a.suggestion!==undefined?' ±':''}</span><span class="w" title="${esc(where)}">${esc(where)}</span><span class="k">#${a.id}</span></div>${a.kind==='selection'&&a.selection?`<div class="nq">“${esc(a.selection)}”</div>`:a.quote?`<div class="nq">${esc(a.quote)}</div>`:''}<textarea data-edit="${a.id}" placeholder="comment">${esc(a.comment||'')}</textarea>${a.suggestion!==null&&a.suggestion!==undefined?`<div class="ns">suggestion: ${a.suggestion===''?'delete these lines':esc(a.suggestion.split('\n').length+' line(s)')}</div>`:''}${repliesHtml(a)}${proofHtml(a)}<div class="replybox"><input data-reply="${a.id}" placeholder="reply…"></div><div class="nf">${done?`<button class="btn" data-act="reopen" data-id="${a.id}">reopen</button>`:`<button class="btn" data-act="resolve" data-id="${a.id}">done</button>`}<button class="btn danger" data-act="delete" data-id="${a.id}">delete</button></div></div>`;}).join('')||'<div style="color:var(--fg-muted);font-size:12px">Click a line number to start. Shift-click to extend the range. ± adds a suggested replacement.</div>';
 const s=model&&model.submission;$('#sent').textContent=s&&s.n?`Feedback submitted · submission ${s.n} · ${s.at}`:'Feedback not submitted';
 const rr=(model&&model.round_replies)||[];const showAll=window._rrOpen;const shown=showAll?rr:rr.slice(-1);
 $('#roundreplies').innerHTML=shown.map(r=>`<div class="reply ${showAll?'open':''}" title="click to expand"><span class="who ${r.author==='Claude'?'claude':r.author==='Codex'?'codex':''}">${esc(r.author)}</span><span class="txt">${esc(r.text)}</span><span class="at">${esc((r.at||'').slice(5,16))}</span></div>`).join('')
  +(rr.length>1?`<button class="more" id="rrmore">${showAll?'show latest only':`${rr.length-1} earlier round repl${rr.length-1===1?'y':'ies'}`}</button>`:'');
 const m=$('#rrmore');if(m)m.onclick=()=>{window._rrOpen=!window._rrOpen;renderNotes();};
 $('#roundreplies').querySelectorAll('.reply').forEach(el=>el.onclick=e=>{if(e.target.closest('.more'))return;el.classList.toggle('open');});}
document.addEventListener('keydown',async e=>{const inp=e.target.closest&&e.target.closest('input[data-reply]');if(!inp||e.key!=='Enter')return;const text=inp.value.trim();if(!text)return;
 await fetch('./reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:+inp.dataset.reply,author:USER,text})});inp.value='';await refresh(true);toast('reply added');});
$('#notes').addEventListener('input',e=>{const id=e.target.dataset.edit;if(!id)return;clearTimeout(e.target._t);
 e.target._t=setTimeout(()=>fetch('./update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:+id,comment:e.target.value})}),400);});
$('#filters').addEventListener('click',e=>{const b=e.target.closest('[data-filter]');if(!b)return;noteFilter=b.dataset.filter;if(noteFilter==='gh')markGhSeen();renderNotes();});
$('#notes').addEventListener('click',async e=>{
 const act=e.target.closest('[data-act]');
 if(act){await fetch('./'+act.dataset.act,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:+act.dataset.id})});await refresh(true);return;}
 const j=e.target.closest('[data-jump]');
 if(j){const a=notes.find(x=>x.id===+j.dataset.jump);if(!a)return;
  // A note opens its file and shows its thread, in Changes.
  if(a.file&&a.kind!=='pr'){openFiles.add(a.file);applyOpen();}setTab('changes');
  const sec=a.kind==='pr'?$('#prdraft'):a.file?document.getElementById(fileAnchor(a.file)):null;
  if(document.querySelector(`.thread-box.folded[data-id="${a.id}"]`))setFolded([a.id],false);
  const t=sec?(sec.querySelector(`.thread-box[data-id="${a.id}"],.pin[data-jump="${a.id}"]`)||sec):$('#main');t.scrollIntoView({behavior:'smooth',block:'center'});}});
document.addEventListener('click',e=>{const p=e.target.closest('.pin[data-jump]');if(p){const n=document.querySelector(`.note[data-id="${p.dataset.jump}"]`);if(n)n.scrollIntoView({behavior:'smooth',block:'center'});}});
$('#cleardone').onclick=async()=>{await fetch('./clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({which:'done'})});await refresh(true);toast('archived done notes');};
$('#clearall').onclick=async()=>{if(!confirm('Archive every note and start a new round?'))return;await fetch('./clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({which:'all'})});await refresh(true);toast('new round');};
$('#copy').onclick=async()=>{const t=await (await fetch('./dump')).text();try{await navigator.clipboard.writeText(t);toast('copied');}catch(e){prompt('copy:',t);}};
$('#send').onclick=async()=>{
 if(submittingFeedback)return;submittingFeedback=true;renderNotes();
 try{const response=await fetch('./submit',{method:'POST'});if(!response.ok)throw Error('Could not submit feedback');
 const r=await response.json();await refresh(true);toast(`Feedback saved (#${r.n}); agent receipt is not confirmed`);
 }catch(e){toast(`Feedback submission failed: ${e.message}`);}finally{submittingFeedback=false;renderNotes();}
};
$('#openpr').onclick=async e=>{const draft=!e.shiftKey;const open=notes.filter(a=>a.status!=='addressed').length;
 const ask=(open?`${open} note${open>1?'s are':' is'} still open. Approve anyway?\n\n`:'')+'Approve this change? The agent writes the PR title and description for you to review here before anything is pushed. It opens as a '+(draft?'DRAFT':'ready-for-review')+' PR.';
 if(!confirm(ask))return;
 const r=await (await fetch('./pr-request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft})})).json();
 toast('Approved — waiting for the agent to draft the PR description');await refresh(true);};
let prState={req:null,pr:null,draft:null};
function renderPrDraft(){const el=$('#prdraft');if(!el)return;const {req,pr,draft}=prState;
 if(!draft||(pr&&pr.url)){el.hidden=true;el.innerHTML='';return;}
 const opening=req&&req.stage==='open'&&req.rev===draft.rev;
 const prNotes=notes.filter(a=>a.kind==='pr');
 el.hidden=false;el.innerHTML=`<header><b>Pull request description</b><span class="rev">rev ${draft.rev} · ${esc((draft.at||'').slice(5,16))} · opens as ${req&&req.draft===false?'ready for review':'a draft'}</span><span class="sp"></span>
  <button class="btn small" id="pr-open" ${opening?'disabled':''}>${opening?'Opening…':'⇪ Approve description &amp; open PR'}</button></header>
  <div class="part" data-part="title"><small>Title</small><div class="prt">${esc(draft.title)}</div><button class="btn small cmt" data-pr-comment="title">Comment</button></div>
  <div class="part" data-part="body"><small>Description · select text to comment on it</small><div class="prb">${esc(draft.body)}</div><button class="btn small cmt" data-pr-comment="body">Comment</button></div>
  ${prNotes.length?`<div class="prnotes">${prNotes.map(threadHtml).join('')}</div>`:''}`;
 $('#pr-open').onclick=async()=>{const open=prNotes.filter(a=>a.status!=='addressed').length;
  if(!confirm((open?`${open} comment${open>1?'s are':' is'} on the description still open. Open the PR anyway?\n\n`:'')+`Open the PR with description rev ${draft.rev}? The agent commits, pushes and opens it with exactly this title and description.`))return;
  const r=await fetch('./pr-request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:!(req&&req.draft===false),stage:'open'})});
  if(!r.ok){toast((await r.json()).error||'could not approve the description');return;}toast('Description approved — the agent will open the PR');await refresh(true);};
 for(const b of el.querySelectorAll('[data-pr-comment]'))b.onclick=()=>openComposer('pr',{part:b.dataset.prComment},b);}
document.addEventListener('mouseup',e=>{const part=e.target.closest('#prdraft .part');if(!part||e.target.closest('button'))return;
 const text=String(getSelection()).trim();if(!text)return;openComposer('pr',{part:part.dataset.part,selection:text},part);});
/* GitHub comments come in on their own; the PR row says how many there are and how many are new since you looked. */
function ghSeen(){try{return new Set(JSON.parse(localStorage.getItem('ra-gh-seen:'+(model?model.repo:''))||'[]'));}catch(e){return new Set();}}
function markGhSeen(){if(!model)return;const seen=ghSeen();let changed=false;for(const a of notes)if(a.gh_id&&!seen.has(a.gh_id)){seen.add(a.gh_id);changed=true;}
 if(!changed)return;try{localStorage.setItem('ra-gh-seen:'+model.repo,JSON.stringify([...seen]));}catch(e){}renderPr(prState.req,prState.pr,prState.draft);}
// The terminal's pull requests come from the desk page that shows this review in a pane; the desk already
// watches them for its PR chip. Another one than the checked-out branch's is read from Git, not checked out.
let deskPrs=[],prView=null,repoSlugs=[],deskHidden=[];
const slugOf=url=>((/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url||'')||[])[1]||'').toLowerCase();
addEventListener('message',e=>{
 if(e.source!==parent||parent===window||e.data?.agentDesk!=='pull-requests'||!Array.isArray(e.data.prs))return;
 deskPrs=e.data.prs.filter(p=>p&&typeof p.url==='string'&&/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(p.url)).slice(0,20)
  .map(p=>({url:p.url,number:+p.url.split('/').pop(),title:String(p.title||'').slice(0,200),branch:String(p.branch||'').slice(0,200),comments:Number.isInteger(p.comments)?p.comments:0}));
 deskHidden=(Array.isArray(e.data.hidden)?e.data.hidden:[]).filter(u=>typeof u==='string').slice(0,200);
 if(prView&&deskHidden.includes(prView.url))selectPr(null);
 renderPr(prState.req,prState.pr,prState.draft);});
function prChoices(){const home=prState.pr&&prState.pr.url,list=deskPrs.filter(p=>repoSlugs.includes(slugOf(p.url)));
 if(home&&list.length&&!list.some(p=>p.url===home))list.unshift({url:home,number:+home.split('/').pop(),title:'',branch:'',comments:0});
 if(prView&&!list.some(p=>p.url===prView.url)&&!deskHidden.includes(prView.url))list.push({...prView,comments:0});return list;}
const prMenu=$('#pr-menu');
function closePrMenu(){prMenu.hidden=true;$('#prpick')?.setAttribute('aria-expanded','false');}
function openPrMenu(e){e.stopPropagation();if(!prMenu.hidden)return closePrMenu();
 const home=prState.pr&&prState.pr.url,current=(prView||prState.pr||{}).url;
 prMenu.innerHTML='<div class="mh">This terminal&#39;s pull requests</div>'+prChoices().map(p=>{const st=[p.url===home&&'checked out',p.comments&&`${p.comments} comment${p.comments===1?'':'s'}`].filter(Boolean).join(' · ');
  return `<button role="menuitemradio" aria-checked="${p.url===current}" data-url="${esc(p.url)}"><span class="ck">${p.url===current?ICONS.check:''}</span><span class="num">#${p.number}</span><span class="t">${esc(p.title||p.branch||'')}</span><span class="st${p.comments?' amb':''}">${esc(st)}</span></button>`;}).join('');
 const r=e.currentTarget.getBoundingClientRect();prMenu.hidden=false;e.currentTarget.setAttribute('aria-expanded','true');
 prMenu.style.top=(r.bottom+6)+'px';prMenu.style.left=Math.max(8,Math.min(r.right-prMenu.offsetWidth,innerWidth-prMenu.offsetWidth-8))+'px';
 prMenu.querySelector('[aria-checked=true]')?.focus();}
prMenu.onclick=e=>{const b=e.target.closest('button[data-url]');if(!b)return;e.stopPropagation();closePrMenu();selectPr(b.dataset.url===(prState.pr&&prState.pr.url)?null:b.dataset.url);};
document.addEventListener('click',e=>{if(!prMenu.hidden&&!prMenu.contains(e.target))closePrMenu();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!prMenu.hidden){closePrMenu();$('#prpick')?.focus();}});
async function selectPr(url){if(url===((prView&&prView.url)||null))return;
 toast(url?`Opening #${url.split('/').pop()}…`:'Back to the checked-out work');
 try{const r=await fetch('./pr-select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});const c=await r.json();if(!r.ok)throw Error(c.error||'failed');
  prView=c.view;await refresh(true);}
 catch(err){toast('Could not open that pull request: '+err.message.slice(0,120));}}
function hostOf(url){try{const h=new URL(url).hostname.toLowerCase();return /(^|\.)github\.com$/.test(h)?'GitHub':h.includes('gitlab')?'GitLab':h;}catch(e){return 'GitHub';}}
const hoverTip=document.createElement('div');hoverTip.id='hover-tip';hoverTip.setAttribute('role','tooltip');hoverTip.hidden=true;document.body.append(hoverTip);
document.addEventListener('mouseover',e=>{const b=e.target.closest('[data-tip]');if(!b||b.contains(e.relatedTarget))return;
 hoverTip.innerHTML=b.dataset.tip;hoverTip.hidden=false;const r=b.getBoundingClientRect(),w=hoverTip.offsetWidth;
 const h=hoverTip.offsetHeight;hoverTip.style.left=Math.max(6,Math.min(r.right-w,innerWidth-w-6))+'px';hoverTip.style.top=(r.bottom+6+h<innerHeight?r.bottom+6:Math.max(4,r.top-h-6))+'px';});
document.addEventListener('mouseout',e=>{const b=e.target.closest('[data-tip]');if(b&&!b.contains(e.relatedTarget))hoverTip.hidden=true;});
document.addEventListener('click',e=>{if(e.target.closest('[data-tip]'))hoverTip.hidden=true;},true);
function renderPr(req,branchPr,draft){const el=$('#prstate');if(!el)return;prState={req,pr:branchPr,draft};renderPrDraft();
 const pr=prView||branchPr,choices=prChoices();
 $('#openpr').hidden=!!(pr&&pr.url)||!!(req&&req.n);
 const gh=notes.filter(a=>a.gh_id),seen=ghSeen(),fresh=gh.filter(a=>!seen.has(a.gh_id));
 const key=JSON.stringify([req,pr,draft&&draft.rev,gh.length,fresh.length,choices.map(c=>c.url+':'+c.comments)]);if(el.dataset.key===key)return;el.dataset.key=key;
 const place=html=>{el.innerHTML=html;};
 const pick=choices.length>1?`<button class="prpick" id="prpick" aria-haspopup="menu" aria-expanded="false" title="Switch to another of this terminal's pull requests" aria-label="Switch pull request"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>`:'';
 if(pr&&pr.url){const m=/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr.url)||[];
  const label=pr.title?`<span class="prtitle">${esc(pr.title)}</span><span class="prnum">#${m[2]||''}</span>`:`<span class="prtitle">${m[1]?esc(m[1])+'#'+m[2]:esc(pr.url.replace(/^https?:\/\/(www\.)?/,''))}</span>`;
  const host=hostOf(pr.url),said=`${gh.length} ${host} comment${gh.length===1?'':'s'}`;
  const tip=`<b>${esc(host)} review comments</b><span>${gh.length} on this pull request${fresh.length?`, ${fresh.length} new`:''}</span><span>Click to sync from ${esc(host)} now. They also sync on their own every two minutes.</span>`;
  place(`${ICONS.pr}<a class="prlink" href="${esc(pr.url)}" target="_blank" rel="noopener" title="${esc((m[1]?m[1]+'#'+m[2]:pr.url)+(pr.title?' · '+pr.title:''))}">${label}</a>${pick}<span class="sp"></span>${fresh.length?`<button class="newc" id="newgh" title="Show the comments that came in from GitHub">${fresh.length} new</button>`:''}<button class="sync" id="pull-reviews" data-tip="${esc(tip)}" aria-label="${said}. Sync review comments from ${esc(host)}">${ICONS.note}<span class="ghc" aria-label="${said}">${gh.length}</span><svg class="i rf" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/></svg></button>`);
  $('#newgh')?.addEventListener('click',()=>{noteFilter='gh';setTab('notes');renderNotes();});
  $('#prpick')?.addEventListener('click',openPrMenu);
  $('#pull-reviews').onclick=async e=>{const b=e.currentTarget;b.disabled=true;
   try{const r=await fetch('./pull-reviews',{method:'POST'});const c=await r.json();if(!r.ok)throw Error(c.error||'failed');
    const parts=[c.comments&&`${c.comments} comment${c.comments>1?'s':''}`,c.replies&&`${c.replies} repl${c.replies>1?'ies':'y'}`,c.reviews&&`${c.reviews} review${c.reviews>1?'s':''}`,c.conversation&&`${c.conversation} conversation comment${c.conversation>1?'s':''}`].filter(Boolean);
    toast(parts.length?`Pulled ${parts.join(', ')} from ${hostOf(pr.url)}`:`Nothing new on ${hostOf(pr.url)}`);el.dataset.key='';await refresh(true);}
   catch(err){toast(`Could not check ${hostOf(pr.url)}: `+err.message.slice(0,120));b.disabled=false;}};return;}
 if(req&&req.n&&req.stage==='open'){place(`<span class="pending">Description rev ${req.rev} approved · waiting for the agent to open the PR…</span>`);return;}
 if(req&&req.n&&draft){place(`<button class="ready">PR description rev ${draft.rev} is ready to review</button>`);el.querySelector('.ready').onclick=()=>{setTab('changes');$('#prdraft').scrollIntoView({behavior:'smooth',block:'start'});};return;}
 if(req&&req.n){place(`<span class="pending">Approved · waiting for the agent to draft the PR description…</span>`);return;}
 place('<span class="pending">No pull request yet</span>');}
let reviewersRunning={},reviewerState={};
const opinionMenu=$('#opinion-menu');
function openOpinion(show){opinionMenu.hidden=!show;$('#codex').setAttribute('aria-expanded',String(show));if(show)opinionMenu.querySelector('button:not(:disabled)')?.focus();}
$('#codex').onclick=e=>{e.stopPropagation();openOpinion(opinionMenu.hidden);};
document.addEventListener('click',e=>{if(!e.target.closest('.opinion'))openOpinion(false);});
document.addEventListener('keydown',e=>{if(e.key==='Escape')openOpinion(false);});
opinionMenu.addEventListener('keydown',e=>{if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;e.preventDefault();const items=[...opinionMenu.querySelectorAll('button:not(:disabled)')],at=items.indexOf(document.activeElement);items[(at+(e.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();});
opinionMenu.onclick=async e=>{const item=e.target.closest('button[data-reviewers]');if(!item||item.disabled)return;openOpinion(false);
 const keys=item.dataset.reviewers.split(',');
 const r=await (await fetch('./second-opinion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reviewers:keys})})).json();
 if(r.error){toast(r.error);return;}
 const names=keys.map(k=>reviewerState[k]?.author||k),busy=keys.filter(k=>!r.started[k]);
 toast(busy.length===keys.length?`${names.join(' and ')} already reviewing`:`asked ${names.join(' and ')} — comments will appear as they land`);await refresh(true);};
// Every agent the host offers is listed, installed or not, so the menu says what it could do and why it can't.
const AV={claude:['C','#d97757'],codex:['Cx','#6e7781'],grok:['G','#8b6cf0'],opencode:['O','#2f9e8f'],pi:['π','#c98a2e']};
function reviewerStatus(rv){if(!rv.available)return '<span class="st">Not installed</span>';if(rv.running)return '<span class="st"><span class="spin"></span>Reviewing</span>';
 if(rv.error)return '<span class="st bad" title="'+esc(rv.error)+'">Failed</span>';if(rv.finished)return `<span class="st">${rv.added} note${rv.added===1?'':'s'}</span>`;return '';}
function renderOpinionMenu(all){const entries=Object.entries(all),ready=entries.filter(([,rv])=>rv.available&&!rv.running);
 const key=JSON.stringify(entries.map(([k,rv])=>[k,rv.available,rv.running,rv.added,!!rv.error,rv.finished]));if(opinionMenu.dataset.key===key)return;opinionMenu.dataset.key=key;
 const items=entries.map(([k,rv])=>{const [letter,colour]=AV[rv.harness]||[rv.author[0],'#6e7781'];
  return `<button type="button" role="menuitem" data-reviewers="${k}"${rv.available&&!rv.running?'':' disabled'} title="${rv.available?'Reviews read-only; its comments land here as notes':esc(rv.harness)+' is not installed on this machine'}"><span class="av" style="--av:${colour}">${esc(letter)}</span><span class="who-name">${esc(rv.author)}</span>${reviewerStatus(rv)}</button>`;});
 opinionMenu.innerHTML='<div class="mh">Ask another agent to review this</div>'+(items.join('')||'<div class="mh">No coding agents found</div>')
  +(ready.length>1?`<hr><button type="button" role="menuitem" class="all" data-reviewers="${ready.map(([k])=>k).join(',')}">Ask all ${ready.length}</button>`:'');}
function renderReviewer(all){if(!all)return;reviewerState=all;renderOpinionMenu(all);const b=$('#codex');const running=Object.values(all).filter(rv=>rv.running).map(rv=>rv.author);
 b.classList.toggle('busy',running.length>0);
 b.innerHTML=running.length?`<span class="spin"></span>${esc(running.length>1?running.length+' agents reviewing':running[0]+' reviewing')}`:'<svg class="spark" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8 6.7 6.7Z"/></svg><span class="lbl">Second opinion</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
 for(const [k,rv] of Object.entries(all)){if(reviewersRunning[k]&&!rv.running)toast(rv.error?`${rv.author} failed: ${rv.error.slice(0,80)}`:`${rv.author} left ${rv.added} note(s)`);reviewersRunning[k]=!!rv.running;}
 const ready=Object.values(all).filter(rv=>rv.available).map(rv=>rv.author);
 const runs=Object.values(all).filter(rv=>rv.running||rv.finished||rv.error).map(rv=>`<span>${esc(rv.author)}: ${rv.running?'reviewing now':rv.error?'last run failed':`${rv.added} note${rv.added===1?'':'s'} at ${esc((rv.finished||'').slice(11,16))}`}</span>`);
 b.removeAttribute('title');
 b.dataset.tip=`<b>Second opinion</b><span>Ask another coding agent to review this diff, read-only. Its line comments and suggested changes land here as notes.</span>`
  +(ready.length?`<span>Available: ${esc(ready.join(', '))}</span>`:'<span>No coding agents are installed on this machine.</span>')+runs.join('');}

/* ---------- state / hot reload ---------- */
async function refresh(force){
 let d;try{d=await (await fetch('./state')).json();}catch(e){return;}
 prView=d.view||null;repoSlugs=d.repos||[];
 renderReviewer(d.reviewers);renderPr(d.pr_request,d.pr,d.pr_draft);
 const changed=d.digest!==digest;const notesKey=JSON.stringify([d.annotations,d.round_replies,d.submission,d.pr_request,d.pr,d.pr_draft]);const notesChanged=notesKey!==lastNotesKey;lastNotesKey=notesKey;notes=d.annotations;force=force||notesChanged;
 if(changed||force){if(changed){const m=await (await fetch('./diff')).json();model=m;digest=d.digest;hlCache={};rawCache={};expandState={};await render();if(digest!==null&&changed&&model)toast('diff reloaded');}
  else if(model){model.submission=d.submission;model.round_replies=d.round_replies;decorateThreads();}
  if(model){model.submission=d.submission;model.round_replies=d.round_replies;renderNotes();}}
}
addEventListener('resize',()=>decoratePins());
(async()=>{await refresh(true);setInterval(()=>refresh(false),1500);
 if(location.hash){const t=document.getElementById(location.hash.slice(1));if(t)t.scrollIntoView();}
 if(PARAMS.get('probe')==='drag'){const cells=[...document.querySelectorAll('td.num.new.click')].slice(0,4);
  const ev=(t,el)=>el.dispatchEvent(new MouseEvent(t,{bubbles:true,button:0,clientX:1,clientY:1}));
  ev('mousedown',cells[0]);ev('mousemove',cells[2]);ev('mousemove',cells[3]);ev('mouseup',cells[3]);ev('click',cells[3]);
  document.title='DRAG '+JSON.stringify({sel,composing:composing&&{kind:composing.kind,start:composing.start,end:composing.end,quoteLines:(composing.quote||'').split('\n').length},selRows:document.querySelectorAll('tr.sel').length,composerOpen:$('#composer').style.display});}
 else if(PARAMS.get('probe')){const r=el=>{if(!el)return null;const b=el.getBoundingClientRect();return [Math.round(b.top),Math.round(b.height)];};
  const sec=document.querySelector('section.file');
  document.title='PROBE '+JSON.stringify({scrollY,top:r($('#top')),section:r(sec),header:r(sec&&sec.querySelector('header')),body:r(sec&&sec.querySelector('.body')),firstRow:r(sec&&sec.querySelector('tr')),secondRow:r(sec&&sec.querySelectorAll('tr')[1])});}})();
</script>
</body></html>
"""


# --------------------------------------------------------------------------
# server
# --------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    base_name: str | None = None
    repo: Path
    base: str
    untracked: bool
    notes: Notes
    user: str = "You"
    # Another of the terminal's pull requests while it is shown, else None for the checked-out work.
    view: dict | None = None
    feedback = None
    answer: str = ""
    remotes: tuple = ()

    def log_message(self, *a):
        pass

    def _send(self, code, body: bytes, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        if path == "/":
            page = PAGE.replace("__TITLE__", html.escape(f"Review · {self.repo.name}")).replace("__USER__", json.dumps(self.user))
            self._send(200, page.encode(), "text/html; charset=utf-8")
        elif path.startswith("/vendor/"):
            asset = {item.name: item for item in VENDOR.iterdir() if item.is_file()}.get(Path(path).name)
            if asset:
                ctype = "text/css" if asset.suffix == ".css" else "application/javascript"
                self._send(200, asset.read_bytes(), ctype)
            else:
                self._send(404, b"// not vendored")
        elif path == "/diff":
            model = current_model()
            model["base_name"] = (self.view or {}).get("base_name") if self.view else Handler.base_name
            model["submission"] = self.notes.submission()
            self._send(200, json.dumps(model).encode())
        elif path == "/file":
            q = parse_qs(url.query)
            rel = (q.get("path") or [""])[0]
            side = (q.get("side") or ["new"])[0]
            target = (self.repo / rel).resolve()
            if self.repo.resolve() not in target.parents:
                self._send(403, b"forbidden", "text/plain")
                return
            view = self.view
            self._send(200, file_text(self.repo, view["base"] if view else self.base, rel, side, view and view["head"]).encode(errors="replace"),
                       "text/plain; charset=utf-8")
        elif path.startswith("/proof/"):
            asset = self.notes.proof_dir() / Path(path).name
            if asset.suffix.lower() in PROOF_TYPES and asset.is_file():
                self._send(200, asset.read_bytes(), PROOF_TYPES[asset.suffix.lower()])
            else:
                self._send(404, b"not found", "text/plain")
        elif path == "/dump":
            self._send(200, dump(self.notes).encode(), "text/plain; charset=utf-8")
        elif path == "/state":
            view = self.view
            base = view["base"] if view else self.base
            text = raw_diff(self.repo, base, self.untracked and not view, view and view["head"])
            body = {
                "digest": diff_digest(self.repo, base, text),
                "annotations": [a for a in self.notes.load() if in_view(a)],
                "view": {k: view[k] for k in ("url", "number", "title", "branch")} if view else None,
                "repos": list(self.remotes),
                "submission": self.notes.submission(),
                "round_replies": self.notes.round_replies(),
                "reviewers": {key: r.status() for key, r in REVIEWERS.items()},
                "pr_request": self.notes.pr_request(),
                "pr": self.notes.pr(),
                "pr_draft": self.notes.pr_draft(),
            }
            self._send(200, json.dumps(body).encode())
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        data = json.loads(self.rfile.read(length) or b"{}")
        if path == "/annotate":
            kind = data.get("kind", "line")
            item = {"kind": kind, "comment": data.get("comment", "")}
            if kind == "pr":
                item["part"] = "title" if data.get("part") == "title" else "body"
                item["quote"] = str(data.get("selection") or "")
            elif kind != "general":
                item["file"] = data.get("file", "")
            if kind in ("line", "chunk", "selection") or (kind == "pin" and data.get("start")):
                item["side"] = data.get("side", "new")
                item["start"] = int(data.get("start") or 0)
                item["end"] = int(data.get("end") or item["start"])
                item["quote"] = data.get("quote", "")
            if kind in ("line", "chunk", "selection"):
                item["suggestion"] = data.get("suggestion")
            if kind == "chunk":
                item["label"] = data.get("label", "")
            if kind == "selection":
                item["selection"] = data.get("selection", "")
            if kind == "pin":
                item["relX"] = round(float(data.get("relX", 0)), 4)
                item["relY"] = round(float(data.get("relY", 0)), 4)
            if self.view:
                item["pr"] = self.view["url"]
            self.notes.add(item)
        elif path == "/reply":
            self.notes.reply(int(data["id"]), data.get("author", self.user), data.get("text", ""))
        elif path == "/round-reply":
            self.notes.round_reply(data.get("author", self.user), data.get("text", ""))
        elif path == "/update":
            self.notes.update(
                int(data["id"]), data.get("comment"), data.get("suggestion"), "suggestion" in data
            )
        elif path == "/resolve":
            self.notes.resolve([int(data["id"])])
        elif path == "/reopen":
            self.notes.resolve([int(data["id"])], reopen=True)
        elif path == "/delete":
            self.notes.resolve([int(data["id"])], delete=True)
        elif path == "/clear":
            self.notes.clear(data.get("which", "all"))
        elif path == "/second-opinion":
            keys = data.get("reviewers") or ["codex"]
            if not isinstance(keys, list) or not keys or any(k not in REVIEWERS for k in keys):
                self._send(400, json.dumps({"error": f"reviewers must be a list of {sorted(REVIEWERS)}"}).encode())
                return
            started = {k: REVIEWERS[k].start(self.repo, self.base, self.untracked, self.notes, self.view) for k in keys}
            self._send(200, json.dumps({"started": started, "reviewers": {k: r.status() for k, r in REVIEWERS.items()}}).encode())
            return
        elif path == "/pull-reviews":
            url = (self.view or self.notes.pr() or {}).get("url", "")
            try:
                counts = import_github_reviews(self.notes, current_model(), fetch_github_reviews(url), url or None)
            except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as exc:
                self._send(502, json.dumps({"error": str(exc)}).encode())
                return
            self._send(200, json.dumps(counts).encode())
            return
        elif path == "/pr-select":
            url = data.get("url")
            if url is not None and not isinstance(url, str):
                self._send(400, json.dumps({"error": "url is a pull request link, or null for the checked-out work"}).encode())
                return
            try:
                view = select_pr(url)
            except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as exc:
                self._send(502, json.dumps({"error": str(exc)}).encode())
                return
            self._send(200, json.dumps({"view": {k: view[k] for k in ("url", "number", "title", "branch")} if view else None}).encode())
            return
        elif path == "/pr-request":
            try:
                req = self.notes.request_pr(bool(data.get("draft", True)), "open" if data.get("stage") == "open" else "describe")
            except ValueError as exc:
                self._send(409, json.dumps({"error": str(exc)}).encode())
                return
            print(f"PR {'APPROVED' if req['stage'] == 'open' else 'REQUESTED'} #{req['n']} at {req['at']}: draft={req['draft']}", flush=True)
            self._send(200, json.dumps(req).encode())
            return
        elif path == "/submit":
            try:
                result = self.feedback.submit()
            except ValueError as exc:
                self._send(400, json.dumps({"error": str(exc)}).encode())
                return
            sub = self.notes.submission()
            open_n = len([a for a in self.notes.load() if a.get("status") != "addressed"])
            print(f"SUBMITTED #{sub['n']} at {sub['at']}: {open_n} open note(s)", flush=True)
            self._send(200, json.dumps({**sub, "delivery": result["state"]}).encode())
            return
        self._send(200, b'{"ok":true}')


def watch(notes: Notes, repo: Path, once: bool, timeout: float | None) -> int:
    seen_pr = notes.pr_request().get("n", 0)

    def pr_requests():
        nonlocal seen_pr
        req = notes.pr_request()
        if req.get("n", 0) <= seen_pr:
            return []
        seen_pr = req["n"]
        if req.get("stage") == "open":
            return [
                f"PR APPROVED #{req['n']} at {req['at']}: draft={req.get('draft')} "
                f"-- the reviewer approved PR description rev {req.get('rev')}; commit, push and gh pr create with exactly "
                f"that title and body (--pr-description prints them), then --pr-url URL"
            ]
        return [
            f"PR REQUESTED #{req['n']} at {req['at']}: draft={req.get('draft')} "
            f"-- the change is approved; write the PR title + body and save them for review with "
            f"--pr-title TITLE --pr-body-file FILE. Do not commit or push until PR APPROVED"
        ]

    return watch_feedback(Path(__file__).parent.name, repo, once=once, timeout=timeout, extra=pr_requests)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("repo", nargs="?", default=".", type=Path, help="path inside the git repo (default: cwd)")
    ap.add_argument("--base", default=None, help="review the branch against this ref's merge-base (default: HEAD, i.e. uncommitted work)")
    ap.add_argument("--no-untracked", action="store_true", help="leave untracked files out of the diff")
    ap.add_argument("--port", type=int, default=8767)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--dump", action="store_true", help="print open notes and exit")
    ap.add_argument("--all", action="store_true", help="with --dump: include addressed notes")
    ap.add_argument("--watch", action="store_true", help="print a line per feedback submission, forever")
    ap.add_argument("--wait", action="store_true", help="block until the next feedback submission, then exit")
    ap.add_argument("--timeout", type=float, default=None, help="with --wait/--watch: give up after N seconds")
    ap.add_argument("--apply", nargs="+", type=int, metavar="ID", help="apply exact suggestions to the working tree, mark addressed")
    ap.add_argument("--reply", nargs=2, action="append", metavar=("ID", "TEXT"),
                    help="post a reply under a note (repeatable); uses --author as the display name")
    ap.add_argument("--round-reply", metavar="TEXT", help="post a reply to the whole round (top of the sidebar)")
    ap.add_argument("--author", default="Agent", help="author for --reply/--round-reply (default Agent; use the session display name)")
    ap.add_argument("--user", default=None, help=f"display name for the human reviewer (default ${REVIEWER_ENV}, else git user.name)")
    ap.add_argument("--pr-url", metavar="URL", help="record the opened PR's URL so the page shows a 'View PR' link")
    ap.add_argument("--pr-title", metavar="TITLE", help="save a PR title draft for review (with --pr-body-file)")
    ap.add_argument("--pr-body-file", metavar="FILE", help="PR body draft for review, from a file or - for stdin")
    ap.add_argument("--pr-description", action="store_true", help="print the current PR title and body draft and exit")
    ap.add_argument("--pull-reviews", action="store_true", help="import review comments from the recorded PR on GitHub (needs gh) and exit")
    ap.add_argument("--reviewers", metavar="JSON", help="the reviewers to offer for a second opinion: a list of {id, label, harness, env}, one per account")
    ap.add_argument("--follow-pr", action="store_true", help="when the branch has an open PR, review all of it and keep importing its GitHub review comments (needs gh)")
    ap.add_argument("--second-opinion", nargs="?", const="codex", choices=[*REVIEWERS, "all"],
                    help="run Codex (default), another harness, or every installed one (all) on the current diff and add their comments as notes, then exit")
    ap.add_argument("--clear", choices=["done", "all"], help="archive addressed notes (done) or every note (all) and start a new round")
    ap.add_argument("--delete", nargs="+", type=int, metavar="ID", help="delete note IDs outright (no archive)")
    ap.add_argument("--resolve", nargs="+", type=int, metavar="ID", help="mark note IDs addressed and exit")
    ap.add_argument("--reopen", nargs="+", type=int, metavar="ID", help="mark note IDs open again and exit")
    ap.add_argument("--proof", metavar="TEXT", help="with --resolve: how you checked the fix (the command you ran and what it showed); required")
    ap.add_argument("--proof-file", metavar="IMAGE", type=Path, help="with --resolve: a screenshot that shows the fix")
    ap.add_argument("--notes-path", action="store_true", help="print the notes JSON path and exit")
    add_arguments(ap)
    args = ap.parse_args()
    if args.reviewers:
        try:
            use_reviewers(args.reviewers)
        except (ValueError, TypeError) as exc:
            sys.exit(f"--reviewers: {exc}")

    try:
        repo = repo_root(args.repo.resolve())
    except RuntimeError as exc:
        sys.exit(f"not a git repo: {args.repo} ({exc})")
    notes = Notes(notes_path_for(repo), repo)
    Handler.user = args.user or reviewer_name(repo)

    if args.notes_path:
        print(notes.path)
        return
    if args.dump:
        print(dump(notes, show_all=args.all))
        return
    if args.apply:
        for line in apply_suggestions(notes, args.apply):
            print(line)
        return
    if args.pr_url:
        notes.set_pr(args.pr_url)
        print(f"recorded PR {args.pr_url}")
        return
    if args.pr_title is not None or args.pr_body_file:
        if not args.pr_title or not args.pr_body_file:
            sys.exit("--pr-title and --pr-body-file go together")
        body = sys.stdin.read() if args.pr_body_file == "-" else Path(args.pr_body_file).read_text()
        draft = notes.set_pr_draft(args.pr_title, body)
        print(f"saved PR description rev {draft['rev']} for review")
        return
    if args.pull_reviews:
        pr = notes.pr() or {}
        try:
            counts = import_github_reviews(notes, diff_model(repo, diff_base(repo, args.base), not args.no_untracked), fetch_github_reviews(pr.get("url", "")))
        except RuntimeError as exc:
            sys.exit(f"could not pull reviews: {exc}")
        print(", ".join(f"{v} {k}" for k, v in counts.items()))
        return
    if args.pr_description:
        draft = notes.pr_draft()
        if not draft:
            sys.exit("no PR description draft yet")
        print(draft["title"])
        print()
        print(draft["body"])
        return
    if args.second_opinion:
        base = diff_base(repo, args.base)
        chosen = [k for k, r in REVIEWERS.items() if r.status()["available"]] if args.second_opinion == "all" else [args.second_opinion]
        print(f"asking {', '.join(chosen)} for a second opinion (this can take a few minutes)...", flush=True)
        threads = [threading.Thread(target=REVIEWERS[k].run_blocking, args=(repo, base, not args.no_untracked, notes)) for k in chosen]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        failed = False
        for k in chosen:
            st = REVIEWERS[k].status()
            if st["error"]:
                failed = True
                print(f"{k} failed: {st['error']}", file=sys.stderr)
                continue
            print(f"{k} added {st['added']} note(s)")
            if st["summary"]:
                print(f"{k} summary: {st['summary']}")
        if failed:
            sys.exit(1)
        return
    if args.clear:
        print(f"archived {notes.clear(args.clear)} note(s); now round {notes.round()}")
        return
    if args.delete:
        print(f"deleted {notes.resolve(args.delete, delete=True)} note(s)")
        return
    # A note an agent marks addressed carries how it was checked, so the reviewer sees proof, not just a claim.
    # Checked before any reply is posted, so a refused command changes nothing.
    if args.resolve and not (args.proof or "").strip():
        sys.exit("say how you checked the fix: add --proof 'the command you ran and what it showed' (and --proof-file for a screenshot)")
    did = False
    for ann_id, text in args.reply or []:
        ok = notes.reply(int(ann_id), args.author, text)
        print(f"replied to #{ann_id}" if ok else f"#{ann_id}: no such note")
        did = True
    if args.round_reply:
        notes.round_reply(args.author, args.round_reply)
        print("posted round reply")
        did = True
    if args.resolve:
        proof = {"author": args.author, "text": args.proof.strip()[:4000], "at": time.strftime("%Y-%m-%d %H:%M:%S")}
        for ann_id in args.resolve:
            try:
                file = notes.keep_proof(ann_id, args.proof_file) if args.proof_file else None
            except (OSError, ValueError) as exc:
                sys.exit(f"could not keep the proof file: {exc}")
            print(f"marked {notes.resolve([ann_id], proof=dict(proof, file=file))} note(s) addressed")
        return
    if did:
        return
    if args.reopen:
        print(f"reopened {notes.resolve(args.reopen, reopen=True)} note(s)")
        return
    if args.watch or args.wait:
        sys.exit(watch(notes, repo, once=args.wait, timeout=args.timeout))

    base = diff_base(repo, args.base)
    Handler.repo, Handler.base, Handler.untracked, Handler.notes = repo, base, not args.no_untracked, notes
    url = f"http://127.0.0.1:{args.port}/"
    try:
        command = " ".join(shlex.quote(str(part)) for part in (sys.executable, Path(__file__).resolve(), repo))
        answer = (f"Answer every note on the review page when you finish it: {command} --author YOUR_NAME --reply ID 'what you changed' "
                  "--resolve ID --proof 'the check you ran and what it showed' (add --proof-file PATH for a screenshot). "
                  "A note you could not address gets only a --reply saying why.")
        # Send delivers what the page shows: the notes on the work or pull request being reviewed.
        feedback = Feedback(args, Path(__file__).parent.name, repo, notes.path, lambda: [a for a in notes.load() if in_view(a)],
                            on_submit=notes.submit, answer=answer)
        Handler.feedback, Handler.answer, Handler.remotes = feedback, answer, tuple(sorted(github_remotes(repo)))
        server = ThreadingHTTPServer(("127.0.0.1", args.port), wrap_handler(Handler, feedback))
    except OSError as e:
        sys.exit(f"cannot bind port {args.port}: {e} (try --port)")
    print(f"repo    {repo}")
    print(f"base    {base}" + ("" if args.base else "  (HEAD: uncommitted work)"))
    print(f"notes   {notes.path}")
    print(f"serving {url}   (ctrl-c to stop)", flush=True)
    if args.follow_pr:
        interval = float(os.environ.get("REVIEW_APP_PR_POLL_SECONDS") or 120)
        threading.Thread(target=follow_pr, args=(notes, repo, interval), daemon=True).start()
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
