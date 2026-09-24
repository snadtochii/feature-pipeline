#!/usr/bin/env python3
"""What did plan's incremental `code-explorer` read, and what of it did the plan use?

For each run in RUNS this script reads the explorer child's transcript and the
ticket's artifacts, and derives:

  - the explorer's Read calls, split into ticket artifacts, repo files and
    files outside the repo, and its other calls (Grep, Glob, WebFetch, ...);
  - which repo files it read that `exploration.md` already cited;
  - which of the files new to it reached `02-plan.md` (Codebase Context or
    Implementation Steps), and which of those the spec never named;
  - the spec's named paths, and for each whether it existed when the explorer
    started, whether `exploration.md` or the project instruction files
    (`AGENTS.md`, `CLAUDE.md`) cite it, and - for a path `exploration.md`
    cites - whether a commit touched it between the exploration's `**Date**`
    and the explorer's start: the coverage and freshness test plan's Step 1.2
    runs.

Paths are resolved against the repo tree as it stood when the explorer
started: the last first-parent commit on HEAD before that timestamp. A short
citation such as `flow/SKILL.md:180` resolves by path suffix; one that matches
several tracked files is counted as ambiguous and covers nothing.

Units and turns are not computed here: they come from
`scripts/measure-session.py --json`, the maintained measurement, and are merged
in from its reports when `--reports <dir>` names a directory holding
`<session-id>.json` files.

Only derived data is written: repo-relative paths, counts, timestamps and
units. No transcript text, no absolute path, no home directory.

Usage (from the repo root):
  python3 docs/research/2026-09-23-plan-incremental-exploration-evidence/explorer_reads.py \
    [--transcripts <dir>] [--reports <dir>] [--out <path>]

  --transcripts  Claude Code project transcript dir
                 (default ~/.claude/projects/-Users-serhiinadtochii-Projects-feature-pipeline)
  --reports      dir of measure-session.py --json reports named <session-id>.json
  --out          write JSON here instead of stdout

Exit 1 on a missing transcript, meta file, report or ticket artifact, an
explorer that cannot be matched, or a failing git call - never a partial result.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DEFAULT_TRANSCRIPTS = Path.home() / ".claude/projects/-Users-serhiinadtochii-Projects-feature-pipeline"
INCREMENTAL_MARKER = "Prior exploration has already been done"
INSTRUCTION_FILES = ("AGENTS.md", "CLAUDE.md")

# ticket, session, explorer agent id, ticket folder glob, exploration.md glob
RUNS = [
    ("FP-109", "9f881c61-3955-49f2-8996-f63f451ae33c", "af1913e1abdfd5f9b",
     "claudedocs/tickets/*/FP-109", "claudedocs/tickets/*/FP-109/exploration.md"),
    ("FP-120", "cf946ddc-c732-4847-97d2-9567a36bc87d", "a59b4bd0083d046cd",
     "claudedocs/tickets/*/FP-120", "claudedocs/tickets/*/FP-120/exploration.md"),
    ("FP-116", "13957db5-4e18-419c-b9d0-04e0b52cdc11", "aa9255e14c044d662",
     "claudedocs/tickets/*/FP-116", "claudedocs/tickets/*/FP-116/exploration.md"),
    ("FP-85", "012fe8f0-de55-467d-bedd-5746510a34e7", "a0fa15b939ef79321",
     "claudedocs/tickets/*/FP-84/tasks/FP-85", "claudedocs/tickets/*/FP-84/exploration.md"),
    ("FP-86", "012fe8f0-de55-467d-bedd-5746510a34e7", "a51c498b7a8dd2c4e",
     "claudedocs/tickets/*/FP-84/tasks/FP-86", "claudedocs/tickets/*/FP-84/exploration.md"),
    ("FP-87", "012fe8f0-de55-467d-bedd-5746510a34e7", "a502425adddd0aaa4",
     "claudedocs/tickets/*/FP-84/tasks/FP-87", "claudedocs/tickets/*/FP-84/exploration.md"),
]

PATH_RE = re.compile(
    r"(?<![\w./@-])((?:[\w.-]+/)*[\w.-]+\.(?:md|sh|py|json|mjs|cjs|js|ts|yaml|yml|toml))(?![\w/-])"
)
SPEC_SECTIONS = ("Description", "Acceptance Criteria", "Design Notes", "Constraints")


def fail(msg: str) -> None:
    print(f"explorer_reads.py: {msg}", file=sys.stderr)
    sys.exit(1)


def git(*args: str) -> str:
    out = subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True)
    if out.returncode != 0:
        fail(f"git {' '.join(args[:2])} failed: {out.stderr.strip()[:200]}")
    return out.stdout


def one(pattern: str) -> Path:
    hits = sorted(glob.glob(str(REPO / pattern)))
    if len(hits) != 1:
        fail(f"expected exactly one match for {pattern}, found {len(hits)}")
    return Path(hits[0])


class Resolver:
    """Resolve a cited path - full, or a suffix like `flow/SKILL.md` - to tracked files."""

    def __init__(self, files: list[str]):
        self.files = files
        self.cache: dict[str, list[str]] = {}

    def resolve(self, cited: str) -> list[str]:
        cited = re.sub(r"^(?:\./)+", "", cited)
        if cited not in self.cache:
            self.cache[cited] = [f for f in self.files if f == cited or f.endswith("/" + cited)]
        return self.cache[cited]

    def cited(self, text: str) -> tuple[set[str], list[str]]:
        """Files a document cites unambiguously, plus the ambiguous citations."""
        resolved, ambiguous = set(), set()
        for raw in PATH_RE.findall(text):
            hits = self.resolve(raw)
            if len(hits) == 1:
                resolved.add(hits[0])
            elif len(hits) > 1:
                ambiguous.add(raw)
        return resolved, sorted(ambiguous)


def section(text: str, heading: str) -> str:
    """Body of `## heading` up to the next `## ` heading."""
    m = re.search(rf"^## {re.escape(heading)}\s*$", text, re.M)
    if not m:
        return ""
    rest = text[m.end():]
    nxt = re.search(r"^## ", rest, re.M)
    return rest[: nxt.start()] if nxt else rest


def normalize(path: str) -> tuple[str, str]:
    """(kind, repo-relative path) - kind is artifact, repo or outside."""
    p = os.path.normpath(path) if path else ""
    root = str(REPO)
    if not p.startswith(root + os.sep):
        return "outside", ""
    rel = os.path.relpath(p, root)
    return ("artifact" if rel.startswith("claudedocs/") else "repo"), rel


def explorer_calls(transcripts: Path, session: str, agent: str, ticket: str) -> tuple[list[dict], str]:
    base = transcripts / session / "subagents"
    jl, meta = base / f"agent-{agent}.jsonl", base / f"agent-{agent}.meta.json"
    if not jl.is_file() or not meta.is_file():
        fail(f"missing transcript or meta for {ticket}: agent-{agent} in session {session}")
    m = json.loads(meta.read_text())
    if m.get("agentType") != "feature:code-explorer" or ticket not in m.get("description", ""):
        fail(f"agent {agent} is not the {ticket} code-explorer")
    calls, start, prompt_ok = {}, "", False
    for line in jl.open():
        d = json.loads(line)
        content = (d.get("message") or {}).get("content")
        if d.get("type") == "user" and not start:
            start = d.get("timestamp", "")
            text = content if isinstance(content, str) else " ".join(
                x.get("text", "") for x in content if isinstance(x, dict))
            prompt_ok = INCREMENTAL_MARKER in text
        if d.get("type") == "assistant" and isinstance(content, list):
            # A streamed message repeats its tool_use blocks; key them by id.
            calls.update({x["id"]: x for x in content if x.get("type") == "tool_use"})
    if not start or not prompt_ok:
        fail(f"agent {agent} has no start record or its prompt lacks the incremental marker")
    return list(calls.values()), start[:19] + "Z"


def analyse(run, transcripts: Path, head_files: list[str], reports: Path | None) -> dict:
    ticket, session, agent, folder_glob, expl_glob = run
    folder = one(folder_glob)
    for name in ("01-spec.md", "02-plan.md"):
        if not (folder / name).is_file():
            fail(f"{ticket}: {name} missing")
    spec = (folder / "01-spec.md").read_text()
    plan = (folder / "02-plan.md").read_text()
    expl = one(expl_glob).read_text()

    calls, start = explorer_calls(transcripts, session, agent, ticket)
    commit = git("rev-list", "-1", "--first-parent", f"--before={start}", "HEAD").strip()
    if not commit:
        fail(f"{ticket}: no commit before {start}")
    run_files = [p for p in git("ls-tree", "-r", "--name-only", commit).splitlines() if p]
    at_run = Resolver(run_files)
    plan_res = Resolver(sorted(set(run_files) | set(head_files)))

    date_m = re.search(r"^\*\*Date\*\*:\s*(\d{4}-\d{2}-\d{2})", expl, re.M)
    expl_date = date_m.group(1) if date_m else ""
    expl_cited, expl_ambiguous = at_run.cited(expl)
    instr_cited: set[str] = set()
    for name in INSTRUCTION_FILES:
        if name in run_files:
            instr_cited |= at_run.cited(git("show", f"{commit}:{name}"))[0]
    plan_cited = (plan_res.cited(section(plan, "Codebase Context"))[0]
                  | plan_res.cited(section(plan, "Implementation Steps"))[0])

    reads = {"artifact": 0, "repo": [], "outside": 0}
    other: dict[str, int] = {}
    for c in calls:
        name, inp = c["name"], c.get("input") or {}
        if name == "Read":
            kind, rel = normalize(inp.get("file_path", ""))
            if kind == "repo":
                reads["repo"].append(rel)
            else:
                reads[kind] += 1
        else:
            other[name] = other.get(name, 0) + 1

    repo_files = sorted(set(reads["repo"]))
    already = [p for p in repo_files if p in expl_cited]
    new = [p for p in repo_files if p not in expl_cited]
    new_in_plan = [p for p in new if p in plan_cited]

    spec_named = sorted(plan_res.cited("\n".join(section(spec, s) for s in SPEC_SECTIONS))[0])
    existing = [p for p in spec_named if p in run_files]
    in_expl = [p for p in existing if p in expl_cited]
    in_instr = [p for p in existing if p in instr_cited and p not in expl_cited]
    stale: list[str] | None = None
    if expl_date:
        # Only what exploration.md describes can go stale; a path the
        # instruction files name is read from them as they stand.
        stale = sorted({p for p in git(
            "log", f"--since={expl_date} 00:00", f"--until={start}",
            "--name-only", "--format=", "--", *in_expl).splitlines() if p}) if in_expl else []

    row = {
        "ticket": ticket,
        "session": session,
        "agent": agent,
        "exploration_date": expl_date or None,
        "explorer_started": start,
        "tree_at_run": commit[:12],
        "reads_total": len(reads["repo"]) + reads["artifact"] + reads["outside"],
        "reads_ticket_artifacts": reads["artifact"],
        "reads_outside_repo": reads["outside"],
        "reads_repo_calls": len(reads["repo"]),
        "reads_repo_files": len(repo_files),
        "reads_already_cited": len(already),
        "reads_new": len(new),
        "read_calls_on_new_files_used_in_plan": sum(1 for p in reads["repo"] if p in new_in_plan),
        "other_calls_total": sum(other.values()),
        "other_calls_by_tool": dict(sorted(other.items())),
        "exploration_cited_files": len(expl_cited),
        "exploration_ambiguous_citations": len(expl_ambiguous),
        "plan_cited_files": len(plan_cited),
        "new_paths_used_in_plan": new_in_plan,
        "new_paths_used_in_plan_not_spec_named": [p for p in new_in_plan if p not in spec_named],
        "spec_named_paths": [
            {"path": p,
             "existed_at_run": p in run_files,
             "cited_in_exploration": p in expl_cited,
             "cited_in_instructions": p in instr_cited,
             "changed_since_exploration": None if stale is None else p in stale}
            for p in spec_named
        ],
        "skip_test": {
            "named_paths": len(spec_named),
            "to_create": [p for p in spec_named if p not in run_files],
            "uncovered_by_exploration": [p for p in existing if p not in expl_cited],
            "uncovered_by_exploration_or_instructions": [
                p for p in existing if p not in expl_cited and p not in instr_cited],
            "stale": stale if stale is not None else "unknown (no Date)",
            "outcome_exploration_only": outcome(existing, in_expl, stale, expl_date),
            "outcome_with_instruction_files": outcome(existing, in_expl + in_instr, stale, expl_date),
        },
        "already_cited_files": already,
        "new_files": new,
    }
    if reports:
        rep = reports / f"{session}.json"
        if not rep.is_file():
            fail(f"--reports given but {rep.name} is missing")
        agents = {a["agent_id"]: a for a in json.loads(rep.read_text())["agents"]}
        if agent not in agents:
            fail(f"{rep.name} has no row for agent {agent}")
        a = agents[agent]
        row["turns"] = a["turns"]
        row["weighted_units"] = a["weighted_units"]
        row["first_turn_floor"] = a["first_turn_floor"]
    return row


def outcome(existing: list[str], covered: list[str], stale: list[str] | None, date: str) -> str:
    """Path half of the Step 1.2 test. Named areas without a path need plan's judgment."""
    if not date or stale is None:
        return "bounded (fail-safe: no Date)"
    if not existing:
        return "no existing named paths - decided on named areas alone"
    if len(covered) < len(existing) or any(p in stale for p in covered):
        return "bounded"
    return "skip (paths only)"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcripts", type=Path, default=DEFAULT_TRANSCRIPTS)
    ap.add_argument("--reports", type=Path)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    if not args.transcripts.is_dir():
        fail(f"transcript dir not found: {args.transcripts}")
    head_files = [p for p in git("ls-files").splitlines() if p]
    rows = [analyse(r, args.transcripts, head_files, args.reports) for r in RUNS]
    doc = json.dumps({"generator": "explorer_reads.py", "runs": rows}, indent=2) + "\n"
    if args.out:
        args.out.write_text(doc)
    else:
        sys.stdout.write(doc)


if __name__ == "__main__":
    main()
