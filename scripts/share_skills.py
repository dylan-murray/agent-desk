"""Make every local skill visible to every installed agent harness without copying content."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_desk.skill_harnesses import make_available_everywhere, share  # noqa: E402,F401  (share is re-exported)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='create the links; without it, only preview them')
    args = parser.parse_args()
    result = make_available_everywhere(apply=args.apply)
    for change in result['linked'] + result['conflicts']:
        print(f"{change['status']}: {change['path']} -> {change['source']}")
    missing = [(skill['id'], harness['label']) for skill in result['skills'] for harness in result['harnesses'] if not skill['availability'][harness['id']]]
    print(f"{len(result['skills'])} skills, {len(result['harnesses'])} harnesses, {len(missing)} gaps" + ('' if args.apply else ' (preview)'))
