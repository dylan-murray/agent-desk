"""Report progress on Agent Desk page notes, so the page shows it on each note.

    annotation_status.py --file DATA/feedback.json 3 working
    annotation_status.py --file DATA/feedback.json 3 resolved --reply "Dropped the heading to 26px."

Notes are named by number (as in the handoff) or id. Stdlib only.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_desk.annotations import STATUSES, AnnotationStore  # noqa: E402
from agent_desk.feedback_history import archive_feedback  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--file', required=True, type=Path, help="the desk's feedback.json, as named in the handoff")
    parser.add_argument('note', nargs='+', help='note numbers or ids')
    parser.add_argument('status', choices=STATUSES)
    parser.add_argument('--reply', help='what changed, or why nothing did; shown on the note')
    args = parser.parse_args(argv)
    if not args.file.is_file():
        parser.error(f'{args.file} does not exist')
    changed = AnnotationStore(args.file, archive=archive_feedback).set_status(args.note, args.status, args.reply)
    if not changed:
        sys.exit('No matching notes: ' + ', '.join(args.note))
    print(json.dumps({'notes': [{'n': n['n'], 'status': n['status'], 'reply': n.get('reply', '')} for n in changed]}))


if __name__ == '__main__':
    main()
