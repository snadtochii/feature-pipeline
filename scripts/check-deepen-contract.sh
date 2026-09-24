#!/usr/bin/env bash
# The deepen plugin's role contract: every agent that can write is fenced to a
# named set the fence contract defines, and every agent that is not fenced can
# neither write nor delegate.
#
# The fence is the run's central control. A writing agent with no binding, a
# binding that names a set the contract does not define, or a binding whose mode
# disagrees with the contract's table would each leave a role free to edit what
# its change is judged against — silently, since an unbound agent simply writes.
# There are no per-agent exceptions: the rule is the same for every file under
# plugins/deepen/agents/.
#
# Asserts:
#   - plugins/deepen/skills/run/references/fence.md's `## §3 Sets` table yields
#     at least one `| `<set>` | `<mode>` |` row, mode deny-match or allow-only;
#   - plugins/deepen/hooks/fence.sh exists and is executable;
#   - plugins/deepen/agents/ holds at least one agent, and each declares its
#     tools as a YAML list (an omitted `tools:` inherits every tool);
#   - an agent listing Write, Edit, MultiEdit, NotebookEdit or Bash has exactly
#     one PreToolUse binding of the exact form
#     `"${CLAUDE_PLUGIN_ROOT}/hooks/fence.sh <mode> <set>"`, whose set is a row
#     of the table in that row's mode, whose matcher covers Write, Edit,
#     MultiEdit and every file-write tool the agent lists, and it lists neither
#     Agent nor Task;
#   - an agent with no binding lists none of Bash, Write, Edit, MultiEdit,
#     NotebookEdit, Agent, Task.
#
# Usage:  scripts/check-deepen-contract.sh
# Exit:   0 every assertion holds; 1 on any failure, one FAIL line each.

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
python3 - "$repo_root" <<'PY'
import os
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
plugin = root / "plugins/deepen"
fence_md = plugin / "skills/run/references/fence.md"
hook = plugin / "hooks/fence.sh"
errors = []

MODES = {"deny-match", "allow-only"}
FILE_WRITE = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
MUTATING = FILE_WRITE | {"Bash"}
DELEGATING = {"Agent", "Task"}
BINDING_RE = re.compile(
    r'^\s+command: "\$\{CLAUDE_PLUGIN_ROOT\}/hooks/fence\.sh (\S+) (\S+)"$'
)
ROW_RE = re.compile(r"^\| `([a-z][a-z0-9-]*)` \| `([a-z-]+)` \|", re.M)

# The set table.
sets = {}
if not fence_md.is_file():
    errors.append(f"missing fence contract: {fence_md.relative_to(root)}")
else:
    section = re.search(
        r"^## §3 Sets\n(.*?)(?=^## |^---$|\Z)", fence_md.read_text(), re.M | re.S
    )
    if not section:
        errors.append("fence.md: missing `## §3 Sets` section")
    else:
        for name, mode in ROW_RE.findall(section.group(1)):
            if mode not in MODES:
                errors.append(f"fence.md §3: set `{name}` has unknown mode `{mode}`")
            elif name in sets:
                errors.append(f"fence.md §3: set `{name}` defined twice")
            else:
                sets[name] = mode
        if not sets and not any("fence.md §3" in e for e in errors):
            errors.append("fence.md §3: the Sets table defines no set")

# The hook every binding names.
if not hook.is_file():
    errors.append(f"missing fence hook: {hook.relative_to(root)}")
elif not os.access(hook, os.X_OK):
    errors.append(f"fence hook is not executable: {hook.relative_to(root)}")

# The agents.
agents = sorted((plugin / "agents").glob("*.md")) if (plugin / "agents").is_dir() else []
if not agents:
    errors.append("plugins/deepen/agents/: no agent definitions found")

fenced = []
read_only = []
for path in agents:
    name = path.stem
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n") or text.count("---") < 2:
        errors.append(f"{name}: no frontmatter")
        continue
    frontmatter = text.split("---", 2)[1]

    # An omitted `tools:` inherits every tool, and an inline or unindented list
    # would parse as no tools — each would pass as read-only, so each fails.
    if not re.search(r"^tools:", frontmatter, re.M):
        errors.append(f"{name}: no `tools:` list — an agent without one inherits every tool")
        continue
    tools_block = re.search(r"^tools:[ \t]*\n((?:  - .*\n?)+)", frontmatter, re.M)
    if not tools_block:
        errors.append(f"{name}: `tools:` is not a YAML list of 2-space `  - <Tool>` items")
        continue
    tools = set(re.findall(r"^  - (\S+)$", tools_block.group(1), re.M))

    # Every line naming the hook must be an exact binding.
    bindings = []
    matcher = None
    event = None
    for line in frontmatter.split("\n"):
        event_m = re.match(r"^  ([A-Za-z]+):\s*$", line)
        if event_m:
            event = event_m.group(1)
        matcher_m = re.match(r'^\s+- matcher: "([^"]*)"\s*$', line)
        if matcher_m:
            matcher = matcher_m.group(1)
        if "fence.sh" in line:
            binding_m = BINDING_RE.match(line)
            if not binding_m:
                errors.append(f"{name}: malformed fence binding: {line.strip()}")
                continue
            bindings.append((binding_m.group(1), binding_m.group(2), matcher, event))

    held_mutating = sorted(tools & MUTATING)
    held_delegating = sorted(tools & DELEGATING)

    if not bindings:
        banned = sorted(tools & (MUTATING | DELEGATING))
        if banned:
            errors.append(f"{name}: lists {banned} with no fence binding")
        else:
            read_only.append(name)
        continue

    if len(bindings) != 1:
        errors.append(f"{name}: {len(bindings)} fence bindings — exactly one allowed")
        continue
    mode, set_name, bound_matcher, bound_event = bindings[0]
    if bound_event != "PreToolUse":
        errors.append(f"{name}: fence binding is under `{bound_event}`, not `PreToolUse`")
    if mode not in MODES:
        errors.append(f"{name}: fence binding mode `{mode}` is not deny-match or allow-only")
    if set_name not in sets:
        errors.append(f"{name}: fence binding names set `{set_name}`, which fence.md §3 does not define")
    elif sets[set_name] != mode:
        errors.append(
            f"{name}: fence binding runs set `{set_name}` in `{mode}`; fence.md §3 defines it as `{sets[set_name]}`"
        )
    covered = set((bound_matcher or "").split("|"))
    missing = sorted(({"Write", "Edit", "MultiEdit"} | (tools & FILE_WRITE)) - covered)
    if missing:
        errors.append(f"{name}: fence matcher `{bound_matcher}` does not cover {missing}")
    if held_delegating:
        errors.append(f"{name}: fenced agent lists {held_delegating}")
    fenced.append(f"{name}: {mode} {set_name}")

if errors:
    print("\n".join(f"FAIL: {error}" for error in errors), file=sys.stderr)
    sys.exit(1)
print(
    f"OK: {len(agents)} deepen agents — {len(fenced)} fenced ({', '.join(fenced)}), "
    f"{len(read_only)} read-only; {len(sets)} sets in fence.md; hook executable"
)
PY
