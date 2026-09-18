from copy import deepcopy


class Unavailable(Exception):
    pass


class Conflict(Exception):
    pass


class CatalogStore:
    def __init__(self, rows):
        self.rows = {row['id']: deepcopy(row) for row in rows}

    def get(self, owner, key):
        row = self.rows.get(key)
        if row is None or row['owner'] != owner:
            raise Unavailable('Record unavailable')
        return deepcopy(row)

    def _prepare_rename(self, owner, key, label, expected_revision):
        row = self.get(owner, key)
        if row['revision'] != expected_revision:
            raise Conflict('Revision changed')
        if not isinstance(label, str) or not label.strip():
            raise ValueError('Nonempty label required')
        row.update(label=label, revision=row['revision'] + 1)
        return row

    def rename(self, owner, key, label, expected_revision):
        row = self._prepare_rename(owner, key, label, expected_revision)
        self.rows[key] = row
        return deepcopy(row)

    def rename_many(self, owner, edits):
        if not isinstance(edits, list) or not edits:
            raise ValueError('Nonempty edit list required')
        staged = {}
        for edit in edits:
            key = edit['id']
            if key in staged:
                raise ValueError('Duplicate record ID')
            staged[key] = self._prepare_rename(
                owner, key, edit['label'], edit['expected_revision']
            )
        results = deepcopy(list(staged.values()))
        self.rows.update(staged)
        return results


class CatalogService:
    def __init__(self, store):
        self.store = store
        self.cache = {}

    def get(self, owner, key):
        cache_key = (owner, key)
        if cache_key not in self.cache:
            self.cache[cache_key] = self.store.get(owner, key)
        return deepcopy(self.cache[cache_key])

    def rename(self, owner, key, label, expected_revision):
        result = self.store.rename(owner, key, label, expected_revision)
        self.cache.pop((owner, key), None)
        return result

    def rename_many(self, owner, edits):
        results = self.store.rename_many(owner, edits)
        for row in results:
            self.cache.pop((owner, row['id']), None)
        return results
