"""Bind quality instructions to the same immutable inputs as the ticket spec."""

import hashlib
import json
from pathlib import Path

from git_state import RunError
import workflow


def fingerprint(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def references(items, base):
    if not isinstance(items, list):
        raise RunError("Quality references must be arrays of {id, path}")
    result = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"].strip():
            raise RunError("Quality references require a nonempty id")
        path = (base / item["path"]).resolve()
        if not path.is_file():
            raise RunError("Required quality instruction is unavailable: " + str(path))
        result.append({"id": item["id"], "path": str(path)})
    if len({item["id"] for item in result}) != len(result):
        raise RunError("Quality reference IDs must be unique within each role")
    return result


def bind(manifest, base):
    policy = manifest.get("quality")
    if not isinstance(policy, dict) or not all(
        key in policy for key in ("implementation_skills", "review_rubrics", "required_checks")
    ):
        raise RunError("Declare quality.implementation_skills, review_rubrics and required_checks")
    built_in = {"id": "runner-baseline", "path": str(Path(__file__).with_name("quality-rubric.md"))}
    digests = {str(Path(__file__).with_name(name)): fingerprint(Path(__file__).with_name(name))
               for name in ("workflow-contract.md", "review.md", "SKILL.md")}
    for ticket in manifest["tickets"]:
        extra = ticket.get("quality", {})
        resolved = {}
        for role in ("implementation_skills", "review_rubrics"):
            items = policy[role] + extra.get(role, [])
            if role == "review_rubrics":
                items = [built_in] + items
            resolved[role] = references(items, base)
            for item in resolved[role]:
                digests[item["path"]] = fingerprint(item["path"])
        ticket["quality"] = resolved
        ticket["checks"] = policy["required_checks"] + ticket["checks"]
        for item in ticket.get("context", []):
            item["path"] = str((base / item["path"]).resolve())
            if not Path(item["path"]).is_file():
                raise RunError("Required context unavailable: " + item["path"])
            digests[item["path"]] = fingerprint(item["path"])
    return digests


def verify(state):
    if "policy_digests" not in state:
        raise RunError("This state predates explicit quality policy; use its original runner or reconcile a new run")
    for path, expected in state["policy_digests"].items():
        if fingerprint(path) != expected:
            raise RunError("Quality instruction or context changed: " + path)


def contract(state, ticket):
    result = {"quality": ticket["quality"], "context": ticket.get("context", []),
              "workflow_contract": str(Path(__file__).with_name("workflow-contract.md"))}
    paths = [item["path"] for role in ticket["quality"].values() for item in role]
    paths += [item["path"] for item in ticket.get("context", [])]
    paths += [str(Path(__file__).with_name(name))
              for name in ("workflow-contract.md", "review.md", "SKILL.md")]
    binding = {"contract": result, "digests": {p: state["policy_digests"][p] for p in paths}}
    result["quality_fingerprint"] = hashlib.sha256(
        json.dumps(binding, sort_keys=True).encode()
    ).hexdigest()
    return result


def check_report(report, state, ticket, tree, field, role):
    if (report.get("ticket") != ticket["id"] or report.get("tree") != tree
            or report.get("quality_fingerprint") != contract(state, ticket)["quality_fingerprint"]):
        raise RunError("Report does not cover the current ticket/tree/quality policy")
    expected = {item["id"] for item in ticket["quality"][role]}
    supplied = report.get(field)
    if not isinstance(supplied, list) or not all(isinstance(item, str) for item in supplied):
        raise RunError("Report requires " + field + " as an array of applied IDs")
    if set(supplied) != expected:
        raise RunError("Report must account for exactly the required " + role)


def record_work(state, ticket, record, tree, report):
    check_report(report, state, ticket, tree, "skills_used", "implementation_skills")
    for field in ("summary", "acceptance_evidence"):
        if not isinstance(report.get(field), str) or not report[field].strip():
            raise RunError("Work report requires nonempty " + field)
    workflow.validate_work(report, record)
    record["work"] = report


def work_current(record, tree):
    return workflow.work_current(record, tree)
