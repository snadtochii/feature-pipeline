#!/usr/bin/env bash
# Check that the per-mode reference split holds: every `*-fs.md` under the
# feature plugin's skills tree is free of server-native vocabulary, every
# `*-server.md` is free of state-folder vocabulary, neither names a file of
# the other mode, and every relative markdown link under that tree resolves
# to an existing file.
#
# A mode file is loaded only by runs in its own storage mode, so a leaked
# token from the other mode is prose the reader pays for and can never use;
# a dangling link fails silently at runtime because nothing else in the repo
# resolves links. Both defects are invisible to check-tool-parity.sh, which
# reads only SKILL.md frontmatter.
#
# Usage:  scripts/check-mode-split.sh
# Exit:   0 all mode files clean and every link resolves, 1 on any violation
#         or unreadable input.

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
skills_dir="$repo_root/plugins/feature/skills"

if [ ! -d "$skills_dir" ]; then
  echo "FAIL: skills directory not found at $skills_dir" >&2
  exit 1
fi

python3 - "$skills_dir" <<'PY'
import pathlib
import re
import sys

skills_dir = pathlib.Path(sys.argv[1])

fs_forbidden = re.compile(r"server-native|pipeline_|mcp__|\S*-server\.md")
# A state-folder token is the folder name followed by "/" and then NOT a
# path-continuing character: `done/<id>`, `in-progress/`, `review/` all match;
# `done/cancelled` (status alternation) and `../review/references/x.md` (the
# review skill's directory inside a link) do not.
server_forbidden = re.compile(
    r"\b(?:backlog|in-progress|review|done)/(?![A-Za-z0-9_])"
    r"|folder[- ]move|state folder|\S*-fs\.md",
    re.IGNORECASE,
)
link_re = re.compile(r"\[[^\]]*\]\(([^)\s]+?\.md)(#[^)]*)?\)")

failures = []
fs_files = server_files = links = 0

for path in sorted(skills_dir.rglob("*.md")):
    rel = path.relative_to(skills_dir.parent.parent.parent)
    lines = path.read_text(encoding="utf-8").split("\n")

    if path.name.endswith("-fs.md"):
        fs_files += 1
        for n, line in enumerate(lines, 1):
            for m in fs_forbidden.finditer(line):
                failures.append(f"{rel}:{n}: fs file mentions '{m.group(0)}'")
    elif path.name.endswith("-server.md"):
        server_files += 1
        for n, line in enumerate(lines, 1):
            for m in server_forbidden.finditer(line):
                failures.append(f"{rel}:{n}: server file mentions '{m.group(0)}'")

    for n, line in enumerate(lines, 1):
        for m in link_re.finditer(line):
            target = m.group(1)
            if target.startswith(("http://", "https://")):
                continue
            links += 1
            resolved = (path.parent / target).resolve()
            if not resolved.is_file():
                failures.append(f"{rel}:{n}: link target not found: {target}")

if fs_files == 0 or server_files == 0:
    print(
        f"FAIL: expected at least one *-fs.md and one *-server.md under {skills_dir}; "
        f"found fs={fs_files} server={server_files}",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"  ok  {fs_files} fs file(s), {server_files} server file(s), {links} link(s) scanned")

if failures:
    print(f"\nFAIL ({len(failures)}):", file=sys.stderr)
    for failure in failures:
        print(f"  - {failure}", file=sys.stderr)
    sys.exit(1)

print(f"\nOK: mode files clean and every relative .md link under {skills_dir.name}/ resolves")
PY
