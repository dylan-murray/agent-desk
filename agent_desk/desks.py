"""Desks: named sets of agents, like herdr's sessions: one per project, say.

Every agent is on exactly one desk. It is on the desk it was put on; otherwise on its
parent's, so a coordinator's workers and a terminal's subagents follow it wherever it
goes; otherwise on the first desk. Membership is recorded only for agents that were
explicitly placed, so an agent that has not been placed needs no record at all.
"""
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

MAX_DESKS = 32
# Placements outlive the agents they name (a closed terminal leaves its record behind), so
# the oldest are dropped past this many. Live agents are re-placed whenever they move.
MAX_PLACEMENTS = 4096
FIRST = dict(id='main', name='Main')
DESK_ID = re.compile(r'^[a-z0-9][a-z0-9-]{0,39}$')


def desk_name(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 40 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('Enter a desk name of 1–40 characters')
    return value.strip()


class Desks:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.desks = None
        self.placed = None

    def _load(self):
        if self.desks is not None:
            return
        try:
            data = json.loads(self.path.read_text())
        except FileNotFoundError:
            self.desks, self.placed = [dict(FIRST)], {}
            return
        except (OSError, ValueError) as exc:
            # Never quietly start over on top of someone's desks: keep the unreadable file
            # aside, say so, and start with one desk so the dashboard still opens.
            aside = self.path.with_name(f'{self.path.name}.unreadable-{int(time.time())}')
            os.replace(self.path, aside)
            print(f'Could not read {self.path} ({exc}); moved it to {aside} and started with one desk', flush=True)
            self.desks, self.placed = [dict(FIRST)], {}
            return
        desks, seen = [], set()
        for item in data.get('desks', []) if isinstance(data, dict) else []:
            try:
                if not DESK_ID.match(item['id']) or item['id'] in seen:
                    continue
                desks.append(dict(id=item['id'], name=desk_name(item['name'])))
                seen.add(item['id'])
            except (KeyError, TypeError, ValueError):
                continue
        self.desks = desks[:MAX_DESKS] or [dict(FIRST)]
        known = {d['id'] for d in self.desks}
        placed = data.get('placed', {}) if isinstance(data, dict) else {}
        self.placed = {k: v for k, v in placed.items() if isinstance(k, str) and v in known} if isinstance(placed, dict) else {}

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_name(self.path.name + '.tmp')
        temp.write_text(json.dumps(dict(desks=self.desks, placed=self.placed), indent=2) + '\n')
        os.replace(temp, self.path)

    def _desk(self, identity):
        desk = next((d for d in self.desks if d['id'] == identity), None)
        if desk is None:
            raise ValueError('That desk no longer exists')
        return desk

    def _name_free(self, name, identity=None):
        if any(d['name'].casefold() == name.casefold() and d['id'] != identity for d in self.desks):
            raise ValueError(f'There is already a desk called “{name}”')

    def snapshot(self):
        with self.lock:
            self._load()
            return [dict(d) for d in self.desks]

    def _resolve(self, agents):
        by_id = {a['id']: a for a in agents if isinstance(a.get('id'), str)}
        first, found = self.desks[0]['id'], {}

        def desk_of(identity, depth=0):
            if identity in found:
                return found[identity]
            desk = self.placed.get(identity)
            if desk is None:
                parent = by_id.get(identity, {}).get('parent_id')
                # Parents form a tree, but never trust that enough to recurse forever.
                desk = desk_of(parent, depth + 1) if isinstance(parent, str) and depth < 32 else first
            found[identity] = desk
            return desk

        return {identity: desk_of(identity) for identity in by_id}

    def annotate(self, agents):
        """Set each agent's desk in place and return the desks."""
        with self.lock:
            self._load()
            resolved = self._resolve(agents)
            for agent in agents:
                if agent.get('id') in resolved:
                    agent['desk'] = resolved[agent['id']]
            return [dict(d) for d in self.desks]

    def desk_for(self, identity):
        """The desk a new agent should be placed on: the one named, or the first."""
        with self.lock:
            self._load()
            return self._desk(identity)['id'] if identity is not None else self.desks[0]['id']

    def create(self, name):
        name = desk_name(name)
        with self.lock:
            self._load()
            if len(self.desks) >= MAX_DESKS:
                raise ValueError(f'{MAX_DESKS} desks is the most Agent Desk keeps')
            self._name_free(name)
            desk = dict(id='desk-' + secrets.token_hex(4), name=name)
            self.desks.append(desk)
            self._save()
            return dict(desk)

    def rename(self, identity, name):
        name = desk_name(name)
        with self.lock:
            self._load()
            desk = self._desk(identity)
            self._name_free(name, identity)
            desk['name'] = name
            self._save()
            return dict(desk)

    def place(self, ids, identity):
        if not isinstance(ids, list) or not 1 <= len(ids) <= 200 or any(not isinstance(i, str) or not 1 <= len(i) <= 200 for i in ids):
            raise ValueError('Choose the agents to move')
        with self.lock:
            self._load()
            self._desk(identity)
            for agent in ids:
                self.placed.pop(agent, None)
                self.placed[agent] = identity
            while len(self.placed) > MAX_PLACEMENTS:
                self.placed.pop(next(iter(self.placed)))
            self._save()
            return dict(self._desk(identity))

    def delete(self, identity, move_to, agents):
        """Remove a desk, moving everything on it to another. agents is the current list, so
        agents that were on it only because it was the first desk move too."""
        with self.lock:
            self._load()
            self._desk(identity)
            if identity == move_to:
                raise ValueError('Choose another desk for its agents')
            self._desk(move_to)
            resolved = self._resolve(agents)
            by_id = {a['id']: a for a in agents if isinstance(a.get('id'), str)}
            for agent, desk in resolved.items():
                parent = by_id[agent].get('parent_id')
                # Followers keep following: they move with whatever they follow.
                if desk == identity and (agent in self.placed or resolved.get(parent) != identity):
                    self.placed[agent] = move_to
            for agent, desk in list(self.placed.items()):
                if desk == identity:
                    self.placed[agent] = move_to
            self.desks = [d for d in self.desks if d['id'] != identity]
            self._save()
            return [dict(d) for d in self.desks]
