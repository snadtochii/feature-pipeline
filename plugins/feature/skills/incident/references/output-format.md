# Incident Report Format

The shape of the one report an incident run produces: its file name, the signature that lets a later run recognise the same failure, its sections, the rules for quoting evidence, and the summary that ends the run. Referenced by `incident/SKILL.md` steps 8–10.

## §1 File name

`<project-root>/claudedocs/incidents/<stamp>-<rule-slug>.md`

- `<stamp>` is the `stamp` the script's `preflight` reported — the run's UTC time as `yyyyMMdd-HHmmss` ([log-query.md](log-query.md) §5). It is never composed by hand.
- `<rule-slug>` is the rule's identity — its UID when the runbook section labels one, else its name (`incident/SKILL.md` step 4) — lowercased, every run of characters outside `[a-z0-9]` replaced by one `-`, leading and trailing `-` removed, cut to 40 characters. A value that leaves nothing gives `alert`.
- A run writes one report. A file of that name already present is left as it is: the new report takes the suffix `-2`, then `-3`, before `.md`. The names already present are the ones step 9's search over the reports lists.

## §2 Signature

One line, at the start of a line, directly under the report's title:

```
Signature: <service> | <rule> | <normalized message> | <top code location>
```

- **`<service>`** — the service's key under `incident.services`.
- **`<rule>`** — the rule's identity: its UID when the runbook section labels one (`incident/SKILL.md` step 4), else its name as the runbook writes it.
- **`<normalized message>`** — the describing line's message text (below), and its error text when it carries one, as `<message>: <error text>`, with every variable part replaced so that two occurrences of one failure read the same. Normalize each part on its own, in this order: a quoted value (`"…"` or `'…'`) becomes `*`; a UUID becomes `*`; a hexadecimal string of 8 or more characters becomes `*`; a number becomes `*`. Then collapse whitespace, replace each `|` with `/` so the four fields stay separable, and cut the message to 120 characters and the error text to 120. An error text that is empty after this adds nothing, so the field never ends in `: `. With no failing line, the field is `no failing line`.
- **`<top code location>`** — the file where the failure arises, as a path relative to the service's repository, with the function's name when one is identifiable: `<path>:<function>`. No line number, since lines move between revisions. With no code location, the field is `unknown`.

**The describing line.** The rule often matches a request log whose message is fixed text, the same for every request, so a signature built from it would give every failure on any route one message. The describing line is, among the correlated lines of the earliest failing request (`incident/SKILL.md` step 5, pass 2), other than the lines the rule matched, the earliest that carries an error: its labels give `detected_level`, `level`, `severity` or `severity_text` as `error`, `fatal` or `critical`, in any case, or carry a non-empty `error`, `err`, `exception` or `exception_message`. With no such line, it is the earliest line the rule matched. Its **error text** is the first non-empty value among its `error`, `err`, `exception` and `exception_message` labels, in that order; a line with none of them carries no error text.

Two failures that share a message and differ in their error text have different signatures:

```
Signature: orders | orders-5xx | refund cancel failed: decode response: invalid character * | src/refunds/cancel.go:Cancel
Signature: orders | orders-5xx | refund cancel failed: context deadline exceeded | src/refunds/cancel.go:Cancel
```

**Match rule.** Two signatures name the same failure when their service, rule and normalized message are equal. The code location strengthens a match; a different or `unknown` location does not break one.

## §3 Sections

The report holds these sections, in this order. A section with nothing to say keeps its heading and reads `none`, except Runbook correction, which is present only when the runbook was wrong or silent.

```markdown
# Incident — <rule> — <service>

Signature: <service> | <rule> | <normalized message> | <top code location>

- Rule: <rule name><, UID <uid> when known>
- Service: <service> — repository `<repo>`
- Window: <start> – <end> UTC<; still firing, the end is the run's time><; the request gave no zone, read as UTC><; the request gave <its words for the time>, read against the run's time <now>>
- Trigger: webhook payload | manual request
- Code revision: <HEAD commit | unknown> — the repository's working tree as it stood, not verified against the deployed revision<, or: confirmed by a log line naming it>
- Not investigated: <the payload's other service and rule groups, and its truncated-alert count | none>
- Sensitive: this file quotes production log lines and may hold real values. Keep it out of version control and share it on purpose.

## Diagnosis

- Classification: known runbook case — <case> | new failure | noise | not classified — not reproduced in the window
- Stored data: may be affected | not affected | unknown — <what decides it>

<What failed, where and why, in a few sentences.>

## Evidence

### Logs

<The describing line with its timestamp and its error text — or, when no correlated line carries an error, the sentence "The signature is built from the rule-matched line: no correlated line carries an error."; the other lines the diagnosis rests on, each with its timestamp; the request IDs followed, and the failing requests whose own error line differs from the describing line; what the history query showed, which counts the message whatever its error text. A partial result is named as partial.>

### Code

- `<path>:<line>` — <what that code does to produce the failure>

## Unverified

- <statement> — <why it could not be verified>

## Earlier reports and tickets

- <report file | ticket ID, title, status> — <how it relates: same signature, possible regression, cancelled without delivering>

## Manual checks

- <something only the owner can confirm or do: a dashboard to read, a record to inspect, a runbook action>

## Proposed fix

<What to change and where. Text only — the run changes no code.>

## Ticket draft

Title: <one line>

<Description, and acceptance criteria as a list. Text for the owner to file; the run creates no ticket.>

## Runbook correction

<What the rule's section says or omits, and the text that would correct it.>
```

## §4 Evidence rules

- **Quote the minimum.** Quote the fewest log lines that carry the diagnosis, and cut each to the part that matters. A query's whole result is never pasted.
- **Redact what looks secret or personal.** In a quoted line, a value that reads as a token, password, key, cookie or authorization header, or as a person's contact or payment detail, is replaced with `[redacted]`. The diagnosis never depends on such a value.
- **Name the code.** Every statement about code names a file and a line. A statement with no location belongs under Unverified.
- **Say what is partial.** A query that returned its limit or left lines out for size, a query that failed, and a pass that did not run are each named where their evidence would have stood.
- **Lookups are stated either way.** Earlier reports and tickets reads `none found` when a lookup ran and matched nothing, and `ticket lookup not run: <reason>` when it could not run.

## §5 Summary

The run's last output, in this order:

```
Incident summary
- rule: <rule> | service: <service>
- window: <start> – <end> UTC
- classification: <classification>
- runbook case: <case | none>
- stored data: <may be affected | not affected | unknown>
- earlier reports: <files | none found> | tickets: <IDs | none found | lookup not run>
- queries: <n> run, <n> failed, <n> truncated
- unverified: <n> statement(s)
- not investigated: <groups | none>
- report: <path> | not written — <report.reason>; the full report is above
```
