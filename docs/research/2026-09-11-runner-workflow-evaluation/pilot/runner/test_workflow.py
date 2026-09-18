"""Workflow failure gates and historical failure shapes in disposable repositories."""

import json

from test_runner import RunnerFixture


class WorkflowTests(RunnerFixture):
    def boundary(self, disposition="preserved"):
        return {"id": "scope", "rule": "spec: only the owner may decide a preview",
                "decision": "Preserve owner checks at every operation", "rationale": "A decision changes owner state",
                "alternative": "Relying only on consumption misses denial", "disposition": disposition,
                "surfaced_to_user": "Synthetic visible fixture plan", "reviewer_check": "Foreign preview read and decision leave owner state untouched",
                "check": "unit"}

    def start(self):
        self.init()
        self.assertEqual(self.cli("next")["outcome"], "plan")

    def test_no_retrospective_initial_plan_or_case_selection(self):
        self.start()
        (self.repo / "app.txt").write_text("hello")
        self.cli("plan", str(self.plan_report()), ok=False)
        (self.repo / "app.txt").unlink()
        self.cli("plan", str(self.plan_report()))
        (self.repo / "app.txt").write_text("hello")
        self.cli("challenge", str(self.challenge_report()), ok=False)
        self.cli("check", "unit", ok=False)
        self.cli("commit", "--message", "DEMO-1: Add greeting", ok=False)

    def test_exception_is_visible_and_blocks_until_prior_approval_is_recorded(self):
        self.start()
        boundary = self.boundary("pending_exception")
        result = self.cli("plan", str(self.plan_report(boundaries=[boundary])))
        self.assertEqual(result["outcome"], "decision_required")
        self.assertEqual(result["plan_evidence"]["boundaries"][0]["id"], "scope")
        self.cli("challenge-packet", ok=False)
        self.cli("check", "unit", ok=False)
        boundary["disposition"] = "approved_exception"
        self.cli("plan", str(self.plan_report(boundaries=[boundary], revision_reason="Apply the user's decision")), ok=False)
        boundary["approval_reference"] = "Synthetic prior user decision, not model authorization"
        result = self.cli("plan", str(self.plan_report(boundaries=[boundary], revision_reason="Apply existing scoped approval")))
        self.assertEqual(result["outcome"], "challenge")
        self.cli("challenge", str(self.challenge_report()))
        self.assertEqual(self.cli("next")["outcome"], "implement")

    def test_boundary_requires_falsifiable_check_and_reuse_requires_invariants(self):
        self.start()
        boundary = self.boundary()
        boundary.pop("reviewer_check")
        self.cli("plan", str(self.plan_report(boundaries=[boundary])), ok=False)
        boundary = self.boundary()
        boundary["check"] = "invented"
        self.cli("plan", str(self.plan_report(boundaries=[boundary])), ok=False)
        reuse = {"id": "receipt", "source": "existing command hook", "choice": "adapt",
                 "rationale": "Multi-operation receipt", "reviewer_check": "No post-unmount dispatch", "check": "unit", "invariants": []}
        self.cli("plan", str(self.plan_report(reuse=[reuse])), ok=False)

    def test_failure_cases_must_be_independent_nonempty_and_bound_to_plan(self):
        self.start()
        self.cli("plan", str(self.plan_report()))
        self.cli("challenge", str(self.challenge_report(reviewer="implementer")), ok=False)
        self.cli("challenge", str(self.challenge_report(cases=[])), ok=False)
        self.cli("challenge", str(self.challenge_report(plan_digest="old")), ok=False)
        self.cli("challenge", str(self.challenge_report()))

    def test_missing_behavior_evidence_and_unresolved_assessment_cannot_pass(self):
        self.ready()
        work = self.root / "work.json"
        report = json.loads(work.read_text())
        report["behavior_evidence"] = []
        work.write_text(json.dumps(report))
        self.cli("work", str(work), ok=False)
        review = self.review()
        report = json.loads(review.read_text())
        report["assessments"][0]["verdict"] = "gap"
        review.write_text(json.dumps(report))
        self.cli("review", str(review), ok=False)

    def test_same_tree_work_change_invalidates_old_review(self):
        self.ready()
        review = self.root / "review.json"
        work = self.root / "work.json"
        report = json.loads(work.read_text())
        report["acceptance_evidence"] = "Changed interpretation of acceptance coverage"
        work.write_text(json.dumps(report))
        self.cli("work", str(work))
        self.assertEqual(self.cli("status")["outcome"], "review")
        self.cli("review", str(review), ok=False)
        self.cli("commit", "--message", "DEMO-1: Add greeting", ok=False)

    def test_plan_amendment_revokes_case_selection_and_work_without_losing_history(self):
        self.ready()
        old_review = self.root / "review.json"
        self.cli("plan", str(self.plan_report(boundaries=[self.boundary()])), ok=False)
        self.cli("plan", str(self.plan_report(boundaries=[self.boundary()], revision_reason="Discovered owner decision boundary")))
        self.assertEqual(self.cli("status")["outcome"], "challenge")
        self.cli("check", "unit", ok=False)
        self.cli("review", str(old_review), ok=False)
        self.cli("challenge", str(self.challenge_report(revision_reason="Reassessed the new boundary")))
        self.assertEqual(self.cli("status")["outcome"], "document")
        record = json.loads(self.state.read_text())["tickets"]["DEMO-1"]
        self.assertEqual(len(record["plan_history"]), 1)
        self.assertEqual(len(record["challenge_history"]), 1)
        self.assertEqual(len(self.cli("context")["obligations"]), 2)

    def test_reviewer_added_check_is_required_and_command_change_revokes_cache(self):
        self.start()
        self.cli("plan", str(self.plan_report()))
        case = {"id": "freeze-auth", "invariant": "Authentication precedes recovery state",
                "setup": "Anonymous frozen request", "expected": "No state read before denial", "check": "boundary"}
        self.cli("challenge", str(self.challenge_report(cases=[case], checks=[self.check("boundary")])) )
        (self.repo / "app.txt").write_text("hello")
        self.work()
        self.cli("check", "unit")
        self.cli("review", str(self.review()))
        self.assertEqual(self.cli("status")["missing_checks"], ["boundary"])
        self.cli("check", "boundary")
        self.assertEqual(self.cli("status")["outcome"], "review")
        self.cli("challenge", str(self.challenge_report(cases=[case], checks=[self.check("boundary", "raise SystemExit(1)")], revision_reason="Replace an insufficient assertion")))
        self.assertEqual(self.cli("status")["missing_checks"], ["boundary"])
        self.cli("check", "boundary", ok=False)

    def test_old_states_are_not_silently_migrated(self):
        self.init()
        state = json.loads(self.state.read_text())
        state.pop("workflow_version")
        self.state.write_text(json.dumps(state))
        self.assertIn("original runner", self.cli("next", ok=False)["reason"])

    def test_historical_failure_shapes_need_specific_evidence(self):
        self.start()
        reuse = {"id": "receipt", "source": "existing command hook and lifecycle tests", "choice": "adapt",
                 "rationale": "Different UI with the same dispatch contract", "invariants": ["No dispatch after pre-dispatch unmount"],
                 "reviewer_check": "Deferred registration resolves after unmount without dispatch", "check": "unit"}
        self.cli("plan", str(self.plan_report(boundaries=[self.boundary()], reuse=[reuse])))
        cases = [{"id": name, "invariant": invariant, "setup": setup, "expected": expected, "check": "unit"}
                 for name, invariant, setup, expected in [
                     ("progress", "Cleanup progresses or fails readiness", "Schema-admitted orphan selected repeatedly", "Detect non-progress"),
                     ("auth", "Authenticate before recovery reads", "Frozen anonymous request", "No pre-auth state query"),
                     ("validation", "Invalid input is not uncertain execution", "Missing required confirmation", "Validation response before handler"),
                     ("purge", "Confirmation precedes destructive dispatch", "Open and cancel purge", "Zero calls"),
                 ]]
        self.cli("challenge", str(self.challenge_report(cases=cases)))
        (self.repo / "app.txt").write_text("hello")
        self.work()
        self.cli("check", "unit")
        review = self.review()
        report = json.loads(review.read_text())
        self.assertEqual(len(report["assessments"]), 6)
        report["assessments"] = []
        review.write_text(json.dumps(report))
        self.cli("review", str(review), ok=False)
        self.cli("commit", "--message", "DEMO-1: Add greeting", ok=False)
