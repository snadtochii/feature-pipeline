#!/usr/bin/env bash
# The deepen plugin's role contract: the fence hook is bound plugin-wide, every
# agent that can write is fenced to a named set the fence contract defines, and
# every agent that is not fenced can neither write nor delegate.
#
# The fence is the run's central control. Claude Code ignores `hooks:` in a
# plugin agent's frontmatter, so deepen binds one PreToolUse hook in its own
# hooks/hooks.json and fence.sh dispatches on the payload's `agent_type` through
# its FENCE_MAP. A missing or mis-matched binding, a writing agent with no map
# row, or a map row that disagrees with the contract's table would each leave a
# role free to edit what its change is judged against — silently, since an
# unfenced write simply lands. There are no per-agent exceptions: the rule is
# the same for every file under plugins/deepen/agents/.
#
# Asserts:
#   - plugins/deepen/skills/run/references/fence.md's `## §3 Sets` table yields
#     at least one `| `<set>` | `<mode>` | `deepen:<agent>` |` row, mode
#     deny-match or allow-only, no set or agent twice;
#   - plugins/deepen/hooks/fence.sh exists and is executable;
#   - plugins/deepen/hooks/hooks.json exists, parses as JSON, and binds exactly
#     one command hook, `${CLAUDE_PLUGIN_ROOT}/hooks/fence.sh`, under
#     `PreToolUse`, whose matcher covers Write, Edit, MultiEdit, NotebookEdit;
#   - fence.sh's FENCE_MAP block holds `<agent> <mode> <set>` rows, and the rows
#     equal the §3 table's (agent, mode, set) triples, in both directions;
#   - every FENCE_MAP row names an existing plugins/deepen/agents/<agent>.md;
#   - plugins/deepen/agents/ holds at least one agent, each declares its tools as
#     a YAML list (an omitted `tools:` inherits every tool), and none carries a
#     `hooks:` frontmatter key (Claude Code ignores it on a plugin agent, so it
#     would read as a fence that is not there);
#   - an agent listing Write, Edit, MultiEdit, NotebookEdit or Bash has a
#     FENCE_MAP row and lists neither Agent nor Task;
#   - an agent with no row lists none of Bash, Write, Edit, MultiEdit,
#     NotebookEdit, Agent, Task;
#   - plugins/deepen/skills/run/references/stage-5-verify.md carries, between
#     `<!-- BEGIN confidence-scale -->` and `<!-- END confidence-scale -->`,
#     exactly lines 5-15 of plugins/feature/skills/review-stage/references/
#     confidence-scale.md — the reviewer rubric it inlines;
#   - plugins/deepen/skills/run/scripts/hotspots.sh, candidate-id.sh and
#     touched-coverage.mjs are executable and their --self-test reproduces the
#     worked example of their contract (hotspots.md §8, candidates.md §4,
#     coverage.md §2); the .mjs script runs under node, whose absence fails.
#
# Usage:  scripts/check-deepen-contract.sh
# Exit:   0 every assertion holds; 1 on any failure, one FAIL line each.

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
python3 - "$repo_root" <<'PY'
import json
import os
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
plugin = root / "plugins/deepen"
fence_md = plugin / "skills/run/references/fence.md"
hook = plugin / "hooks/fence.sh"
hooks_json = plugin / "hooks/hooks.json"
errors = []

MODES = {"deny-match", "allow-only"}
FILE_WRITE = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
MUTATING = FILE_WRITE | {"Bash"}
DELEGATING = {"Agent", "Task"}
HOOK_COMMAND = "${CLAUDE_PLUGIN_ROOT}/hooks/fence.sh"
ROW_RE = re.compile(
    r"^\| `([a-z][a-z0-9-]*)` \| `([a-z-]+)` \| `deepen:([a-z][a-z0-9-]*)`", re.M
)
NAME_RE = re.compile(r"^[a-z][a-z0-9-]*$")

# The set table: set -> (mode, agent).
table = {}
if not fence_md.is_file():
    errors.append(f"missing fence contract: {fence_md.relative_to(root)}")
else:
    section = re.search(
        r"^## §3 Sets\n(.*?)(?=^## |^---$|\Z)", fence_md.read_text(), re.M | re.S
    )
    if not section:
        errors.append("fence.md: missing `## §3 Sets` section")
    else:
        seen_agents = set()
        for name, mode, agent in ROW_RE.findall(section.group(1)):
            if mode not in MODES:
                errors.append(f"fence.md §3: set `{name}` has unknown mode `{mode}`")
            elif name in table:
                errors.append(f"fence.md §3: set `{name}` defined twice")
            elif agent in seen_agents:
                errors.append(f"fence.md §3: agent `deepen:{agent}` bound to two sets")
            else:
                table[name] = (mode, agent)
                seen_agents.add(agent)
        if not table and not any("fence.md §3" in e for e in errors):
            errors.append("fence.md §3: the Sets table defines no set")
table_triples = {(agent, mode, name) for name, (mode, agent) in table.items()}

# The hook script and its agent-to-set map.
fence_map = {}
if not hook.is_file():
    errors.append(f"missing fence hook: {hook.relative_to(root)}")
else:
    if not os.access(hook, os.X_OK):
        errors.append(f"fence hook is not executable: {hook.relative_to(root)}")
    block = re.search(
        r"^# BEGIN FENCE_MAP\n(.*?)^# END FENCE_MAP$", hook.read_text(), re.M | re.S
    )
    if not block:
        errors.append("fence.sh: no `# BEGIN FENCE_MAP` ... `# END FENCE_MAP` block")
    else:
        for line in block.group(1).split("\n"):
            line = line.strip()
            if line in ("", "FENCE_MAP='", "'"):
                continue
            parts = line.split()
            if len(parts) != 3 or not NAME_RE.match(parts[0]) or not NAME_RE.match(parts[2]):
                errors.append(f"fence.sh FENCE_MAP: malformed row: {line}")
                continue
            agent, mode, set_name = parts
            if mode not in MODES:
                errors.append(f"fence.sh FENCE_MAP: `{agent}` has unknown mode `{mode}`")
            if agent in fence_map:
                errors.append(f"fence.sh FENCE_MAP: `{agent}` mapped twice")
                continue
            fence_map[agent] = (mode, set_name)
        if not fence_map:
            errors.append("fence.sh FENCE_MAP: no rows")
map_triples = {(agent, mode, name) for agent, (mode, name) in fence_map.items()}
# A row whose agent has no definition dispatches for nothing: the lockstep holds
# while the role the table promises is missing.
for agent in sorted(fence_map):
    if not (plugin / "agents" / f"{agent}.md").is_file():
        errors.append(f"fence.sh FENCE_MAP row `{agent}` names no agent file")
if table and fence_map:
    for agent, mode, name in sorted(map_triples - table_triples):
        errors.append(
            f"fence.sh FENCE_MAP row `{agent} {mode} {name}` has no matching fence.md §3 row"
        )
    for agent, mode, name in sorted(table_triples - map_triples):
        errors.append(
            f"fence.md §3 row `{name}` ({mode}, deepen:{agent}) has no matching fence.sh FENCE_MAP row"
        )

# The plugin-level binding.
if not hooks_json.is_file():
    errors.append(f"missing hook binding: {hooks_json.relative_to(root)}")
else:
    try:
        config = json.loads(hooks_json.read_text(encoding="utf-8"))
    except ValueError as exc:
        config = None
        errors.append(f"hooks.json does not parse: {exc}")
    if config is not None:
        events = config.get("hooks") if isinstance(config, dict) else None
        if not isinstance(events, dict):
            errors.append("hooks.json: no top-level `hooks` object")
            events = {}
        bindings = []
        for event, groups in events.items():
            for group in groups if isinstance(groups, list) else []:
                if not isinstance(group, dict):
                    continue
                for entry in group.get("hooks") or []:
                    command = entry.get("command", "") if isinstance(entry, dict) else ""
                    if "fence.sh" in str(command):
                        bindings.append((event, group.get("matcher", ""), entry))
        if len(bindings) != 1:
            errors.append(f"hooks.json: {len(bindings)} fence.sh bindings — exactly one allowed")
        for event, matcher, entry in bindings:
            if event != "PreToolUse":
                errors.append(f"hooks.json: fence.sh is bound under `{event}`, not `PreToolUse`")
            if entry.get("type") != "command" or entry.get("command") != HOOK_COMMAND:
                errors.append(
                    f"hooks.json: fence binding is not the command `{HOOK_COMMAND}`: {json.dumps(entry)}"
                )
            covered = set(str(matcher).split("|"))
            missing = sorted(FILE_WRITE - covered)
            if missing:
                errors.append(f"hooks.json: fence matcher `{matcher}` does not cover {missing}")

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

    if re.search(r"^hooks:", frontmatter, re.M):
        errors.append(
            f"{name}: `hooks:` in frontmatter — Claude Code ignores it on a plugin agent; "
            "the fence is bound in hooks/hooks.json and mapped in fence.sh's FENCE_MAP"
        )

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

    held_delegating = sorted(tools & DELEGATING)
    if name not in fence_map:
        banned = sorted(tools & (MUTATING | DELEGATING))
        if banned:
            errors.append(f"{name}: lists {banned} with no fence.sh FENCE_MAP row")
        else:
            read_only.append(name)
        continue

    if held_delegating:
        errors.append(f"{name}: fenced agent lists {held_delegating}")
    mode, set_name = fence_map[name]
    fenced.append(f"{name}: {mode} {set_name}")

# The reviewer rubric. The verify stage spawns the feature plugin's reviewers
# across plugins, where ${CLAUDE_PLUGIN_ROOT} resolves to deepen, so it inlines
# feature's rubric instead of linking it; the copy must not drift from its source.
verify_md = plugin / "skills/run/references/stage-5-verify.md"
rubric_md = root / "plugins/feature/skills/review-stage/references/confidence-scale.md"
rubric_fail = (
    "stage-5-verify.md confidence-scale block differs from feature's "
    "confidence-scale.md lines 5-15"
)
if not verify_md.is_file() or not rubric_md.is_file():
    errors.append(rubric_fail)
else:
    inlined = re.search(
        r"<!-- BEGIN confidence-scale -->\n(.*?)\n<!-- END confidence-scale -->",
        verify_md.read_text(encoding="utf-8"),
        re.S,
    )
    source = "\n".join(rubric_md.read_text(encoding="utf-8").split("\n")[4:15])
    if not inlined or inlined.group(1) != source:
        errors.append(rubric_fail)

if errors:
    print("\n".join(f"FAIL: {error}" for error in errors), file=sys.stderr)
    sys.exit(1)
print(
    f"OK: {len(agents)} deepen agents — {len(fenced)} fenced ({', '.join(fenced)}), "
    f"{len(read_only)} read-only; {len(table)} sets in fence.md, {len(fence_map)} FENCE_MAP rows; "
    "hooks.json binds fence.sh on PreToolUse; hook executable; "
    "stage-5-verify.md rubric matches feature's confidence-scale.md"
)
PY

# The run's measured numbers — the hotspot table, the candidate id and the
# touched-function coverage — are shipped as scripts whose --self-test
# reproduces the worked example of their contract. Running them here pins the
# encoding in CI, so a prose edit and the script cannot drift apart unnoticed.
selftest_failed=0
for script in hotspots.sh candidate-id.sh touched-coverage.mjs; do
    path="$repo_root/plugins/deepen/skills/run/scripts/$script"
    if [ ! -x "$path" ]; then
        printf 'FAIL: %s is missing or not executable\n' "plugins/deepen/skills/run/scripts/$script" >&2
        selftest_failed=1
        continue
    fi
    case "$script" in
        *.mjs)
            if ! command -v node >/dev/null 2>&1; then
                printf 'FAIL: %s --self-test needs node, which is not on PATH\n' "$script" >&2
                selftest_failed=1
                continue
            fi
            interpreter=node
            ;;
        *) interpreter=bash ;;
    esac
    if ! output=$("$interpreter" "$path" --self-test 2>&1); then
        printf 'FAIL: %s --self-test: %s\n' "$script" "$output" >&2
        selftest_failed=1
    fi
done
if [ "$selftest_failed" -ne 0 ]; then
    exit 1
fi
echo "OK: hotspots.sh, candidate-id.sh and touched-coverage.mjs self-tests reproduce their worked examples"
