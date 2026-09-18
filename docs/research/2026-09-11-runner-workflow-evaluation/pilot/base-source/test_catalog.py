import unittest
from catalog import CatalogService, CatalogStore, Unavailable


class CatalogTests(unittest.TestCase):
    def test_rename_refreshes_detached_cached_read(self):
        service = CatalogService(CatalogStore([{'id': 'a', 'owner': 'alice', 'label': 'Before', 'revision': 1}]))
        old = service.get('alice', 'a')
        service.rename('alice', 'a', 'After', 1)
        self.assertEqual(service.get('alice', 'a')['label'], 'After')
        self.assertEqual(old['label'], 'Before')
        with self.assertRaises(Unavailable):
            service.get('bob', 'a')
