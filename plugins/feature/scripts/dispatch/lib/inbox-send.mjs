// The inbox helper a signalled run starts (CONTRACT.md §10, Inbox item).
//
// Reads one JSON request on stdin — `{ access, projectId, runId, body,
// timeoutMs }` — sends the run's inbox item through `sendInbox`, and prints
// `{"notes": [...]}` on stdout. Started only by `sendInboxSync`, with an
// argument vector and no argument of its own; the token never reaches its
// arguments or environment.
//
// Private to the implementation: only dispatch.mjs is a command.

import { sendInbox } from './server.mjs';

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const notes = await sendInbox({
  access: request.access,
  projectId: request.projectId,
  runId: request.runId,
  body: request.body,
  timeoutMs: request.timeoutMs,
});
process.stdout.write(`${JSON.stringify({ notes })}\n`);
