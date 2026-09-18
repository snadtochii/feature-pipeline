"""Disposable prototype: complete Git snapshots without changing the real index."""

import os
from pathlib import Path
import subprocess
import tempfile


class RunError(Exception):
    pass


def git(repo, *args, env=None):
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, env=env, check=False
    )
    if result.returncode:
        raise RunError(result.stderr.decode(errors="replace").strip())
    return result.stdout


def text(repo, *args):
    return git(repo, *args).decode().strip()


def clean(repo):
    return not git(repo, "status", "--porcelain=v1", "--untracked-files=all")


def snapshot(repo):
    # Start from HEAD, not the user's index: include staged AND working-tree edits.
    # Ignore rules remain authoritative; no ignored files are added.
    with tempfile.TemporaryDirectory(prefix="codex-prototype-index-") as folder:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(folder) / "index"))
        git(repo, "read-tree", "HEAD", env=env)
        git(repo, "add", "-A", "--", ".", env=env)
        return git(repo, "write-tree", env=env).decode().strip()


def changed_paths(repo, base, tree):
    return [
        p.decode()
        for p in git(repo, "diff", "--no-renames", "--name-only", "-z", base, tree).split(b"\0")
        if p
    ]


def owned_snapshot(repo, ticket, record):
    tree = snapshot(repo)
    paths = changed_paths(repo, record["base"], tree)
    outside = [
        p for p in paths
        if not any(p == allowed or p.startswith(allowed + "/") for allowed in ticket["paths"])
    ]
    if outside:
        raise RunError("Changes outside this ticket's owned paths: " + ", ".join(outside))
    return tree, paths


def stage_paths(repo, paths):
    # Literal pathspecs handle names beginning with ':' and filenames with spaces.
    env = dict(os.environ, GIT_LITERAL_PATHSPECS="1")
    git(repo, "add", "-A", "--", *paths, env=env)


def patch(repo, base, tree):
    return git(repo, "diff", "--binary", "--no-ext-diff", "--no-textconv", base, tree)


def verify_pr(repo, url, branch, base, head):
    import json
    import re

    origin = subprocess.run(["gh", "repo", "view", "--json", "url"], cwd=repo,
                            capture_output=True, text=True, check=False)
    if origin.returncode:
        raise RunError("Cannot resolve this checkout's GitHub repository")
    repository_url = json.loads(origin.stdout)["url"].rstrip("/")
    if not re.fullmatch(re.escape(repository_url) + r"/pull/[1-9][0-9]*", url):
        raise RunError("PR URL does not belong to this checkout's GitHub repository")

    result = subprocess.run(
        ["gh", "pr", "view", url, "--json",
         "url,state,headRefOid,headRefName,baseRefName,isCrossRepository"],
        cwd=repo, capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise RunError("PR verification failed: " + result.stderr.strip())
    pr = json.loads(result.stdout)
    if (pr["state"] != "OPEN" or pr["headRefOid"] != head
            or pr["headRefName"] != branch or pr["baseRefName"] != base
            or pr["isCrossRepository"]):
        raise RunError("PR does not match the open, same-repository, verified branch/base/head")
    return pr
