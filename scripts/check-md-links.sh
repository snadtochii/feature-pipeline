#!/usr/bin/env bash
# Every relative markdown link inside the repository's own documentation trees
# resolves to an existing file.
#
# A dangling link fails silently at runtime: nothing in this repository resolves
# links, so a reference to a file that was renamed or deleted simply sends a
# reader — or an agent loading a skill's reference — nowhere. That makes it the
# characteristic failure of any change that moves or removes a document, which
# is exactly when nobody is looking for it.
#
# The roots are listed below. Adding a documentation tree is one line; the rule
# itself is the same for all of them, which is why it is a check of its own
# rather than a passenger on a rule that applies to one tree.
#
# What this deliberately leaves unguarded, so a later reader knows the shape of
# the hole rather than assuming there is none:
#   - a relative link whose target is not a `.md` file (a directory, an image);
#   - the `#anchor` fragment, captured and discarded — a link to a heading the
#     target file does not contain still resolves and passes;
#   - reference-style links, `[text][ref]` with the target defined elsewhere;
#   - links pointing INTO these roots from files outside them (the root README,
#     CLAUDE.md, AGENTS.md): those files quote illustrative relative links
#     inside their own templates, which a scan would false-positive on.
#
# Usage:  scripts/check-md-links.sh
# Exit:   0 every relative .md link in every root resolves; 1 on any dangling
#         link, a root that does not exist, or a root that yields no markdown.

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)

# The documentation trees this repository owns. One line per root.
roots=(
  "plugins/feature/skills"
  "plugins/tidy-loop"
  "plugins/deepen"
)

for root in "${roots[@]}"; do
  if [ ! -d "$repo_root/$root" ]; then
    echo "FAIL: scan root not found at $repo_root/$root" >&2
    exit 1
  fi
done

python3 - "$repo_root" "${roots[@]}" <<'PY'
import pathlib
import re
import sys

repo_root = pathlib.Path(sys.argv[1])
roots = [repo_root / arg for arg in sys.argv[2:]]

# Inline `[text](target.md)` only. Group 2 is the `#anchor`, captured so the
# target parses cleanly and then discarded — see the header for what that
# leaves unguarded.
link_re = re.compile(r"\[[^\]]*\]\(([^)\s]+?\.md)(#[^)]*)?\)")

# Regression probes: the rule has to still match what it is for.
probe_failures = []
for text, should_match in (
    ("[x](a.md)", True),
    ("[x](../b/c.md#frag)", True),
    ("[x](https://example.com/d.md)", True),  # matched, then skipped as remote
    ("[x](dir/)", False),
    ("[x][ref]", False),
):
    if bool(link_re.search(text)) is not should_match:
        probe_failures.append(text)
if probe_failures:
    print(f"FAIL: link-rule regression ({len(probe_failures)}):", file=sys.stderr)
    for f in probe_failures:
        print(f"  - {f}", file=sys.stderr)
    sys.exit(1)

# Vendored or generated trees: never the repository's own documentation.
# Deliberately narrow. Names like `build` and `dist` are legitimate first-party
# directories here (plugins/feature/skills/build is a skill), and pruning one
# would silently shrink the scanned set rather than fail. `node_modules` must
# stay: the checks fixtures install pinned toolchains under them, so a machine
# that has run the checks runner would otherwise scan third-party package
# documentation whose relative links point at files npm does not ship.
pruned = {"node_modules", ".git", "__pycache__"}

failures = []
counts = {}

for root in roots:
    docs = links = 0
    for path in sorted(root.rglob("*.md")):
        if pruned & set(path.relative_to(root).parts):
            continue
        rel = path.relative_to(repo_root)
        docs += 1
        for n, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
            for m in link_re.finditer(line):
                target = m.group(1)
                if target.startswith(("http://", "https://")):
                    continue
                links += 1
                if not (path.parent / target).resolve().is_file():
                    failures.append(f"{rel}:{n}: link target not found: {target}")

    counts[root] = (docs, links)
    # A root that yields zero markdown files is a hard failure: a mistyped root
    # would otherwise turn its share of the check into a silent no-op.
    if docs == 0:
        print(f"FAIL: no markdown files found under {root}", file=sys.stderr)
        sys.exit(1)

for root in roots:
    docs, links = counts[root]
    print(f"  ok  {root.relative_to(repo_root)}: {docs} markdown file(s), {links} link(s) scanned")

if failures:
    print(f"\nFAIL ({len(failures)}):", file=sys.stderr)
    for failure in failures:
        print(f"  - {failure}", file=sys.stderr)
    sys.exit(1)

print(
    "\nOK: every relative .md link resolves under "
    + ", ".join(f"{root.relative_to(repo_root)}/" for root in roots)
)
PY
