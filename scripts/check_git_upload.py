"""Check the complete Git index before publishing; never print secret values."""

import argparse
from pathlib import Path
import re
import subprocess
import sys


SECRET_PATTERNS = (
    ("private key", re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----")),
    ("GitHub token", re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b")),
    ("AWS access key", re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("OpenAI token", re.compile(rb"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b")),
    ("Slack token", re.compile(rb"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    ("credential in URL", re.compile(rb"https?://[^\s/:<>\"']+:[^\s/@<>\"']+@", re.I)),
    ("credential assignment", re.compile(
        rb"(?:[\"']?\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|secret[_-]?key)[\"']?)"
        rb"\s*[:=]\s*[\"']([A-Za-z0-9_+/=.-]{20,})[\"']", re.I)),
)


def git(root, *args, data=None, allowed=(0,)):
    result = subprocess.run(
        ["git", "-c", f"safe.directory={root.resolve().as_posix()}", "-C", str(root), *args],
        input=data, capture_output=True, check=False
    )
    if result.returncode not in allowed:
        raise RuntimeError(f"git {args[0]} failed (exit {result.returncode})")
    return result.stdout


def check(root):
    entries = git(root, "ls-files", "--stage", "-z").split(b"\0")
    indexed = []
    for entry in filter(None, entries):
        metadata, name = entry.split(b"\t", 1)
        mode, sha, stage = metadata.split()
        if stage != b"0":
            raise RuntimeError("Resolve merge conflicts before committing.")
        if mode not in (b"100644", b"100755"):
            raise RuntimeError("Review symlinks or submodules before publishing.")
        indexed.append((name, sha))
    if not indexed:
        print("No indexed files to check.")
        return 0

    ignored = set(filter(None, git(
        root, "check-ignore", "--no-index", "-z", "--stdin",
        data=b"\0".join(name for name, _ in indexed) + b"\0", allowed=(0, 1)
    ).split(b"\0")))
    problems = [(name, "excluded by Git ignore rules") for name in sorted(ignored)]
    # Read index blobs, including staged changes that differ from the working copy.
    batch = git(root, "cat-file", "--batch", data=b"\n".join(sha for _, sha in indexed) + b"\n")
    position = 0
    for name, expected_sha in indexed:
        end = batch.index(b"\n", position)
        sha, kind, size = batch[position:end].split()
        if sha != expected_sha or kind != b"blob":
            raise RuntimeError("Unexpected Git object in index.")
        size = int(size)
        content = batch[end + 1:end + 1 + size]
        position = end + 2 + size
        if name in ignored:
            continue
        if size > 10 * 1024 * 1024:
            problems.append((name, "larger than the 10 MiB source-file limit"))
        for label, pattern in SECRET_PATTERNS:
            if pattern.search(content):
                problems.append((name, f"possible {label}; review locally"))

    for name, reason in problems:
        print(f"BLOCKED: {name.decode('utf-8', errors='replace')}: {reason}", file=sys.stderr)
    if problems:
        print("Remove private files from the index; keep local copies. Secret values are not displayed.", file=sys.stderr)
        return 1
    print(f"Upload check passed: {len(indexed)} indexed files; no ignored files or recognized secrets.")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        return check(args.repo)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Upload check failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
