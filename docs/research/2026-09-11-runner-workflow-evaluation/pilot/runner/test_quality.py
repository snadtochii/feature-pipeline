"""Observable quality gates, using synthetic receipts rather than model review claims."""

import json

from test_runner import RunnerFixture


class QualityTests(RunnerFixture):
    def policy_file(self, name):
        path = self.root / (name + ".md")
        path.write_text("Apply the consuming project's " + name + " rules.\n")
        return {"id": name, "path": str(path)}

    def test_policy_must_be_explicit(self):
        self.config.pop("quality")
        self.manifest.write_text(json.dumps(self.config))
        result = self.cli("init", "--repo", str(self.repo), "--branch", "codex/prototype",
                          "--manifest", str(self.manifest), "--owner", "implementer", ok=False)
        self.assertIn("Declare quality", result["reason"])
        self.assertFalse(self.state.exists())

    def test_missing_required_skill_fails_before_entry(self):
        self.config["quality"]["implementation_skills"] = [{"id": "missing", "path": "missing.md"}]
        self.manifest.write_text(json.dumps(self.config))
        self.cli("init", "--repo", str(self.repo), "--branch", "codex/prototype",
                 "--manifest", str(self.manifest), "--owner", "implementer", ok=False)
        self.assertFalse(self.state.exists())

    def test_project_checks_cannot_be_omitted_by_ticket(self):
        self.config["quality"]["required_checks"] = [self.check("project", "raise SystemExit(1)")]
        self.implement()
        self.cli("check", "unit")
        self.cli("review", str(self.review()))
        self.assertEqual(self.cli("status")["missing_checks"], ["project"])
        self.cli("check", "project", ok=False)
        self.cli("commit", "--message", "DEMO-1: Add greeting", ok=False)

    def test_each_implementation_skill_requires_a_receipt(self):
        self.config["quality"]["implementation_skills"] = [self.policy_file("project-tdd")]
        self.implement()
        self.work()
        report = self.root / "work.json"
        value = json.loads(report.read_text())
        value["skills_used"] = []
        report.write_text(json.dumps(value))
        self.cli("work", str(report), ok=False)

    def test_reviewer_must_account_for_all_rubrics(self):
        self.config["quality"]["review_rubrics"] = [self.policy_file("project-design")]
        self.implement()
        report = self.review()
        value = json.loads(report.read_text())
        self.assertEqual(set(value["rubrics_applied"]), {"runner-baseline", "project-design"})
        value["rubrics_applied"] = ["runner-baseline"]
        report.write_text(json.dumps(value))
        self.cli("review", str(report), ok=False)

    def test_quality_document_edits_invalidate_the_run(self):
        rubric = self.policy_file("design")
        self.config["quality"]["review_rubrics"] = [rubric]
        self.ready()
        from pathlib import Path
        Path(rubric["path"]).write_text("Changed acceptance policy")
        self.cli("commit", "--message", "DEMO-1: Add greeting", ok=False)

    def test_work_report_is_required_even_with_tests_and_review(self):
        self.ready()
        state = json.loads(self.state.read_text())
        state["tickets"]["DEMO-1"].pop("work")
        self.state.write_text(json.dumps(state))
        self.assertEqual(self.cli("status")["outcome"], "document")
        self.cli("commit", "--message", "DEMO-1: Add greeting", ok=False)

    def test_ticket_additions_cannot_remove_global_policy(self):
        self.config["quality"]["implementation_skills"] = [self.policy_file("global")]
        self.config["tickets"][0]["quality"] = {"implementation_skills": [self.policy_file("local")]}
        self.implement()
        context = self.cli("context")
        self.assertEqual([item["id"] for item in context["quality"]["implementation_skills"]], ["global", "local"])
