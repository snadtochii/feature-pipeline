# Baseline quality review

Apply this rubric and every additional rubric in the packet. Read the child spec,
parent PRD, shared exploration, project guidance, and predecessor context listed
there. Parent constraints apply even when the child does not repeat them.

For every acceptance criterion, identify the implementation and executed evidence
that cover it. Distinguish source inspection from a command actually run. Flag
missing cases, weak assertions, unsupported skips, and tests that duplicate the
implementation without checking observable behavior. A command's successful exit
alone does not establish acceptance. Evaluate feature-level integration as well
as the ticket's local behavior where this change affects it.

Check that the change follows repository conventions and existing abstractions.
Look for duplicated business rules, unnecessary wrappers, oversized interfaces,
unclear ownership, excessive conditionals, and error paths callers cannot handle.
Propose a simpler design when it solves a concrete maintenance or correctness
problem; avoid speculative generalization and style-only churn.

Trace relevant boundary cases: invalid/empty inputs, failures, concurrency,
cancellation, retries, resource lifetime, and compatibility with prior tickets.
For trust boundaries inspect authorization, validation, secrets and data exposure.
For expensive paths inspect query count, I/O, unbounded work and resource growth.
For UI changes inspect accessibility and the required current-build browser proof.

Report actionable findings with location, triggering case, impact, and correction.
Return pass only when no actionable findings remain and every applicable criterion
and selected rubric has been considered. Record limitations and context reuse.
The implementation report is evidence to verify, not authority for your verdict.

For touched project laws, inspect the recorded design decision, actual prior user
authorization for exceptions, and the falsification check. For reused/adapted
behavior compare invariants with the predecessor implementation and tests.
Assess every independently selected case against its actual assertions and logs,
including relevant cross-feature interactions. Read plan/case revisions for
unjustified weakening. A report declaration establishes accountability, not truth.
