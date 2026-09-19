"""Black-box protocol probes against disposable Git repositories, not model reviews."""

import json
import os
from pathlib import Path
import subprocess
import signal
import sys
import tempfile
import time
import unittest

RUNNER = Path(__file__).with_name("runner.py")


class RunnerFixture(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="codex-runner-probe-")
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.state = self.root / "run" / "state.json"
        self.manifest = self.root / "manifest.json"
        self.git("init", "-b", "codex/prototype")
        self.git("config", "user.name", "Prototype probe")
        self.git("config", "user.email", "probe@example.invalid")
        (self.repo / "seed.txt").write_text("baseline\n")
        self.git("add", ".")
        self.git("commit", "-m", "Fixture baseline")
        self.initial = self.git("rev-parse", "HEAD")
        self.spec = self.root / "DEMO-1.md"
        self.spec.write_text("Implement a greeting in app.txt.\n")
        self.config = {
            "version": 1, "commit_authorized": True, "delivery": "local",
            "quality": {"implementation_skills": [], "review_rubrics": [], "required_checks": []},
            "tickets": [{"id": "DEMO-1", "spec": str(self.spec), "blocked_by": [],
                         "paths": ["app.txt"], "checks": [self.check("unit")]}],
            "final_checks": [self.check("integration")],
        }

    def check(self, name, code=None):
        return {"name": name, "argv": [sys.executable, "-c", code or
                "from pathlib import Path; assert Path('app.txt').read_text() == 'hello'"]}

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, stderr=subprocess.DEVNULL).decode().strip()

    def cli(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(RUNNER), "--state", str(self.state), *args],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0 if ok else 1, result.stdout + result.stderr)
        return json.loads(result.stdout or result.stderr)

    def init(self):
        self.manifest.write_text(json.dumps(self.config))
        return self.cli("init", "--repo", str(self.repo), "--branch", "codex/prototype",
                        "--manifest", str(self.manifest), "--owner", "implementer")

    def implement(self):
        self.init()
        self.cli("next")
        self.preflight()
        (self.repo / "app.txt").write_text("hello")

    def plan_report(self, **updates):
        context = self.cli("context")
        report = {key: context[key] for key in ("ticket", "base", "tree", "quality_fingerprint")}
        report.update(approach="Implement the fixture behavior and verify observable output.",
                      boundary_assessment="Standalone fixture, no project boundary changes.",
                      boundaries=[], reuse_assessment="No existing implementation to adapt.", reuse=[], checks=[])
        report.update(updates)
        path = self.root / "plan.json"
        path.write_text(json.dumps(report))
        return path

    def challenge_report(self, **updates):
        packet = self.cli("challenge-packet")
        report = {key: packet[key] for key in ("ticket", "base", "tree", "quality_fingerprint", "plan_digest")}
        report.update(reviewer="independent-probe", selection_basis="Synthetic fixture requirement: exact output.",
                      cases=[{"id": "output", "invariant": "Exact required output",
                              "setup": "Read the newly created file", "expected": "Its content equals the specified value",
                              "check": packet["required_checks"][0]["name"]}], checks=[])
        report.update(updates)
        path = self.root / "challenge.json"
        path.write_text(json.dumps(report))
        return path

    def preflight(self):
        if self.cli("context")["outcome"] == "plan":
            self.cli("plan", str(self.plan_report()))
        if self.cli("context")["outcome"] == "challenge":
            self.cli("challenge", str(self.challenge_report()))

    def review(self, packet=None, reviewer="independent-probe", verdict="pass", findings=None):
        self.work()
        packet = self.cli("packet")
        report = self.root / "review.json"
        report.write_text(json.dumps({key: packet[key] for key in ("ticket", "base", "tree")} |
                                     {"reviewer": reviewer, "verdict": verdict,
                                      "findings": findings or [], "summary": "Synthetic protocol evidence only"}))
        content = json.loads(report.read_text())
        content.update(quality_fingerprint=packet["quality_fingerprint"],
                       rubrics_applied=[item["id"] for item in packet["quality"]["review_rubrics"]])
        content.update({key: packet[key] for key in ("plan_digest", "challenge_digest", "work_digest", "checks_digest")})
        content["assessments"] = [{"obligation": item["id"], "check": item["check"],
                                   "verdict": "satisfied", "evidence": "Synthetic protocol assertion inspected."}
                                  for item in packet["obligations"]]
        report.write_text(json.dumps(content))
        return report

    def work(self):
        context = self.cli("context")
        report = self.root / "work.json"
        report.write_text(json.dumps({
            "ticket": context["ticket"], "tree": context["tree"],
            "quality_fingerprint": context["quality_fingerprint"],
            "skills_used": [item["id"] for item in context["quality"]["implementation_skills"]],
            "plan_digest": context["plan_digest"], "challenge_digest": context["challenge_digest"],
            "behavior_evidence": [{"obligation": item["id"], "check": item["check"],
                                   "evidence": "Declared command asserts the fixture's observable output."}
                                  for item in context["obligations"]],
            "summary": "Added fixture behavior.", "acceptance_evidence": "See declared assertion command.",
        }))
        return self.cli("work", str(report))

    def ready(self):
        self.implement()
        self.cli("check", "unit")
        self.cli("review", str(self.review()))


class RunnerTests(RunnerFixture):
    def test_three_dependent_tickets_commit_in_order(self):
        for number in (2, 3):
            spec = self.root / f"DEMO-{number}.md"
            spec.write_text(f"Add part {number}")
            self.config["tickets"].append({
                "id": f"DEMO-{number}", "spec": str(spec), "blocked_by": [f"DEMO-{number-1}"],
                "paths": [f"part{number}.txt"], "checks": [self.check("unit",
                    f"from pathlib import Path; assert Path('part{number}.txt').read_text() == 'part{number}'")],
            })
        self.config["tickets"].reverse()
        self.config["final_checks"] = [self.check("integration",
            "from pathlib import Path; assert [Path(p).read_text() for p in ['app.txt','part2.txt','part3.txt']] == ['hello','part2','part3']")]
        self.init()
        bases = []
        for number in (1, 2, 3):
            decision = self.cli("next")
            self.assertEqual(decision["ticket"], f"DEMO-{number}")
            bases.append(decision["base"])
            self.preflight()
            name, value = ("app.txt", "hello") if number == 1 else (f"part{number}.txt", f"part{number}")
            (self.repo / name).write_text(value)
            self.cli("check", "unit")
            packet = self.cli("packet")
            self.assertEqual(packet["paths"], [name])
            self.cli("review", str(self.review(packet)))
            self.cli("commit", "--message", f"DEMO-{number}: Add part")
        self.assertEqual(len(set(bases)), 3)
        self.assertEqual(self.git("rev-list", "--count", self.initial + "..HEAD"), "3")
        self.assertEqual(self.cli("next")["outcome"], "integration_required")
        self.cli("finish", ok=False)
        self.cli("check", "integration", "--final")
        self.assertEqual(self.cli("finish")["outcome"], "complete")

    def test_untracked_staged_unstaged_deleted_and_renamed_snapshot(self):
        self.config["tickets"][0]["paths"] = ["seed.txt", ":new file.txt", "renamed.txt"]
        self.init()
        self.cli("next")
        self.preflight()
        self.git("mv", "seed.txt", "renamed.txt")
        (self.repo / "renamed.txt").write_text("staged")
        self.git("add", "renamed.txt")
        (self.repo / "renamed.txt").write_text("unstaged plus staged")
        (self.repo / ":new file.txt").write_text("untracked")
        before_index = self.git("write-tree")
        packet = self.cli("packet")
        self.assertEqual(set(packet["paths"]), {"seed.txt", "renamed.txt", ":new file.txt"})
        self.assertIn("unstaged plus staged", Path(packet["patch"]).read_text())
        self.assertIn("untracked", Path(packet["patch"]).read_text())
        self.assertEqual(before_index, self.git("write-tree"))

    def test_staged_only_code_is_reviewed(self):
        self.implement()
        self.git("add", "app.txt")
        self.assertEqual(self.git("diff"), "")
        self.assertEqual(self.cli("packet")["paths"], ["app.txt"])

    def test_missing_gate_never_commits_or_finishes(self):
        self.implement()
        self.cli("commit", "--message", "DEMO-1: Add greeting", ok=False)
        self.cli("check", "unit")
        self.work()
        self.assertEqual(self.cli("status")["outcome"], "review")
        self.cli("finish", ok=False)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.initial)

    def test_fix_invalidates_review_and_checks(self):
        self.ready()
        old_report = self.review()
        (self.repo / "app.txt").write_text("wrong")
        self.assertEqual(self.cli("next")["outcome"], "document")
        self.cli("review", str(old_report), ok=False)
        self.cli("check", "unit", ok=False)
        self.cli("commit", "--message", "DEMO-1: Add greeting", ok=False)

    def test_reviewer_must_not_be_author(self):
        self.implement()
        self.cli("review", str(self.review(reviewer="implementer")), ok=False)

    def test_unresolved_review_findings_block_commit(self):
        self.implement()
        self.cli("check", "unit")
        report = self.review(verdict="changes_required", findings=[{"issue": "Missing boundary check"}])
        self.cli("review", str(report))
        self.cli("commit", "--message", "DEMO-1: Add greeting", ok=False)

    def test_capacity_block_retains_gate_and_requires_no_new_agents(self):
        self.implement()
        self.cli("check", "unit")
        self.work()
        self.cli("block", "--reason", "No reviewer capacity", "--recovery", "One read-only reviewer available")
        for _ in range(3):
            state = self.cli("next")
            self.assertEqual(state["outcome"], "review")
            self.assertEqual(state["blocker"]["reason"], "No reviewer capacity")
        self.cli("review", str(self.review()))
        self.assertEqual(self.cli("next")["outcome"], "commit")

    def test_clean_entry_and_owned_paths(self):
        (self.repo / "unrelated.txt").write_text("user work")
        self.manifest.write_text(json.dumps(self.config))
        self.cli("init", "--repo", str(self.repo), "--branch", "codex/prototype",
                 "--manifest", str(self.manifest), "--owner", "implementer", ok=False)
        (self.repo / "unrelated.txt").unlink()
        self.init()
        self.cli("next")
        (self.repo / "unrelated.txt").write_text("user work")
        self.cli("packet", ok=False)
        self.assertEqual((self.repo / "unrelated.txt").read_text(), "user work")
        self.assertEqual(self.git("diff", "--cached"), "")

    def test_resume_after_commit_before_state_write(self):
        self.ready()
        decision = self.cli("status")
        state = json.loads(self.state.read_text())
        record = state["tickets"]["DEMO-1"]
        record.update(phase="committing", intent={"tree": decision["tree"], "message": "DEMO-1: Add greeting"})
        self.state.write_text(json.dumps(state))
        self.git("add", "app.txt")
        self.git("commit", "-m", "DEMO-1: Add greeting")
        head = self.git("rev-parse", "HEAD")
        self.assertEqual(self.cli("next")["outcome"], "integration_required")
        self.assertEqual(json.loads(self.state.read_text())["tickets"]["DEMO-1"]["commit"], head)
        self.cli("next")
        self.assertEqual(self.git("rev-list", "--count", self.initial + "..HEAD"), "1")

    def test_spec_and_manifest_changes_are_not_silent(self):
        self.implement()
        self.spec.write_text("Different acceptance criteria")
        self.cli("status", ok=False)
        self.spec.write_text("Implement a greeting in app.txt.\n")
        self.manifest.write_text(self.manifest.read_text() + "\n")
        self.cli("status", ok=False)

    def test_unknown_or_cyclic_dependencies_rejected(self):
        self.config["tickets"][0]["blocked_by"] = ["DEMO-2"]
        self.manifest.write_text(json.dumps(self.config))
        self.cli("init", "--repo", str(self.repo), "--branch", "codex/prototype",
                 "--manifest", str(self.manifest), "--owner", "implementer", ok=False)
        self.config["tickets"][0]["blocked_by"] = ["DEMO-1"]
        self.manifest.write_text(json.dumps(self.config))
        self.cli("init", "--repo", str(self.repo), "--branch", "codex/prototype",
                 "--manifest", str(self.manifest), "--owner", "implementer", ok=False)

    def test_external_commit_stops_resume(self):
        self.implement()
        self.git("commit", "--allow-empty", "-m", "Unrelated commit")
        self.cli("next", ok=False)

    def test_check_cache_and_source_mutation(self):
        self.implement()
        self.cli("check", "unit")
        self.assertTrue(self.cli("check", "unit")["cached"])
        self.assertNotIn("cached", self.cli("check", "unit", "--rerun"))
        (self.repo / "app.txt").write_text("changed")
        self.cli("check", "unit", ok=False)

    def test_mutating_check_cannot_pass(self):
        self.config["tickets"][0]["checks"] = [self.check("unit", "from pathlib import Path; Path('app.txt').write_text('changed')")]
        self.implement()
        result = self.cli("check", "unit", ok=False)
        self.assertEqual(result["exit_code"], -1)

    def test_check_timeout_recorded_as_failure(self):
        self.config["tickets"][0]["checks"] = [self.check("unit", "import time; time.sleep(20)") | {"timeout": 1}]
        self.implement()
        self.assertEqual(self.cli("check", "unit", ok=False)["exit_code"], 124)

    def test_hook_modified_commit_does_not_complete_ticket(self):
        self.ready()
        hook = self.repo / ".git/hooks/pre-commit"
        hook.write_text("#!/bin/sh\nprintf changed > app.txt\ngit add app.txt\n")
        hook.chmod(0o755)
        self.cli("commit", "--message", "DEMO-1: Add greeting", ok=False)
        self.cli("next", ok=False)
        self.assertEqual(json.loads(self.state.read_text())["tickets"]["DEMO-1"]["phase"], "committing")

    def test_epic_pr_cannot_degrade_to_local_completion(self):
        self.config.update(delivery="epic-pr", pr_base="main")
        self.ready()
        self.cli("commit", "--message", "DEMO-1: Add greeting")
        self.cli("check", "integration", "--final")
        self.cli("finish", ok=False)
        self.assertFalse(json.loads(self.state.read_text())["complete"])

    def test_multiline_commit_message_file(self):
        self.ready()
        message = self.root / "message.txt"
        body = "DEMO-1: Add greeting\n\nExplain the boundary and verification."
        message.write_text(body + "\n")
        self.cli("commit", "--message-file", str(message))
        self.assertEqual(self.git("show", "-s", "--format=%B", "HEAD"), body)
        self.assertEqual(self.cli("next")["outcome"], "integration_required")

    def test_failed_final_rerun_revokes_completion(self):
        marker = self.root / "external-condition"
        marker.touch()
        self.config["final_checks"] = [self.check("integration",
            f"from pathlib import Path; assert Path({str(marker)!r}).exists()")]
        self.ready()
        self.cli("commit", "--message", "DEMO-1: Add greeting")
        self.cli("check", "integration", "--final")
        self.cli("finish")
        marker.unlink()
        self.cli("check", "integration", "--final", "--rerun", ok=False)
        self.assertEqual(self.cli("next")["outcome"], "integration_required")
        self.cli("finish", ok=False)

    def test_cancelling_check_stops_its_process_and_preserves_pending_gate(self):
        marker = self.root / "check-pid"
        code = f"import os,time; from pathlib import Path; Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(20)"
        self.config["tickets"][0]["checks"] = [self.check("unit", code)]
        self.implement()
        process = subprocess.Popen([sys.executable, str(RUNNER), "--state", str(self.state), "check", "unit"],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            for _ in range(100):
                if marker.exists():
                    break
                time.sleep(0.02)
            self.assertTrue(marker.exists())
            process.send_signal(signal.SIGTERM)
            process.communicate(timeout=5)
            self.assertEqual(process.returncode, 1)
            with self.assertRaises(ProcessLookupError):
                os.kill(int(marker.read_text()), 0)
            self.assertEqual(self.cli("next")["outcome"], "document")
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()


if __name__ == "__main__":
    unittest.main()
