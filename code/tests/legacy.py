"""Explicit access to preserved research fixtures; never an active-data fallback."""
import hashlib
import json
from pathlib import Path
import unittest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
ARCHIVE_ROOT = PROJECT_ROOT / 'before1123'


def archive_path(relative):
    path = (ARCHIVE_ROOT / relative).resolve()
    if not path.is_relative_to(ARCHIVE_ROOT.resolve()):
        raise ValueError('Archive fixture path escaped its root.')
    if not path.exists():
        raise unittest.SkipTest('The local before1123 research archive is not installed.')
    return path


def archived_design(family):
    config = 'prefilter_bpf.json' if family == 'bpf' else 'prefilter_fixed.json'
    folder = 'bpf_design' if family == 'bpf' else 'prefilter_design'
    settings_bytes = archive_path('code/config/' + config).read_bytes()
    settings = json.loads(settings_bytes)
    digest = hashlib.sha256(settings_bytes).hexdigest()
    for path in sorted(archive_path('experiment/outputs/' + folder + '/runs').glob('*/manifest.json'), reverse=True):
        record = json.loads(path.read_text(encoding='utf-8-sig'))
        recorded_digest = record['config_sha256'] if family == 'bpf' else record['config']['sha256']
        if recorded_digest != digest:
            continue
        for name, expected in record['artifacts'].items():
            if hashlib.sha256((path.parent / name).read_bytes()).hexdigest() != expected:
                raise ValueError('Archived design fixture changed.')
        return settings, path, record, json.loads((path.parent / 'design.json').read_text(encoding='utf-8-sig'))
    raise ValueError('A matching archived design fixture is required.')
