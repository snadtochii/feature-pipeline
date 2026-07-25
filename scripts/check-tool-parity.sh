#!/usr/bin/env bash
# Check that every skill's `pipeline_*` allowed-tools entries are dual-listed
# correctly: one bare name and one plugin-scoped name per tool, with the two
# sets identical.
#
# The scoped prefix is DERIVED from the connector plugin's manifest — its
# `name` plus its single `mcpServers` key — so renaming either is caught here
# instead of failing silently at runtime. A bare-only list grants nothing on
# Claude Code and raises no error, which is exactly the drift this guards.
#
# Usage:  scripts/check-tool-parity.sh
# Exit:   0 all skills consistent, 1 on any mismatch or unreadable input.

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
connector_manifest="$repo_root/plugins/server-native/.claude-plugin/plugin.json"
skills_dir="$repo_root/plugins/feature/skills"

if [ ! -f "$connector_manifest" ]; then
  echo "FAIL: connector manifest not found at $connector_manifest" >&2
  exit 1
fi

python3 - "$connector_manifest" "$skills_dir" <<'PY'
import json
import pathlib
import re
import sys

manifest_path, skills_dir = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])

manifest = json.loads(manifest_path.read_text())
plugin_name = manifest.get("name")
servers = list((manifest.get("mcpServers") or {}).keys())

if not plugin_name or len(servers) != 1:
    print(
        f"FAIL: expected exactly one mcpServers key and a plugin name in "
        f"{manifest_path}; got name={plugin_name!r} servers={servers!r}",
        file=sys.stderr,
    )
    sys.exit(1)

prefix = f"mcp__plugin_{plugin_name}_{servers[0]}__"
print(f"derived scoped prefix: {prefix}")

bare_re = re.compile(r"^  - (pipeline_\w+)$")
scoped_re = re.compile(r"^  - " + re.escape(prefix) + r"(pipeline_\w+)$")
stray_re = re.compile(r"^  - (mcp__plugin_\S*?pipeline_\w+)$")

failures = []
checked = 0

for skill in sorted(skills_dir.glob("*/SKILL.md")):
    lines = skill.read_text().split("\n")
    fences = [i for i, line in enumerate(lines) if line == "---"][:2]
    if len(fences) != 2:
        failures.append(f"{skill}: no frontmatter fences")
        continue
    front = lines[fences[0]:fences[1]]

    bare = [m.group(1) for line in front if (m := bare_re.match(line))]
    scoped = [m.group(1) for line in front if (m := scoped_re.match(line))]
    stray = [
        m.group(1)
        for line in front
        if (m := stray_re.match(line)) and not scoped_re.match(line)
    ]

    if not bare and not scoped and not stray:
        continue  # skill declares no pipeline tools at all

    checked += 1
    name = skill.parent.name

    if stray:
        failures.append(
            f"{name}: {len(stray)} scoped entr(ies) do not match the derived prefix "
            f"{prefix} — {stray}"
        )
    if sorted(bare) != sorted(scoped):
        only_bare = sorted(set(bare) - set(scoped))
        only_scoped = sorted(set(scoped) - set(bare))
        detail = []
        if only_bare:
            detail.append(f"missing scoped: {only_bare}")
        if only_scoped:
            detail.append(f"missing bare: {only_scoped}")
        failures.append(f"{name}: bare/scoped mismatch — {'; '.join(detail)}")
    elif not stray:
        print(f"  ok  {name}: {len(bare)} tool(s) dual-listed")

if not checked:
    print("FAIL: no skill declared any pipeline_* tools — check the skills path", file=sys.stderr)
    sys.exit(1)

if failures:
    print(f"\nFAIL ({len(failures)}):", file=sys.stderr)
    for failure in failures:
        print(f"  - {failure}", file=sys.stderr)
    sys.exit(1)

print(f"\nOK: {checked} skill(s) consistent against {prefix}")
PY
