#!/usr/bin/env bash
# Structural checks for the shared pipeline/runtime boundary. This does not
# replace real Claude/Codex smoke runs (see docs/plans/FP-82-runtime-compatibility.md).
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
python3 - "$repo_root" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
plugin = root / "plugins/feature"
refs = plugin / "skills/flow/references"
errors = []

for name in ("flow", "plan", "build", "ship"):
    path = plugin / "skills" / name / "SKILL.md"
    text = path.read_text()
    frontmatter = text.split("---", 2)[1]
    for tool in ("Agent", "Task"):
        if not re.search(rf"^  - {tool}$", frontmatter, re.M):
            errors.append(f"{name}: missing native spawn alias {tool}")
    if not re.search(r"^\*\*Runtime\.\*\*.*\]\([^)]*runtime\.md\)", text, re.M):
        errors.append(f"{name}: missing runtime dispatch")

for runtime in ("claude", "codex"):
    path = refs / f"runtime-{runtime}.md"
    if not path.is_file():
        errors.append(f"missing runtime file: {path.name}")
        continue
    headings = re.findall(r"^## (.+)$", path.read_text(), re.M)
    for operation in ("Invoke skill", "Spawn and models", "Wait and resume", "Capacity"):
        if operation not in headings:
            errors.append(f"{path.name}: missing operation {operation}")

briefs = (refs / "stage-briefs.md").read_text()
declared = set(re.findall(r"^\| `(<[A-Z_]+>)` \|", briefs, re.M))
for number, name in ((4, "Plan"), (6, "Build")):
    section = re.search(rf"^## §{number} {name} brief\n(.*?)(?=^## |\Z)", briefs, re.M | re.S)
    blocks = re.findall(r"^```\n(.*?)^```", section.group(1), re.M | re.S) if section else []
    if not blocks:
        errors.append(f"missing {name} template")
        continue
    template = blocks[0]
    for placeholder in ("<RUNTIME_BLOCK>", "<STAGE_INVOCATION>"):
        if template.count(placeholder) != 1:
            errors.append(f"{name}: expected exactly one {placeholder}")
    if not template.lstrip().startswith("<RUNTIME_BLOCK>"):
        errors.append(f"{name}: runtime block must precede stage instructions")
    unknown = set(re.findall(r"<[A-Z_]+>", template)) - declared
    if unknown:
        errors.append(f"{name}: undeclared placeholders {sorted(unknown)}")
    if re.search(r"invoke the [` ]*(Skill|Task|Agent)\b|subagent_type:", template, re.I):
        errors.append(f"{name}: shared template embeds a native invocation")

build = (plugin / "skills/build/SKILL.md").read_text()
roles = re.findall(r"\*\*[a-d]\. `feature:([^`]+)`", build)
expected = {"code-reviewer", "security-engineer", "performance-engineer", "code-architect"}
if len(roles) != 4 or set(roles) != expected:
    errors.append("build: independent review roster must contain each of the four roles once")
for role in expected:
    path = plugin / "agents" / f"{role}.md"
    if not path.is_file():
        errors.append(f"missing shared role definition: {role}")
        continue
    frontmatter = path.read_text().split("---", 2)[1]
    if re.search(r"^  - (?:Bash|Write|Edit|Agent|Task)$", frontmatter, re.M):
        errors.append(f"{role}: read-only role has a mutating/delegating tool")

if errors:
    print("\n".join(f"FAIL: {error}" for error in errors), file=sys.stderr)
    sys.exit(1)
print("OK: 4 runtime consumers, 2 runtime implementations, 2 neutral stage templates, 4 read-only reviewer roles")
PY
