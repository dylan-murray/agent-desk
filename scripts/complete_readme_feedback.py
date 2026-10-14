"""Mark implemented README annotations done without resolving newer feedback."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_desk.paths import DATA_DIR
from agent_desk.readme_feedback import request_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--ids', type=int, nargs='+', required=True)
    args = parser.parse_args()
    snapshot = json.loads(args.snapshot.read_text())
    registry = json.loads((DATA_DIR / 'skill-uis.json').read_text())
    ui = next((item for item in registry if item['id'] == snapshot['tool_id']), None)
    if not ui or ui['context'] != snapshot['document']:
        raise ValueError('Reopen the annotator for this document before acknowledging notes')
    config = request_json(ui['url'] + '/desk-feedback/config')
    result = request_json(ui['url'] + '/desk-feedback/complete',
                          {'request_id': snapshot['request_id'], 'ids': args.ids},
                          {'X-Readme-Feedback': config['token']})
    print('Marked done:', ', '.join(map(str, result['resolved'])))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        sys.exit(str(error))
