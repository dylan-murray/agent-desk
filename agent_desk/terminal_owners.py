"""Attach to surviving owners without moving or restarting their PTYs."""
from agent_desk.terminal_supervisor import SupervisorClient, ExternalParents, legacy_location, private_directory, existing_owners


class TerminalOwners:
    def __init__(self, primary, additional=()):
        self.primary=primary
        self.clients=[primary,*additional]
        self.external_parents=ExternalParents(self)
        # Terminals never move between owners, so one lookup per ID is enough.
        self.owners={}

    @classmethod
    def attach(cls, data_dir, port, start=True):
        primary=SupervisorClient(data_dir,port,start=start)
        primary_pid=primary.call('hello')['pid']
        legacy=legacy_location(data_dir,port)
        others=[]
        if legacy!=primary.folder and (legacy/'rpc.sock').exists() and (legacy/'token').exists():
            private_directory(legacy)
            old=SupervisorClient(data_dir,port,start=False)
            old.folder=legacy;old.token=(legacy/'token').read_text()
            # Refuse to hide an owner on authentication/connection failure.
            # A partial list could falsely reconcile live runs as interrupted.
            try:
                if old.call('hello')['pid']!=primary_pid:others.append(old)
            except (FileNotFoundError,ConnectionRefusedError):
                if set(existing_owners(data_dir,port))-{primary_pid}:raise
        return cls(primary,others)

    def call(self, operation, **fields):
        if operation=='parents':
            for client in self.clients:client.call(operation,**fields)
            return None
        if operation=='hello':return self.primary.call(operation,**fields)
        raise ValueError('Unsupported multi-owner operation')

    def list(self):
        rows=[row for client in self.clients for row in client.list()]
        if len({row['id'] for row in rows})!=len(rows):
            raise ValueError('Duplicate terminal IDs across owners; refusing ambiguous routing')
        return rows

    def owner(self, identity):
        if len(self.clients)==1:return self.primary
        if identity in self.owners:return self.owners[identity]
        matches=[client for client in self.clients if any(row['id']==identity for row in client.list())]
        if len(matches)!=1:raise ValueError('Terminal not found' if not matches else 'Ambiguous terminal owner')
        self.owners[identity]=matches[0]
        return matches[0]

    def get(self, identity):
        return self.owner(identity).get(identity)

    def output(self, identity, cursor, wait=0):
        return self.owner(identity).output(identity, cursor, wait)

    def send(self, identity, event):
        return self.owner(identity).send(identity, event)

    def launch(self, payload, coordinator=None):
        return self.primary.launch(payload,coordinator=coordinator)

    def child_pids(self):
        return set().union(*(client.child_pids() for client in self.clients))

    def close(self):
        for client in self.clients:client.close()
