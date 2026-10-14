---
name: agent-desk-setup
description: Set up Agent Desk on this machine. Checks prerequisites, starts it, and adds the user's Claude and Codex accounts. Use when someone asks to install, set up, or configure Agent Desk, or to add an account to it.
---

# Set up Agent Desk

Work through these steps in order. Report what you found and did at each one, and stop to ask when a step needs a decision from the user.

## 1. Check prerequisites

Agent Desk needs macOS or Linux, Python 3.11+, and Node.js 18+. It has no Python dependencies.

```sh
python3 --version
node --version
command -v claude codex grok
```

At least one agent CLI must be installed and signed in. If none is, tell the user which ones Agent Desk supports (Claude Code, Codex, Grok) and stop. Do not install or sign in to a CLI for them.

## 2. Get and start it

If there is no checkout yet:

```sh
git clone https://github.com/dylan-murray/agent-desk.git
```

Start it from the checkout, in the background, and leave it running:

```sh
python3 -m agent_desk
```

It listens on 127.0.0.1:4310 only. Use `--port` if 4310 is taken. Check it with `curl -s http://127.0.0.1:4310/config.js`, which prints the accounts it knows about.

## 3. Add accounts

Claude and Codex each start with one account: the login the CLI uses by default (`~/.claude`, `~/.codex`). Nothing needs adding for those.

Someone with a second login, such as a personal subscription beside a work one, keeps it in a separate config folder. Look for these:

```sh
ls -d ~/.claude-* ~/.codex-* 2>/dev/null
```

Ask the user which folders are accounts they want in Agent Desk and what to call each. Do not guess: a folder may be a backup. Never read the files inside these folders; they hold credentials.

Accounts are saved in `accounts.json` in the data directory (`data/` in a source checkout, or wherever `AGENT_DESK_DATA_DIR` points). Each entry looks like this:

```json
[
  {"id": "claude-personal", "harness": "claude", "name": "Personal", "config_dir": "~/.claude-personal"},
  {"id": "codex-personal", "harness": "codex", "name": "Personal", "config_dir": "~/.codex-personal"}
]
```

- `harness` is `claude` or `codex`.
- `id` is the harness, a hyphen, and the name in lowercase with hyphens. It must not change later: saved sessions refer to it.
- `config_dir` is absolute or starts with `~/`.
- Give a Claude account and a Codex account the same `name` when they belong together. A coordinator on one then launches workers on the other.

Merge new entries into the existing file; do not overwrite entries already there. The user can make the same change in the app under **New → Terminal → Accounts**.

If a config folder does not exist yet, the account is not signed in. Give the user the command to run themselves:

```sh
CLAUDE_CONFIG_DIR=~/.claude-personal claude
CODEX_HOME=~/.codex-personal codex login
```

## 4. Confirm

Reload `http://127.0.0.1:4310/config.js` and check that every account is listed with the right label. Then tell the user to open http://127.0.0.1:4310, choose **New → Terminal**, and pick an account.

Point them to `docs/guide.md` for coordinators, automations, the model router, and remote SSH machines.
