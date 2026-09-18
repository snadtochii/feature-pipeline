from copy import deepcopy
import unittest

from catalog import CatalogService, CatalogStore, Conflict, Unavailable


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.store = CatalogStore([
            {'id': 'a', 'owner': 'alice', 'label': 'A', 'revision': 1, 'tags': ['a']},
            {'id': 'b', 'owner': 'alice', 'label': 'B', 'revision': 3, 'tags': ['b']},
            {'id': 'c', 'owner': 'alice', 'label': 'C', 'revision': 2, 'tags': ['c']},
            {'id': 'd', 'owner': 'bob', 'label': 'D', 'revision': 7, 'tags': ['d']},
        ])
        self.service = CatalogService(self.store)
        self.snapshots = {
            (row['owner'], row['id']): self.service.get(row['owner'], row['id'])
            for row in self.store.rows.values()
        }

    def assert_rejected_unchanged(self, operation, error, message):
        rows_before = deepcopy(self.store.rows)
        cache_before = deepcopy(self.service.cache)
        cache_entries = dict(self.service.cache)
        snapshots_before = deepcopy(self.snapshots)
        with self.assertRaises(error) as caught:
            operation()
        self.assertEqual(str(caught.exception), message)
        self.assertEqual(self.store.rows, rows_before)
        self.assertEqual(self.service.cache, cache_before)
        self.assertEqual(self.snapshots, snapshots_before)
        for key, entry in cache_entries.items():
            self.assertIs(self.service.cache[key], entry)
            self.assertEqual(self.service.get(*key), cache_before[key])

    def test_rename_refreshes_detached_cached_read(self):
        service = CatalogService(CatalogStore([{'id': 'a', 'owner': 'alice', 'label': 'Before', 'revision': 1}]))
        old = service.get('alice', 'a')
        service.rename('alice', 'a', 'After', 1)
        self.assertEqual(service.get('alice', 'a')['label'], 'After')
        self.assertEqual(old['label'], 'Before')
        with self.assertRaises(Unavailable):
            service.get('bob', 'a')

    def test_batch_success_order_cache_and_nested_detachment(self):
        unrelated = {key: self.service.cache[key] for key in [('alice', 'c'), ('bob', 'd')]}
        rows_before = deepcopy(self.store.rows)
        edits = [
            {'id': 'b', 'label': ' B changed ', 'expected_revision': 3},
            {'id': 'a', 'label': 'A changed', 'expected_revision': 1},
        ]
        results = self.service.rename_many('alice', edits)
        expected = [
            dict(rows_before['b'], label=' B changed ', revision=4),
            dict(rows_before['a'], label='A changed', revision=2),
        ]
        self.assertEqual(results, expected)
        for result in expected:
            self.assertEqual(self.store.get('alice', result['id']), result)
            self.assertEqual(self.service.get('alice', result['id']), result)
        for key, entry in unrelated.items():
            self.assertIs(self.service.cache[key], entry)
            self.assertEqual(entry, rows_before[key[1]])
            self.assertEqual(self.store.rows[key[1]], rows_before[key[1]])
        for key, old in self.snapshots.items():
            self.assertEqual(old, rows_before[key[1]])
        results[0]['label'] = 'caller mutation'
        results[0]['tags'].append('caller mutation')
        read = self.service.get('alice', 'a')
        read['label'] = 'read mutation'
        read['tags'].append('read mutation')
        self.snapshots[('alice', 'b')]['tags'].append('old snapshot mutation')
        for result in expected:
            self.assertEqual(self.store.get('alice', result['id']), result)
            self.assertEqual(self.service.get('alice', result['id']), result)
        self.assertEqual(results[1], expected[1])

    def test_late_batch_rejection_is_atomic(self):
        bad_edits = [
            ({'id': 'b', 'label': 'changed', 'expected_revision': 2}, Conflict, 'Revision changed'),
            ({'id': 'absent', 'label': 'changed', 'expected_revision': 1}, Unavailable, 'Record unavailable'),
            ({'id': 'd', 'label': 'changed', 'expected_revision': 7}, Unavailable, 'Record unavailable'),
            ({'id': 'a', 'label': 'again', 'expected_revision': 1}, ValueError, 'Duplicate record ID'),
        ]
        for label in ['', ' \t\n', None, 12, ['label']]:
            bad_edits.append((
                {'id': 'b', 'label': label, 'expected_revision': 3},
                ValueError, 'Nonempty label required',
            ))
        for edit, error, message in bad_edits:
            with self.subTest(edit=edit):
                edits = [{'id': 'a', 'label': 'first valid', 'expected_revision': 1}, edit]
                self.assert_rejected_unchanged(
                    lambda: self.service.rename_many('alice', edits), error, message,
                )

    def test_batch_foreign_and_absent_have_identical_public_error(self):
        for key in ['d', 'absent']:
            with self.subTest(key=key):
                self.assert_rejected_unchanged(
                    lambda: self.service.rename_many('alice', [
                        {'id': key, 'label': 'changed', 'expected_revision': 7},
                    ]), Unavailable, 'Record unavailable',
                )

    def test_invalid_batch_containers_leave_rows_and_cache_unchanged(self):
        edit = {'id': 'a', 'label': 'changed', 'expected_revision': 1}
        for edits in [[], None, edit, (edit,), 'edits']:
            with self.subTest(edits=edits):
                self.assert_rejected_unchanged(
                    lambda: self.service.rename_many('alice', edits),
                    ValueError, 'Nonempty edit list required',
                )

    def test_single_rename_contract_before_and_after_batch(self):
        for revision in [1, 3]:
            with self.subTest(revision=revision):
                for key, label, expected_revision, error, message in [
                    ('a', 'stale', revision - 1, Conflict, 'Revision changed'),
                    ('a', '', revision - 1, Conflict, 'Revision changed'),
                    ('a', ' \t', revision, ValueError, 'Nonempty label required'),
                    ('d', 'foreign', 7, Unavailable, 'Record unavailable'),
                    ('absent', 'missing', 1, Unavailable, 'Record unavailable'),
                ]:
                    self.assert_rejected_unchanged(
                        lambda: self.service.rename('alice', key, label, expected_revision),
                        error, message,
                    )
                result = self.service.rename('alice', 'a', ' single ', revision)
                self.assertEqual(result['label'], ' single ')
                self.assertEqual(result['revision'], revision + 1)
                self.assertEqual(self.service.get('alice', 'a'), result)
                result['label'] = 'caller mutation'
                result['tags'].append('caller mutation')
                self.assertEqual(self.service.get('alice', 'a')['label'], ' single ')
                self.assertEqual(self.store.get('alice', 'a')['tags'], ['a'])
                if revision == 1:
                    self.service.rename_many('alice', [
                        {'id': 'a', 'label': 'batch', 'expected_revision': 2},
                        {'id': 'b', 'label': 'batch B', 'expected_revision': 3},
                    ])
                    self.assertEqual(self.service.get('alice', 'a')['revision'], 3)
