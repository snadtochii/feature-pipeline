// One session's agent tree (../CONTRACT.md §5): the root's agent ID, an
// agent's parent and its lineage. Every walk up the tree — recognition's
// ticket and stage inheritance, a run's stage head and plugin versions, and
// friction's skill — goes through `lineage`, so the parent rule is decided
// here alone.
//
// Private to the implementation: only insights.mjs is a command.

export const ROOT_AGENT_ID = 'root';

/**
 * An agent's parent among `byId` (agent ID → agent): none for the root, the
 * root for an agent naming no parent, and none when the parent it names is
 * not in the session.
 */
export function parentOf(agent, byId) {
  if (agent.agent_id === ROOT_AGENT_ID) {
    return null;
  }
  return byId.get(agent.parent_agent_id ?? ROOT_AGENT_ID) ?? null;
}

/**
 * The agent, then its ancestors nearest first. The walk stops at the root,
 * at a parent missing from the session, at a cycle, and after any agent for
 * which `stepsUp` is false.
 */
export function* lineage(agent, byId, stepsUp = () => true) {
  const seen = new Set();
  let cursor = agent;
  while (cursor !== null && !seen.has(cursor.agent_id)) {
    yield cursor;
    seen.add(cursor.agent_id);
    cursor = stepsUp(cursor) ? parentOf(cursor, byId) : null;
  }
}
