# Confidence Scale

This rubric is injected into each reviewer subagent's prompt by `build/SKILL.md` at spawn time — reviewer agent bodies must not duplicate it. Build composes its review-checkpoint prompt with this file's contents under a `## Confidence scale (use this exactly)` header, plus the per-reviewer suffix.

Every potential issue gets a score from 0–100:

| Score | Meaning |
|---|---|
| **0** | False positive — doesn't stand up to scrutiny, or pre-existing |
| **25** | Maybe real, maybe not — stylistic, not in project guidelines |
| **50** | Real issue but a nitpick or rare-in-practice — not very important |
| **75** | Confirmed real — will hit in practice, directly impacts functionality, or cited in project guidelines |
| **100** | Absolutely certain — confirmed, frequent, obviously wrong |

**Only report issues with confidence ≥ 80.** Focus on issues that truly matter.
