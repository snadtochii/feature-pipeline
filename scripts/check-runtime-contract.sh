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

for name in ("flow", "plan", "build", "review-stage", "ship"):
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
review_stage = (plugin / "skills/review-stage/SKILL.md").read_text()
roles = re.findall(r"\*\*[a-d]\. `feature:([^`]+)`", review_stage)
expected = {"code-reviewer", "security-engineer", "performance-engineer", "code-architect"}
if len(roles) != 4 or set(roles) != expected:
    errors.append("review-stage: independent review roster must contain each of the four roles once")

for role in expected:
    path = plugin / "agents" / f"{role}.md"
    if not path.is_file():
        errors.append(f"missing shared role definition: {role}")
        continue
    frontmatter = path.read_text().split("---", 2)[1]
    if re.search(r"^  - (?:Bash|Write|Edit|Agent|Task)$", frontmatter, re.M):
        errors.append(f"{role}: read-only role has a mutating/delegating tool")

# The confidence scale is stated once and injected into every reviewer prompt;
# a stage that stops naming it, or a missing file, silently drops the rubric.
if not (plugin / "skills/review-stage/references/confidence-scale.md").is_file():
    errors.append("missing reviewer rubric: skills/review-stage/references/confidence-scale.md")
if "references/confidence-scale.md" not in review_stage:
    errors.append("review-stage: shared base must inject references/confidence-scale.md")

# The post-gate finalizer is the mirror image of the reviewer block above: build
# must name it, its definition must exist, and it must KEEP the mutating tool the
# reviewers must not have — the tail is git work, and a budget that lost `Bash`
# would leave the child unable to commit while still reporting success.
if "feature:finalizer" not in build:
    errors.append("build: verdict gate must spawn feature:finalizer")
finalizer = plugin / "agents/finalizer.md"
if not finalizer.is_file():
    errors.append("missing shared role definition: finalizer")
else:
    frontmatter = finalizer.read_text().split("---", 2)[1]
    if not re.search(r"^  - Bash$", frontmatter, re.M):
        errors.append("finalizer: mutating role must keep Bash in its tool budget")
    # Upper bound as well as lower: the unchanged `flow -> stage -> role` depth
    # count in runtime-claude.md holds only while this stays a leaf that never
    # delegates, and the role decides nothing and looks nothing up.
    forbidden = re.findall(r"^  - (Agent|Task|TodoWrite|WebFetch|WebSearch)$", frontmatter, re.M)
    if forbidden:
        errors.append(f"finalizer: leaf role must not hold {sorted(set(forbidden))}")

# The required UI checks are stated once and injected at both ui-tester spawn
# sites; the tester needs the resize tool the checks' two widths depend on. A
# spawn site that stops naming the contract, or a budget that loses the tool,
# would silently drop the checks from every browser pass.
if not (plugin / "skills/build/references/ui-checks.md").is_file():
    errors.append("missing required UI checks contract: skills/build/references/ui-checks.md")
if "references/ui-checks.md" not in build:
    errors.append("build: test checkpoint must inject references/ui-checks.md")
ship_ui = plugin / "skills/ship/references/ui-verification.md"
if not ship_ui.is_file() or "build/references/ui-checks.md" not in ship_ui.read_text():
    errors.append("ship: ui-verification.md must inject build/references/ui-checks.md")
tester = plugin / "agents/ui-tester.md"
tester_frontmatter = tester.read_text().split("---", 2)[1] if tester.is_file() else ""
for resize_tool in ("mcp__playwright__browser_resize", "mcp__chrome-devtools__resize_page"):
    if not re.search(rf"^  - {re.escape(resize_tool)}$", tester_frontmatter, re.M):
        errors.append(f"ui-tester: tool budget must list {resize_tool}")

if errors:
    print("\n".join(f"FAIL: {error}" for error in errors), file=sys.stderr)
    sys.exit(1)
print("OK: 5 runtime consumers, 2 runtime implementations, 2 neutral stage templates, 4 read-only reviewer roles, 1 confidence-scale injection site, 1 mutating finalizer role, 2 ui-checks injection sites")
PY
