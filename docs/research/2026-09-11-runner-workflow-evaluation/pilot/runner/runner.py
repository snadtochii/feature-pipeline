#!/usr/bin/env python3
"""PROTOTYPE: one writer, one epic branch, explicit ticket gates; Python stdlib only."""

import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile

from git_state import RunError, clean, git, owned_snapshot, patch
from git_state import snapshot, stage_paths, text, verify_pr
import feature_adapter
import quality
import workflow


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
        temporary = stream.name
    os.replace(temporary, path)


def checks_valid(checks):
    names = [c["name"] for c in checks]
    if len(names) != len(set(names)):
        raise RunError("Check names must be unique")
    for check in checks:
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", check["name"]):
            raise RunError("Check names must be simple identifiers")
        if not check["argv"] or not all(isinstance(a, str) for a in check["argv"]):
            raise RunError("Checks require a nonempty argv array")
        if not 0 < check.get("timeout", 120) <= 3600:
            raise RunError("Check timeout must be between 1 and 3600 seconds")


def validate_manifest(manifest):
    if manifest.get("version") != 1 or manifest.get("commit_authorized") is not True:
        raise RunError("Version 1 and explicit per-ticket commit authorization are required")
    if manifest.get("delivery") not in ("local", "epic-pr"):
        raise RunError("Delivery must be local or epic-pr")
    if manifest["delivery"] == "epic-pr" and not manifest.get("pr_base"):
        raise RunError("An epic PR requires an explicit pr_base")
    tickets = manifest["tickets"]
    ids = [t["id"] for t in tickets]
    if not ids or len(ids) != len(set(ids)):
        raise RunError("An epic requires a nonempty, unique ticket roster")
    for ticket in tickets:
        if not re.fullmatch(r"[A-Z][A-Z0-9]*-[1-9][0-9]*", ticket["id"]):
            raise RunError("Ticket IDs must use PREFIX-N")
        if not Path(ticket["spec"]).is_file():
            raise RunError("Missing spec: " + ticket["spec"])
        if not ticket["paths"] or any(
            p in ("", ".") or p.startswith("/") or ".." in Path(p).parts
            or ".git" in Path(p).parts or p.endswith("/") for p in ticket["paths"]
        ):
            raise RunError("Owned paths must be explicit relative files/directories")
        if not ticket["checks"]:
            raise RunError("Each ticket requires at least one check")
        checks_valid(ticket["checks"])
        if any(dep not in ids for dep in ticket.get("blocked_by", [])):
            raise RunError("Unresolved dependency on " + ticket["id"])
    resolved = set()
    while len(resolved) < len(ids):
        ready = {t["id"] for t in tickets if set(t.get("blocked_by", [])) <= resolved}
        if ready <= resolved:
            raise RunError("Dependency cycle")
        resolved |= ready
    if not manifest.get("final_checks"):
        raise RunError("Declare the epic integration checks")
    checks_valid(manifest["final_checks"])


def initialize(path, repo, branch, manifest_path, owner):
    if path.exists():
        raise RunError("State already exists; resume it")
    repo = Path(text(repo, "rev-parse", "--show-toplevel")).resolve()
    if path.is_relative_to(repo):
        raise RunError("Keep prototype state/evidence outside the code checkout")
    if branch in ("main", "master") or text(repo, "branch", "--show-current") != branch:
        raise RunError("Check out the declared dedicated epic branch first")
    if not clean(repo):
        raise RunError("Start on a clean checkout; preserve unrelated work before initializing")
    manifest_path = manifest_path.resolve()
    manifest = json.loads(manifest_path.read_text())
    for ticket in manifest.get("tickets", []):
        ticket["spec"] = str((manifest_path.parent / ticket["spec"]).resolve())
    policy_digests = quality.bind(manifest, manifest_path.parent)
    validate_manifest(manifest)
    state = {
        "version": 1, "workflow_version": workflow.VERSION,
        "repo": str(repo), "branch": branch, "owner": owner,
        "manifest_path": str(manifest_path), "manifest_digest": digest(manifest_path),
        "manifest": manifest, "expected_head": text(repo, "rev-parse", "HEAD"),
        "spec_digests": {t["id"]: digest(t["spec"]) for t in manifest["tickets"]},
        "tickets": {t["id"]: {"phase": "pending"} for t in manifest["tickets"]},
        "current": None, "final_checks": {}, "pr": None, "complete": False,
        "policy_digests": policy_digests,
        "feature": copy.deepcopy(manifest.get("feature")),
    }
    save(path, state)
    return state


def reconcile(state):
    if state.get("workflow_version") != workflow.VERSION:
        raise RunError("State predates this workflow contract; use its original runner or reconcile a new run")
    quality.verify(state)
    repo = state["repo"]
    if text(repo, "branch", "--show-current") != state["branch"]:
        raise RunError("Checkout changed; return to the recorded epic branch")
    if digest(state["manifest_path"]) != state["manifest_digest"]:
        raise RunError("Manifest changed; reconcile scope explicitly before resuming")
    for ticket in state["manifest"]["tickets"]:
        if digest(ticket["spec"]) != state["spec_digests"][ticket["id"]]:
            raise RunError("Spec changed; evidence invalid for " + ticket["id"])
    head = text(repo, "rev-parse", "HEAD")
    if state["current"]:
        record = state["tickets"][state["current"]]
        if record["phase"] == "committing" and head != record["base"]:
            parents = text(repo, "show", "-s", "--format=%P", head).split()
            if (parents == [record["base"]]
                    and text(repo, "rev-parse", head + "^{tree}") == record["intent"]["tree"]
                    and text(repo, "show", "-s", "--format=%B", head) == record["intent"]["message"]):
                record.update(phase="done", commit=head)
                state.update(current=None, expected_head=head)
    if head != state["expected_head"]:
        raise RunError("Unexpected HEAD: inspect external commits or hook changes; do not repeat commit")
    if state["current"] is None and not clean(repo):
        raise RunError("Changes exist between ticket boundaries; reconcile them before advancing")


def current(state):
    if not state["current"]:
        raise RunError("Call next to select a ticket")
    ticket = next(t for t in state["manifest"]["tickets"] if t["id"] == state["current"])
    return ticket, state["tickets"][ticket["id"]]


def missing_checks(definitions, evidence, tree):
    return [c["name"] for c in definitions
            if not workflow.check_current(c, evidence.get(c["name"], {}), tree)]


def status(state):
    if state["complete"]:
        return {"outcome": "complete", "head": state["expected_head"], "pr": state["pr"]}
    if state["current"] is None:
        pending = [t for t, r in state["tickets"].items() if r["phase"] != "done"]
        return {"outcome": "ready" if pending else "integration_required", "remaining": pending}
    ticket, record = current(state)
    tree, paths = owned_snapshot(state["repo"], ticket, record)
    missing = missing_checks(workflow.checks(ticket, record), record["checks"], tree)
    reviewed = workflow.review_current(record, tree)
    gate = workflow.preflight_gate(record)
    if gate:
        action = gate
    elif not paths:
        action = "implement"
    elif not quality.work_current(record, tree):
        action = "document"
    elif missing:
        action = "verify"
    elif not reviewed:
        action = "review"
    else:
        action = "commit"
    return {"outcome": action, "ticket": ticket["id"], "spec": ticket["spec"],
            "base": record["base"], "tree": tree, "paths": paths,
            "missing_checks": missing, "review_current": reviewed,
            "blocker": record.get("blocker"),
            **quality.contract(state, ticket),
            **workflow.context(record),
            "required_checks": workflow.checks(ticket, record),
            "predecessors": feature_adapter.predecessors(state, ticket)}


def select_next(state):
    if state["current"] or state["complete"]:
        return
    done = {key for key, value in state["tickets"].items() if value["phase"] == "done"}
    for ticket in state["manifest"]["tickets"]:
        if ticket["id"] not in done and set(ticket.get("blocked_by", [])) <= done:
            state["current"] = ticket["id"]
            state["tickets"][ticket["id"]] = {
                "phase": "active", "base": state["expected_head"], "checks": {},
            }
            return


def make_packet(path, state, challenge=False):
    ticket, record = current(state)
    tree, paths = owned_snapshot(state["repo"], ticket, record)
    if not challenge and not paths:
        raise RunError("No implementation delta to review")
    if challenge:
        if not record.get("plan") or workflow.preflight_gate(record) == "decision_required":
            raise RunError("Resolve the plan before requesting failure cases")
    else:
        workflow.require_ready(record)
    folder = path.parent / "evidence" / ticket["id"] / tree
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "change.patch").write_bytes(patch(state["repo"], record["base"], tree))
    packet = {"ticket": ticket["id"], "base": record["base"], "tree": tree,
              "spec": ticket["spec"], "spec_digest": state["spec_digests"][ticket["id"]],
              "repo": state["repo"], "paths": paths, "patch": str(folder / "change.patch"),
              **quality.contract(state, ticket),
              **workflow.context(record),
              "purpose": "failure-case-selection" if challenge else "final-review",
              "predecessors": feature_adapter.predecessors(state, ticket),
              "required_checks": workflow.checks(ticket, record), "check_evidence": record["checks"],
              "work_evidence": None if challenge else record.get("work"),
              "plan_history": record.get("plan_history", []),
              "challenge_history": record.get("challenge_history", [])}
    save(folder / ("challenge-packet.json" if challenge else "packet.json"), packet)
    record["packet"] = packet
    return packet


def record_preflight(state, report_path, challenge=False):
    ticket, record = current(state)
    tree, paths = owned_snapshot(state["repo"], ticket, record)
    report = json.loads(report_path.read_text())
    workflow.identify(report, state, ticket, record, tree,
                      quality.contract(state, ticket)["quality_fingerprint"])
    additions = report.get("checks", [])
    if not isinstance(additions, list):
        raise RunError("Additional checks must be an array")
    definitions = ticket["checks"] + additions
    if challenge:
        definitions += record.get("plan", {}).get("checks", [])
    checks_valid(definitions)
    if challenge:
        workflow.record_challenge(state, record, report, paths, definitions)
    else:
        workflow.record_plan(record, report, paths, definitions)


def run_check(path, state, name, final=False, rerun=False):
    if final:
        if any(r["phase"] != "done" for r in state["tickets"].values()):
            raise RunError("Finish all tickets before epic integration verification")
        definitions, results, label = state["manifest"]["final_checks"], state["final_checks"], "epic"
        tree = snapshot(state["repo"])
    else:
        ticket, record = current(state)
        workflow.require_ready(record)
        definitions, results, label = workflow.checks(ticket, record), record["checks"], ticket["id"]
        tree, _ = owned_snapshot(state["repo"], ticket, record)
    check = next((c for c in definitions if c["name"] == name), None)
    if check is None:
        raise RunError("Unknown required check: " + name)
    if not rerun and not missing_checks([check], results, tree):
        return dict(results[name], cached=True)
    results.pop(name, None)
    if final:
        state["complete"] = False
    save(path, state)  # An interrupted rerun must not leave an old pass authoritative.
    folder = path.parent / "evidence" / label / tree
    folder.mkdir(parents=True, exist_ok=True)
    log = folder / (name + ".log")
    with log.open("w") as stream:
        process = subprocess.Popen(check["argv"], cwd=state["repo"], stdout=stream,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=check.get("timeout", 120))
        except subprocess.TimeoutExpired:
            code = 124
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
    after = snapshot(state["repo"])
    results[name] = {"tree": tree, "exit_code": code if tree == after else -1,
                     "argv": check["argv"], "timeout": check.get("timeout", 120), "log": str(log)}
    return results[name]


def record_review(state, report_path):
    ticket, record = current(state)
    tree, _ = owned_snapshot(state["repo"], ticket, record)
    report = json.loads(report_path.read_text())
    quality.check_report(report, state, ticket, tree, "rubrics_applied", "review_rubrics")
    if any(report.get(k) != v for k, v in {
        "ticket": ticket["id"], "base": record["base"], "tree": tree,
    }.items()):
        raise RunError("Review does not cover the current ticket/base/tree")
    if not report.get("reviewer") or report["reviewer"] == state["owner"]:
        raise RunError("Independent reviewer identity required; self-review is not this profile")
    if report.get("verdict") not in ("pass", "changes_required") or not isinstance(report.get("findings"), list):
        raise RunError("Review requires verdict and findings array")
    if report["verdict"] == "pass" and report["findings"]:
        raise RunError("Resolve actionable findings before passing review")
    workflow.validate_review(report, record)
    record["review"] = report
    record.pop("blocker", None)


def commit_ticket(path, state, message):
    ticket, record = current(state)
    decision = status(state)
    if decision["outcome"] != "commit":
        raise RunError("Commit gate incomplete: " + json.dumps(decision))
    message = message.strip()
    if not message.startswith(ticket["id"] + ": "):
        raise RunError("Use a ticket-prefixed commit subject, with an optional body")
    record.update(phase="committing", intent={"tree": decision["tree"], "message": message})
    save(path, state)  # Crash recovery starts before any Git mutation.
    stage_paths(state["repo"], decision["paths"])
    if text(state["repo"], "write-tree") != decision["tree"]:
        raise RunError("Index diverged before commit")
    message_path = path.parent / "commit-message.txt"
    message_path.write_text(message + "\n")
    git(state["repo"], "commit", "-F", str(message_path))
    reconcile(state)  # Verify actual tree/parent/message; preserve hook behavior.


def finish(state, pr_url=None):
    if any(r["phase"] != "done" for r in state["tickets"].values()):
        raise RunError("Tickets remain incomplete")
    tree = snapshot(state["repo"])
    missing = missing_checks(state["manifest"]["final_checks"], state["final_checks"], tree)
    if missing:
        raise RunError("Epic integration checks pending: " + ", ".join(missing))
    if state["manifest"]["delivery"] == "epic-pr":
        if not pr_url:
            raise RunError("Requested PR delivery remains pending; supply the real PR URL")
        state["pr"] = verify_pr(state["repo"], pr_url, state["branch"],
                                state["manifest"]["pr_base"], state["expected_head"])
    state["complete"] = True


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--state", type=Path, required=True, help="State JSON outside the code checkout")
    commands = root.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="Bind an authorized manifest to an existing clean epic branch")
    init.add_argument("--repo", type=Path, required=True)
    init.add_argument("--branch", required=True)
    init.add_argument("--manifest", type=Path, required=True)
    init.add_argument("--owner", required=True)
    adapter = commands.add_parser("import-feature", help="Prepare a manifest from an existing fs-native solo ticket or epic")
    adapter.add_argument("--repo", type=Path, required=True)
    adapter.add_argument("--ticket", required=True)
    adapter.add_argument("--profile", type=Path, required=True)
    for name in ("status", "next", "packet", "challenge-packet", "context", "sync-feature"):
        commands.add_parser(name)
    for name in ("plan", "challenge"):
        command = commands.add_parser(name, help="Record pre-implementation workflow evidence")
        command.add_argument("report", type=Path)
    work = commands.add_parser("work", help="Record the plan, implementation evidence and applied skills")
    work.add_argument("report", type=Path)
    check = commands.add_parser("check", help="Execute one declared argv check; record its code fingerprint")
    check.add_argument("name")
    check.add_argument("--final", action="store_true")
    check.add_argument("--rerun", action="store_true", help="Invalidate and rerun after changed environment or disputed evidence")
    review = commands.add_parser("review")
    review.add_argument("report", type=Path)
    commit = commands.add_parser("commit")
    message = commit.add_mutually_exclusive_group(required=True)
    message.add_argument("--message")
    message.add_argument("--message-file", type=Path)
    block = commands.add_parser("block", help="Record a concrete recovery condition; does not change Goal lifecycle")
    block.add_argument("--reason", required=True)
    block.add_argument("--recovery", required=True)
    end = commands.add_parser("finish")
    end.add_argument("--pr-url")
    return root


def main():
    def interrupted(signum, frame):
        raise InterruptedError("Check interrupted; evidence remains pending")

    signal.signal(signal.SIGTERM, interrupted)
    args = parser().parse_args()
    path = args.state.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.command == "import-feature":
                if path.exists():
                    raise RunError("A run already exists here; resume it")
                print(json.dumps(feature_adapter.import_manifest(
                    args.repo, args.ticket, args.profile, path.parent / "manifest.json"), indent=2))
                return 0
            if args.command == "init":
                state = initialize(path, args.repo, args.branch, args.manifest, args.owner)
            else:
                state = json.loads(path.read_text())
                reconcile(state)
                save(path, state)
            feature_adapter.sync(state)
            save(path, state)
            output = None
            if args.command == "next":
                select_next(state)
            elif args.command in ("packet", "challenge-packet"):
                output = make_packet(path, state, args.command == "challenge-packet")
            elif args.command in ("plan", "challenge"):
                record_preflight(state, args.report, args.command == "challenge")
            elif args.command == "check":
                output = run_check(path, state, args.name, args.final, args.rerun)
            elif args.command == "review":
                record_review(state, args.report)
            elif args.command == "work":
                ticket, record = current(state)
                tree, _ = owned_snapshot(state["repo"], ticket, record)
                quality.record_work(state, ticket, record, tree, json.loads(args.report.read_text()))
            elif args.command == "commit":
                message = args.message_file.read_text() if args.message_file else args.message
                commit_ticket(path, state, message)
            elif args.command == "block":
                _, record = current(state)
                record["blocker"] = {"reason": args.reason, "recovery": args.recovery}
            elif args.command == "finish":
                state["complete"] = False
                save(path, state)
                finish(state, args.pr_url)
            save(path, state)
            feature_adapter.sync(state)
            save(path, state)
            print(json.dumps(output if output is not None else status(state), indent=2))
            if args.command == "check" and output["exit_code"] != 0:
                return 1
    except (RunError, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"outcome": "blocked", "reason": str(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
