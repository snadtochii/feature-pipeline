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

    def rename(self, owner, key, label, expected_revision):
        row = self.get(owner, key)
        if row['revision'] != expected_revision:
            raise Conflict('Revision changed')
        if not isinstance(label, str) or not label.strip():
            raise ValueError('Nonempty label required')
        row.update(label=label, revision=row['revision'] + 1)
        self.rows[key] = row
        return deepcopy(row)


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
