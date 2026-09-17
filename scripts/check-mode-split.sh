#!/usr/bin/env bash
# The per-mode reference split under plugins/feature/skills: every `*-fs.md` is
# free of server-native vocabulary, every `*-server.md` is free of state-folder
# vocabulary, neither names a file of the other mode, and every `-fs` file has
# its `-server` sibling in the same directory (and vice versa).
#
# A mode file is loaded only by runs in its own storage mode, so a leaked token
# from the other mode is prose the reader pays for and can never use, and a half
# pair means one mode has no procedure for that concern. Both are invisible to
# check-tool-parity.sh, which reads only SKILL.md frontmatter.
#
# Relative markdown links are checked by scripts/check-md-links.sh, which spans
# every documentation tree rather than this one alone.
#
# Usage:  scripts/check-mode-split.sh
# Exit:   0 all mode files clean and every pair complete; 1 on any violation,
#         probe failure, empty scan root, or unreadable input.

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
skills_dir="$repo_root/plugins/feature/skills"

if [ ! -d "$skills_dir" ]; then
  echo "FAIL: skills directory not found at $skills_dir" >&2
  exit 1
fi

python3 - "$repo_root" "$skills_dir" <<'PY'
import pathlib
import re
import sys

repo_root = pathlib.Path(sys.argv[1])
skills_dir = pathlib.Path(sys.argv[2])

fs_forbidden = re.compile(r"server-native|pipeline_|mcp__|\S*-server\.md")

# A state-folder token is a whole-word state name followed by "/" — so
# `preview/assets` and `undone/file` are not tokens. Three specific contexts
# are exempt because they are not folder references:
#   - a skill-directory path segment: `../review/references/x.md`,
#     `skills/review/…` (preceded by `../` or `skills/`);
#   - the two hyphenated compounds that end in a state name and are not
#     folders: `address-review/` (a skill directory) and `in-review/` (the
#     status, inside an enum alternation);
#   - a status-enum alternation: `done/cancelled`, `backlog/in-review/done`
#     (followed by another status word).
# Everything else — `backlog/FP-123`, `done/<id>`, `pre-review/FP-123`, a
# bare `review/`, `claudedocs/tickets/in-progress/` — is a leak.
_status = r"(?:backlog|in-progress|in-review|review|done|cancelled|partial-completion)"
server_forbidden = re.compile(
    r"(?<!\w)(?<!\.\./)(?<!skills/)(?<!address-)(?<!in-)(?:backlog|in-progress|review|done)/(?!" + _status + r"\b)"
    r"|folder[- ]move|state folder|\S*-fs\.md",
    re.IGNORECASE,
)

# Regression probes — every string in `caught` must match, none in `clean`.
probes = {
    fs_forbidden: (
        ["a server-native run", "call pipeline_get_ticket", "mcp__plugin_x", "see storage-server.md"],
        ["the other storage mode", "the personal server", "storage.md"],
    ),
    server_forbidden: (
        ["move `backlog/FP-123`", "under done/ticket", "sits in review/ with", "claudedocs/tickets/in-progress/",
         "`done/<id>`", "pre-review/FP-123", "a folder move", "no state folders exist", "see storage-fs.md"],
        ["the rest done/cancelled/partial-completion", "(backlog/in-review/done → in-progress)",
         "[x](../../review/references/pr-comments.md)", "skills/review/references/x.md",
         "../address-review/SKILL.md", "preview/assets", "undone/file", "a review of the diff", "done and dusted"],
    ),
}
probe_failures = []
for rx, (caught, clean) in probes.items():
    for s in caught:
        if not rx.search(s):
            probe_failures.append(f"regex {rx.pattern[:40]!r}… should catch {s!r}")
    for s in clean:
        if rx.search(s):
            probe_failures.append(f"regex {rx.pattern[:40]!r}… should not catch {s!r}")
if probe_failures:
    print(f"FAIL: token-rule regression ({len(probe_failures)}):", file=sys.stderr)
    for f in probe_failures:
        print(f"  - {f}", file=sys.stderr)
    sys.exit(1)

failures = []
fs_files = server_files = 0
stems = {}  # (directory, stem) -> {"fs", "server"}

# A scan root that yields zero markdown files is a hard failure: a mistyped
# root would otherwise turn the check into a silent no-op.
counts = {}

# Vendored or generated trees: never the repository's own documentation.
# Deliberately narrow. Names like `build` and `dist` are legitimate
# first-party directories here (plugins/feature/skills/build is a skill),
# and pruning one would silently shrink the scanned set rather than fail.
pruned = {"node_modules", ".git", "__pycache__"}

for root in (skills_dir,):
    docs = 0
    for path in sorted(root.rglob("*.md")):
        if pruned & set(path.relative_to(root).parts):
            continue
        rel = path.relative_to(repo_root)
        docs += 1
        lines = path.read_text(encoding="utf-8").split("\n")

        if path.name.endswith("-fs.md"):
            fs_files += 1
            stems.setdefault((path.parent, path.name[: -len("-fs.md")]), set()).add("fs")
            for n, line in enumerate(lines, 1):
                for m in fs_forbidden.finditer(line):
                    failures.append(f"{rel}:{n}: fs file mentions '{m.group(0)}'")
        elif path.name.endswith("-server.md"):
            server_files += 1
            stems.setdefault((path.parent, path.name[: -len("-server.md")]), set()).add("server")
            for n, line in enumerate(lines, 1):
                for m in server_forbidden.finditer(line):
                    failures.append(f"{rel}:{n}: server file mentions '{m.group(0)}'")

    counts[root] = docs
    if docs == 0:
        print(f"FAIL: no markdown files found under {root}", file=sys.stderr)
        sys.exit(1)

for (directory, stem), modes in sorted(stems.items()):
    rel_dir = directory.relative_to(repo_root)
    if "fs" not in modes:
        failures.append(f"{rel_dir}/{stem}-server.md: no {stem}-fs.md sibling")
    if "server" not in modes:
        failures.append(f"{rel_dir}/{stem}-fs.md: no {stem}-server.md sibling")

if fs_files == 0 or server_files == 0:
    print(
        f"FAIL: expected at least one *-fs.md and one *-server.md under {skills_dir}; "
        f"found fs={fs_files} server={server_files}",
        file=sys.stderr,
    )
    sys.exit(1)

pairs = sum(1 for modes in stems.values() if modes == {"fs", "server"})
print(f"  ok  {skills_dir.relative_to(repo_root)}: {counts[skills_dir]} markdown file(s) scanned")
print(f"  ok  {fs_files} fs file(s), {server_files} server file(s), {pairs} complete pair(s)")

if failures:
    print(f"\nFAIL ({len(failures)}):", file=sys.stderr)
    for failure in failures:
        print(f"  - {failure}", file=sys.stderr)
    sys.exit(1)

print(f"\nOK: mode files clean and every pair complete under {skills_dir.relative_to(repo_root)}/")
PY
