"""Evidence contracts for design decisions, reuse and independent failure cases.

These gates validate declarations and their bindings. They cannot authenticate a
human approval, prove reviewer independence, or infer test adequacy from prose.
"""

import hashlib
import json
import re

from git_state import RunError

VERSION = 1


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def prose(value, field):
    if not isinstance(value.get(field), str) or not value[field].strip():
        raise RunError("Workflow report requires nonempty " + field)


def rows(value, field):
    items = value.get(field)
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise RunError("Workflow report requires " + field + " as an array of objects")
    ids = [item.get("id") for item in items]
    if any(not isinstance(i, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", i) for i in ids):
        raise RunError(field + " require simple nonempty IDs")
    if len(ids) != len(set(ids)):
        raise RunError("Duplicate IDs in " + field)
    return items


def identify(report, state, ticket, record, tree, policy):
    if not isinstance(report, dict) or any(report.get(k) != v for k, v in {
        "ticket": ticket["id"], "base": record["base"], "tree": tree,
        "quality_fingerprint": policy,
    }.items()):
        raise RunError("Workflow report does not cover current ticket/base/tree/policy")


def challenge_current(record):
    return bool(record.get("plan") and record.get("challenge")
                and record["challenge"]["plan_digest"] == fingerprint(record["plan"]))


def checks(ticket, record):
    return (ticket["checks"] + record.get("plan", {}).get("checks", [])
            + (record["challenge"].get("checks", []) if challenge_current(record) else []))


def check_current(check, evidence, tree):
    return (evidence.get("tree") == tree and evidence.get("exit_code") == 0
            and evidence.get("argv") == check["argv"]
            and evidence.get("timeout") == check.get("timeout", 120))


def check_names(items, definitions):
    names = {item["name"] for item in definitions}
    for item in items:
        if item.get("check") not in names:
            raise RunError("Obligation references an undeclared check: " + str(item.get("check")))


def preflight_gate(record):
    if not record.get("plan"):
        return "plan"
    if any(item["disposition"] == "pending_exception" for item in record["plan"]["boundaries"]):
        return "decision_required"
    if not challenge_current(record):
        return "challenge"
    return None


def require_ready(record):
    gate = preflight_gate(record)
    if gate:
        raise RunError("Workflow gate pending: " + gate)


def record_plan(record, report, paths, definitions):
    if not record.get("plan") and paths:
        raise RunError("Record the initial plan before product edits; preserve and reconcile existing work")
    for field in ("approach", "boundary_assessment", "reuse_assessment"):
        prose(report, field)
    boundaries = rows(report, "boundaries")
    reuse = rows(report, "reuse")
    for item in boundaries:
        for field in ("rule", "decision", "rationale", "alternative", "reviewer_check", "surfaced_to_user"):
            prose(item, field)
        if item.get("disposition") not in ("preserved", "approved_exception", "pending_exception"):
            raise RunError("Boundary disposition must preserve a rule or explicitly resolve an exception")
        if item["disposition"] == "approved_exception":
            prose(item, "approval_reference")
    for item in reuse:
        for field in ("source", "rationale", "reviewer_check"):
            prose(item, field)
        if item.get("choice") not in ("reuse", "adapt", "replace"):
            raise RunError("Reuse choice must be reuse, adapt or replace")
        invariants = item.get("invariants")
        if not isinstance(invariants, list) or not invariants or not all(
                isinstance(i, str) and i.strip() for i in invariants):
            raise RunError("Reused behavior requires explicit preserved invariants")
    check_names(boundaries + reuse, definitions)
    if record.get("plan") and report != record["plan"]:
        prose(report, "revision_reason")
        record.setdefault("plan_history", []).append(record["plan"])
    record["plan"] = report


def record_challenge(state, record, report, paths, definitions):
    if not record.get("plan") or preflight_gate(record) == "decision_required":
        raise RunError("Resolve the plan and requested exceptions before failure-case selection")
    if not record.get("challenge") and paths:
        raise RunError("Select initial independent failure cases before product edits")
    if report.get("reviewer") == state["owner"]:
        raise RunError("Failure cases require an independent reviewer identity")
    prose(report, "reviewer")
    prose(report, "selection_basis")
    if report.get("plan_digest") != fingerprint(record["plan"]):
        raise RunError("Failure cases do not cover the recorded plan")
    cases = rows(report, "cases")
    if not cases:
        raise RunError("Select at least one independently chosen failure case")
    for item in cases:
        for field in ("invariant", "setup", "expected"):
            prose(item, field)
    check_names(cases, definitions)
    if record.get("challenge") and report != record["challenge"]:
        prose(report, "revision_reason")
        record.setdefault("challenge_history", []).append(record["challenge"])
    record["challenge"] = report
    record.pop("blocker", None)


def obligations(record):
    result = []
    for group, items in (("boundary", record.get("plan", {}).get("boundaries", [])),
                         ("reuse", record.get("plan", {}).get("reuse", [])),
                         ("case", record.get("challenge", {}).get("cases", []))):
        for item in items:
            result.append({"id": group + ":" + item["id"], "check": item["check"],
                           "expectation": item.get("reviewer_check", item.get("expected"))})
    return result


def context(record):
    return {"workflow_version": VERSION,
            "plan_digest": fingerprint(record.get("plan")),
            "challenge_digest": fingerprint(record.get("challenge")),
            "work_digest": fingerprint(record.get("work")),
            "checks_digest": fingerprint(record.get("checks")),
            "plan_evidence": record.get("plan"), "challenge_evidence": record.get("challenge"),
            "obligations": obligations(record)}


def bound(report, record):
    return all(report.get(field) == fingerprint(record.get(key))
               for field, key in (("plan_digest", "plan"), ("challenge_digest", "challenge")))


def coverage(report, field, record, review=False):
    supplied = report.get(field)
    if not isinstance(supplied, list) or not all(isinstance(row, dict) for row in supplied):
        raise RunError("Report requires " + field + " for every obligation")
    expected = {item["id"]: item for item in obligations(record)}
    ids = [item.get("obligation") for item in supplied]
    if not all(isinstance(i, str) for i in ids) or len(ids) != len(set(ids)) or set(ids) != set(expected):
        raise RunError("Report must cover exactly the boundary, reuse and independent-case obligations")
    for item in supplied:
        prose(item, "evidence")
        if item.get("check") != expected[item["obligation"]]["check"]:
            raise RunError("Obligation evidence must name its declared check")
        if review:
            if item.get("verdict") not in ("satisfied", "gap"):
                raise RunError("Each review assessment requires satisfied or gap")
            if report["verdict"] == "pass" and item["verdict"] != "satisfied":
                raise RunError("A review pass cannot contain an obligation gap")


def validate_work(report, record):
    require_ready(record)
    if not bound(report, record):
        raise RunError("Work report has stale plan or failure-case evidence")
    coverage(report, "behavior_evidence", record)
    if "plan" in report and report["plan"] != record["plan"]["approach"]:
        raise RunError("Revise the recorded plan before changing its work-report narrative")
    report["plan"] = record["plan"]["approach"]


def validate_review(report, record):
    require_ready(record)
    if not bound(report, record) or report.get("work_digest") != fingerprint(record.get("work")):
        raise RunError("Review has stale plan, failure-case or work evidence")
    if report.get("checks_digest") != fingerprint(record.get("checks")):
        raise RunError("Review has stale check evidence")
    if not work_current(record, report["tree"]):
        raise RunError("Review requires current work evidence")
    coverage(report, "assessments", record, review=True)


def work_current(record, tree):
    return (preflight_gate(record) is None and record.get("work", {}).get("tree") == tree
            and bound(record["work"], record))


def review_current(record, tree):
    report = record.get("review", {})
    return (work_current(record, tree) and report.get("tree") == tree
            and report.get("verdict") == "pass" and bound(report, record)
            and report.get("work_digest") == fingerprint(record.get("work"))
            and report.get("checks_digest") == fingerprint(record.get("checks")))
