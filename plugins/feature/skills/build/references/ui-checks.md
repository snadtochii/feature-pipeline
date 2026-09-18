# Required UI Checks

This contract is injected into every `ui-tester` spawn prompt — by `close-stage/SKILL.md`'s test checkpoint and by ship's end-of-run pass ([`../../ship/references/ui-verification.md`](../../ship/references/ui-verification.md)) — under a `## Required UI checks (use this exactly)` header. The `ui-tester` agent body points at the injected block and must not duplicate it. The brief that carries this block also names the run's evidence home — the one directory every capture below is written into.

These checks are part of every browser pass, on top of the ticket's acceptance criteria. They are required, and their failures affect the verdict exactly like a failed acceptance criterion.

## 1. Required states

For every form and dialog the pass exercises, trigger and capture:

- **Validation error** — submit with invalid input, and submit empty.
- **Submitting / disabled** — any control disabled until its input is valid, and the state while a submit is in flight. A submit that completes too fast to capture is an observation, not a failed check.
- **Empty** — where the screen has one (a list, table or panel with no data).

Loading states are not required.

A screen with no form or dialog still gets the viewport checks in §2. A state the screen has but the pass cannot trigger (a dialog that will not open, a submit that cannot be forced to fail) is a failed check with the reason — never a silent skip.

## 2. Viewports

- **Desktop**: 1280×800. **Mobile**: 390×844.
- Set each with the resize tool of the browser the session drives: `mcp__playwright__browser_resize` for a Playwright session, `mcp__chrome-devtools__resize_page` for an attached DevTools tab.
- Every acceptance-criterion screenshot and every state screenshot from §1 is captured at both widths.
- A resize that is unavailable (the tool is not exposed in this session) or fails is a failed check under the UI-states criterion, with the reason. Never record a width as "not verified".

## 3. Capture

- Write every screenshot to an explicit path inside the evidence home named in the brief — the `filename` parameter for Playwright, `filePath` for DevTools. Never rely on the tool's default output directory.
- Take full-page screenshots. When a screenshot suggests clipping or truncation, confirm it with an accessibility snapshot, read inline and never saved to a file.
- Detect layout shift by comparing the same viewport before and after the error message appears.
- Names — fixed, so a rerun overwrites the earlier capture:
  - Acceptance criteria: `<AC-n>-desktop.png`, `<AC-n>-mobile.png`.
  - States: `<screen-slug>-<error|empty|disabled>-<desktop|mobile>.png`.
  - A pass that covers more than one ticket in one evidence home (an epic) prefixes every name with the ticket ID: `<ticket-id>-<AC-n>-desktop.png`, so each child's AC 1 keeps its own file.
- A screenshot that cannot be written is a failed check with the reason.

## 4. Severity rule

**Findings** — severity MAJOR or higher, verdict-affecting, never downgraded:

- overflow or horizontal scroll;
- overlapping or clipped controls;
- an unreadable or truncated label;
- layout shift when an error message appears.

**Observations** — reported, never verdict-affecting:

- a wrapped heading;
- a spacing preference;
- any other aesthetic judgment.

A defect on the findings list stays a finding. It is never reported as a polish note or an observation.

## 5. Reporting

- Each finding is a bug report with category `layout` or `error-state`, listed under `## Failed Criteria` against the spec's UI-states acceptance criterion. When the spec has no such criterion, list it against the implicit criterion **UI states (required check)**.
- Every failed check from §1–§3 (untriggerable state, unavailable resize, unwritable screenshot) is listed the same way, with its reason.
- Observations go in a separate `## Observations` section, which never affects the verdict.
- Name the evidence home and the screenshot filenames in the report.
