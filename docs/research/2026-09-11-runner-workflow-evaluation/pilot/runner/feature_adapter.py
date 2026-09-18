"""Filesystem feature tickets: import immutable context and publish replayable results."""

import hashlib
import json
from pathlib import Path
import re
import subprocess

from feature_yaml import document, source_digest, with_status, yaml_read
from git_state import RunError, git, snapshot, text
import workflow

STATES = ("backlog", "in-progress", "review", "done")
ARTIFACTS = ("02-plan.md", "03-implementation.md", "04-review.md", "05-tests.md", "06-summary.md")


def digest(path):
    if not Path(path).exists():
        return None
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def atomic_text(path, content):
    import os
    import tempfile

    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
        temporary = stream.name
    os.replace(temporary, path)


def locate(root, identifier):
    if not re.fullmatch(r"[A-Z][A-Z0-9]*-[1-9][0-9]*", identifier):
        raise RunError("Feature ticket identifiers must use PREFIX-N")
    found = []
    for state in STATES:
        for path in (root / state).glob("**/" + identifier):
            if (path / "prd.md").is_file() or (path / "01-spec.md").is_file():
                found.append(path)
    if len(found) != 1:
        raise RunError("Expected exactly one feature ticket for " + identifier)
    return found[0]


def config_guard(root):
    path = root / "config.yaml"
    raw = path.read_text() if path.exists() else ""
    config = yaml_read(raw, allow_empty=True) if raw.strip() else {}
    mode = config.get("mode", "fs-native")
    if mode != "fs-native":
        raise RunError("This adapter supports fs-native storage only; configured mode: " + str(mode))
    git_config = config.get("git") or {}
    if not isinstance(git_config, dict):
        raise RunError("Project git configuration must be a mapping")
    commit = git_config.get("commit", "prompt")
    if commit == "never":
        raise RunError("Project git.commit: never conflicts with this committed-ticket profile")


def ignored_container(repo, root, identifier):
    folder = locate(root, identifier)
    relative_files = {str(p.relative_to(folder)) for p in folder.rglob("*") if p.is_file()}
    for spec in folder.rglob("01-spec.md"):
        relative_files.update(str((spec.parent / name).relative_to(folder)) for name in ARTIFACTS)
    prefixes, probes = [], []
    for state in STATES:
        path = root / state / identifier
        if path.parent.is_symlink() or path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise RunError("Ticket state destinations must be ordinary directories inside the ticket root")
        relative = str(path.relative_to(repo))
        prefixes.append(relative)
        probes.extend(relative + "/" + name for name in sorted(relative_files))
    if git(repo, "ls-files", "--", *prefixes):
        raise RunError("Tracked ticket folders require a separate adapter; preserve " + identifier)
    result = subprocess.run(["git", "-C", str(repo), "check-ignore", "--no-index", "-z", "--stdin"],
                            input=("\0".join(probes) + "\0").encode(), capture_output=True)
    ignored = set(result.stdout.decode().split("\0"))
    missing = [p for p in probes if p not in ignored]
    if result.returncode not in (0, 1) or missing:
        raise RunError("Every ticket input/artifact must be ignored in every state: " + ", ".join(missing[:3]))


def ordinary_tree(root, folder):
    if not folder.resolve().is_relative_to(root.resolve()) or folder.is_symlink():
        raise RunError("Ticket storage must remain inside the configured ticket root")
    if any(path.is_symlink() for path in folder.rglob("*")):
        raise RunError("Symlinks in a ticket subtree require manual reconciliation")


def import_manifest(repo, identifier, profile_path, output):
    repo = Path(text(repo, "rev-parse", "--show-toplevel")).resolve()
    root = repo / "claudedocs" / "tickets"
    if not root.resolve().is_relative_to(repo):
        raise RunError("Feature ticket root must reside inside the consuming repository")
    config_guard(root)
    folder = locate(root, identifier)
    if folder.parent.name == "tasks":
        raise RunError("Import the parent epic to preserve its full roster and shared constraints")
    ordinary_tree(root, folder)
    ignored_container(repo, root, identifier)
    output = output.resolve()
    if output.is_relative_to(repo) or output.exists() or (output.parent / "inputs").exists():
        raise RunError("Import into a new external run directory; preserve any existing manifest/inputs")
    profile_path = profile_path.resolve()
    profile = json.loads(profile_path.read_text())
    epic = (folder / "prd.md").exists()
    parent_file = folder / ("prd.md" if epic else "01-spec.md")
    _, parent, _ = document(parent_file)
    if parent.get("id") != identifier or (epic and parent.get("kind") != "epic"):
        raise RunError("Ticket folder and frontmatter identity/kind disagree")
    if epic and parent.get("status") not in ("backlog", "in-progress"):
        raise RunError("Reconcile the parent epic's existing terminal/review state before import")
    roster = parent.get("children") if epic else [identifier]
    if not isinstance(roster, list) or not roster or not all(isinstance(i, str) for i in roster):
        raise RunError("Epic requires its complete children roster")
    if len(set(roster)) != len(roster):
        raise RunError("Duplicate child in epic roster")
    actual = {p.parent.name for p in (folder / "tasks").glob("*/01-spec.md")} if epic else {identifier}
    if actual != set(roster):
        raise RunError("Declared and materialized child rosters differ; refine/reconcile before import")
    overrides = profile.get("tickets", {})
    completed = profile.get("completed", {})
    sources, published, frozen, specs, metadata = {}, {}, {}, {}, {}

    def source(path, kind):
        relative = str(path.relative_to(folder))
        sources[relative] = {"kind": kind, "digest": source_digest(path) if kind == "frontmatter" else digest(path)}
        if kind == "frontmatter":
            sources[relative]["status"] = document(path)[1].get("status")
        return relative

    if epic:
        source(parent_file, "frontmatter")
    source(folder / "exploration.md", "bytes")
    for ticket_id in roster:
        spec = folder / "tasks" / ticket_id / "01-spec.md" if epic else parent_file
        if locate(root, ticket_id) != spec.parent:
            raise RunError("Child ID resolves outside its declared parent: " + ticket_id)
        _, meta, _ = document(spec)
        if meta.get("id") != ticket_id or (epic and meta.get("parent") != identifier):
            raise RunError("Child identity/parent mismatch: " + ticket_id)
        if meta.get("status") not in ("backlog", "in-progress", "done", "cancelled"):
            raise RunError("Reconcile existing review/partial state before importing " + ticket_id)
        specs[ticket_id], metadata[ticket_id] = spec, meta
        source(spec, "frontmatter")
        for artifact in ARTIFACTS:
            path = spec.parent / artifact
            published[str(path.relative_to(folder))] = digest(path)
        if meta["status"] == "cancelled":
            frozen[ticket_id] = "cancelled"
        elif meta["status"] == "done":
            commit = completed.get(ticket_id)
            if not isinstance(commit, str) or not re.fullmatch(r"[a-fA-F0-9]{40,64}", commit):
                raise RunError("Previously done ticket requires a full completed commit SHA: " + ticket_id)
            git(repo, "merge-base", "--is-ancestor", commit, "HEAD")
            frozen[ticket_id] = "done"

    active = [i for i in roster if i not in frozen]
    if not active:
        raise RunError("No active implementation tickets; use the existing pipeline to reconcile completed work")
    if set(overrides) != set(active):
        raise RunError("Profile tickets must declare owned paths/checks for exactly the active roster")
    pending_copies = {}

    def capture(path):
        relative = path.relative_to(folder)
        target = output.parent / "inputs" / relative
        pending_copies[target] = path.read_text()
        return str(target)

    shared = []
    if epic:
        shared.append({"kind": "parent-prd", "path": capture(parent_file)})
    if (folder / "exploration.md").exists():
        shared.append({"kind": "shared-exploration", "path": capture(folder / "exploration.md")})
    tickets = []
    for ticket_id in active:
        spec, meta = specs[ticket_id], metadata[ticket_id]
        deps = meta.get("blocked_by", [])
        if not isinstance(deps, list) or not all(isinstance(i, str) for i in deps):
            raise RunError("blocked_by must be a list: " + ticket_id)
        if any(dep not in roster or frozen.get(dep) == "cancelled" for dep in deps):
            raise RunError("Unresolved or cancelled dependency: " + ticket_id)
        context = list(shared)
        for artifact in ARTIFACTS:
            previous = spec.parent / artifact
            if previous.exists():
                saved = capture(previous)
                if artifact == "02-plan.md":
                    context.append({"kind": "existing-plan", "path": saved})
        for dep in deps:
            context.append({"kind": "predecessor-spec", "path": capture(specs[dep])})
            if dep in frozen:
                for artifact in ("03-implementation.md", "06-summary.md"):
                    path = specs[dep].parent / artifact
                    if path.exists():
                        context.append({"kind": "predecessor-result", "path": capture(path)})
        options = overrides[ticket_id]
        tickets.append({"id": ticket_id, "spec": capture(spec), "context": context,
                        "blocked_by": [d for d in deps if d not in frozen],
                        "paths": options["paths"], "checks": options.get("checks", []),
                        "quality": options.get("quality", {})})
    manifest = {key: profile[key] for key in ("version", "commit_authorized", "delivery", "quality", "final_checks")}
    if "pr_base" in profile:
        manifest["pr_base"] = profile["pr_base"]
    manifest["tickets"] = tickets
    for policy in [manifest["quality"]] + [t["quality"] for t in tickets]:
        for role in ("implementation_skills", "review_rubrics"):
            for item in policy.get(role, []):
                item["path"] = str((profile_path.parent / item["path"]).resolve())
    manifest["feature"] = {"root": str(root), "id": identifier, "epic": epic,
                           "roster": roster, "frozen": frozen, "sources": sources,
                           "published": published, "folder_state": folder.parent.name,
                           "config_digest": digest(root / "config.yaml")}
    # Validate the entire import before writing any output or touching source tickets.
    import copy
    import quality
    from runner import validate_manifest

    preview = copy.deepcopy(manifest)
    # Snapshot targets do not yet exist; validation uses the original source paths.
    for ticket in preview["tickets"]:
        ticket["spec"] = str(specs[ticket["id"]])
        ticket["context"] = []
    quality.bind(preview, profile_path.parent)
    validate_manifest(preview)
    for path, content in pending_copies.items():
        atomic_text(path, content)
    atomic_text(output, json.dumps(manifest, indent=2) + "\n")
    return {"outcome": "imported", "manifest": str(output), "tickets": active, "preserved": frozen}


def desired_statuses(state, adapter):
    records = state["tickets"]
    started = any(r["phase"] != "pending" for r in records.values())
    if not started:
        return adapter["folder_state"], {p: item.get("status") for p, item in adapter["sources"].items() if item["kind"] == "frontmatter"}
    complete = state["complete"]
    pr = state["manifest"]["delivery"] == "epic-pr"
    folder_state = ("review" if pr else "done") if complete else "in-progress"
    targets = {}
    for identifier in adapter["roster"]:
        relative = f"tasks/{identifier}/01-spec.md" if adapter["epic"] else "01-spec.md"
        record = records.get(identifier)
        if record is None:
            value = adapter["frozen"][identifier]
        elif record["phase"] == "pending":
            value = adapter["sources"][relative]["status"]
        elif complete:
            value = "in-review" if pr else "done"
        elif record["phase"] == "done" and local_delivered(state, record):
            value = "done"
        else:
            value = "in-progress"
        targets[relative] = value
    if adapter["epic"]:
        targets["prd.md"] = "in-review" if folder_state == "review" else folder_state
    return folder_state, targets


def local_delivered(state, record):
    return state["manifest"]["delivery"] == "local" and (
        any(r["phase"] != "done" for r in state["tickets"].values())
        or record["commit"] != state["expected_head"])


def artifacts(state, ticket, record, tree):
    if record["phase"] == "pending":
        return {}
    evidence_tree = record.get("intent", {}).get("tree") if record["phase"] == "done" else tree
    work = record.get("work")
    review = record.get("review")
    work_ok = workflow.work_current(record, evidence_tree)
    review_ok = workflow.review_current(record, evidence_tree)
    checks_ok = all(workflow.check_current(c, record["checks"].get(c["name"], {}), evidence_tree)
                    for c in workflow.checks(ticket, record))
    accepted = record["phase"] == "done" and work_ok and review_ok and checks_ok
    delivered = accepted and (state["complete"] or local_delivered(state, record))
    provenance = f"Runner: codex-ticket-runner\nBranch: {state['branch']}\nTree: {evidence_tree}\n"
    result = {}
    if record.get("plan"):
        result["02-plan.md"] = (record["plan"]["approach"].rstrip() + "\n\n## Workflow decision record\n\n```json\n"
                               + json.dumps(record["plan"], indent=2) + "\n```\n")
    if work:
        result["03-implementation.md"] = ("verdict: " + ("pass" if work_ok else "partial") + "\n\n" + provenance
            + "\n" + work["summary"] + "\n\n## Acceptance evidence\n" + work["acceptance_evidence"]
            + "\n\nSkills used: " + json.dumps(work["skills_used"]) + "\n"
            + "\n## Independent cases and behavior evidence\n\n```json\n"
            + json.dumps({"challenge": record.get("challenge"),
                          "behavior_evidence": work.get("behavior_evidence")}, indent=2) + "\n```\n")
    if review:
        result["04-review.md"] = ("verdict: " + ("pass" if review_ok else "partial") + "\n\n" + provenance
            + "\nIndependent reviewer report (inspect tree above for currency):\n\n```json\n"
            + json.dumps(review, indent=2) + "\n```\n")
    if record["checks"]:
        result["05-tests.md"] = ("verdict: " + ("pass" if checks_ok else "partial") + "\n\n" + provenance
            + "\nDeclared command evidence; browser coverage exists only if a browser command is declared.\n\n```json\n"
            + json.dumps(record["checks"], indent=2) + "\n```\n")
    result["06-summary.md"] = ("verdict: " + ("pass" if delivered else "partial") + "\n\n" + provenance
        + f"\nTicket: {ticket['id']}\nCommit: {record.get('commit', 'pending')}\n"
        + ("Delivery verified.\n" if delivered else "Run delivery/integration pending; resume the recorded runner state.\n")
        + ("PR: " + state["pr"]["url"] + "\n" if state.get("pr") else "")
        + "\nBlocker: " + json.dumps(record.get("blocker")) + "\n")
    return result


def sync(state):
    adapter = state.get("feature")
    if not adapter:
        return
    repo, root = Path(state["repo"]), Path(adapter["root"])
    if not root.resolve().is_relative_to(repo):
        raise RunError("Feature ticket root moved outside the consuming repository")
    config_guard(root)
    if digest(root / "config.yaml") != adapter["config_digest"]:
        raise RunError("Feature configuration changed; reconcile before publishing")
    folder = locate(root, adapter["id"])
    ordinary_tree(root, folder)
    ignored_container(repo, root, adapter["id"])
    if adapter["epic"]:
        actual = {p.parent.name for p in (folder / "tasks").glob("*/01-spec.md")}
        if actual != set(adapter["roster"]):
            raise RunError("Feature child roster changed; publication blocked")
    destination_state, statuses = desired_statuses(state, adapter)
    if folder.parent.name not in (adapter["folder_state"], destination_state):
        raise RunError("Ticket folder moved outside this runner; preserve and reconcile")
    status_writes = {}
    for relative, bound in adapter["sources"].items():
        path = folder / relative
        actual = source_digest(path) if bound["kind"] == "frontmatter" else digest(path)
        if actual != bound["digest"]:
            raise RunError("Feature source changed: " + str(path))
        if bound["kind"] == "frontmatter":
            current_status = document(path)[1].get("status")
            if current_status not in (bound["status"], statuses[relative]):
                raise RunError("Ticket status changed outside this runner: " + str(path))
            if current_status != statuses[relative]:
                status_writes[relative] = with_status(path, statuses[relative])
    destination = root / destination_state / adapter["id"]
    if destination != folder and destination.exists():
        raise RunError("Destination ticket folder already exists; preserve both folders")
    tree = snapshot(repo)
    writes = {}
    for ticket in state["manifest"]["tickets"]:
        prefix = f"tasks/{ticket['id']}/" if adapter["epic"] else ""
        for name, content in artifacts(state, ticket, state["tickets"][ticket["id"]], tree).items():
            writes[prefix + name] = content
    for relative, previous in adapter["published"].items():
        actual = digest(folder / relative)
        desired = hashlib.sha256(writes[relative].encode()).hexdigest() if relative in writes else previous
        if actual not in (previous, desired):
            raise RunError("Artifact edited outside this runner; preserve " + str(folder / relative))
    # Preflight completed. Move first, then write; replay accepts old or desired bytes.
    if destination != folder:
        destination.parent.mkdir(parents=True, exist_ok=True)
        folder.rename(destination)
    for relative, content in status_writes.items():
        atomic_text(destination / relative, content)
    for relative, content in writes.items():
        if digest(destination / relative) != hashlib.sha256(content.encode()).hexdigest():
            atomic_text(destination / relative, content)
    adapter["folder_state"] = destination_state
    for relative, value in statuses.items():
        adapter["sources"][relative]["status"] = value
    for relative in writes:
        adapter["published"][relative] = digest(destination / relative)


def predecessors(state, ticket):
    result = []
    for identifier in ticket.get("blocked_by", []):
        record = state["tickets"][identifier]
        item = {"ticket": identifier, "commit": record.get("commit"),
                "boundary_decisions": record.get("plan", {}).get("boundaries", [])}
        if state.get("feature"):
            adapter = state["feature"]
            folder = locate(Path(adapter["root"]), adapter["id"]) / "tasks" / identifier
            item["artifacts"] = [str(folder / name) for name in ARTIFACTS if (folder / name).exists()]
        result.append(item)
    return result
