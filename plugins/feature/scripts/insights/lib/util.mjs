// The small helpers the insights modules share: ordering, sums, ISO times and
// counted maps. Pure; nothing here knows a digest's or a ticket's shape.
//
// Private to the implementation: only insights.mjs is a command.

/** Ascending order for strings or numbers, the `sort` comparator every list here uses. */
export const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const sum = (values) => values.reduce((total, value) => total + value, 0);

/** Epoch milliseconds of an ISO time; NaN for anything that is not a string or does not parse. */
export const msOf = (iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);

/** Add `by` to `key`'s count in the Map `counts`. */
export function countInto(counts, key, by = 1) {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

/** A Map as a plain object, its keys in ascending order. */
export const sortedObject = (map) => Object.fromEntries([...map].sort(([a], [b]) => compare(a, b)));
