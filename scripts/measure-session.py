#!/usr/bin/env python3
r"""Turn a Claude Code session transcript into a stable token-consumption report.

A pipeline run's cost is turns x window: every turn re-reads the whole
conversation, so a change that shortens a long agent is worth more than one
that removes a few tool calls. This script reads a session `.jsonl`, its
`subagents/*.jsonl` and `subagents/*.meta.json`, and reports where the tokens
went - per agent, per role, per ticket, and per build phase - so a pipeline
change can be compared before and after with the same measure.

Read-only. Nothing is written except an explicit `--out` path.

Privacy: the report carries token counts, tool names, agent descriptions and
the file names of pipeline artifacts. It never carries message text. That is
enforced structurally - the JSON document is serialized from explicit field
lists on the report objects, never from a raw transcript record - not by a
redaction pass that could be forgotten.

Usage:
  scripts/measure-session.py <session.jsonl> [options]
  scripts/measure-session.py <session-dir> [options]
  scripts/measure-session.py <session-id> --project <slug> [options]
  scripts/measure-session.py report <session> [options]       # explicit form
  scripts/measure-session.py compare <baseline.json> <candidate.json> [options]
  scripts/measure-session.py compare --baseline A.json --baseline B.json \
                                     --candidate C.json [--assert]
  scripts/measure-session.py self-test

  Runs on Python 3.9 and newer, which is what a stock macOS `/usr/bin/python3`
  provides. No install step and no third-party import.

  report options:
    --json                    emit the full report as one JSON document
    --out <path>              write the output to <path> instead of stdout
    --weights i=1,cw=1.25,cr=0.1,o=5
    --role-map <json|path>    ordered {role: description-regex} overrides
    --check-pattern <regex>   override the check/test-run heuristic

  compare options:
    --baseline <f> / --candidate <f>   repeatable, for N-vs-M arms
    --assert                  exit non-zero on any figure outside tolerance
    --tolerance-share <pp>    default 1.0 percentage points
    --tolerance-rel <pct>     default 2.0 percent

Exit: 0 on success. 1 on any of: an unresolvable session path; a JSONL line
      that will not parse (named with its line number); a subagent `.jsonl`
      with no `.meta.json`, or a `.meta.json` with no `.jsonl`; a `meta.json`
      missing a required key; an assistant record with no `message.id`; an
      agent whose assistant records carry no `usage` at all; zero agents or
      zero assistant turns; a `--weights` or `--role-map` string that will not
      parse, or a regex that will not compile; a `--check-pattern` that will
      not compile; in compare, an unknown or mismatched `schema_version`, an
      arm with zero reports, or, under `--assert`, a figure outside tolerance;
      an unwritable `--out` path. A self-test probe failure also exits 1.
      A missing phase boundary inside a build is NOT a failure - it renders as
      `n/a` with its reason, because a stuck build is a legitimate thing to
      measure.

## Weights

Weighted units are `w_i*input + w_cw*cache_write + w_cr*cache_read + w_o*output`
with defaults `i=1, cw=1.25, cr=0.1, o=5`. The unit is weighted input-token
equivalents. It is deliberately NOT a price and NOT a plan-limit multiplier:
the weights approximate the relative cost of the four token classes so that
agents can be ranked against each other, and raw per-model token totals are
printed beside every weighted table so no multiplier is implied. Override the
weights with `--weights`; the active values and a worked example computed from
a real row are printed in every report header.

Two units appear in the report and they are never comparable to each other.
Role and ticket tables are in weighted units. Phase tables are in re-read sum:
the sum of the per-turn window over a phase's turns, where a turn's window is
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Every
column header carries its unit.

## Regression anchor

The anchor is a three-ticket ship session: 33 subagents plus the root, three
build stage subagents. `scripts/measure-session.expected.json` is a
privacy-clean `--json` report of it, committed beside this script.

Session transcripts are private and are never committed, so the anchor is two
checks rather than one. Anyone who still has that session re-measures it and
asserts the whole document mechanically:

  python3 scripts/measure-session.py <session> --json --out /tmp/fresh.json \
    && python3 scripts/measure-session.py compare \
         scripts/measure-session.expected.json /tmp/fresh.json --assert

Anyone who does not has the figures below, which the committed document must
continue to agree with, plus `self-test` - whose pattern table also runs at the
start of every report, so a recognition rule cannot rot unnoticed.

Figures reproduced from the independent hand measurement of that session:

  role shares      build stages 33.1%, the four reviewer roles 16.7% combined
                   (correctness 6.1, architecture 4.3, security 3.5,
                   performance 2.8), code-explorer 5.1%, root session 7.7%
  agent floors     46-48k for the restricted-tool reviewer roles,
                   83-89k for general-purpose children
  phase shares     implement / review / post-review / post-gate, per build:
                   109 turns 87k->325k: 37.7 / 33.2 /  6.0 / 23.2
                   116 turns 89k->400k: 43.4 / 27.0 /  9.3 / 20.3
                    68 turns 88k->288k: 25.1 / 43.0 / 12.5 / 19.3
  parity           all three builds verdict pass, commit / pushed / PR true

Deviations from the hand measurement, each a deliberate correctness choice
rather than a discrepancy:

  - Usage is merged per `message.id` on the TERMINAL record (non-null
    `stop_reason`), not the first record. A non-terminal record carries a
    partial streaming snapshot - one measured message reports
    `output_tokens: 4` on its non-terminal line and 862 on its terminal one.
    Keeping the first record undercounts output tokens, which carry the x5
    weight, so role shares move by a fraction of a percentage point.
  - Turns are counted by distinct `message.id`, not by terminal records: one
    build has 113 terminal records against 116 distinct ids.
  - A phase boundary is the FIRST write of its marker artifact. Keying on the
    last write puts a post-gate rewrite of `06-summary.md` - a build appending
    its PR URL after the gate - inside post-review, which moved one build's
    split from 12.5 / 19.3 to 28.0 / 3.9.
  - `pr` requires a `gh pr create`; a `git push` alone sets `pushed`, not
    `pr`. All three booleans read command text, so all three are estimates.
  - The check/test-run count excludes commands that only READ a script:
    `head -8 scripts/check-tool-parity.sh` names a check script but does not
    run one. Against a rule that matched the pattern anywhere in the command
    text the counts are 39 vs 42, 32 vs 43 and 4 vs 4; every excluded command
    is a `sed -n`, `cat`, `grep -n`, `head` or `ls`.

A figure landing outside this anchor for any other reason is investigated
rather than absorbed by widening a tolerance.

## Unverified paths

One recognition surface is implemented from its documented contract and
exercised by nothing: no available transcript reaches it, and a synthetic
probe there would assert this script's reading of the contract rather than
the real shape. It is correct by construction and unproven:

  - `pipeline_write_artifact` artifact writes (server-native storage mode).
    The anchor session contains zero MCP tool calls.

Three more are pinned by synthetic probes in `self-test`; their behaviour is
asserted, their real-transcript shape is not:

  - Shell writes to an artifact (`> path`, `>> path`, `tee path`). A session
    told to work through the shell writes its artifacts with a heredoc and
    never calls `Write`; without this surface such a build reports no review
    or post-gate boundary at all. The anchor session contains no such write.
  - A standalone `/feature:build` root session, recognised through the
    `<command-name>/feature:build</command-name>` record.
  - The finalizer child. Its recognition contract is
    `parentAgentId == <the build's id>` - the build agent in the single-agent
    shape, the close-stage child in the three-stage one - AND a description
    matching `^Finalize <TICKET-ID>\b`. `parentAgentId` alone is
    insufficient, because a build already spawns four reviewers. A finalizer
    child is reported as the post-gate phase of its parent build; any spawn
    that means to be recognised as one must emit exactly that description.

    This clause reaches the phase table through the `self+children` column:
    the child's re-read sum is attributed to the phase holding its spawn
    turn. The phase boundaries themselves, and the parity fields, are read
    from the tool calls of the agent that authors the artifact, so
    `04-review.md` and `06-summary.md` must be written by one of the agents
    the shapes below name. Were a write to move into the finalizer, the
    post-gate boundary would read as missing and `verdict`, `findings`,
    `commit` and `pr` would all degrade to `unknown` - correctly, but the
    measurement would stop answering AC 4. A change to who writes an
    artifact is therefore a change to this script.
  - The three-stage build shape: implement, then a review-stage and a
    close-stage child. A child is a stage by its role - the `review-stage` /
    `close-stage` entries of the role map, which match the `Review stage for
    <TICKET-ID>` / `Close stage for <TICKET-ID>` literals and the anchored
    `<TICKET-ID> review stage` / `<TICKET-ID> close stage` form a measured
    session used - and is grouped with its siblings by (parent, ticket). The implement agent is a `Build stage
    for <TICKET-ID>` sibling (under flow), else the parent itself when that
    is the root session or ran `/feature:build` (standalone build: its turns
    from the first stage spawn on are sequencer turns, credited to the stage
    whose spawn most recently preceded them). Phases: implement = the
    implement agent's turns; review = the review-stage child, its reviewers
    as children; post-review = the close-stage child up to its FIRST
    `06-summary.md` write; post-gate = the rest of it, the finalizer as a
    child. Parity reads `04-review.md` from the review stage and
    `06-summary.md` from the close stage. Pinned by a synthetic probe of each
    parent shape, and checked once by hand against a real standalone-build
    transcript - the RC-52 pair in
    docs/research/2026-09-17-paired-run-benchmark-protocol.md §7.2.

Codex transcripts are out of scope and take the loud-failure path.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path

SCHEMA_VERSION = 1
GENERATOR = "measure-session.py"

DEFAULT_WEIGHTS = {"i": 1.0, "cw": 1.25, "cr": 0.1, "o": 5.0}
WEIGHT_KEYS = ("i", "cw", "cr", "o")
UNIT_NAME = "weighted input-token equivalents - not a price and not a plan-limit multiplier"

# Ordered role refinement, applied ONLY to agents whose agentType is
# `general-purpose`: that one type collapses build stages, plan stages, ship
# wrappers, ship reviewers and address children into a single bucket.
DEFAULT_ROLE_MAP = {
    "build-stage": r"^Build stage for ",
    "plan-stage": r"^Plan stage for ",
    "review-stage": r"^Review stage for |^\S+ review stage$",
    "close-stage": r"^Close stage for |^\S+ close stage$",
    "finalize-child": r"^Finalize ",
    "ship-implementer": r" implementer via flow$",
    "ship-review": r"^Independent review of ",
    "ship-address": r"^Address review on ",
}
GENERIC_ROLE = "general-purpose"
GENERIC_FALLBACK_ROLE = "general-purpose (other)"
ROOT_ROLE = "root-session"
ROOT_AGENT_ID = "root"
UNATTRIBUTED = "unattributed"

# Matched ANYWHERE in a Bash command, never prefix-anchored: real check runs
# sit inside compound commands that begin with a variable assignment. Segments
# whose leading word only reads a file are excluded before matching.
DEFAULT_CHECK_PATTERN = (
    r"check-[a-z-]+\.(?:sh|mjs)|bash scripts/|vitest|pytest"
    r"|npm (?:run|test|ci)\b|node |tsc\b|pyright"
)

# Leading words that read rather than run. `head -8 scripts/check-x.sh` names a
# check script but does not run it; `cat .../commit.md` is not a commit.
READ_ONLY_COMMANDS = frozenset(
    """cat head tail sed less more grep rg wc ls find awk diff stat file
    xxd od cut sort uniq tr column printf echo test [ true false""".split()
)

ARTIFACT_NAME_RE = re.compile(r"^0[3-6]-[a-z-]+\.md$")
QUOTED_RE = re.compile(r"'[^']*'|\"[^\"]*\"")
TICKET_RE = re.compile(r"\b[A-Z][A-Z0-9]*-\d+\b")
# `<LETTERS>-<digits>` is also the shape of a standard's name, and those appear
# in agent descriptions ("normalise to UTF-8"). They are indistinguishable from
# a ticket id by pattern alone - `UTF`/`SHA`/`RFC` are three letters and
# `8`/`256`/`7231` are one to four digits - so the separation is by name. A
# project whose real prefix collides pins it with `--ticket-prefix`.
NON_TICKET_PREFIXES = frozenset(
    """UTF SHA RFC ISO CVE CWE MD AES RSA HMAC CRC BASE ASCII PEP ECMA IEEE ANSI
    HTTP HTTPS TLS SSL IPV EC CJK GB BIG WIN CP KOI""".split()
)


def find_ticket(text: str, allowed_prefixes=None):
    """First ticket id in `text`, or None.

    `allowed_prefixes` (from `--ticket-prefix`) makes the match exact; without
    it every `<LETTERS>-<digits>` token is a ticket except the standards names
    in `NON_TICKET_PREFIXES`.
    """
    for match in TICKET_RE.finditer(text or ""):
        prefix = match.group(0).split("-", 1)[0]
        if allowed_prefixes is not None:
            if prefix in allowed_prefixes:
                return match.group(0)
            continue
        if prefix not in NON_TICKET_PREFIXES:
            return match.group(0)
    return None
VERDICT_RE = re.compile(r"^verdict:\s*[*_`]*\s*(pass|partial|stuck)\b", re.MULTILINE | re.IGNORECASE)
SEVERITIES = ("CRITICAL", "IMPORTANT", "SUGGESTION")
# The build verdict set, plus the artifact-store vocabulary that a server-side
# write carries in its own field. Anything else is not a verdict.
KNOWN_VERDICTS = frozenset({"pass", "partial", "stuck", "fail"})
SLASH_BUILD_RE = re.compile(r"<command-name>\s*/?feature:build\s*</command-name>")
COMMAND_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.DOTALL)
FINALIZER_DESC_RE_TEMPLATE = r"^Finalize {ticket}\b"
# The three stages of a three-stage build are keyed on the role map above -
# the one recognition path, so a `--role-map` override moves all of them.
IMPLEMENT_STAGE_ROLE = "build-stage"
STAGE_CHILD_ROLES = {"review-stage": "review", "close-stage": "close"}
REVIEWER_SUBAGENT = "feature:code-reviewer"
SPAWN_TOOLS = ("Agent", "Task")

CONVERSATION_RECORD_TYPES = frozenset({"assistant", "user", "attachment", "system"})
SESSION_METADATA_RECORD_TYPES = frozenset(
    {
        "queue-operation",
        "bridge-session",
        "last-prompt",
        "pr-link",
        "atis-latch",
        "file-history-snapshot",
        "custom-title",
        "mode",
    }
)

PHASE_NAMES = ("implement", "review", "post-review", "post-gate")

EXACT_FIGURES = (
    "token counts (input / cache-write / cache-read / output), turn counts, "
    "windows, first-turn floors, peak windows, re-read sums, weighted units, "
    "and every share derived from them - all taken from the API `usage` field"
)
ESTIMATE_FIGURES = (
    "the check/test-run count, the commit / pushed / PR booleans (all three "
    "read command text, so a command that names an action it did not perform "
    "can move them), and any reviewer finding count recovered by scanning a "
    "review body rather than reading its documented count block"
)


class MeasureError(Exception):
    """The single failure type. `main()` is the only handler."""

    def __init__(self, path, reason):
        super().__init__(f"{path}: {reason}")
        self.path = str(path)
        self.reason = reason


# --------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------


@dataclass
class Turn:
    index: int
    message_id: str
    model: str | None
    input_tokens: int
    cache_write_tokens: int
    cache_read_tokens: int
    output_tokens: int
    has_usage: bool

    @property
    def window(self) -> int:
        return self.input_tokens + self.cache_write_tokens + self.cache_read_tokens


@dataclass
class ToolCall:
    turn: int
    tool_use_id: str | None
    name: str
    input: dict


@dataclass
class RawAgent:
    """One transcript plus its metadata, already parsed into records.

    `records` is a list of already-decoded JSON objects; `label` is the name
    used in error messages. Constructed by `read_session()` from disk, or
    in-memory by `self-test`.
    """

    agent_id: str
    label: str
    meta: dict | None
    records: list


@dataclass
class Agent:
    agent_id: str
    label: str
    agent_type: str
    description: str
    spawn_depth: int
    parent_id: str | None
    tool_use_id: str | None
    turns: list
    tool_calls: list
    models: list
    slash_build_ticket: str | None = None
    turns_without_usage: int = 0
    unknown_record_types: list = field(default_factory=list)
    role: str = ""
    ticket: str = UNATTRIBUTED

    @property
    def input_tokens(self) -> int:
        return sum(t.input_tokens for t in self.turns)

    @property
    def cache_write_tokens(self) -> int:
        return sum(t.cache_write_tokens for t in self.turns)

    @property
    def cache_read_tokens(self) -> int:
        return sum(t.cache_read_tokens for t in self.turns)

    @property
    def output_tokens(self) -> int:
        return sum(t.output_tokens for t in self.turns)

    @property
    def first_turn_floor(self):
        """Turn 1's window, or None when turn 1 carries no usage to read."""
        if not self.turns or not self.turns[0].has_usage:
            return None
        return self.turns[0].window

    @property
    def peak_window(self) -> int:
        return max((t.window for t in self.turns), default=0)

    @property
    def reread_sum(self) -> int:
        return sum(t.window for t in self.turns)

    def weighted_units(self, weights) -> float:
        return weighted_units(
            self.input_tokens,
            self.cache_write_tokens,
            self.cache_read_tokens,
            self.output_tokens,
            weights,
        )


def weighted_units(inp, cache_write, cache_read, output, weights) -> float:
    return (
        weights["i"] * inp
        + weights["cw"] * cache_write
        + weights["cr"] * cache_read
        + weights["o"] * output
    )


# --------------------------------------------------------------------------
# Disk shell - the only code that reads the filesystem on the input side
# --------------------------------------------------------------------------


def _parse_jsonl(path: Path) -> list:
    records = []
    try:
        handle = path.open(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise MeasureError(path, f"cannot read the transcript ({exc.strerror})") from exc
    with handle:
        for lineno, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise MeasureError(path, f"line {lineno} is not valid JSON ({exc.msg})") from exc
    return records


def pair_subagent_files(transcript_stems, meta_stems, describe):
    """Check that every subagent transcript has its meta.json and vice versa.

    Pure: it takes two name sets and a `stem -> label` callable, so the rule can
    be asserted without a directory on disk.
    """
    for stem in sorted(transcript_stems):
        if stem not in meta_stems:
            raise MeasureError(
                describe(stem, "jsonl"), "subagent transcript has no .meta.json sibling"
            )
    for stem in sorted(meta_stems):
        if stem not in transcript_stems:
            raise MeasureError(
                describe(stem, "meta"), "meta.json has no .jsonl transcript sibling"
            )


def check_schema_version(document, label):
    """Validate a loaded report document's schema version. Pure."""
    if not isinstance(document, dict):
        raise MeasureError(label, "report is not a JSON object")
    version = document.get("schema_version")
    if version != SCHEMA_VERSION:
        raise MeasureError(
            label,
            f"unknown schema_version {version!r}; this script writes and reads "
            f"schema_version {SCHEMA_VERSION}",
        )


def resolve_session(argument: str, project: str | None) -> Path:
    """Resolve the three accepted session forms to the root `.jsonl` path."""
    tried = []
    candidate = Path(argument).expanduser()

    if candidate.suffix == ".jsonl":
        tried.append(str(candidate))
        if candidate.is_file():
            return candidate
    if candidate.is_dir():
        sidecar = candidate.with_suffix(".jsonl")
        tried.append(str(sidecar))
        if sidecar.is_file():
            return sidecar
    if candidate.suffix != ".jsonl":
        with_suffix = Path(str(candidate) + ".jsonl")
        tried.append(str(with_suffix))
        if with_suffix.is_file():
            return with_suffix

    if project:
        base = Path.home() / ".claude" / "projects" / project / f"{argument}.jsonl"
        tried.append(str(base))
        if base.is_file():
            return base
    else:
        tried.append(
            "~/.claude/projects/<slug>/<session-id>.jsonl (not tried: --project was not given)"
        )

    raise MeasureError(argument, "no session transcript found; tried " + ", ".join(tried))


def read_session(argument: str, project: str | None = None):
    """Thin disk shell: resolve, read, pair each subagent with its meta.json."""
    root_path = resolve_session(argument, project)
    session_id = root_path.stem
    raws = [RawAgent(ROOT_AGENT_ID, root_path.name, None, _parse_jsonl(root_path))]

    sub_dir = root_path.with_suffix("") / "subagents"
    if sub_dir.is_dir():
        transcripts = {p.stem: p for p in sorted(sub_dir.glob("*.jsonl"))}
        metas = {p.name[: -len(".meta.json")]: p for p in sorted(sub_dir.glob("*.meta.json"))}
        pair_subagent_files(
            set(transcripts),
            set(metas),
            lambda stem, kind: transcripts[stem] if kind == "jsonl" else metas[stem],
        )
        for stem in sorted(transcripts, key=lambda s: transcripts[s].stat().st_mtime):
            meta_path = metas[stem]
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise MeasureError(meta_path, f"cannot parse meta.json ({exc})") from exc
            if not isinstance(meta, dict):
                raise MeasureError(meta_path, "meta.json is not a JSON object")
            agent_id = stem[len("agent-") :] if stem.startswith("agent-") else stem
            raws.append(
                RawAgent(agent_id, transcripts[stem].name, meta, _parse_jsonl(transcripts[stem]))
            )

    return session_id, root_path, raws


# --------------------------------------------------------------------------
# Pure core - parse raw agents into the model
# --------------------------------------------------------------------------

REQUIRED_META_KEYS = ("agentType", "description", "toolUseId", "spawnDepth")


def _content_blocks(message) -> list:
    content = message.get("content")
    return content if isinstance(content, list) else []


def _merge_usage(raw: RawAgent):
    """Per `message.id`, keep the terminal record's usage; else the last one."""
    order = []
    turn_of = {}
    best = {}
    model_of = {}
    tool_calls = []
    assistant_records = 0
    slash_ticket = None
    unknown_types = set()

    for record in raw.records:
        if not isinstance(record, dict):
            raise MeasureError(raw.label, "a transcript line is not a JSON object")
        rtype = record.get("type")
        if rtype not in CONVERSATION_RECORD_TYPES and rtype not in SESSION_METADATA_RECORD_TYPES:
            # Ignored by type name rather than by heuristic, and surfaced so a
            # transcript format that has moved on is visible instead of silent.
            unknown_types.add(str(rtype))
        message = record.get("message")
        if not isinstance(message, dict):
            message = {}

        if rtype == "user" and slash_ticket is None:
            content = message.get("content")
            if isinstance(content, str) and SLASH_BUILD_RE.search(content):
                args = COMMAND_ARGS_RE.search(content)
                found = find_ticket(args.group(1)) if args else None
                slash_ticket = found or UNATTRIBUTED

        if rtype != "assistant":
            continue

        assistant_records += 1
        message_id = message.get("id")
        if not isinstance(message_id, str) or not message_id:
            raise MeasureError(raw.label, "an assistant record carries no message.id")
        if message_id not in turn_of:
            order.append(message_id)
            turn_of[message_id] = len(order)
        turn = turn_of[message_id]

        if message.get("model"):
            model_of[message_id] = message["model"]

        usage = message.get("usage")
        if isinstance(usage, dict):
            terminal = message.get("stop_reason") is not None
            previous = best.get(message_id)
            if previous is None or terminal or not previous[1]:
                best[message_id] = (usage, terminal)

        for block in _content_blocks(message):
            if isinstance(block, dict) and block.get("type") == "tool_use":
                tool_calls.append(
                    ToolCall(
                        turn=turn,
                        tool_use_id=block.get("id"),
                        name=str(block.get("name") or ""),
                        input=block.get("input") if isinstance(block.get("input"), dict) else {},
                    )
                )

    if assistant_records == 0:
        raise MeasureError(raw.label, "zero assistant turns - not a Claude Code transcript?")
    if not best:
        raise MeasureError(raw.label, "no assistant record carries message.usage")

    turns = []
    without_usage = 0
    for index, message_id in enumerate(order, start=1):
        entry = best.get(message_id)
        if entry is None:
            without_usage += 1
            turns.append(Turn(index, message_id, model_of.get(message_id), 0, 0, 0, 0, False))
            continue
        usage = entry[0]
        turns.append(
            Turn(
                index=index,
                message_id=message_id,
                model=model_of.get(message_id),
                # Only the top level of `usage` is read: never `usage.iterations[]`
                # (a per-iteration array that double-counts) and never the nested
                # `cache_creation` map, whose members already sum to the flat
                # `cache_creation_input_tokens`.
                input_tokens=int(usage.get("input_tokens") or 0),
                cache_write_tokens=int(usage.get("cache_creation_input_tokens") or 0),
                cache_read_tokens=int(usage.get("cache_read_input_tokens") or 0),
                output_tokens=int(usage.get("output_tokens") or 0),
                has_usage=True,
            )
        )

    models = sorted({t.model for t in turns if t.model})
    return turns, tool_calls, models, without_usage, slash_ticket, sorted(unknown_types)


def _classify_role(agent: Agent, role_map) -> str:
    if agent.agent_id == ROOT_AGENT_ID:
        return ROOT_ROLE
    if agent.agent_type != GENERIC_ROLE:
        return agent.agent_type
    for role, pattern in role_map.items():
        if pattern.search(agent.description):
            return role
    return GENERIC_FALLBACK_ROLE


def parse_agents(raws, role_map) -> list:
    agents = []
    for raw in raws:
        turns, tool_calls, models, without_usage, slash_ticket, unknown_types = _merge_usage(raw)
        if raw.meta is None:
            agent = Agent(
                agent_id=raw.agent_id,
                label=raw.label,
                agent_type=ROOT_ROLE,
                description="",
                spawn_depth=0,
                parent_id=None,
                tool_use_id=None,
                turns=turns,
                tool_calls=tool_calls,
                models=models,
                slash_build_ticket=slash_ticket,
                turns_without_usage=without_usage,
            )
        else:
            missing = [k for k in REQUIRED_META_KEYS if k not in raw.meta]
            if missing:
                raise MeasureError(
                    raw.label.replace(".jsonl", ".meta.json"),
                    "meta.json is missing required key(s): " + ", ".join(missing),
                )
            agent = Agent(
                agent_id=raw.agent_id,
                label=raw.label,
                agent_type=str(raw.meta["agentType"]),
                description=str(raw.meta["description"]),
                spawn_depth=int(raw.meta["spawnDepth"]),
                # An absent parentAgentId means the parent is the root session.
                parent_id=str(raw.meta.get("parentAgentId") or ROOT_AGENT_ID),
                tool_use_id=str(raw.meta["toolUseId"]),
                turns=turns,
                tool_calls=tool_calls,
                # meta.json's `model` is a spawn-time override marker, not the
                # model that ran: the model comes from `message.model`.
                models=models,
                slash_build_ticket=slash_ticket,
                turns_without_usage=without_usage,
            )
        agent.role = _classify_role(agent, role_map)
        agent.unknown_record_types = unknown_types
        agents.append(agent)

    if not agents:
        raise MeasureError("<session>", "zero agents - nothing to measure")
    if not any(a.turns for a in agents):
        raise MeasureError("<session>", "zero assistant turns across every agent")
    return agents


def attribute_tickets(agents, ticket_prefixes=None) -> None:
    by_id = {a.agent_id: a for a in agents}
    own = {}
    for agent in agents:
        found = find_ticket(agent.description or "", ticket_prefixes)
        if found:
            own[agent.agent_id] = found
        elif agent.slash_build_ticket and agent.slash_build_ticket != UNATTRIBUTED:
            own[agent.agent_id] = agent.slash_build_ticket

    for agent in agents:
        ticket = own.get(agent.agent_id)
        seen = {agent.agent_id}
        cursor = agent
        while ticket is None and cursor.parent_id and cursor.parent_id not in seen:
            seen.add(cursor.parent_id)
            parent = by_id.get(cursor.parent_id)
            if parent is None:
                break
            ticket = own.get(parent.agent_id)
            cursor = parent
        agent.ticket = ticket or UNATTRIBUTED


# --------------------------------------------------------------------------
# Tool-call recognition - only `tool_use.input` is ever scanned
# --------------------------------------------------------------------------


def artifact_write_name(call: ToolCall) -> str | None:
    """The pipeline artifact a tool call writes, in either write form."""
    if call.name in ("Write", "Edit", "MultiEdit"):
        file_path = call.input.get("file_path")
        if isinstance(file_path, str):
            base = os.path.basename(file_path)
            if ARTIFACT_NAME_RE.match(base):
                return base
        return None
    if call.name.split("__")[-1] == "pipeline_write_artifact":
        name = call.input.get("name")
        if isinstance(name, str):
            base = name if name.endswith(".md") else name + ".md"
            if ARTIFACT_NAME_RE.match(base):
                return base
        return None
    if call.name == "Bash":
        match = _shell_artifact_redirect(call.input.get("command"))
        if match:
            return match.group("base")
    return None


# A shell write to an artifact: `> path`, `>> path` or `tee [-a] path` whose
# basename is a 03-06 artifact. A session told to work through the shell writes
# its artifacts with `cat > .../04-review.md <<'EOF'`, never with Write. Reading
# a file (`cat 04-review.md`, `< 04-review.md`) is not matched.
SHELL_ARTIFACT_REDIRECT_RE = re.compile(
    r"(?:(?<![<>&\d])>>?|\btee\s+(?:-a\s+)?)\s*[\"']?"
    r"(?P<path>(?:[^\s\"'<>|;&]*/)?(?P<base>0[3-6]-[a-z-]+\.md))(?![\w.-])"
)
HEREDOC_BODY_RE = re.compile(
    r"<<-?\s*[\"']?(?P<tag>[A-Za-z_][A-Za-z0-9_]*)[\"']?[^\n]*\n(?P<body>.*?)\n[ \t]*(?P=tag)[ \t]*(?:\n|$)",
    re.S,
)


def _shell_artifact_redirect(command):
    if not isinstance(command, str):
        return None
    return SHELL_ARTIFACT_REDIRECT_RE.search(command)


def artifact_write_body(call: ToolCall) -> str:
    if call.name == "Write":
        value = call.input.get("content")
    elif call.name == "Edit":
        value = call.input.get("new_string")
    elif call.name == "MultiEdit":
        edits = call.input.get("edits")
        value = "\n".join(
            str(e.get("new_string") or "") for e in edits if isinstance(e, dict)
        ) if isinstance(edits, list) else ""
    elif call.name.split("__")[-1] == "pipeline_write_artifact":
        value = call.input.get("body")
    elif call.name == "Bash" and _shell_artifact_redirect(call.input.get("command")):
        # The heredoc body when there is one; otherwise the command text, which
        # still carries an `echo`/`printf` payload.
        command = call.input.get("command")
        heredoc = HEREDOC_BODY_RE.search(command)
        value = heredoc.group("body") if heredoc else command
    else:
        value = ""
    return value if isinstance(value, str) else ""


def spawned_subagent_type(call: ToolCall) -> str | None:
    if call.name in SPAWN_TOOLS:
        value = call.input.get("subagent_type")
        return value if isinstance(value, str) else None
    return None


def _command_segments(command: str):
    """Split a shell command into runnable segments.

    Separators are `&&`, `||`, `;`, `|` and newlines. Leading environment
    assignments (`D=/tmp`, `ROOT=$(pwd)`) are stripped so the first real word
    is the one classified.
    """
    for segment in re.split(r"&&|\|\||[;\n|]", command):
        words = segment.strip().split()
        while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
            words = words[1:]
        if words:
            yield " ".join(words), words[0]


def counts_as_run(command: str, check_re) -> bool:
    for segment, first_word in _command_segments(command):
        if first_word in READ_ONLY_COMMANDS:
            continue
        if check_re.search(segment):
            return True
    return False


def _strip_quoted(text: str) -> str:
    """Blank out single- and double-quoted runs, keeping the string's length.

    A git verb is always a bare word, never inside a quoted argument, so the
    quoted text is noise for verb detection: without this
    `git commit -m "fix push bug"` reports a push that never happened.
    """
    return QUOTED_RE.sub(lambda match: " " * len(match.group(0)), text)


def _git_segment(command: str, verb: str) -> bool:
    for segment, first_word in _command_segments(command):
        if first_word != "git":
            continue
        words = _strip_quoted(segment).split()
        # `git -C <dir> commit ...` keeps the verb after the option block.
        if verb in words[1:]:
            return True
    return False


def has_commit(command: str) -> bool:
    return _git_segment(command, "commit")


def has_push(command: str) -> bool:
    return _git_segment(command, "push")


def has_pr_creation(command: str) -> bool:
    """`gh pr create` only. A push is not a PR - it is reported separately."""
    for segment, first_word in _command_segments(command):
        if first_word == "gh" and re.search(r"\bpr\s+create\b", segment):
            return True
    return False


# --------------------------------------------------------------------------
# Build recognition, phases, parity
# --------------------------------------------------------------------------


@dataclass
class Phase:
    name: str
    status: str = "ok"
    reason: str = ""
    turns: int = 0
    start_turn: int | None = None
    end_turn: int | None = None
    start_window: int | None = None
    end_window: int | None = None
    reread_self: int = 0
    reread_self_children: int = 0
    share_self: float | None = None
    share_self_children: float | None = None
    # The agents whose turns this phase spans. Empty for a single-agent build;
    # a three-stage build's review phase names its review-stage child, and its
    # post-review and post-gate phases the close-stage child.
    agent_ids: list = field(default_factory=list)


@dataclass
class Parity:
    verdict: str = "unknown"
    verdict_label: str = "unknown"
    findings: dict = field(default_factory=lambda: {s: "unknown" for s in SEVERITIES})
    findings_label: str = "unknown"
    check_runs: int | str = "unknown"
    bash_calls: int = 0
    check_runs_label: str = "unknown"
    commit: object = "unknown"
    pushed: object = "unknown"
    pr: object = "unknown"
    commit_pr_label: str = "unknown"
    tail_label: str = "unknown"
    notes: list = field(default_factory=list)


@dataclass
class BuildReport:
    agent_id: str
    ticket: str
    role: str
    site: str
    turns: int
    reread_self: int
    reread_self_children: int
    phases: list
    parity: Parity
    finalizer_agent_ids: list = field(default_factory=list)
    # Three-stage builds only: {"implement": [...], "review": [...], "close": [...]}.
    stage_agent_ids: dict = field(default_factory=dict)


def stage_child_kind(agent: Agent) -> str | None:
    """`review` or `close` for a review-stage / close-stage child, else None."""
    return STAGE_CHILD_ROLES.get(agent.role)


def is_build_agent(agent: Agent) -> bool:
    # A review-stage child writes 04-review.md and spawns the reviewers, but
    # it is a phase of its parent's build, never a build of its own.
    if stage_child_kind(agent):
        return False
    for call in agent.tool_calls:
        if artifact_write_name(call) == "04-review.md":
            return True
        if spawned_subagent_type(call) == REVIEWER_SUBAGENT:
            return True
    return False


def build_site(agent: Agent) -> str:
    if agent.agent_id == ROOT_AGENT_ID:
        return "root session (standalone /feature:build)"
    return "stage subagent (under flow)"


def _subtree_reread(agent_id, children_by_parent, by_id) -> int:
    total = 0
    for child in children_by_parent.get(agent_id, []):
        total += by_id[child].reread_sum + _subtree_reread(child, children_by_parent, by_id)
    return total


def split_phases(agent: Agent, spawn_turn_of_child, children_by_parent, by_id) -> list:
    # A phase boundary is the FIRST write of its marker artifact: the phase ends
    # the moment its output exists, and a later rewrite of that artifact is work
    # belonging to a later phase. One rule for both markers - a build that
    # appends its PR URL to 06-summary.md during the post-gate work must not
    # have that turn counted as post-review.
    first_reviewer = None
    review_write = None
    summary_write = None
    for call in agent.tool_calls:
        if first_reviewer is None and spawned_subagent_type(call) == REVIEWER_SUBAGENT:
            first_reviewer = call.turn
        name = artifact_write_name(call)
        if name == "04-review.md" and review_write is None:
            review_write = call.turn
        if name == "06-summary.md" and summary_write is None:
            summary_write = call.turn
    if review_write is not None and summary_write is not None and summary_write <= review_write:
        summary_write = None
    # The same normalisation for the other ordering: a 04-review.md write that
    # precedes the first reviewer spawn is not this review's output, so the
    # review boundary is unknown. Without this the phases overlap -
    # `implement` runs to first_reviewer-1 while `post-review` starts at
    # review_write+1, which is earlier - and the shares sum past 100%.
    review_before_spawn = (
        review_write is not None and first_reviewer is not None and review_write < first_reviewer
    )
    if review_before_spawn:
        review_write = None
        summary_write = None

    total_turns = len(agent.turns)
    windows = [t.window for t in agent.turns]

    def reread(start, end):
        if start > end:
            return 0
        return sum(windows[start - 1 : end])

    child_reread_at = {}
    for child_id in children_by_parent.get(agent.agent_id, []):
        spawn_turn = spawn_turn_of_child.get(child_id)
        if spawn_turn is None:
            continue
        subtree = by_id[child_id].reread_sum + _subtree_reread(child_id, children_by_parent, by_id)
        child_reread_at[spawn_turn] = child_reread_at.get(spawn_turn, 0) + subtree

    bounds = []
    if first_reviewer is None:
        bounds.append(("implement", 1, total_turns, "ok", ""))
        missing = "no reviewer spawn in this transcript"
        for name in PHASE_NAMES[1:]:
            bounds.append((name, None, None, "n/a", missing))
        # A build with no reviewer spawn ran everything before the review
        # boundary: report it as one implement phase spanning the agent rather
        # than as three zeroes.
        bounds[0] = ("implement", 1, total_turns, "ok", "")
    else:
        bounds.append(("implement", 1, first_reviewer - 1, "ok", ""))
        if review_write is None:
            if review_before_spawn:
                tail = "the only 04-review.md write precedes the first reviewer spawn"
                missing = f"{tail}, so the review boundary is unknown"
            else:
                tail = "no 04-review.md write"
                missing = f"{tail}, so the review boundary is unknown"
            bounds.append(("review", first_reviewer, total_turns, "ok", f"{tail}; review runs to the end"))
            for name in PHASE_NAMES[2:]:
                bounds.append((name, None, None, "n/a", missing))
        else:
            bounds.append(("review", first_reviewer, review_write, "ok", ""))
            if summary_write is None:
                bounds.append(
                    (
                        "post-review",
                        review_write + 1,
                        total_turns,
                        "ok",
                        "no 06-summary.md write; post-review runs to the end",
                    )
                )
                bounds.append(
                    (
                        "post-gate",
                        None,
                        None,
                        "n/a",
                        "no 06-summary.md write, so the post-gate boundary is unknown",
                    )
                )
            else:
                bounds.append(("post-review", review_write + 1, summary_write, "ok", ""))
                bounds.append(("post-gate", summary_write + 1, total_turns, "ok", ""))

    total_self = reread(1, total_turns)
    total_children = sum(child_reread_at.values())
    phases = []
    for name, start, end, status, reason in bounds:
        if status != "ok":
            phases.append(Phase(name=name, status=status, reason=reason))
            continue
        start = max(1, start)
        turns_in_phase = max(0, end - start + 1)
        self_sum = reread(start, end)
        children_sum = sum(v for t, v in child_reread_at.items() if start <= t <= end)
        phases.append(
            Phase(
                name=name,
                status="ok",
                reason=reason,
                turns=turns_in_phase,
                start_turn=start if turns_in_phase else None,
                end_turn=end if turns_in_phase else None,
                start_window=windows[start - 1] if turns_in_phase else None,
                end_window=windows[end - 1] if turns_in_phase else None,
                reread_self=self_sum,
                reread_self_children=self_sum + children_sum,
                share_self=(100.0 * self_sum / total_self) if total_self else None,
                share_self_children=(
                    100.0 * (self_sum + children_sum) / (total_self + total_children)
                    if (total_self + total_children)
                    else None
                ),
            )
        )
    return phases


def _accumulate_phase(name, spans, relay_spans, spawn_turn_of_child, children_by_parent, by_id, skip_children, reason=""):
    """One phase assembled from turn spans over one or more agents.

    `spans` are `(agent, start, end)` on the stage agents that own the phase;
    `relay_spans` are the sequencer's own turns that belong to it (the spawn
    and the turns that handle the return), counted into the sums but kept out
    of the turn range. A child spawned inside a span is credited to the phase,
    except the stage agents themselves, which `skip_children` names - their
    turns are already the phase's own.
    """
    turns = 0
    self_sum = 0
    children_sum = 0
    start_window = end_window = None
    start_turn = end_turn = None
    agent_ids = []
    relay_turns = 0
    relay_agent = None
    tagged = [(False, span) for span in spans] + [(True, span) for span in relay_spans]
    for is_relay, (agent, start, end) in tagged:
        start = max(1, start)
        end = min(end, len(agent.turns))
        if start > end:
            continue
        windows = [t.window for t in agent.turns]
        turns += end - start + 1
        self_sum += sum(windows[start - 1 : end])
        for child_id in children_by_parent.get(agent.agent_id, []):
            if child_id in skip_children:
                continue
            spawn = spawn_turn_of_child.get(child_id)
            if spawn is not None and start <= spawn <= end:
                children_sum += by_id[child_id].reread_sum + _subtree_reread(
                    child_id, children_by_parent, by_id
                )
        if is_relay:
            relay_turns += end - start + 1
            relay_agent = agent.agent_id
            continue
        if start_window is None:
            start_window = windows[start - 1]
            start_turn = start
        end_window = windows[end - 1]
        end_turn = end
        if agent.agent_id not in agent_ids:
            agent_ids.append(agent.agent_id)
    if relay_turns:
        note = f"+{relay_turns} sequencer turn(s) in {relay_agent}"
        reason = f"{reason}; {note}" if reason else note
    return Phase(
        name=name,
        status="ok",
        reason=reason,
        turns=turns,
        start_turn=start_turn,
        end_turn=end_turn,
        start_window=start_window,
        end_window=end_window,
        reread_self=self_sum,
        reread_self_children=self_sum + children_sum,
        agent_ids=agent_ids,
    )


def split_staged_phases(
    implement_agents, review_agents, close_agents, relay, spawn_turn_of_child, children_by_parent, by_id
):
    """Phases of a three-stage build: implement, then review-stage and
    close-stage children.

    `implement_agents` own every turn of the implement phase - `Build stage
    for` siblings under flow. When `relay` is set it is the standalone build
    root instead: its turns before the first stage spawn are the implement
    phase, and each later turn is credited to the stage whose spawn most
    recently preceded it (the spawn turn of the close stage to post-review,
    the turns after it to post-gate). Inside a close-stage child the
    post-review / post-gate boundary is the FIRST 06-summary.md write, as in
    `split_phases`.
    """
    stage_ids = {a.agent_id for a in review_agents + close_agents}
    relay_spans = {name: [] for name in PHASE_NAMES}
    if relay is not None:
        stage_spawns = sorted(
            (spawn_turn_of_child[a.agent_id], stage_child_kind(a))
            for a in review_agents + close_agents
            if a.agent_id in spawn_turn_of_child
        )
        first_spawn = stage_spawns[0][0] if stage_spawns else len(relay.turns) + 1
        implement_spans = [(relay, 1, first_spawn - 1)]
        for turn in range(first_spawn, len(relay.turns) + 1):
            spawn_turn, kind = max((s for s in stage_spawns if s[0] <= turn), key=lambda s: s[0])
            if kind == "review":
                relay_spans["review"].append((relay, turn, turn))
            elif turn == spawn_turn:
                relay_spans["post-review"].append((relay, turn, turn))
            else:
                relay_spans["post-gate"].append((relay, turn, turn))
    else:
        implement_spans = [(a, 1, len(a.turns)) for a in implement_agents]

    def phase(name, spans, reason=""):
        return _accumulate_phase(
            name, spans, relay_spans[name], spawn_turn_of_child, children_by_parent, by_id, stage_ids, reason
        )

    phases = []
    if implement_spans:
        phases.append(phase("implement", implement_spans))
    else:
        phases.append(
            Phase(
                name="implement",
                status="n/a",
                reason="no implement agent: the stage children's parent neither ran "
                "/feature:build nor spawned a `Build stage for` sibling",
            )
        )
    if review_agents:
        phases.append(phase("review", [(a, 1, len(a.turns)) for a in review_agents]))
    else:
        phases.append(Phase(name="review", status="n/a", reason="no review stage child"))
    if close_agents:
        post_review = []
        post_gate = []
        reasons = []
        for agent in close_agents:
            summary_write = next(
                (c.turn for c in agent.tool_calls if artifact_write_name(c) == "06-summary.md"),
                None,
            )
            if summary_write is None:
                post_review.append((agent, 1, len(agent.turns)))
                reasons.append(f"no 06-summary.md write in {agent.agent_id}; post-review runs to its end")
            else:
                post_review.append((agent, 1, summary_write))
                post_gate.append((agent, summary_write + 1, len(agent.turns)))
        phases.append(phase("post-review", post_review, "; ".join(reasons)))
        if post_gate:
            phases.append(phase("post-gate", post_gate))
        else:
            phases.append(
                Phase(
                    name="post-gate",
                    status="n/a",
                    reason="no 06-summary.md write, so the post-gate boundary is unknown",
                )
            )
    else:
        missing = "no close stage child"
        phases.append(Phase(name="post-review", status="n/a", reason=missing))
        phases.append(Phase(name="post-gate", status="n/a", reason=missing))

    total_self = sum(p.reread_self for p in phases)
    total_all = sum(p.reread_self_children for p in phases)
    for p in phases:
        if p.status != "ok":
            continue
        p.share_self = (100.0 * p.reread_self / total_self) if total_self else None
        p.share_self_children = (100.0 * p.reread_self_children / total_all) if total_all else None
    return phases


def _severity_counts(body: str):
    """Reviewer findings per severity, from the review body.

    First choice is the documented top-of-file count block, in either the
    pipe-table form or a `SEVERITY: n` line. Anything recovered by scanning
    the body instead is labelled an estimate.
    """
    counts = {}
    for severity in SEVERITIES:
        # `| IMPORTANT | 4 (after de-duplication) |` is still a count cell.
        table = re.search(
            rf"^\|\s*{severity}\s*\|\s*(\d+)\b[^|]*\|", body, re.MULTILINE | re.IGNORECASE
        )
        inline = re.search(rf"^\s*{severity}\s*[:=]\s*(\d+)\b", body, re.MULTILINE | re.IGNORECASE)
        match = table or inline
        if match:
            counts[severity] = int(match.group(1))
    if len(counts) == len(SEVERITIES):
        return counts, "exact"

    # A single line carrying all three counts, e.g.
    # `10 findings (0 CRITICAL, 8 IMPORTANT, 2 SUGGESTION)`. All three must
    # appear together, so a sentence mentioning one severity cannot match.
    triple = re.search(
        r"(\d+)\s+CRITICAL[^\n]*?(\d+)\s+IMPORTANT[^\n]*?(\d+)\s+SUGGESTION",
        body,
        re.IGNORECASE,
    )
    if triple:
        return dict(zip(SEVERITIES, (int(g) for g in triple.groups()))), "exact"

    estimated = {}
    for severity in SEVERITIES:
        heading = re.search(
            rf"^(#+)\s*{severity}\b[^\n]*\n", body, re.MULTILINE | re.IGNORECASE
        )
        if heading is None:
            estimated[severity] = counts.get(severity, 0)
            continue
        # The section ends at the next heading of the same or a higher level,
        # so the findings nested under it stay inside it.
        level = len(heading.group(1))
        rest = body[heading.end() :]
        following = re.search(rf"^#{{1,{level}}}\s", rest, re.MULTILINE)
        text = rest[: following.start()] if following else rest
        if re.match(r"^none\b", text.strip(), re.IGNORECASE):
            estimated[severity] = 0
        else:
            estimated[severity] = len(re.findall(r"^#+\s+\S", text, re.MULTILINE)) or len(
                re.findall(r"^\s*[-*]\s+\S", text, re.MULTILINE)
            )
    return estimated, "estimate"


def _newest_answer(calls, answer_of):
    """Scan an artifact's writes newest first; the first write that answers wins.

    The last write is not always the informative one: a build appends its PR URL
    to `06-summary.md` with an `Edit` carrying that line alone, and records a
    deferred conflict into `04-review.md` the same way. Reading only the last
    write would report `unknown` for a verdict, or zero findings for a review
    that had them.
    """
    for call in reversed(calls):
        answer = answer_of(call)
        if answer is not None:
            return answer
    return None


def extract_parity(artifact_agents, bash_agents, check_re) -> Parity:
    """Parity fields of one build.

    `artifact_agents` are scanned for the 04-review.md and 06-summary.md
    writes - the build itself in the single-agent shape, the review-stage and
    close-stage children in the three-stage one. `bash_agents` are scanned for
    check runs and the commit / push / PR commands: those plus the implement
    agent and the finalizer, whose commands answer the same questions.
    """
    parity = Parity()

    summary_calls = [
        c for a in artifact_agents for c in a.tool_calls if artifact_write_name(c) == "06-summary.md"
    ]
    review_calls = [
        c for a in artifact_agents for c in a.tool_calls if artifact_write_name(c) == "04-review.md"
    ]

    def verdict_of(call):
        found = VERDICT_RE.search(artifact_write_body(call))
        if found:
            return found.group(1).lower(), None
        # The server-side write carries its verdict as a field rather than in
        # the body. It is validated against the known vocabulary before it is
        # copied: an unrecognised value is a shape this script does not know,
        # not a verdict, and raw tool input must never reach the report.
        raw = call.input.get("verdict")
        if isinstance(raw, str) and raw.strip().lower() in KNOWN_VERDICTS:
            return raw.strip().lower(), (
                "verdict read from the artifact-write verdict field, whose vocabulary is "
                "pass|fail|partial and differs from the build verdict set pass|partial|stuck"
            )
        return None

    answer = _newest_answer(summary_calls, verdict_of)
    if answer is not None:
        parity.verdict, note = answer
        parity.verdict_label = "exact"
        if note:
            parity.notes.append(note)
    elif summary_calls:
        parity.notes.append(
            "no 06-summary.md write in this transcript states a recognised verdict"
        )

    def findings_of(call):
        counts, label = _severity_counts(artifact_write_body(call))
        # An exact count block of all zeros is a real zero - the all-reviewers-
        # failed case. An estimate of all zeros is a body that answered nothing.
        if label == "exact" or any(counts.values()):
            return counts, label
        return None

    answer = _newest_answer(review_calls, findings_of)
    if answer is not None:
        counts, label = answer
        parity.findings = {s: counts.get(s, 0) for s in SEVERITIES}
        parity.findings_label = label
    elif review_calls:
        parity.notes.append(
            "no 04-review.md write in this transcript carries a severity count, "
            "so the findings stay unknown rather than zero"
        )

    runs = 0
    bash_calls = 0
    commit = False
    pushed = False
    pr = False
    for source in bash_agents:
        for call in source.tool_calls:
            if call.name != "Bash":
                continue
            command = call.input.get("command")
            if not isinstance(command, str):
                continue
            bash_calls += 1
            if counts_as_run(command, check_re):
                runs += 1
            if has_commit(command):
                commit = True
            if has_push(command):
                pushed = True
            if has_pr_creation(command):
                pr = True
    parity.check_runs = runs
    parity.bash_calls = bash_calls
    parity.check_runs_label = "estimate"

    # The commit and PR answers are only trustworthy once the transcript has
    # reached the post-gate work. A build that never wrote 06-summary.md ended
    # before that point, so the tail is genuinely unknown rather than false.
    if summary_calls:
        parity.tail_label = "exact"
        parity.commit = commit
        parity.pushed = pushed
        parity.pr = pr
        parity.commit_pr_label = "estimate"
    else:
        parity.notes.append(
            "no 06-summary.md write, so the transcript ends before the commit and PR work"
        )

    return parity


# --------------------------------------------------------------------------
# Report assembly
# --------------------------------------------------------------------------


@dataclass
class Report:
    session_id: str
    weights: dict
    role_map_source: dict
    check_pattern: str
    agents: list
    builds: list
    notes: list = field(default_factory=list)

    def total_units(self) -> float:
        return sum(a.weighted_units(self.weights) for a in self.agents)


def build_report(session_id, raws, weights, role_map_source, check_pattern, ticket_prefixes=None) -> Report:
    role_map = compile_role_map(role_map_source)
    check_re = compile_check_pattern(check_pattern)

    agents = parse_agents(raws, role_map)
    attribute_tickets(agents, ticket_prefixes)

    by_id = {a.agent_id: a for a in agents}
    children_by_parent = {}
    for agent in agents:
        if agent.parent_id and agent.parent_id in by_id:
            children_by_parent.setdefault(agent.parent_id, []).append(agent.agent_id)

    # One pass over every tool call, not a rescan of the parent's calls per
    # child: tool_use ids are unique across the session, so a single index
    # answers every spawn-turn lookup.
    turn_of_tool_use = {
        call.tool_use_id: call.turn
        for a in agents
        for call in a.tool_calls
        if call.tool_use_id
    }
    spawn_turn_of_child = {
        a.agent_id: turn_of_tool_use[a.tool_use_id]
        for a in agents
        if a.tool_use_id and a.tool_use_id in turn_of_tool_use
    }

    notes = []
    orphans = [a.agent_id for a in agents if a.parent_id and a.parent_id not in by_id]
    if orphans:
        notes.append(
            f"{len(orphans)} agent(s) name a parent that is not in this session: "
            + ", ".join(sorted(orphans))
        )

    # Degradations belong on the report, not in one renderer: a `--json`
    # consumer - `compare --assert` included - must see the same undercount
    # warning a reader of the text report sees.
    no_usage = sum(a.turns_without_usage for a in agents)
    if no_usage:
        notes.append(
            f"{no_usage} turn(s) carry no usage and are counted as zero tokens; "
            "every sum and share below them is an undercount, and an agent whose "
            "first turn is one reports its floor as '-'"
        )
    unknown_types = sorted({t for a in agents for t in a.unknown_record_types})
    if unknown_types:
        notes.append(
            "record type(s) this script does not classify were ignored: "
            + ", ".join(unknown_types)
        )

    def finalizer_re_for(ticket):
        return re.compile(
            FINALIZER_DESC_RE_TEMPLATE.format(ticket=re.escape(ticket))
            if ticket != UNATTRIBUTED
            else r"^Finalize\b"
        )

    def finalizers_under(parent_ids, ticket):
        pattern = finalizer_re_for(ticket)
        return [
            child
            for parent_id in parent_ids
            for child in children_by_parent.get(parent_id, [])
            if pattern.search(by_id[child].description or "")
        ]

    # Three-stage builds: a review-stage or close-stage child is a phase of
    # its parent's build, grouped by (parent, ticket). A finalizer under a
    # close stage is that build's post-gate child.
    staged = {}
    for agent in agents:
        kind = stage_child_kind(agent)
        if kind and agent.parent_id in by_id:
            group = staged.setdefault((agent.parent_id, agent.ticket), {"review": [], "close": []})
            group[kind].append(agent)
    staged_parents = {parent_id for parent_id, _ in staged}

    builds = []
    for agent in agents:
        if not is_build_agent(agent) or agent.agent_id in staged_parents:
            continue
        phases = split_phases(agent, spawn_turn_of_child, children_by_parent, by_id)
        finalizers = finalizers_under([agent.agent_id], agent.ticket)
        parity = extract_parity([agent], [agent] + [by_id[c] for c in finalizers], check_re)
        children_total = sum(
            by_id[c].reread_sum + _subtree_reread(c, children_by_parent, by_id)
            for c in children_by_parent.get(agent.agent_id, [])
        )
        builds.append(
            BuildReport(
                agent_id=agent.agent_id,
                ticket=agent.ticket,
                role=agent.role,
                site=build_site(agent),
                turns=len(agent.turns),
                reread_self=agent.reread_sum,
                reread_self_children=agent.reread_sum + children_total,
                phases=phases,
                parity=parity,
                finalizer_agent_ids=finalizers,
            )
        )

    def spawn_order(agent):
        return spawn_turn_of_child.get(agent.agent_id, 0)

    for (parent_id, ticket), group in staged.items():
        parent = by_id[parent_id]
        review_agents = sorted(group["review"], key=spawn_order)
        close_agents = sorted(group["close"], key=spawn_order)
        stage_ids = {a.agent_id for a in review_agents + close_agents}
        siblings = [
            by_id[c]
            for c in children_by_parent.get(parent_id, [])
            if by_id[c].role == IMPLEMENT_STAGE_ROLE and by_id[c].ticket == ticket
        ]
        if siblings:
            implement_agents, relay = sorted(siblings, key=spawn_order), None
            site = "stage subagents (under flow)"
        elif parent.agent_id == ROOT_AGENT_ID or parent.slash_build_ticket:
            implement_agents, relay = [parent], parent
            site = "root session (standalone /feature:build), stages as subagents"
        else:
            implement_agents, relay = [], None
            site = "stage subagents (implement agent not found)"
        phases = split_staged_phases(
            implement_agents, review_agents, close_agents, relay, spawn_turn_of_child, children_by_parent, by_id
        )
        finalizers = finalizers_under([a.agent_id for a in close_agents], ticket)
        group_agents = implement_agents + review_agents + close_agents
        parity = extract_parity(
            review_agents + close_agents, group_agents + [by_id[c] for c in finalizers], check_re
        )
        reread_self = sum(a.reread_sum for a in group_agents)
        children_total = sum(
            by_id[c].reread_sum + _subtree_reread(c, children_by_parent, by_id)
            for a in group_agents
            for c in children_by_parent.get(a.agent_id, [])
            if c not in stage_ids
        )
        builds.append(
            BuildReport(
                agent_id=implement_agents[0].agent_id if implement_agents else f"{parent_id} (stages)",
                ticket=ticket,
                role="three-stage build",
                site=site,
                turns=sum(len(a.turns) for a in group_agents),
                reread_self=reread_self,
                reread_self_children=reread_self + children_total,
                phases=phases,
                parity=parity,
                finalizer_agent_ids=finalizers,
                stage_agent_ids={
                    "implement": [a.agent_id for a in implement_agents],
                    "review": [a.agent_id for a in review_agents],
                    "close": [a.agent_id for a in close_agents],
                },
            )
        )

    if not builds:
        notes.append("no build agent in this session, so the phase table is omitted")

    report = Report(
        session_id=session_id,
        weights=dict(weights),
        role_map_source=dict(role_map_source),
        check_pattern=check_pattern,
        agents=agents,
        builds=builds,
        notes=notes,
    )
    return report


def compile_role_map(role_map_source):
    compiled = {}
    for role, pattern in role_map_source.items():
        if not isinstance(pattern, str):
            raise MeasureError("--role-map", f"entry {role!r} is not a regex string")
        try:
            compiled[role] = re.compile(pattern)
        except re.error as exc:
            raise MeasureError("--role-map", f"entry {role!r} will not compile: {exc}") from exc
    return compiled


def compile_check_pattern(pattern):
    try:
        return re.compile(pattern)
    except re.error as exc:
        raise MeasureError("--check-pattern", f"will not compile: {exc}") from exc


def group_totals(report: Report, key):
    groups = {}
    for agent in report.agents:
        bucket = groups.setdefault(
            key(agent),
            {
                "count": 0,
                "turns": 0,
                "input_tokens": 0,
                "cache_write_tokens": 0,
                "cache_read_tokens": 0,
                "output_tokens": 0,
                "weighted_units": 0.0,
            },
        )
        bucket["count"] += 1
        bucket["turns"] += len(agent.turns)
        bucket["input_tokens"] += agent.input_tokens
        bucket["cache_write_tokens"] += agent.cache_write_tokens
        bucket["cache_read_tokens"] += agent.cache_read_tokens
        bucket["output_tokens"] += agent.output_tokens
        bucket["weighted_units"] += agent.weighted_units(report.weights)
    total = sum(b["weighted_units"] for b in groups.values())
    for bucket in groups.values():
        bucket["share_pct"] = (100.0 * bucket["weighted_units"] / total) if total else 0.0
    return groups


def model_totals(report: Report):
    totals = {}
    for agent in report.agents:
        label = "/".join(agent.models) if agent.models else "unknown"
        bucket = totals.setdefault(
            label,
            {
                "turns": 0,
                "input_tokens": 0,
                "cache_write_tokens": 0,
                "cache_read_tokens": 0,
                "output_tokens": 0,
            },
        )
        bucket["turns"] += len(agent.turns)
        bucket["input_tokens"] += agent.input_tokens
        bucket["cache_write_tokens"] += agent.cache_write_tokens
        bucket["cache_read_tokens"] += agent.cache_read_tokens
        bucket["output_tokens"] += agent.output_tokens
    return totals


# --------------------------------------------------------------------------
# Serialization - explicit field lists, which is the privacy guarantee
# --------------------------------------------------------------------------


def weights_expression(weights) -> str:
    return (
        f"{weights['i']:g}*input + {weights['cw']:g}*cache_write "
        f"+ {weights['cr']:g}*cache_read + {weights['o']:g}*output"
    )


def agent_to_dict(agent: Agent, weights) -> dict:
    return {
        "agent_id": agent.agent_id,
        "role": agent.role,
        "agent_type": agent.agent_type,
        "description": agent.description,
        "spawn_depth": agent.spawn_depth,
        "parent": agent.parent_id,
        "ticket": agent.ticket,
        "models": list(agent.models),
        "turns": len(agent.turns),
        "turns_without_usage": agent.turns_without_usage,
        "input_tokens": agent.input_tokens,
        "cache_write_tokens": agent.cache_write_tokens,
        "cache_read_tokens": agent.cache_read_tokens,
        "output_tokens": agent.output_tokens,
        "first_turn_floor": agent.first_turn_floor,
        "peak_window": agent.peak_window,
        "reread_sum": agent.reread_sum,
        "weighted_units": round(agent.weighted_units(weights), 3),
    }


def phase_to_dict(phase: Phase) -> dict:
    return {
        "name": phase.name,
        "status": phase.status,
        "reason": phase.reason,
        "turns": phase.turns,
        "start_turn": phase.start_turn,
        "end_turn": phase.end_turn,
        "start_window": phase.start_window,
        "end_window": phase.end_window,
        "reread_self": phase.reread_self,
        "reread_self_children": phase.reread_self_children,
        "agent_ids": list(phase.agent_ids),
        "share_self_pct": None if phase.share_self is None else round(phase.share_self, 3),
        "share_self_children_pct": (
            None if phase.share_self_children is None else round(phase.share_self_children, 3)
        ),
    }


def parity_to_dict(parity: Parity) -> dict:
    return {
        "verdict": parity.verdict,
        "verdict_label": parity.verdict_label,
        "findings": dict(parity.findings),
        "findings_label": parity.findings_label,
        "check_runs": parity.check_runs,
        "bash_calls": parity.bash_calls,
        "check_runs_label": parity.check_runs_label,
        "commit": parity.commit,
        "pushed": parity.pushed,
        "pr": parity.pr,
        "commit_pr_label": parity.commit_pr_label,
        "tail_label": parity.tail_label,
        "notes": list(parity.notes),
    }


def build_to_dict(build: BuildReport) -> dict:
    return {
        "agent_id": build.agent_id,
        "ticket": build.ticket,
        "role": build.role,
        "site": build.site,
        "turns": build.turns,
        "reread_self": build.reread_self,
        "reread_self_children": build.reread_self_children,
        "phases": [phase_to_dict(p) for p in build.phases],
        "parity": parity_to_dict(build.parity),
        "finalizer_agent_ids": list(build.finalizer_agent_ids),
        "stage_agent_ids": {k: list(v) for k, v in build.stage_agent_ids.items()},
    }


def report_to_dict(report: Report) -> dict:
    """The full JSON document.

    Every value below is copied from a named field of the report model. No
    transcript record, message body or tool input is reachable from here.
    """
    roles = group_totals(report, lambda a: a.role)
    tickets = group_totals(report, lambda a: a.ticket)
    models = model_totals(report)
    return {
        "schema_version": SCHEMA_VERSION,
        "generator": GENERATOR,
        # The session id only - never the transcript path, which carries the
        # user's home directory.
        "session_id": report.session_id,
        "unit": UNIT_NAME,
        "weights": dict(report.weights),
        "weights_expression": weights_expression(report.weights),
        "role_map": dict(report.role_map_source),
        "check_pattern": report.check_pattern,
        "labels": {"exact": EXACT_FIGURES, "estimate": ESTIMATE_FIGURES},
        "totals": {
            "agents": len(report.agents),
            "turns": sum(len(a.turns) for a in report.agents),
            "input_tokens": sum(a.input_tokens for a in report.agents),
            "cache_write_tokens": sum(a.cache_write_tokens for a in report.agents),
            "cache_read_tokens": sum(a.cache_read_tokens for a in report.agents),
            "output_tokens": sum(a.output_tokens for a in report.agents),
            "weighted_units": round(report.total_units(), 3),
        },
        "agents": [agent_to_dict(a, report.weights) for a in report.agents],
        "roles": [
            {"role": name, **{k: (round(v, 3) if isinstance(v, float) else v) for k, v in data.items()}}
            for name, data in sorted(roles.items(), key=lambda kv: -kv[1]["weighted_units"])
        ],
        "tickets": [
            {"ticket": name, **{k: (round(v, 3) if isinstance(v, float) else v) for k, v in data.items()}}
            for name, data in sorted(tickets.items(), key=lambda kv: -kv[1]["weighted_units"])
        ],
        "models": [{"model": name, **data} for name, data in sorted(models.items())],
        "builds": [build_to_dict(b) for b in report.builds],
        "notes": list(report.notes),
    }


# --------------------------------------------------------------------------
# Text rendering
# --------------------------------------------------------------------------


def _fmt_int(value) -> str:
    if value is None:
        return "-"
    return f"{value:,}"


def _table(headers, rows) -> list:
    widths = [len(h) for h in headers]
    for row in rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(str(cell)))
    lines = ["  ".join(h.ljust(widths[i]) for i, h in enumerate(headers)).rstrip()]
    lines.append("  ".join("-" * widths[i] for i in range(len(headers))))
    for row in rows:
        lines.append(
            "  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(row)).rstrip()
        )
    return lines


def render_text(report: Report, session_path=None) -> str:
    weights = report.weights
    out = []
    out.append(f"# Session measurement - {report.session_id}")
    if session_path:
        # The file name only. The full path carries the user's home directory
        # and the project slug, which no output of this script emits.
        out.append(f"transcript file: {Path(session_path).name}")
    out.append(f"agents: {len(report.agents)}   turns: {sum(len(a.turns) for a in report.agents)}")
    out.append("")
    out.append("## Units")
    out.append(f"weighted units = {weights_expression(weights)}")
    out.append(f"unit: {UNIT_NAME}")

    example = max(report.agents, key=lambda a: a.weighted_units(weights))
    out.append(
        "worked example ({}): {} = {:,.0f} weighted units".format(
            example.agent_id,
            " + ".join(
                f"{weights[k]:g}*{v:,}"
                for k, v in zip(
                    WEIGHT_KEYS,
                    (
                        example.input_tokens,
                        example.cache_write_tokens,
                        example.cache_read_tokens,
                        example.output_tokens,
                    ),
                )
            ),
            example.weighted_units(weights),
        )
    )
    out.append(
        "re-read sum = sum over a phase's turns of "
        "(input_tokens + cache_creation_input_tokens + cache_read_input_tokens)"
    )
    if report.agents and report.agents[0].turns:
        first = report.agents[0]
        head = first.turns[:3]
        out.append(
            "worked example ({}, turns 1-{}): {} = {:,}".format(
                first.agent_id,
                len(head),
                " + ".join(f"{t.window:,}" for t in head),
                sum(t.window for t in head),
            )
        )
    out.append(f"exact (from API usage): {EXACT_FIGURES}")
    out.append(f"estimate: {ESTIMATE_FIGURES}")
    out.append("")
    out.append("## Role map (applied to general-purpose agents, in order)")
    for role, pattern in report.role_map_source.items():
        out.append(f"  {role:<20} {pattern}")
    out.append(f"check/test-run pattern: {report.check_pattern}")
    out.append("")

    out.append("## Agents")
    rows = []
    for agent in sorted(report.agents, key=lambda a: -a.weighted_units(weights)):
        rows.append(
            [
                agent.agent_id,
                agent.role,
                (agent.description or "-")[:38],
                agent.spawn_depth,
                agent.parent_id or "-",
                "/".join(agent.models) or "unknown",
                agent.ticket,
                len(agent.turns),
                _fmt_int(agent.input_tokens),
                _fmt_int(agent.cache_write_tokens),
                _fmt_int(agent.cache_read_tokens),
                _fmt_int(agent.output_tokens),
                _fmt_int(agent.first_turn_floor),
                _fmt_int(agent.peak_window),
                f"{agent.weighted_units(weights) / 1000:,.0f}k",
            ]
        )
    out += _table(
        [
            "agent",
            "role",
            "description",
            "depth",
            "parent",
            "model",
            "ticket",
            "turns",
            "input tok",
            "cache-w tok",
            "cache-r tok",
            "output tok",
            "floor tok",
            "peak tok",
            "units (w)",
        ],
        rows,
    )
    out.append("")

    for title, key in (("Roles", lambda a: a.role), ("Tickets", lambda a: a.ticket)):
        groups = group_totals(report, key)
        out.append(f"## {title} (weighted units)")
        rows = [
            [
                name,
                data["count"],
                data["turns"],
                _fmt_int(data["input_tokens"]),
                _fmt_int(data["cache_write_tokens"]),
                _fmt_int(data["cache_read_tokens"]),
                _fmt_int(data["output_tokens"]),
                f"{data['weighted_units'] / 1000:,.0f}k",
                f"{data['share_pct']:.1f}%",
            ]
            for name, data in sorted(groups.items(), key=lambda kv: -kv[1]["weighted_units"])
        ]
        out += _table(
            [
                title[:-1].lower(),
                "agents",
                "turns",
                "input tok",
                "cache-w tok",
                "cache-r tok",
                "output tok",
                "units (w)",
                "share",
            ],
            rows,
        )
        out.append("")

    out.append("## Raw token totals per model (no weighting applied)")
    rows = [
        [
            name,
            data["turns"],
            _fmt_int(data["input_tokens"]),
            _fmt_int(data["cache_write_tokens"]),
            _fmt_int(data["cache_read_tokens"]),
            _fmt_int(data["output_tokens"]),
        ]
        for name, data in sorted(model_totals(report).items())
    ]
    out += _table(
        ["model", "turns", "input tok", "cache-w tok", "cache-r tok", "output tok"], rows
    )
    out.append("")

    if report.builds:
        out.append("## Build phases (re-read sum, in tokens)")
        for build in report.builds:
            out.append(
                f"### {build.ticket} - {build.agent_id} ({build.site}), "
                f"{build.turns} turns, re-read self {build.reread_self:,}"
            )
            rows = []
            for phase in build.phases:
                if phase.status != "ok":
                    rows.append([phase.name, "n/a", "-", "-", "-", "-", "-", "-", phase.reason])
                    continue
                rows.append(
                    [
                        phase.name,
                        phase.turns,
                        f"{phase.start_turn}-{phase.end_turn}" if phase.turns else "-",
                        _fmt_int(phase.start_window),
                        _fmt_int(phase.end_window),
                        _fmt_int(phase.reread_self),
                        f"{phase.share_self:.1f}%" if phase.share_self is not None else "-",
                        _fmt_int(phase.reread_self_children),
                        f"{phase.share_self_children:.1f}%"
                        if phase.share_self_children is not None
                        else "-",
                    ]
                )
            out += _table(
                [
                    "phase",
                    "turns",
                    "turn range",
                    "start window",
                    "end window",
                    "re-read self",
                    "share self",
                    "re-read self+children",
                    "share self+children",
                ],
                rows,
            )
            if build.stage_agent_ids:
                out.append(
                    "stage agents: "
                    + " | ".join(
                        f"{stage} {', '.join(ids) or '-'}"
                        for stage, ids in build.stage_agent_ids.items()
                    )
                )
            if build.finalizer_agent_ids:
                out.append(
                    "finalizer child in post-gate: " + ", ".join(build.finalizer_agent_ids)
                )
            parity = build.parity
            out.append(
                "parity: verdict {} ({}) | findings C{} I{} S{} ({}) | "
                "check runs {} of {} Bash calls ({}) | "
                "commit {} | pushed {} | pr {} ({}, tail {})".format(
                    parity.verdict,
                    parity.verdict_label,
                    parity.findings.get("CRITICAL"),
                    parity.findings.get("IMPORTANT"),
                    parity.findings.get("SUGGESTION"),
                    parity.findings_label,
                    parity.check_runs,
                    parity.bash_calls,
                    parity.check_runs_label,
                    parity.commit,
                    parity.pushed,
                    parity.pr,
                    parity.commit_pr_label,
                    parity.tail_label,
                )
            )
            for note in parity.notes:
                out.append(f"  note: {note}")
            out.append("")

    # Every note lives on `report.notes`, so the text report and the JSON
    # document a `compare --assert` reads carry the same degradations.
    for note in report.notes:
        out.append(f"note: {note}")
    if report.notes:
        out.append("")

    out.append(f"OK: measured {len(report.agents)} agent(s) in session {report.session_id}.")
    return "\n".join(out)


# --------------------------------------------------------------------------
# compare
# --------------------------------------------------------------------------


def load_report_document(path_text: str) -> dict:
    path = Path(path_text).expanduser()
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise MeasureError(path, f"cannot read the report ({exc.strerror})") from exc
    except json.JSONDecodeError as exc:
        raise MeasureError(path, f"not valid JSON ({exc.msg})") from exc
    check_schema_version(document, path)
    return document


def _arm_values(documents, extract):
    """Collect one figure across an arm; missing in a document means absent."""
    values = []
    for document in documents:
        value = extract(document)
        if value is not None:
            values.append(value)
    return values


def _span(values):
    if not values:
        return None
    if len(values) == 1:
        return {"min": values[0], "median": values[0], "max": values[0], "n": 1}
    return {
        "min": min(values),
        "median": statistics.median(values),
        "max": max(values),
        "n": len(values),
    }


def _fmt_span(span, suffix="", scale=1.0):
    if span is None:
        return "n/a"
    if span["n"] == 1:
        return f"{span['median'] / scale:,.1f}{suffix}"
    return (
        f"{span['min'] / scale:,.1f}/{span['median'] / scale:,.1f}/"
        f"{span['max'] / scale:,.1f}{suffix}"
    )


def _role_index(document):
    return {row["role"]: row for row in document.get("roles", [])}


def _keyed_builds(document):
    """Yield (key, build) using one occurrence rule, so every index lines up."""
    seen = {}
    for build in document.get("builds", []):
        ticket = build.get("ticket", UNATTRIBUTED)
        occurrence = seen.get(ticket, 0)
        seen[ticket] = occurrence + 1
        yield (ticket if occurrence == 0 else f"{ticket}#{occurrence + 1}"), build


def _phase_index(document):
    return {
        f"{key}:{phase['name']}": phase
        for key, build in _keyed_builds(document)
        for phase in build.get("phases", [])
    }


def _parity_index(document):
    return {key: build.get("parity", {}) for key, build in _keyed_builds(document)}


def compare_reports(baseline_docs, candidate_docs, tolerance_share, tolerance_rel, assert_mode):
    lines = []
    failures = []

    if not baseline_docs:
        raise MeasureError("--baseline", "the baseline arm holds zero reports")
    if not candidate_docs:
        raise MeasureError("--candidate", "the candidate arm holds zero reports")

    lines.append("# Compare")
    lines.append(
        f"baseline: {len(baseline_docs)} report(s) - "
        + ", ".join(d.get("session_id", "?") for d in baseline_docs)
    )
    lines.append(
        f"candidate: {len(candidate_docs)} report(s) - "
        + ", ".join(d.get("session_id", "?") for d in candidate_docs)
    )
    lines.append("")

    base_weights = {tuple(sorted(d.get("weights", {}).items())) for d in baseline_docs + candidate_docs}
    if len(base_weights) > 1:
        lines.append(
            "warning: the arms were produced under different weights; weighted figures "
            "are not comparable across them"
        )
    base_maps = {
        tuple(sorted(d.get("role_map", {}).items())) for d in baseline_docs + candidate_docs
    }
    if len(base_maps) > 1:
        lines.append(
            "warning: the arms were produced under different role maps; only roles present "
            "in both arms are compared"
        )
    if len(base_weights) > 1 or len(base_maps) > 1:
        lines.append("")

    # --- roles -------------------------------------------------------------
    base_roles = [_role_index(d) for d in baseline_docs]
    cand_roles = [_role_index(d) for d in candidate_docs]
    role_names = sorted(
        {name for index in base_roles for name in index}
        | {name for index in cand_roles for name in index}
    )
    excluded = [
        name
        for name in role_names
        if not any(name in i for i in base_roles) or not any(name in i for i in cand_roles)
    ]
    rows = []
    for name in role_names:
        base_units = _span(_arm_values(base_roles, lambda i, n=name: i.get(n, {}).get("weighted_units")))
        cand_units = _span(_arm_values(cand_roles, lambda i, n=name: i.get(n, {}).get("weighted_units")))
        base_share = _span(_arm_values(base_roles, lambda i, n=name: i.get(n, {}).get("share_pct")))
        cand_share = _span(_arm_values(cand_roles, lambda i, n=name: i.get(n, {}).get("share_pct")))
        delta_units = (
            f"{(cand_units['median'] - base_units['median']) / 1000:+,.1f}k"
            if base_units and cand_units
            else "n/a"
        )
        delta_share = (
            f"{cand_share['median'] - base_share['median']:+.1f}pp"
            if base_share and cand_share
            else "n/a"
        )
        rows.append(
            [
                name,
                _fmt_span(base_units, "k", 1000.0),
                _fmt_span(cand_units, "k", 1000.0),
                delta_units,
                _fmt_span(base_share, "%"),
                _fmt_span(cand_share, "%"),
                delta_share,
            ]
        )
        if assert_mode and base_units and cand_units:
            failures += _check_tolerance(
                f"role {name} weighted units",
                base_units["median"],
                cand_units["median"],
                tolerance_rel,
                None,
            )
            failures += _check_tolerance(
                f"role {name} share",
                base_share["median"],
                cand_share["median"],
                None,
                tolerance_share,
            )
        elif assert_mode:
            failures.append(f"role {name}: present in only one arm")

    lines.append("## Role deltas (weighted units; min/median/max when an arm holds several reports)")
    lines += _table(
        ["role", "baseline", "candidate", "delta", "base share", "cand share", "delta"], rows
    )
    if excluded:
        lines.append("roles present in only one arm: " + ", ".join(excluded))
    lines.append("")

    # --- phases ------------------------------------------------------------
    base_phases = [_phase_index(d) for d in baseline_docs]
    cand_phases = [_phase_index(d) for d in candidate_docs]
    keys = sorted(
        {k for index in base_phases for k in index} | {k for index in cand_phases for k in index}
    )
    rows = []
    for key in keys:
        base_sum = _span(_arm_values(base_phases, lambda i, k=key: i.get(k, {}).get("reread_self")))
        cand_sum = _span(_arm_values(cand_phases, lambda i, k=key: i.get(k, {}).get("reread_self")))
        base_share = _span(
            _arm_values(base_phases, lambda i, k=key: i.get(k, {}).get("share_self_pct"))
        )
        cand_share = _span(
            _arm_values(cand_phases, lambda i, k=key: i.get(k, {}).get("share_self_pct"))
        )
        if base_sum is None or cand_sum is None:
            rows.append(
                [
                    key,
                    _fmt_span(base_sum, "k", 1000.0),
                    _fmt_span(cand_sum, "k", 1000.0),
                    "n/a",
                    _fmt_span(base_share, "%"),
                    _fmt_span(cand_share, "%"),
                    "n/a",
                ]
            )
            if assert_mode:
                failures.append(f"phase {key}: present in only one arm")
            continue
        rows.append(
            [
                key,
                _fmt_span(base_sum, "k", 1000.0),
                _fmt_span(cand_sum, "k", 1000.0),
                f"{(cand_sum['median'] - base_sum['median']) / 1000:+,.1f}k",
                _fmt_span(base_share, "%"),
                _fmt_span(cand_share, "%"),
                f"{cand_share['median'] - base_share['median']:+.1f}pp"
                if base_share and cand_share
                else "n/a",
            ]
        )
        if assert_mode:
            failures += _check_tolerance(
                f"phase {key} re-read sum", base_sum["median"], cand_sum["median"], tolerance_rel, None
            )
            if base_share and cand_share:
                failures += _check_tolerance(
                    f"phase {key} share", base_share["median"], cand_share["median"], None, tolerance_share
                )

    lines.append("## Phase deltas (re-read sum, self column)")
    lines += _table(
        ["ticket:phase", "baseline", "candidate", "delta", "base share", "cand share", "delta"],
        rows,
    )
    lines.append("")

    # --- parity ------------------------------------------------------------
    base_parity = [_parity_index(d) for d in baseline_docs]
    cand_parity = [_parity_index(d) for d in candidate_docs]
    parity_keys = sorted(
        {k for index in base_parity for k in index} | {k for index in cand_parity for k in index}
    )
    rows = []
    for key in parity_keys:
        base_values = [i[key] for i in base_parity if key in i]
        cand_values = [i[key] for i in cand_parity if key in i]
        rows.append(
            [
                key,
                _parity_summary(base_values),
                _parity_summary(cand_values),
            ]
        )
        if assert_mode:
            base_set = {_parity_summary([v]) for v in base_values}
            cand_set = {_parity_summary([v]) for v in cand_values}
            if not base_values or not cand_values:
                failures.append(f"parity {key}: present in only one arm")
            elif base_set != cand_set:
                failures.append(
                    f"parity {key}: baseline {sorted(base_set)} vs candidate {sorted(cand_set)}"
                )
    lines.append("## Parity (no saving is readable without its parity evidence)")
    lines += _table(["ticket", "baseline", "candidate"], rows)
    lines.append("")

    return lines, failures


def _parity_summary(values) -> str:
    if not values:
        return "n/a"
    parts = []
    for value in values:
        findings = value.get("findings", {})
        parts.append(
            "verdict={} C{} I{} S{} checks={} commit={} pushed={} pr={}".format(
                value.get("verdict"),
                findings.get("CRITICAL"),
                findings.get("IMPORTANT"),
                findings.get("SUGGESTION"),
                value.get("check_runs"),
                value.get("commit"),
                value.get("pushed"),
                value.get("pr"),
            )
        )
    unique = sorted(set(parts))
    return unique[0] if len(unique) == 1 else " | ".join(unique)


def _check_tolerance(label, base, candidate, tolerance_rel, tolerance_share):
    failures = []
    if tolerance_share is not None:
        if abs(candidate - base) > tolerance_share:
            failures.append(
                f"{label}: {base:.2f} vs {candidate:.2f} "
                f"({candidate - base:+.2f}pp, tolerance {tolerance_share:g}pp)"
            )
        return failures
    if base == 0:
        if candidate != 0:
            failures.append(f"{label}: 0 vs {candidate:,.0f} (baseline is zero)")
        return failures
    relative = 100.0 * (candidate - base) / base
    if abs(relative) > tolerance_rel:
        failures.append(
            f"{label}: {base:,.0f} vs {candidate:,.0f} "
            f"({relative:+.2f}%, tolerance {tolerance_rel:g}%)"
        )
    return failures


# --------------------------------------------------------------------------
# self-test
# --------------------------------------------------------------------------


def _call(tool_name, /, **inputs):
    return ToolCall(turn=1, tool_use_id="toolu_probe", name=tool_name, input=inputs)


def _synthetic_agent(agent_id, records, meta=None, label=None):
    return RawAgent(agent_id, label or f"<synthetic>/{agent_id}.jsonl", meta, records)


def _assistant(message_id, usage=True, stop_reason="end_turn", content=None):
    message = {"id": message_id, "model": "claude-probe-1", "stop_reason": stop_reason}
    if usage:
        message["usage"] = {
            "input_tokens": 10,
            "cache_creation_input_tokens": 20,
            "cache_read_input_tokens": 30,
            "output_tokens": 40,
        }
    if content is not None:
        message["content"] = content
    return {"type": "assistant", "message": message}


def _register_pattern_probes(probe, role_map):
    """The pure pattern assertions: every regex and classifier in the file.

    Extracted from `run_self_test` so `run_report` can assert the same table
    on every run, the way `scripts/check-mode-split.sh` asserts its probes
    before it scans anything. They touch nothing outside this module.
    """
    # --- artifact-write recognition ---------------------------------------
    probe(
        "artifact write: Write 04-review.md",
        artifact_write_name(_call("Write", file_path="/a/b/04-review.md", content="x"))
        == "04-review.md",
    )
    probe(
        "artifact write: Edit 03-implementation.md",
        artifact_write_name(_call("Edit", file_path="/a/03-implementation.md", new_string="x"))
        == "03-implementation.md",
    )
    probe(
        "artifact write: pipeline_write_artifact 06-summary",
        artifact_write_name(
            _call("mcp__plugin_server-native_ps__pipeline_write_artifact", name="06-summary.md", body="y")
        )
        == "06-summary.md",
    )
    probe(
        "artifact write: pipeline_write_artifact without .md",
        artifact_write_name(_call("pipeline_write_artifact", name="04-review", body="y"))
        == "04-review.md",
    )
    probe(
        "artifact write NOT: a Read of 04-review.md",
        artifact_write_name(_call("Read", file_path="/a/04-review.md")) is None,
    )
    probe(
        "artifact write NOT: 01-spec.md is outside the 03-06 range",
        artifact_write_name(_call("Write", file_path="/a/01-spec.md", content="x")) is None,
    )
    probe(
        "artifact write NOT: a Bash command naming 04-review.md",
        artifact_write_name(_call("Bash", command="cat 04-review.md")) is None,
    )
    probe(
        "artifact write: Bash heredoc redirect to 04-review.md",
        artifact_write_name(
            _call("Bash", command="cd /r && cat > claudedocs/tickets/in-progress/X-1/04-review.md <<'EOF'\n# Review\nEOF")
        )
        == "04-review.md",
    )
    probe(
        "artifact write: Bash append redirect to 06-summary.md",
        artifact_write_name(_call("Bash", command="cat >> t/06-summary.md <<'EOF'\n## PR\nEOF"))
        == "06-summary.md",
    )
    probe(
        "artifact write: Bash tee -a to 05-tests.md",
        artifact_write_name(_call("Bash", command="printf 'x' | tee -a t/05-tests.md")) == "05-tests.md",
    )
    probe(
        "artifact write NOT: Bash input redirect from 04-review.md",
        artifact_write_name(_call("Bash", command="wc -l < t/04-review.md")) is None,
    )
    probe(
        "artifact write NOT: Bash stderr redirect beside a read of 04-review.md",
        artifact_write_name(_call("Bash", command="cat t/04-review.md 2>/dev/null")) is None,
    )
    probe(
        "artifact write NOT: Bash redirect to 04-review.md.bak",
        artifact_write_name(_call("Bash", command="cp a > t/04-review.md.bak")) is None,
    )
    probe(
        "artifact body: Bash heredoc body is what is scanned",
        artifact_write_body(
            _call("Bash", command="cat > t/06-summary.md <<'EOF'\n# Summary\nverdict: pass\nEOF")
        )
        == "# Summary\nverdict: pass",
    )

    # --- reviewer spawn ----------------------------------------------------
    probe(
        "reviewer spawn: Agent feature:code-reviewer",
        spawned_subagent_type(
            _call("Agent", subagent_type="feature:code-reviewer", description="Correctness review FP-1")
        )
        == "feature:code-reviewer",
    )
    probe(
        "reviewer spawn NOT: a Bash command naming feature:code-reviewer",
        spawned_subagent_type(_call("Bash", command="grep feature:code-reviewer SKILL.md")) is None,
    )

    # --- verdict -----------------------------------------------------------
    probe(
        "verdict: a summary body",
        (VERDICT_RE.search("# Summary - FP-1\n\nverdict: pass\n") or [None])
        and VERDICT_RE.search("# Summary - FP-1\n\nverdict: pass\n").group(1) == "pass",
    )
    probe(
        "verdict NOT: a skill body enumerating the vocabulary",
        VERDICT_RE.search("The build verdict set is `pass | partial | stuck`.") is None,
    )

    # --- severities --------------------------------------------------------
    table_body = "| Severity | Count |\n|---|---|\n| CRITICAL | 0 |\n| IMPORTANT | 4 |\n| SUGGESTION | 10 |\n"
    counts, label = _severity_counts(table_body)
    probe(
        "severities: the documented count block is read exactly",
        counts == {"CRITICAL": 0, "IMPORTANT": 4, "SUGGESTION": 10} and label == "exact",
        f"got {counts} ({label})",
    )
    section_body = "## CRITICAL\n\nNone.\n\n## IMPORTANT\n\n### a\n\n### b\n\n## SUGGESTION\n\nNone.\n"
    counts, label = _severity_counts(section_body)
    probe(
        "severities: a body with no count block falls back to an estimate",
        counts == {"CRITICAL": 0, "IMPORTANT": 2, "SUGGESTION": 0} and label == "estimate",
        f"got {counts} ({label})",
    )

    # --- command classification -------------------------------------------
    check_re = compile_check_pattern(DEFAULT_CHECK_PATTERN)
    probe(
        "check run: a compound command beginning with an assignment",
        counts_as_run('D=/tmp && bash scripts/check-mode-split.sh', check_re),
    )
    probe("check run: npm test", counts_as_run("npm test -- --run", check_re))
    probe(
        "check run NOT: head of a check script is a read",
        not counts_as_run("head -8 scripts/check-tool-parity.sh", check_re),
    )
    probe(
        "check run NOT: grep over a check script is a read",
        not counts_as_run("grep -n vitest scripts/check-tidy-checks.mjs", check_re),
    )
    probe(
        "commit: inside a compound command",
        has_commit('D=/tmp/x && git commit -F $D/m1.txt'),
    )
    probe("commit: git -C keeps the verb", has_commit('git -C /wt commit -F /tmp/m.txt'))
    probe("commit NOT: cat of commit.md", not has_commit("cat references/commit.md"))
    probe(
        "commit NOT: a path merely containing the word",
        not has_commit("wc -l $P/pr-creation.md $P/commit.md"),
    )
    probe("pr: gh pr create", has_pr_creation('B=x && gh pr create --base main --title t'))
    probe(
        "pr NOT: a push is a push, not a PR",
        not has_pr_creation("git push -u origin feature/FP-1"),
    )
    probe("pushed: git push", has_push("git push -u origin feature/FP-1"))
    probe(
        "pushed NOT: a commit is not a push",
        not has_push('D=/tmp && git commit -F $D/m.txt'),
    )
    probe(
        "pr NOT: reading pr-creation.md",
        not has_pr_creation("cat $P/pr-creation.md"),
    )

    # --- ticket ids and the role map --------------------------------------
    probe("ticket: from a description", TICKET_RE.search("Build stage for FP-86").group(0) == "FP-86")
    probe("ticket: first of two wins", TICKET_RE.search("FP-1 and BL-2").group(0) == "FP-1")
    probe("ticket NOT: a PR number", TICKET_RE.search("Independent review of PR 97") is None)
    role_map = compile_role_map(DEFAULT_ROLE_MAP)
    for description, expected in (
        ("Build stage for FP-86", "build-stage"),
        ("Plan stage for FP-85", "plan-stage"),
        ("Finalize FP-93 after the gate", "finalize-child"),
        ("Review stage for FP-3", "review-stage"),
        ("FP-3 close stage", "close-stage"),
        ("FP-87 implementer via flow", "ship-implementer"),
        ("Independent review of PR 97", "ship-review"),
        ("Address review on PR 98", "ship-address"),
        ("Something else entirely", GENERIC_FALLBACK_ROLE),
    ):
        agent = Agent(
            agent_id="probe",
            label="probe",
            agent_type=GENERIC_ROLE,
            description=description,
            spawn_depth=1,
            parent_id=ROOT_AGENT_ID,
            tool_use_id=None,
            turns=[],
            tool_calls=[],
            models=[],
        )
        probe(f"role map: {description!r} -> {expected}", _classify_role(agent, role_map) == expected)
    probe(
        "role map: a non-generic agentType is used verbatim",
        _classify_role(
            Agent(
                agent_id="p",
                label="p",
                agent_type="feature:code-reviewer",
                description="Build stage for FP-1",
                spawn_depth=3,
                parent_id="x",
                tool_use_id=None,
                turns=[],
                tool_calls=[],
                models=[],
            ),
            role_map,
        )
        == "feature:code-reviewer",
    )
    probe(
        "role map: a regex that will not compile is a loud error",
        _raises(lambda: compile_role_map({"bad": "["})),
    )
    probe(
        "weights: a malformed string is a loud error",
        _raises(lambda: parse_weights("i=one")),
    )

    probe(
        "verdict: markdown emphasis around the value",
        VERDICT_RE.search("# Summary\n\nverdict: **pass**\n").group(1) == "pass",
    )
    counts, label = _severity_counts(
        "| CRITICAL | 0 |\n| IMPORTANT | 4 (after de-duplication) |\n| SUGGESTION | 4 |\n"
    )
    probe(
        "severities: an annotated count cell is still exact",
        counts == {"CRITICAL": 0, "IMPORTANT": 4, "SUGGESTION": 4} and label == "exact",
        f"got {counts} ({label})",
    )
    counts, label = _severity_counts(
        "verdict: reviewed - 10 findings (0 CRITICAL, 8 IMPORTANT, 2 SUGGESTION); 9 applied\n"
    )
    probe(
        "severities: one line carrying all three counts is exact",
        counts == {"CRITICAL": 0, "IMPORTANT": 8, "SUGGESTION": 2} and label == "exact",
        f"got {counts} ({label})",
    )
    counts, label = _severity_counts("Three IMPORTANT findings were applied in-context.\n")
    probe(
        "severities NOT: prose naming one severity is not a count block",
        label == "estimate",
        f"got {counts} ({label})",
    )



def run_self_test() -> int:
    checks = []
    failures = []

    def probe(name, condition, detail=""):
        checks.append(name)
        if not condition:
            failures.append(f"{name}{': ' + detail if detail else ''}")

    role_map = compile_role_map(DEFAULT_ROLE_MAP)
    _register_pattern_probes(probe, role_map)

    # --- parity body selection --------------------------------------------
    def _parity_of(calls):
        agent = Agent(
            agent_id="p",
            label="p",
            agent_type=GENERIC_ROLE,
            description="Build stage for FP-1",
            spawn_depth=2,
            parent_id=ROOT_AGENT_ID,
            tool_use_id=None,
            turns=[],
            tool_calls=calls,
            models=[],
        )
        return extract_parity([agent], [agent], compile_check_pattern(DEFAULT_CHECK_PATTERN))

    fragment_edit = [
        _call("Write", file_path="/t/06-summary.md", content="# Summary\n\nverdict: pass\n"),
        _call("Edit", file_path="/t/06-summary.md", new_string="PR: https://example.invalid/1"),
    ]
    probe(
        "parity: a fragment Edit does not hide the verdict in an earlier write",
        _parity_of(fragment_edit).verdict == "pass",
        f"got {_parity_of(fragment_edit).verdict}",
    )
    fragment_review = [
        _call("Write", file_path="/t/04-review.md", content="| CRITICAL | 0 |\n| IMPORTANT | 3 |\n| SUGGESTION | 1 |\n"),
        _call("Edit", file_path="/t/04-review.md", new_string="status: deferred (conflict)"),
        _call("Write", file_path="/t/06-summary.md", content="verdict: pass"),
    ]
    probe(
        "parity: a fragment Edit does not zero the findings",
        _parity_of(fragment_review).findings == {"CRITICAL": 0, "IMPORTANT": 3, "SUGGESTION": 1},
        f"got {_parity_of(fragment_review).findings}",
    )
    no_counts = [_call("Write", file_path="/t/04-review.md", content="No code changes to review.\n")]
    probe(
        "parity: a review body with no counts stays unknown, never zero",
        _parity_of(no_counts).findings == {s: "unknown" for s in SEVERITIES},
        f"got {_parity_of(no_counts).findings}",
    )
    bad_verdict = [
        _call(
            "pipeline_write_artifact",
            name="06-summary.md",
            body="no verdict line here",
            verdict="a sentence that is not a verdict",
        )
    ]
    probe(
        "parity: an unrecognised artifact verdict field is not copied into the report",
        _parity_of(bad_verdict).verdict == "unknown",
        f"got {_parity_of(bad_verdict).verdict!r}",
    )
    good_verdict = [
        _call("pipeline_write_artifact", name="06-summary.md", body="body", verdict="partial")
    ]
    probe(
        "parity: a recognised artifact verdict field is read",
        _parity_of(good_verdict).verdict == "partial",
    )
    no_tail = [_call("Write", file_path="/t/04-review.md", content="| CRITICAL | 0 |")]
    probe(
        "parity: no 06-summary write leaves commit and pr unknown, never false",
        _parity_of(no_tail).commit == "unknown" and _parity_of(no_tail).pr == "unknown",
    )

    # --- phase boundaries --------------------------------------------------
    phase_records = []
    for index in range(1, 9):
        content = None
        if index == 3:
            content = [
                {
                    "type": "tool_use",
                    "id": "t1",
                    "name": "Agent",
                    "input": {"subagent_type": REVIEWER_SUBAGENT, "description": "Correctness FP-1"},
                }
            ]
        elif index == 5:
            content = [
                {
                    "type": "tool_use",
                    "id": "t2",
                    "name": "Write",
                    "input": {"file_path": "/t/04-review.md", "content": "| CRITICAL | 1 |"},
                }
            ]
        elif index == 6:
            content = [
                {
                    "type": "tool_use",
                    "id": "t3",
                    "name": "Write",
                    "input": {"file_path": "/t/06-summary.md", "content": "verdict: pass"},
                }
            ]
        elif index == 8:
            content = [
                {
                    "type": "tool_use",
                    "id": "t4",
                    "name": "Edit",
                    "input": {"file_path": "/t/06-summary.md", "new_string": "verdict: pass\nPR: url"},
                }
            ]
        phase_records.append(_assistant(f"m{index}", content=content))
    probe_agents = parse_agents([_synthetic_agent("build", phase_records)], role_map)
    attribute_tickets(probe_agents)
    probe_phases = split_phases(probe_agents[0], {}, {}, {a.agent_id: a for a in probe_agents})
    ranges = {p.name: (p.start_turn, p.end_turn) for p in probe_phases}
    probe(
        "phases: a boundary keys on the FIRST write of its marker artifact",
        ranges
        == {
            "implement": (1, 2),
            "review": (3, 5),
            "post-review": (6, 6),
            "post-gate": (7, 8),
        },
        f"got {ranges}",
    )
    probe(
        "phases: a post-gate rewrite of 06-summary.md stays in post-gate",
        ranges["post-gate"] == (7, 8),
    )

    # The mirror of the FIRST-write rule: a 04-review.md write that PRECEDES
    # the first reviewer spawn is not this review's output. Without the guard
    # `implement` and `post-review` overlap and the shares sum past 100%.
    early_records = []
    for index in range(1, 9):
        content = None
        if index == 2:
            content = [
                {
                    "type": "tool_use",
                    "id": "e1",
                    "name": "Write",
                    "input": {"file_path": "/t/04-review.md", "content": "stale"},
                }
            ]
        elif index == 4:
            content = [
                {
                    "type": "tool_use",
                    "id": "e2",
                    "name": "Task",
                    "input": {"subagent_type": REVIEWER_SUBAGENT, "description": "Correctness review T"},
                }
            ]
        elif index == 6:
            content = [
                {
                    "type": "tool_use",
                    "id": "e3",
                    "name": "Write",
                    "input": {"file_path": "/t/06-summary.md", "content": "verdict: pass"},
                }
            ]
        early_records.append(_assistant(f"e{index}", content=content))
    early_agents = parse_agents([_synthetic_agent("early", early_records)], role_map)
    early_phases = split_phases(early_agents[0], {}, {}, {a.agent_id: a for a in early_agents})
    early_by_name = {p.name: p for p in early_phases}
    early_share = sum(p.share_self or 0.0 for p in early_phases)
    probe(
        "phases: a 04-review.md write BEFORE the first reviewer spawn does not overlap",
        early_share <= 100.0001,
        f"shares sum to {early_share:.1f}%",
    )
    probe(
        "phases: that ordering renders the downstream phases n/a with a reason",
        early_by_name["post-review"].status == "n/a"
        and early_by_name["post-gate"].status == "n/a"
        and "precedes the first reviewer spawn" in early_by_name["post-review"].reason,
        f"got {[(p.name, p.status) for p in early_phases]}",
    )

    # AC 3's second recognition site: a standalone `/feature:build` root
    # session, recognised through the <command-name> record rather than a
    # `Build stage for ...` description.
    slash_records = [
        {
            "type": "user",
            "message": {
                "content": "<command-name>/feature:build</command-name>"
                "<command-args>FP-42</command-args>"
            },
        }
    ]
    for index in range(1, 5):
        content = None
        if index == 2:
            content = [
                {
                    "type": "tool_use",
                    "id": "r1",
                    "name": "Task",
                    "input": {"subagent_type": REVIEWER_SUBAGENT, "description": "Correctness review FP-42"},
                }
            ]
        elif index == 3:
            content = [
                {
                    "type": "tool_use",
                    "id": "r2",
                    "name": "Write",
                    "input": {"file_path": "/t/04-review.md", "content": "| CRITICAL | 0 |"},
                }
            ]
        slash_records.append(_assistant(f"r{index}", content=content))
    slash_agents = parse_agents(
        [_synthetic_agent(ROOT_AGENT_ID, slash_records, label="<synthetic>/root.jsonl")], role_map
    )
    attribute_tickets(slash_agents)
    probe(
        "build site: a standalone /feature:build root session is recognised as a build",
        is_build_agent(slash_agents[0]) and slash_agents[0].agent_id == ROOT_AGENT_ID,
    )
    probe(
        "build site: that root session reports the standalone site and its ticket",
        build_site(slash_agents[0]).startswith("root session")
        and slash_agents[0].ticket == "FP-42",
        f"site={build_site(slash_agents[0])} ticket={slash_agents[0].ticket}",
    )

    # AC 3's finalizer clause, as behaviour rather than as a role-map string:
    # a `Finalize <TICKET>` child spawned after the 06-summary.md write is
    # attributed to its parent build's post-gate phase.
    fin_parent_records = []
    for index in range(1, 7):
        content = None
        if index == 2:
            content = [
                {
                    "type": "tool_use",
                    "id": "f1",
                    "name": "Task",
                    "input": {"subagent_type": REVIEWER_SUBAGENT, "description": "Correctness review FP-42"},
                }
            ]
        elif index == 3:
            content = [
                {
                    "type": "tool_use",
                    "id": "f2",
                    "name": "Write",
                    "input": {"file_path": "/t/04-review.md", "content": "| CRITICAL | 0 |"},
                }
            ]
        elif index == 4:
            content = [
                {
                    "type": "tool_use",
                    "id": "f3",
                    "name": "Write",
                    "input": {"file_path": "/t/06-summary.md", "content": "verdict: pass"},
                }
            ]
        elif index == 5:
            content = [
                {
                    "type": "tool_use",
                    "id": "f4",
                    "name": "Task",
                    "input": {"subagent_type": "general-purpose", "description": "Finalize FP-42"},
                }
            ]
        fin_parent_records.append(_assistant(f"f{index}", content=content))
    fin_child_records = [_assistant(f"fc{i}") for i in range(1, 4)]
    fin_agents = parse_agents(
        [
            _synthetic_agent("pbuild", fin_parent_records),
            _synthetic_agent(
                "fchild",
                fin_child_records,
                meta={
                    "agentType": "general-purpose",
                    "description": "Finalize FP-42",
                    "parentAgentId": "pbuild",
                    "spawnDepth": 3,
                    "toolUseId": "f4",
                },
            ),
        ],
        role_map,
    )
    attribute_tickets(fin_agents)
    fin_by_id = {a.agent_id: a for a in fin_agents}
    fin_parent = fin_by_id["pbuild"]
    fin_phases = split_phases(
        fin_parent, {"fchild": 5}, {"pbuild": ["fchild"]}, fin_by_id
    )
    fin_post_gate = next(p for p in fin_phases if p.name == "post-gate")
    fin_child_reread = fin_by_id["fchild"].reread_sum
    probe(
        "finalizer: a Finalize <TICKET> child lands in its parent build's post-gate",
        fin_post_gate.status == "ok"
        and fin_post_gate.reread_self_children - fin_post_gate.reread_self == fin_child_reread
        and fin_child_reread > 0,
        f"post-gate self={fin_post_gate.reread_self} "
        f"self+children={fin_post_gate.reread_self_children} child={fin_child_reread}",
    )
    # The three-stage shape, end to end through build_report: a standalone
    # /feature:build root that spawns a review stage and a close stage. Every
    # synthetic turn has a 60-token window, so the expected sums are exact.
    def _spawn(tool_use_id, description, subagent_type=GENERIC_ROLE):
        return {
            "type": "tool_use",
            "id": tool_use_id,
            "name": "Task",
            "input": {"subagent_type": subagent_type, "description": description},
        }

    def _write(tool_use_id, name, content):
        return {
            "type": "tool_use",
            "id": tool_use_id,
            "name": "Write",
            "input": {"file_path": f"/t/{name}", "content": content},
        }

    def _meta(description, parent, tool_use_id, agent_type=GENERIC_ROLE, depth=1):
        meta = {
            "agentType": agent_type,
            "description": description,
            "spawnDepth": depth,
            "toolUseId": tool_use_id,
        }
        if parent is not None:
            meta["parentAgentId"] = parent
        return meta

    def _records(prefix, count, content_at):
        return [_assistant(f"{prefix}{i}", content=content_at.get(i)) for i in range(1, count + 1)]

    weights = dict(DEFAULT_WEIGHTS)
    standalone_root = [
        {
            "type": "user",
            "message": {
                "content": "<command-name>/feature:build</command-name>"
                "<command-args>FP-42</command-args>"
            },
        }
    ] + _records(
        "sr",
        6,
        {2: [_spawn("s1", "Review stage for FP-42")], 4: [_spawn("s2", "Close stage for FP-42")]},
    )
    standalone_raws = [
        _synthetic_agent(ROOT_AGENT_ID, standalone_root, label="<synthetic>/root.jsonl"),
        _synthetic_agent(
            "rstage",
            _records(
                "rs",
                3,
                {
                    1: [_spawn("rv1", "FP-42 correctness review", REVIEWER_SUBAGENT)],
                    3: [_write("rw1", "04-review.md", "| CRITICAL | 1 |")],
                },
            ),
            meta=_meta("Review stage for FP-42", None, "s1"),
        ),
        _synthetic_agent(
            "rev",
            _records("rv", 2, {}),
            meta=_meta("FP-42 correctness review", "rstage", "rv1", REVIEWER_SUBAGENT, 2),
        ),
        _synthetic_agent(
            "cstage",
            _records(
                "cs",
                4,
                {
                    2: [_write("cw1", "06-summary.md", "verdict: pass")],
                    3: [_spawn("fz1", "Finalize FP-42")],
                },
            ),
            meta=_meta("Close stage for FP-42", None, "s2"),
        ),
        _synthetic_agent(
            "fin",
            _records(
                "fz",
                2,
                {
                    1: [
                        {
                            "type": "tool_use",
                            "id": "fb1",
                            "name": "Bash",
                            "input": {"command": "git commit -F m.txt && git push && gh pr create"},
                        }
                    ]
                },
            ),
            meta=_meta("Finalize FP-42", "cstage", "fz1", "feature:finalizer", 2),
        ),
    ]
    staged = build_report("probe", standalone_raws, weights, DEFAULT_ROLE_MAP, DEFAULT_CHECK_PATTERN)
    probe(
        "three-stage: a standalone build with stage children is exactly one build",
        len(staged.builds) == 1
        and staged.builds[0].agent_id == ROOT_AGENT_ID
        and staged.builds[0].stage_agent_ids == {
            "implement": [ROOT_AGENT_ID],
            "review": ["rstage"],
            "close": ["cstage"],
        },
        f"builds={[(b.agent_id, b.stage_agent_ids) for b in staged.builds]}",
    )
    if staged.builds:
        by_name = {p.name: p for p in staged.builds[0].phases}
        expected = {
            # (turns, self, self+children): the root's 6 turns split 1 / 2 / 1 / 2
            # across the phases, the stage children add their own, and the
            # reviewer and finalizer land under review and post-gate.
            "implement": (1, 60, 60),
            "review": (5, 300, 420),
            "post-review": (3, 180, 180),
            "post-gate": (4, 240, 360),
        }
        got = {
            name: (p.turns, p.reread_self, p.reread_self_children) for name, p in by_name.items()
        }
        probe(
            "three-stage: sequencer turns follow the stage they relay; children land by spawn turn",
            got == expected and all(by_name[n].status == "ok" for n in expected),
            f"got {got}",
        )
        probe(
            "three-stage: the review phase names its stage child and its own turn range",
            by_name["review"].agent_ids == ["rstage"]
            and (by_name["review"].start_turn, by_name["review"].end_turn) == (1, 3)
            and by_name["post-gate"].agent_ids == ["cstage"]
            and (by_name["post-gate"].start_turn, by_name["post-gate"].end_turn) == (3, 4),
            f"review={by_name['review']} post-gate={by_name['post-gate']}",
        )
        probe(
            "three-stage: shares sum to 100 over the group",
            abs(sum(p.share_self for p in by_name.values()) - 100.0) < 1e-6
            and abs(sum(p.share_self_children for p in by_name.values()) - 100.0) < 1e-6,
        )
        parity = staged.builds[0].parity
        probe(
            "three-stage: parity reads the review stage's findings and the close stage's verdict",
            parity.verdict == "pass"
            and parity.findings.get("CRITICAL") == 1
            and parity.commit is True
            and parity.pr is True
            and staged.builds[0].finalizer_agent_ids == ["fin"],
            f"verdict={parity.verdict} findings={parity.findings} commit={parity.commit} "
            f"pr={parity.pr} finalizers={staged.builds[0].finalizer_agent_ids}",
        )

    flow_root = _records(
        "fr",
        2,
        {
            1: [
                _spawn("b1", "Build stage for FP-42"),
                _spawn("s1", "Review stage for FP-42"),
                _spawn("s2", "Close stage for FP-42"),
            ]
        },
    )
    flow_raws = [
        _synthetic_agent(ROOT_AGENT_ID, flow_root, label="<synthetic>/root.jsonl"),
        _synthetic_agent("bstage", _records("bs", 3, {}), meta=_meta("Build stage for FP-42", None, "b1")),
        _synthetic_agent("rstage", _records("rs", 2, {}), meta=_meta("Review stage for FP-42", None, "s1")),
        _synthetic_agent(
            "cstage",
            _records("cs", 2, {1: [_write("cw1", "06-summary.md", "verdict: pass")]}),
            meta=_meta("Close stage for FP-42", None, "s2"),
        ),
    ]
    under_flow = build_report("probe", flow_raws, weights, DEFAULT_ROLE_MAP, DEFAULT_CHECK_PATTERN)
    flow_got = {
        p.name: (p.turns, p.reread_self) for b in under_flow.builds for p in b.phases
    }
    probe(
        "three-stage: under flow the Build stage sibling is the implement phase, whole",
        len(under_flow.builds) == 1
        and under_flow.builds[0].agent_id == "bstage"
        and under_flow.builds[0].site.endswith("(under flow)")
        and flow_got == {"implement": (3, 180), "review": (2, 120), "post-review": (1, 60), "post-gate": (1, 60)},
        f"builds={[b.agent_id for b in under_flow.builds]} phases={flow_got}",
    )

    stuck_records = [_assistant(f"s{i}") for i in range(1, 4)]
    stuck_agents = parse_agents([_synthetic_agent("stuck", stuck_records)], role_map)
    stuck_phases = split_phases(stuck_agents[0], {}, {}, {a.agent_id: a for a in stuck_agents})
    probe(
        "phases: a missing boundary renders n/a with a reason, never zero",
        stuck_phases[1].status == "n/a" and bool(stuck_phases[1].reason),
    )

    # --- usage merge -------------------------------------------------------
    streaming = [
        {
            "type": "assistant",
            "message": {
                "id": "m1",
                "model": "m",
                "stop_reason": None,
                "usage": {"input_tokens": 1, "output_tokens": 4},
            },
        },
        {
            "type": "assistant",
            "message": {
                "id": "m1",
                "model": "m",
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 1, "output_tokens": 862},
            },
        },
    ]
    turns = _merge_usage(_synthetic_agent("probe", streaming))[0]
    probe(
        "usage merge: the terminal record wins over the streaming snapshot",
        len(turns) == 1 and turns[0].output_tokens == 862,
        f"got {[t.output_tokens for t in turns]}",
    )

    # --- AC 6 error paths, driven through the pure core -------------------
    probe(
        "error: an agent whose assistant records carry no usage",
        _raises_measure(
            lambda: parse_agents([_synthetic_agent("a", [_assistant("m1", usage=False)])], role_map),
            "usage",
        ),
    )
    probe(
        "error: zero assistant turns",
        _raises_measure(
            lambda: parse_agents([_synthetic_agent("a", [{"type": "user", "message": {}}])], role_map),
            "zero assistant turns",
        ),
    )
    probe(
        "error: a meta.json missing required keys",
        _raises_measure(
            lambda: parse_agents(
                [_synthetic_agent("a", [_assistant("m1")], meta={"agentType": "x"})], role_map
            ),
            "missing required key",
        ),
    )
    probe(
        "error: an assistant record with no message.id",
        _raises_measure(
            lambda: parse_agents(
                [_synthetic_agent("a", [{"type": "assistant", "message": {"usage": {}}}])], role_map
            ),
            "message.id",
        ),
    )
    probe(
        "error: an unknown compare schema_version",
        _raises_measure(_probe_schema_version, "schema_version"),
    )
    probe(
        "error: a subagent transcript with no meta.json",
        _raises_measure(_probe_missing_meta, "no .meta.json"),
    )
    probe(
        "error: a meta.json with no subagent transcript",
        _raises_measure(_probe_missing_transcript, "no .jsonl"),
    )
    probe(
        "error: an unresolvable session path",
        _raises_measure(
            lambda: resolve_session("/nonexistent/session-probe", None), "no session transcript"
        ),
    )

    probe(
        "cli: --project accepts a slug beginning with a dash",
        _join_project_slug(["id", "--project", "-Users-me-Projects-x"])
        == ["id", "--project=-Users-me-Projects-x"],
    )
    probe(
        "cli: a bare session argument is routed to the report subcommand",
        make_parser().parse_args(_join_project_slug(["report", "s.jsonl"])).command == "report",
    )

    # --- a probe table that cannot fail is itself a failure ---------------
    if not checks:
        print("FAIL (1):", file=sys.stderr)
        print("  - the probe table is empty, so it can never fail", file=sys.stderr)
        return 1

    for name in checks:
        if not any(f.startswith(name) for f in failures):
            print(f"  ok  {name}")

    if failures:
        print(f"\nFAIL ({len(failures)}):", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(f"\nOK: {len(checks)} self-test probe(s) passed; nothing was written to disk.")
    return 0


def _raises(call) -> bool:
    try:
        call()
    except MeasureError:
        return True
    except Exception:
        return False
    return False


def _raises_measure(call, fragment) -> bool:
    try:
        call()
    except MeasureError as exc:
        return fragment.lower() in str(exc).lower()
    except Exception:
        return False
    return False


def _probe_schema_version():
    check_schema_version({"schema_version": 99}, "<synthetic>/report.json")


def _probe_missing_meta():
    pair_subagent_files(
        {"agent-x"}, set(), lambda stem, kind: f"<synthetic>/{stem}.jsonl"
    )


def _probe_missing_transcript():
    pair_subagent_files(
        set(), {"agent-x"}, lambda stem, kind: f"<synthetic>/{stem}.meta.json"
    )


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def parse_weights(text: str) -> dict:
    weights = dict(DEFAULT_WEIGHTS)
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise MeasureError("--weights", f"{part!r} is not of the form key=value")
        key, _, value = part.partition("=")
        key = key.strip()
        if key not in WEIGHT_KEYS:
            raise MeasureError(
                "--weights", f"unknown key {key!r}; expected one of {', '.join(WEIGHT_KEYS)}"
            )
        try:
            weights[key] = float(value)
        except ValueError as exc:
            raise MeasureError("--weights", f"{value!r} is not a number") from exc
    return weights


def parse_role_map(text: str) -> dict:
    raw = text
    candidate = Path(text).expanduser()
    if candidate.is_file():
        try:
            raw = candidate.read_text(encoding="utf-8")
        except OSError as exc:
            raise MeasureError(candidate, f"cannot read the role map ({exc.strerror})") from exc
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise MeasureError("--role-map", f"not valid JSON ({exc.msg})") from exc
    if not isinstance(parsed, dict) or not parsed:
        raise MeasureError("--role-map", "expected a non-empty JSON object of role -> regex")
    compile_role_map(parsed)
    return parsed


def _write_out(text: str, out_path) -> Path:
    """Write `text` to `out_path`, guarded. The only write this script performs.

    Both the success and the failure path go through here, so an unwritable
    `--out` fails the same way either way - the docstring's "Exit: 1 on an
    unwritable `--out` path" holds regardless of what is being written.
    """
    path = Path(out_path).expanduser()
    # No directory is created: the only write this script performs is the file
    # it was explicitly given.
    if path.parent and not path.parent.is_dir():
        raise MeasureError(path, f"the directory {path.parent} does not exist")
    try:
        path.write_text(text + "\n", encoding="utf-8")
    except OSError as exc:
        raise MeasureError(path, f"cannot write the output ({exc.strerror})") from exc
    return path


def _emit(text: str, out_path: str | None) -> None:
    if out_path is None:
        print(text)
        return
    print(f"OK: wrote {_write_out(text, out_path)}")


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="measure-session.py",
        description="Measure where a Claude Code session's tokens went.",
    )
    subparsers = parser.add_subparsers(dest="command")

    report = subparsers.add_parser("report", help="measure one session (the default)")
    report.add_argument("session", help="session .jsonl, session directory, or session id")
    report.add_argument("--project", help="project slug, with a bare session id")
    report.add_argument("--json", action="store_true", dest="as_json", help="emit JSON")
    report.add_argument("--out", help="write to this path instead of stdout")
    report.add_argument("--weights", help="i=1,cw=1.25,cr=0.1,o=5")
    report.add_argument("--role-map", dest="role_map", help="JSON object, or a path to one")
    report.add_argument("--check-pattern", dest="check_pattern", help="check/test-run regex")
    report.add_argument(
        "--ticket-prefix",
        dest="ticket_prefix",
        action="append",
        default=[],
        help="repeatable; only these prefixes are ticket ids (e.g. --ticket-prefix FP)",
    )

    compare = subparsers.add_parser("compare", help="compare two or more reports")
    compare.add_argument("positional", nargs="*", help="baseline.json candidate.json")
    compare.add_argument("--baseline", action="append", default=[], help="repeatable")
    compare.add_argument("--candidate", action="append", default=[], help="repeatable")
    compare.add_argument("--out", help="write to this path instead of stdout")
    compare.add_argument(
        "--assert", action="store_true", dest="assert_mode", help="exit non-zero outside tolerance"
    )
    compare.add_argument("--tolerance-share", type=float, default=1.0, help="percentage points")
    compare.add_argument("--tolerance-rel", type=float, default=2.0, help="percent")

    subparsers.add_parser("self-test", help="run the inline probes; writes nothing")
    return parser


def assert_pattern_probes(role_map) -> None:
    """Assert the pure pattern table before measuring anything.

    `scripts/check-mode-split.sh` asserts its probes on every invocation, which
    is what keeps them from rotting. The same applies here: a regex that has
    stopped recognising what it claims to recognise must not quietly produce a
    plausible report.
    """
    failures = []

    def probe(name, condition, detail=""):
        if not condition:
            failures.append(f"{name}{': ' + detail if detail else ''}")

    _register_pattern_probes(probe, role_map)
    if failures:
        raise MeasureError(
            "self-test", f"{len(failures)} pattern probe(s) failed: " + "; ".join(failures)
        )


def run_report(args) -> int:
    weights = parse_weights(args.weights) if args.weights else dict(DEFAULT_WEIGHTS)
    role_map = parse_role_map(args.role_map) if args.role_map else dict(DEFAULT_ROLE_MAP)
    check_pattern = args.check_pattern or DEFAULT_CHECK_PATTERN
    compile_check_pattern(check_pattern)
    assert_pattern_probes(compile_role_map(DEFAULT_ROLE_MAP))

    session_id, session_path, raws = read_session(args.session, args.project)
    ticket_prefixes = {p.strip().upper() for p in args.ticket_prefix if p.strip()} or None
    report = build_report(session_id, raws, weights, role_map, check_pattern, ticket_prefixes)

    if args.as_json:
        text = json.dumps(report_to_dict(report), indent=2, sort_keys=False)
    else:
        text = render_text(report, session_path)
    _emit(text, args.out)
    return 0


def run_compare(args) -> int:
    baseline = list(args.baseline)
    candidate = list(args.candidate)
    positional = list(args.positional)
    if positional:
        if len(positional) != 2 or baseline or candidate:
            raise MeasureError(
                "compare",
                "the positional form takes exactly two reports "
                "(baseline.json candidate.json); use --baseline/--candidate for N-vs-M",
            )
        baseline, candidate = [positional[0]], [positional[1]]
    if not baseline or not candidate:
        raise MeasureError("compare", "both a baseline and a candidate report are required")

    baseline_docs = [load_report_document(p) for p in baseline]
    candidate_docs = [load_report_document(p) for p in candidate]
    lines, failures = compare_reports(
        baseline_docs,
        candidate_docs,
        args.tolerance_share,
        args.tolerance_rel,
        args.assert_mode,
    )
    if failures:
        # The failure block first, and no `OK: wrote ...` confirmation: a
        # leading OK is reserved for the terminal success sentence.
        print(f"FAIL ({len(failures)}):", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        if args.out:
            written = _write_out("\n".join(lines), args.out)
            print(f"delta table written to {written}", file=sys.stderr)
        else:
            print("\n".join(lines))
        return 1
    if args.assert_mode:
        lines.append("OK: every compared figure is within tolerance.")
    _emit("\n".join(lines), args.out)
    return 0


def _join_project_slug(argv):
    """Let `--project <slug>` accept a slug that begins with a dash.

    Every real project slug does - `-Users-me-Projects-thing` - and argparse
    reads a leading-dash value as the next option. Joining the pair into
    `--project=<slug>` before parsing keeps the natural spelling working.
    """
    joined = []
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--project" and index + 1 < len(argv):
            joined.append(f"--project={argv[index + 1]}")
            index += 2
            continue
        joined.append(token)
        index += 1
    return joined


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    argv = _join_project_slug(argv)
    known = {"report", "compare", "self-test"}
    if argv and argv[0] not in known and not argv[0].startswith("-"):
        argv = ["report"] + argv

    parser = make_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 1

    try:
        if args.command == "report":
            return run_report(args)
        if args.command == "compare":
            return run_compare(args)
        return run_self_test()
    except MeasureError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
