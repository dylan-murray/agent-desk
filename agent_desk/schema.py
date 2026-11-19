"""SQLite schema changes as numbered steps, shared by the stores that keep their data in SQLite."""


def migrate(db, steps):
    """Bring the schema up to date. A database's PRAGMA user_version is how many steps it has had: this runs the
    rest, each once and in its own transaction, so a failed step leaves it as it was. Change a schema by adding a
    step, never by editing one that has shipped. True when the database was new. A database a newer Agent Desk has
    migrated further is left as it is: steps only add, so this version's queries still work on it."""
    version = db.execute('PRAGMA user_version').fetchone()[0]
    for number, step in enumerate(steps[version:], start=version + 1):
        db.executescript(f'BEGIN; {step} PRAGMA user_version = {number}; COMMIT;')
    return version == 0
