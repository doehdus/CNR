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

SOURCE_LIMIT = 10 * 1024 * 1024
RESEARCH_LIMIT = 100 * 1024 * 1024
SECRET_MARKERS = {
    "private key": (b"-----begin",),
    "GitHub token": (b"ghp_", b"gho_", b"ghu_", b"ghs_", b"ghr_", b"github_pat_"),
    "AWS access key": (b"akia", b"asia"),
    "OpenAI token": (b"sk-",),
    "Slack token": (b"xox",),
    "credential in URL": (b"http",),
    "credential assignment": (b"api", b"client", b"access", b"auth", b"password", b"secret"),
}


def file_limit(name):
    return RESEARCH_LIMIT if name.startswith((b"data/", b"analysis/results/", b"analysis/graphs/", b"experiment/")) else SOURCE_LIMIT


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
    # One request/response at a time avoids buffering the entire research index.
    command = ["git", "-c", f"safe.directory={root.resolve().as_posix()}", "-C", str(root), "cat-file", "--batch"]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    scanned = {}
    try:
        for name, expected_sha in indexed:
            if expected_sha not in scanned:
                process.stdin.write(expected_sha + b"\n"); process.stdin.flush()
                sha, kind, length = process.stdout.readline().split()
                if sha != expected_sha or kind != b"blob": raise RuntimeError("Unexpected Git object in index.")
                size = int(length)
                if size <= RESEARCH_LIMIT:
                    content = process.stdout.read(size)
                    if len(content) != size: raise RuntimeError("Incomplete Git object in index.")
                    lower_content = content.lower()
                    labels = [label for label, pattern in SECRET_PATTERNS
                              if any(marker in lower_content for marker in SECRET_MARKERS[label]) and pattern.search(content)]
                else:
                    remaining = size
                    while remaining:
                        chunk = process.stdout.read(min(remaining, 1024 * 1024))
                        if not chunk: raise RuntimeError("Incomplete Git object in index.")
                        remaining -= len(chunk)
                    labels = []  # Oversized objects are rejected regardless of contents.
                if process.stdout.read(1) != b"\n": raise RuntimeError("Unexpected Git object boundary.")
                scanned[expected_sha] = size, labels
            size, labels = scanned[expected_sha]
            if name in ignored: continue
            limit = file_limit(name)
            if size > limit:
                kind = "research-data" if limit == RESEARCH_LIMIT else "source-file"
                problems.append((name, f"larger than the {limit // (1024 * 1024)} MiB {kind} limit"))
            problems.extend((name, f"possible {label}; review locally") for label in labels)
        process.stdin.close()
        if process.wait(timeout=30): raise RuntimeError("Could not inspect Git objects.")
    finally:
        if process.poll() is None:
            process.kill(); process.wait()
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream and not stream.closed: stream.close()

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
