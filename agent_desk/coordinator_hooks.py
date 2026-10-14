"""User-authored event instructions, delivered atomically with their source event."""
import secrets
import time

HOOK_EVENTS = {
    'condition': 'When the condition matches',
    'before_publish': 'Before pushing or opening a PR',
    'created': 'Coordinator starts',
    'resumed': 'Saved coordinator reopens',
    'user_message': 'You send a task',
    'worker_report': 'Worker reports back',
    'worker_missing': 'Worker exits without a report',
}


class CoordinatorHooks:
    def init_hooks(self):
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS coordinator_hooks (
                    id TEXT PRIMARY KEY, scope TEXT NOT NULL, event TEXT NOT NULL,
                    instruction TEXT NOT NULL, enabled INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS coordinator_hook_runs (
                    id TEXT PRIMARY KEY, coordinator TEXT, hook TEXT, event TEXT,
                    instruction TEXT, created REAL);
            ''')
            if 'skill' not in [r[1] for r in db.execute('PRAGMA table_info(coordinator_hooks)')]:
                db.execute("ALTER TABLE coordinator_hooks ADD COLUMN skill TEXT NOT NULL DEFAULT ''")
            migrated=db.execute("SELECT 1 FROM sqlite_master WHERE name='inherited_hook_snapshots'").fetchone()
            db.execute('CREATE TABLE IF NOT EXISTS inherited_hook_snapshots(hook TEXT PRIMARY KEY, source TEXT)')
            if not migrated:
                # Keep old rows for audit while replacing exact copied defaults
                # with live inheritance. Distinct session settings stay local.
                db.execute("INSERT INTO inherited_hook_snapshots SELECT h.id,MIN(d.id) FROM coordinator_hooks h JOIN coordinator_hooks d ON d.scope='defaults' AND h.scope!='defaults' AND h.event=d.event AND h.instruction=d.instruction AND h.skill=d.skill AND h.enabled=d.enabled GROUP BY h.id")


    def hooks(self, payload):
        identity = payload.get('id')
        self.get(identity)
        scope = 'defaults' if payload.get('defaults') is True else identity
        with self.db() as db:
            items = [dict(r) for r in db.execute('SELECT * FROM coordinator_hooks WHERE scope=? AND id NOT IN (SELECT hook FROM inherited_hook_snapshots) ORDER BY rowid', (scope,))]
            runs = [dict(r) for r in db.execute('SELECT * FROM coordinator_hook_runs WHERE coordinator=? ORDER BY created DESC LIMIT 20', (identity,))]
        return {'live_defaults':True, 'hooks': items, 'events': HOOK_EVENTS, 'runs': runs, 'tools': [{k:v for k,v in t.items() if k in ('id','title','target')} for t in self.tool_catalog()]}

    def save_hook(self, payload):
        identity = payload.get('id'); self.get(identity)
        scope = 'defaults' if payload.get('defaults') is True else identity
        hook_id = payload.get('hook_id')
        with self.lock, self.db() as db:
            if hook_id and not db.execute('SELECT 1 FROM coordinator_hooks WHERE id=? AND scope=?', (hook_id, scope)).fetchone():
                raise ValueError('Hook not found in this scope')
            if hook_id:db.execute('DELETE FROM inherited_hook_snapshots WHERE hook=?',(hook_id,))
            if payload.get('delete') is True:
                db.execute('DELETE FROM coordinator_hooks WHERE id=? AND scope=?', (hook_id, scope))
            else:
                skill=payload.get('skill','')
                if skill and skill not in [t['id'] for t in self.tool_catalog()]:raise ValueError('Choose an installed tool UI')
                if payload.get('event')=='before_publish' and skill!='code-review':raise ValueError('Before publish requires the Code review tool UI')
                instruction = payload.get('instruction'); event = payload.get('event','condition'); enabled = payload.get('enabled')
                if event not in HOOK_EVENTS: raise ValueError('Choose a supported hook event')
                if not isinstance(instruction, str) or not 1 <= len(instruction.strip()) <= 1000:
                    raise ValueError('Enter a hook instruction of up to 1,000 characters')
                if type(enabled) is not bool: raise ValueError('Hook enabled must be true or false')
                if not hook_id and db.execute('SELECT COUNT(*) FROM coordinator_hooks WHERE scope=?', (scope,)).fetchone()[0] >= 20:
                    raise ValueError('Use at most 20 hooks per scope')
                db.execute('INSERT INTO coordinator_hooks VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET event=excluded.event,instruction=excluded.instruction,enabled=excluded.enabled,skill=excluded.skill',
                           (hook_id or 'hook-'+secrets.token_hex(8), scope, event, instruction.strip(), enabled, skill))
        return self.hooks(payload)

    def effective_hooks(self, db, identity):
        return [dict(r) for r in db.execute("SELECT * FROM coordinator_hooks WHERE (scope='defaults' OR scope=?) AND enabled=1 AND id NOT IN (SELECT hook FROM inherited_hook_snapshots) ORDER BY rowid",(identity,))]

    def copy_default_hooks(self, db, identity):
        # Defaults are now inherited at evaluation time by every coordinator.
        pass

    def fire_hooks(self, db, identity, event, source_key):
        for hook in self.effective_hooks(db,identity):
            if hook['event']!=event:continue
            key = source_key+':hook:'+hook['id']
            inserted = db.execute('INSERT OR IGNORE INTO coordinator_hook_runs VALUES(?,?,?,?,?,?)',
                                 (key, identity, hook['id'], event, hook['instruction'], time.time())).rowcount
            if not inserted: continue
            self.append(db, identity, 'system', 'Hook queued · '+HOOK_EVENTS[event]+'\n'+hook['instruction'], key)
            # Same transaction as the event. Existing turns batch these instructions.
            db.execute('INSERT OR IGNORE INTO turns VALUES(?,?,?,?,?)', (key, identity, 'pending', 0, time.time()))

    def active_hooks(self, identity):
        with self.db() as db:
            return [dict(r) for r in db.execute("""
                SELECT h.id,h.event,h.instruction,
                substr(h.id,1,length(h.id)-length(h.hook)-6) AS source_event,
                (SELECT substr(m.text,1,2000) FROM messages m
                 WHERE m.event_key=substr(h.id,1,length(h.id)-length(h.hook)-6)) AS source_excerpt FROM coordinator_hook_runs h
                JOIN turns t ON t.id=h.id WHERE h.coordinator=?
                AND (t.state='running' OR t.state LIKE 'batch:%') ORDER BY h.created
            """, (identity,))]
