"""Filesystem ticket import/publication against a separate consuming Git repository."""

import json
from pathlib import Path
from unittest.mock import patch

import feature_adapter
from feature_yaml import document
from test_runner import RunnerFixture


class FeatureFixture(RunnerFixture):
    def setUp(self):
        super().setUp()
        (self.repo / ".gitignore").write_text("claudedocs/tickets/\n")
        self.git("add", ".gitignore")
        self.git("commit", "-m", "Ignore local ticket bookkeeping")
        self.ticket_root = self.repo / "claudedocs/tickets"
        self.epic = self.ticket_root / "backlog/DEMO-10"
        self.epic.mkdir(parents=True)
        (self.epic / "prd.md").write_text("---\nid: DEMO-10\ntitle: 'A: small epic'\nkind: epic\nstatus: backlog\nchildren:\n  - DEMO-2\n  - DEMO-1\ncreated: 2026-09-09\n---\n\n## Cross-cutting Constraints\nAlways preserve Unicode.\n")
        (self.epic / "exploration.md").write_text("Use the existing fixture patterns.\n")
        for number in (1, 2):
            child = self.epic / "tasks" / f"DEMO-{number}"
            child.mkdir(parents=True)
            dependency = "[DEMO-1]" if number == 2 else "[]"
            (child / "01-spec.md").write_text(f"---\nid: DEMO-{number}\nparent: DEMO-10\ntitle: >-\n  Child {number}\nstatus: backlog # initial state\nblocked_by: {dependency}\n---\n\n## Acceptance Criteria\n- [ ] Add {'app.txt' if number == 1 else 'part2.txt'}.\n")
        (self.epic / "tasks/DEMO-1/02-plan.md").write_text("Existing implementation plan.\n")
        self.profile = self.root / "profile.json"
        self.profile_value = {
            "version": 1, "commit_authorized": True, "delivery": "local",
            "quality": self.config["quality"],
            "tickets": {
                "DEMO-1": {"paths": ["app.txt"], "checks": [self.check("unit")]},
                "DEMO-2": {"paths": ["part2.txt"], "checks": [self.check("unit",
                    "from pathlib import Path; assert Path('part2.txt').read_text() == 'second'")]},
            },
            "final_checks": [self.check("integration",
                "from pathlib import Path; assert Path('app.txt').read_text() == 'hello'; assert Path('part2.txt').read_text() == 'second'")],
        }

    def import_feature(self, ok=True):
        self.profile.write_text(json.dumps(self.profile_value))
        return self.cli("import-feature", "--repo", str(self.repo), "--ticket", "DEMO-10",
                        "--profile", str(self.profile), ok=ok)

    def start(self):
        result = self.import_feature()
        self.cli("init", "--repo", str(self.repo), "--branch", "codex/prototype",
                 "--manifest", result["manifest"], "--owner", "implementer")
        self.cli("next")
        self.preflight()
        return self.cli("context")

    def complete_ticket(self, number):
        decision = self.cli("next")
        self.assertEqual(decision["ticket"], f"DEMO-{number}")
        self.preflight()
        name, content = ("app.txt", "hello") if number == 1 else ("part2.txt", "second")
        (self.repo / name).write_text(content)
        self.work()
        self.cli("check", "unit")
        self.cli("review", str(self.review()))
        self.cli("commit", "--message", f"DEMO-{number}: Add behavior")


class FeatureTests(FeatureFixture):
    def test_epic_context_order_artifacts_and_final_status(self):
        decision = self.start()
        kinds = {item["kind"] for item in decision["context"]}
        self.assertEqual(kinds, {"parent-prd", "shared-exploration", "existing-plan"})
        self.assertIn("Always preserve Unicode", Path(next(i["path"] for i in decision["context"] if i["kind"] == "parent-prd")).read_text())
        active = self.ticket_root / "in-progress/DEMO-10"
        self.assertFalse(self.epic.exists())
        self.assertEqual(document(active / "tasks/DEMO-1/01-spec.md")[1]["status"], "in-progress")
        self.complete_ticket(1)
        self.assertEqual(document(active / "tasks/DEMO-1/01-spec.md")[1]["status"], "done")
        self.assertEqual(document(active / "tasks/DEMO-2/01-spec.md")[1]["status"], "backlog")
        next_ticket = self.cli("next")
        self.assertEqual(next_ticket["predecessors"][0]["commit"], self.git("rev-parse", "HEAD"))
        self.assertTrue(next_ticket["predecessors"][0]["artifacts"])
        self.complete_ticket(2)
        self.assertTrue(active.exists())
        self.assertEqual(document(active / "tasks/DEMO-2/01-spec.md")[1]["status"], "in-progress")
        self.cli("finish", ok=False)
        self.cli("check", "integration", "--final")
        self.cli("finish")
        done = self.ticket_root / "done/DEMO-10"
        self.assertTrue(done.exists())
        self.assertEqual(document(done / "prd.md")[1]["title"], "A: small epic")
        for number in (1, 2):
            child = done / "tasks" / f"DEMO-{number}"
            self.assertEqual(document(child / "01-spec.md")[1]["status"], "done")
            self.assertEqual(document(child / "01-spec.md")[1]["title"], f"Child {number}")
            self.assertTrue(all((child / name).exists() for name in feature_adapter.ARTIFACTS))
            self.assertTrue((child / "06-summary.md").read_text().startswith("verdict: pass\n"))
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertNotIn("claudedocs", self.git("show", "--stat", "HEAD"))

    def test_missing_declared_child_blocks_import_without_mutating_tickets(self):
        (self.epic / "tasks/DEMO-2/01-spec.md").unlink()
        self.import_feature(ok=False)
        self.assertFalse(self.state.exists())
        self.assertEqual(document(self.epic / "prd.md")[1]["status"], "backlog")

    def test_duplicate_yaml_keys_do_not_silently_change_roster(self):
        path = self.epic / "prd.md"
        path.write_text(path.read_text().replace("kind: epic", "kind: epic\nchildren: [DEMO-1]"))
        self.import_feature(ok=False)
        self.assertFalse((self.state.parent / "inputs").exists())

    def test_parent_or_status_edits_block_before_next_mutation(self):
        self.start()
        path = self.ticket_root / "in-progress/DEMO-10/prd.md"
        original = path.read_text()
        path.write_text(original.replace("Always preserve Unicode", "Changed shared constraint"))
        self.cli("next", ok=False)
        path.write_text(original.replace("status: in-progress", "status: cancelled"))
        self.cli("next", ok=False)
        self.assertEqual(document(path)[1]["status"], "cancelled")

    def test_user_artifact_edit_is_preserved(self):
        self.start()
        (self.repo / "app.txt").write_text("hello")
        self.work()
        path = self.ticket_root / "in-progress/DEMO-10/tasks/DEMO-1/03-implementation.md"
        path.write_text("User's added evidence\n")
        self.cli("sync-feature", ok=False)
        self.assertEqual(path.read_text(), "User's added evidence\n")

    def test_requested_pr_keeps_all_children_pending_delivery(self):
        self.profile_value.update(delivery="epic-pr", pr_base="main")
        self.start()
        self.complete_ticket(1)
        self.complete_ticket(2)
        self.cli("check", "integration", "--final")
        self.cli("finish", ok=False)
        folder = self.ticket_root / "in-progress/DEMO-10"
        self.assertTrue(folder.exists())
        for number in (1, 2):
            child = folder / "tasks" / f"DEMO-{number}"
            self.assertEqual(document(child / "01-spec.md")[1]["status"], "in-progress")
            self.assertTrue((child / "06-summary.md").read_text().startswith("verdict: partial"))

    def test_publication_replays_after_folder_move_and_interrupted_write(self):
        self.start()
        self.complete_ticket(1)
        self.complete_ticket(2)
        self.cli("check", "integration", "--final")
        state = json.loads(self.state.read_text())
        state["complete"] = True
        self.state.write_text(json.dumps(state))
        original = feature_adapter.atomic_text

        def interrupt(path, content):
            if path.name == "06-summary.md":
                raise OSError("Injected publication interruption")
            original(path, content)

        with patch.object(feature_adapter, "atomic_text", side_effect=interrupt):
            with self.assertRaises(OSError):
                feature_adapter.sync(state)
        self.assertTrue((self.ticket_root / "done/DEMO-10").exists())
        self.assertEqual(self.cli("sync-feature")["outcome"], "complete")
        self.cli("sync-feature")
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_server_mode_and_tracked_tickets_are_rejected(self):
        config = self.ticket_root / "config.yaml"
        config.write_text("mode: server-native\nproject: example\n")
        self.import_feature(ok=False)
        config.unlink()
        self.git("add", "-f", "claudedocs/tickets/backlog/DEMO-10/prd.md")
        self.import_feature(ok=False)

    def test_conflicting_no_commit_configuration_is_rejected(self):
        (self.ticket_root / "config.yaml").write_text("git:\n  commit: never\n")
        self.import_feature(ok=False)

    def test_old_done_dependency_requires_ancestry_evidence(self):
        path = self.epic / "tasks/DEMO-1/01-spec.md"
        path.write_text(path.read_text().replace("status: backlog", "status: done"))
        self.profile_value["tickets"].pop("DEMO-1")
        self.import_feature(ok=False)
        self.profile_value["completed"] = {"DEMO-1": self.git("rev-parse", "HEAD")}
        decision = self.start()
        self.assertEqual(decision["ticket"], "DEMO-2")
        self.assertEqual(decision["predecessors"], [])
        self.assertIn("predecessor-spec", {i["kind"] for i in decision["context"]})
