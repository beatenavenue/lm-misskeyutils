"""Generate golden data for evaluateRules from the Python step3 implementation.

Usage (from the repository root, Python 3.12+, python-dotenv installed):

    python packages/core/test/fixtures/evaluate-rules/generate_golden.py

The script loads `days_expire.step3` from the working tree (the patched
version whose reactionCount handling is fixed, tag `python-final`) and, for
comparison, the unpatched version from git (`python-final~1`). Both are run on
the same note/rule matrix. The expected output is taken from the patched
version; the script asserts that the only differences to the unpatched version
are notes whose id contains "reactionCount", which documents the bug fix.
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
NOW = dt.datetime(2026, 9, 1, 0, 0, 0, tzinfo=dt.timezone.utc)

RULES = [
    {'day': 180, 'pinned': True},
    {
        'day': 30,
        'renoteCount': 2,
        'repliesCount': 2,
        'reactionCount': 2,
        'pinned': True,
        'renote': True,
        'reply': True,
        'inChannel': True,
    },
    {'day': 60, 'renoteCount': 5, 'repliesCount': 5, 'reactionCount': 5, 'pinned': True},
]

# age -> createdAt = NOW - age; "30d" is exactly the boundary (not older than 30 days)
AGES = {
    '10d': dt.timedelta(days=10),
    '30d': dt.timedelta(days=30),
    '30d1s': dt.timedelta(days=30, seconds=1),
    '45d': dt.timedelta(days=45),
    '60d': dt.timedelta(days=60),
    '60d1s': dt.timedelta(days=60, seconds=1),
    '179d': dt.timedelta(days=179),
    '180d': dt.timedelta(days=180),
    '181d': dt.timedelta(days=181),
    '400d': dt.timedelta(days=400),
}

VARIANTS: dict[str, dict] = {
    'plain': {},
    'pinned': {'__pinned': True},
    'renote': {'renoteId': 'r1'},
    'reply': {'replyId': 'p1'},
    'channel': {'channelId': 'c1'},
    'renoteCount1': {'renoteCount': 1},
    'renoteCount2': {'renoteCount': 2},
    'renoteCount5': {'renoteCount': 5},
    'repliesCount1': {'repliesCount': 1},
    'repliesCount2': {'repliesCount': 2},
    'repliesCount5': {'repliesCount': 5},
    'reactionCount1': {'reactionCount': 1},
    'reactionCount2': {'reactionCount': 2},
    'reactionCount5': {'reactionCount': 5},
    'renote-reactionCount5': {'renoteId': 'r1', 'reactionCount': 5},
    'export-only': {'__export': True},  # no count fields at all, like a Misskey export
}


def build_notes() -> tuple[list[dict], list[str]]:
    notes: list[dict] = []
    pinned: list[str] = []
    for age_name, age in AGES.items():
        created = (NOW - age).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        for variant_name, fields in VARIANTS.items():
            note_id = f'{age_name}-{variant_name}'
            note = {
                'id': note_id,
                'createdAt': created,
                'renoteId': None,
                'replyId': None,
                'channelId': None,
                'renoteCount': 0,
                'repliesCount': 0,
                'reactionCount': 0,
            }
            if fields.get('__export'):
                note = {'id': note_id, 'createdAt': created, 'renoteId': None, 'replyId': None}
            for key, value in fields.items():
                if key == '__pinned':
                    pinned.append(note_id)
                elif not key.startswith('__'):
                    note[key] = value
            notes.append(note)
    return notes, pinned


def load_step3(source: Path) -> types.FunctionType:
    """Import days_expire from *source* without triggering limitmanage side effects."""
    os.environ.setdefault('LM_LOGLEVEL', 'WARNING')
    os.environ.setdefault('LM_DEBUGLEVEL', '0')
    os.environ.setdefault('LM_BASE_URL', 'https://example.invalid/api')
    os.environ.setdefault('LM_API_TOKEN', 'dummy')
    os.environ.setdefault('LM_USERAGENT', 'golden')
    sys.path.insert(0, str(ROOT))
    spec = importlib.util.spec_from_file_location(f'days_expire_{source.stem}_{id(source)}', source)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    class FixedDateTime(dt.datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: D102
            return NOW.astimezone(tz) if tz else NOW

    module.datetime = FixedDateTime  # step3 calls datetime.now(...)
    return module.step3


def main() -> None:
    notes, pinned = build_notes()
    rules_sorted = sorted(RULES, key=lambda r: r['day'])

    patched = load_step3(ROOT / 'days_expire.py')
    expected = patched(notes, pinned, rules_sorted)

    unpatched_src = subprocess.run(
        ['git', '-C', str(ROOT), 'show', 'python-final~1:days_expire.py'], check=True, capture_output=True, text=True
    ).stdout
    with tempfile.NamedTemporaryFile('w', suffix='_unpatched.py', delete=False) as tmp:
        tmp.write(unpatched_src)
        unpatched_path = Path(tmp.name)
    unpatched = load_step3(unpatched_path)
    legacy = unpatched(notes, pinned, rules_sorted)

    diff = set(expected) ^ set(legacy)
    assert diff, 'expected the reactionCount fix to change the result'
    assert all('reactionCount' in note_id for note_id in diff), diff

    (HERE / 'notes.json').write_text(json.dumps(notes, indent=2) + '\n')
    (HERE / 'pinned.json').write_text(json.dumps(pinned, indent=2) + '\n')
    (HERE / 'rules.json').write_text(json.dumps(RULES, indent=2) + '\n')
    (HERE / 'expected.json').write_text(
        json.dumps({'now': NOW.strftime('%Y-%m-%dT%H:%M:%S.000Z'), 'deleteIds': expected}, indent=2) + '\n'
    )
    print(f'notes: {len(notes)}, delete targets: {len(expected)}, legacy-only differences: {sorted(diff)}')


if __name__ == '__main__':
    main()
