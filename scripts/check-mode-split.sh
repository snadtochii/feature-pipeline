#!/usr/bin/env bash
# Check that the per-mode reference split holds: every `*-fs.md` under the
# feature plugin's skills tree is free of server-native vocabulary, every
# `*-server.md` is free of state-folder vocabulary, neither names a file of
# the other mode, every `-fs` file has its `-server` sibling in the same
# directory (and vice versa), and every relative markdown link under that
# tree resolves to an existing file.
#
# A mode file is loaded only by runs in its own storage mode, so a leaked
# token from the other mode is prose the reader pays for and can never use;
# a half pair means one mode has no procedure for that concern; a dangling
# link fails silently at runtime because nothing else in the repo resolves
# links. All of these are invisible to check-tool-parity.sh, which reads
# only SKILL.md frontmatter.
#
# The two token rules are probed against fixed strings before the scan
# (a regex regression fails the script before it can pass the tree).
#
# Usage:  scripts/check-mode-split.sh
# Exit:   0 all mode files clean, every pair complete, and every link
#         resolves; 1 on any violation, probe failure, or unreadable input.

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

# A state-folder token is a state name followed by "/". Two contexts are
# exempt because they are not folder references:
#   - a skill-directory path segment: `../review/references/x.md`,
#     `skills/review/…`, `address-review/SKILL.md` (preceded by `../`,
#     `skills/`, or `-`);
#   - a status-enum alternation: `done/cancelled`, `backlog/in-review/done`
#     (followed by another status word).
# Everything else — `backlog/FP-123`, `done/<id>`, a bare `review/`,
# `claudedocs/tickets/in-progress/` — is a leak.
_status = r"(?:backlog|in-progress|in-review|review|done|cancelled|partial-completion)"
server_forbidden = re.compile(
    r"(?<!\.\./)(?<!skills/)(?<!-)(?:backlog|in-progress|review|done)/(?!" + _status + r"\b)"
    r"|folder[- ]move|state folder|\S*-fs\.md",
    re.IGNORECASE,
)
link_re = re.compile(r"\[[^\]]*\]\(([^)\s]+?\.md)(#[^)]*)?\)")

# Regression probes — every string in `caught` must match, none in `clean`.
probes = {
    fs_forbidden: (
        ["a server-native run", "call pipeline_get_ticket", "mcp__plugin_x", "see storage-server.md"],
        ["the other storage mode", "the personal server", "storage.md"],
    ),
    server_forbidden: (
        ["move `backlog/FP-123`", "under done/ticket", "sits in review/ with", "claudedocs/tickets/in-progress/",
         "`done/<id>`", "a folder move", "no state folders exist", "see storage-fs.md"],
        ["the rest done/cancelled/partial-completion", "(backlog/in-review/done → in-progress)",
         "[x](../../review/references/pr-comments.md)", "skills/review/references/x.md",
         "../address-review/SKILL.md", "a review of the diff", "done and dusted"],
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
fs_files = server_files = links = 0
stems = {}  # (directory, stem) -> {"fs", "server"}

for path in sorted(skills_dir.rglob("*.md")):
    rel = path.relative_to(skills_dir.parent.parent.parent)
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

    for n, line in enumerate(lines, 1):
        for m in link_re.finditer(line):
            target = m.group(1)
            if target.startswith(("http://", "https://")):
                continue
            links += 1
            resolved = (path.parent / target).resolve()
            if not resolved.is_file():
                failures.append(f"{rel}:{n}: link target not found: {target}")

for (directory, stem), modes in sorted(stems.items()):
    rel_dir = directory.relative_to(skills_dir.parent.parent.parent)
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
print(f"  ok  {fs_files} fs file(s), {server_files} server file(s), {pairs} complete pair(s), {links} link(s) scanned")

if failures:
    print(f"\nFAIL ({len(failures)}):", file=sys.stderr)
    for failure in failures:
        print(f"  - {failure}", file=sys.stderr)
    sys.exit(1)

print(f"\nOK: mode files clean, every pair complete, and every relative .md link under {skills_dir.name}/ resolves")
PY
