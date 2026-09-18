"""Additional lifecycle boundaries; GitHub replies are explicit offline fixtures."""

import json
import os
import sys
from unittest.mock import patch

from feature_yaml import document
from test_feature_adapter import FeatureFixture


class DeliveryTests(FeatureFixture):
    def test_solo_ticket_keeps_its_spec_and_moves_after_integration(self):
        child = self.epic / "tasks/DEMO-1"
        solo = self.ticket_root / "backlog/DEMO-1"
        child.rename(solo)
        spec = solo / "01-spec.md"
        spec.write_text(spec.read_text().replace("parent: DEMO-10\n", ""))
        import shutil
        shutil.rmtree(self.epic)
        self.profile_value["tickets"].pop("DEMO-2")
        self.profile_value["final_checks"] = [self.check("integration")]
        self.profile.write_text(json.dumps(self.profile_value))
        result = self.cli("import-feature", "--repo", str(self.repo), "--ticket", "DEMO-1", "--profile", str(self.profile))
        self.cli("init", "--repo", str(self.repo), "--branch", "codex/prototype",
                 "--manifest", result["manifest"], "--owner", "implementer")
        self.complete_ticket(1)
        self.assertTrue((self.ticket_root / "in-progress/DEMO-1").exists())
        self.cli("check", "integration", "--final")
        self.cli("finish")
        self.assertEqual(document(self.ticket_root / "done/DEMO-1/01-spec.md")[1]["status"], "done")
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_verified_epic_pr_publishes_shared_url_and_never_done(self):
        self.profile_value.update(delivery="epic-pr", pr_base="main")
        self.start()
        self.complete_ticket(1)
        self.complete_ticket(2)
        self.cli("check", "integration", "--final")
        fake_bin = self.root / "bin"
        fake_bin.mkdir()
        reply = self.root / "gh-reply.json"
        metadata = {"url": "https://github.com/fixture/example/pull/7", "state": "OPEN",
                    "headRefOid": "wrong-head", "headRefName": "codex/prototype",
                    "baseRefName": "main", "isCrossRepository": False}
        reply.write_text(json.dumps(metadata))
        gh = fake_bin / "gh"
        gh.write_text(f"#!{sys.executable}\nimport sys\nfrom pathlib import Path\n"
                      "if sys.argv[1:3] == ['repo', 'view']:\n"
                      "    print('{\"url\": \"https://github.com/fixture/example\"}')\n"
                      "else:\n"
                      f"    print(Path({str(reply)!r}).read_text())\n")
        gh.chmod(0o755)
        with patch.dict(os.environ, {"PATH": str(fake_bin) + os.pathsep + os.environ["PATH"]}):
            self.cli("finish", "--pr-url", metadata["url"], ok=False)
            self.assertFalse((self.ticket_root / "review/DEMO-10").exists())
            metadata["headRefOid"] = self.git("rev-parse", "HEAD")
            reply.write_text(json.dumps(metadata))
            self.cli("finish", "--pr-url", metadata["url"])
        review = self.ticket_root / "review/DEMO-10"
        self.assertEqual(document(review / "prd.md")[1]["status"], "in-review")
        for number in (1, 2):
            child = review / "tasks" / f"DEMO-{number}"
            self.assertEqual(document(child / "01-spec.md")[1]["status"], "in-review")
            self.assertIn(metadata["url"], (child / "06-summary.md").read_text())
        self.assertFalse((self.ticket_root / "done/DEMO-10").exists())

    def test_final_rerun_failure_demotes_previously_complete_epic(self):
        marker = self.root / "environment-ready"
        marker.touch()
        self.profile_value["final_checks"] = [self.check("integration",
            f"from pathlib import Path; assert Path({str(marker)!r}).exists()")]
        self.start()
        self.complete_ticket(1)
        self.complete_ticket(2)
        self.cli("check", "integration", "--final")
        self.cli("finish")
        self.assertTrue((self.ticket_root / "done/DEMO-10").exists())
        marker.unlink()
        self.cli("check", "integration", "--final", "--rerun", ok=False)
        pending = self.ticket_root / "in-progress/DEMO-10"
        self.assertTrue(pending.exists())
        self.assertEqual(document(pending / "prd.md")[1]["status"], "in-progress")
        self.cli("finish", ok=False)

    def test_partial_ignore_rules_fail_before_import(self):
        (self.repo / ".gitignore").write_text("\n".join(
            "claudedocs/tickets/**/" + name for name in
            ("01-spec.md", "prd.md", "02-plan.md", "exploration.md", "06-summary.md")) + "\n")
        self.git("add", ".gitignore")
        self.git("commit", "-m", "Fixture partial ignore rules")
        self.import_feature(ok=False)
        self.assertTrue(self.epic.exists())

    def test_symlink_state_destination_fails_before_import(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.ticket_root / "review").symlink_to(outside, target_is_directory=True)
        self.import_feature(ok=False)
        self.assertEqual(list(outside.iterdir()), [])

    def test_empty_optional_configuration_uses_filesystem_defaults(self):
        (self.ticket_root / "config.yaml").write_text("# No project overrides\n")
        self.assertEqual(self.import_feature()["outcome"], "imported")

    def test_open_review_parent_requires_reconciliation(self):
        path = self.epic / "prd.md"
        path.write_text(path.read_text().replace("status: backlog", "status: in-review"))
        self.import_feature(ok=False)
        self.assertEqual(document(path)[1]["status"], "in-review")

    def test_pending_sibling_status_comment_is_untouched(self):
        sibling = self.epic / "tasks/DEMO-2/01-spec.md"
        original = sibling.read_text()
        self.start()
        sibling = self.ticket_root / "in-progress/DEMO-10/tasks/DEMO-2/01-spec.md"
        self.assertEqual(sibling.read_text(), original)
