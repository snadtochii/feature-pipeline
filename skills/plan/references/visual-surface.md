# Visual plan surface (`--visual`)

How `plan` renders the canonical `02-plan.md` into `02-plan.html` — a self-contained, opt-in **human review surface** — and folds the human's review back into the Markdown.

**Invariants (do not violate):**
- `02-plan.md` is the source of truth and the only plan artifact `build` reads. `02-plan.html` is a **derived view that no stage ever reads back**.
- The HTML is **self-contained**: one file, opened directly in a browser, **no build step, no install**. Libraries load from a CDN at view time; everything degrades gracefully when the CDN is unreachable.
- This is only invoked when `--visual` is set. With the flag absent, none of this runs and plan behaves exactly as before.

---

## When to render

Only when `--visual` is set, and only **after `02-plan.md` has been written** (the HTML is derived from the file, never the other way around). Applies to both design modes — see `SKILL.md` Phase 2 for the per-mode insertion points.

The render is opinionated about visual density (borrow from `nicobailon/visual-explainer`): a list with **4+ rows or 3+ columns** earns a real table or diagram, not an ASCII block. A flow with branches earns a Mermaid diagram. Prose stays prose.

---

## Section → component mapping

`02-plan.md` has a fixed section order; render each into the matching component:

| `02-plan.md` section | Component in `02-plan.html` |
|---|---|
| Architecture Decision | A short prose summary **plus** a Mermaid diagram of the chosen approach (data/flow/layers) |
| Implementation Steps | One **step card** each: goal, files (as a file-change map), pattern-to-follow, edge cases |
| Implementation Steps → all `Files:` entries | A consolidated **file-change map** (tree or table) showing every create/modify across the plan |
| Open Questions Resolved | One **open-question card** each: question, resolution, `auto-resolved`/user-answered badge |
| Architecture Decision → trade-offs / any "Option A vs B" | **Side-by-side** two-column comparison (the "risky trade-offs" surface) |
| Build Sequence | The phased **checklist**, rendered as grouped checkboxes |
| Critical Details | **Callout** blocks (error / state / testing / perf / security) |

MVP scope: the components above only. **Not** in MVP — interactive editable prototypes, pan/zoom wireframes, Chart.js data-viz, slide decks. Keep them out unless a later ticket adds them.

---

## Aesthetic constraints

Opinionated and restrained — avoid the "AI slop" neon-dashboard look:
- One constrained palette. Default "blueprint/editorial": near-white background (`#fbfbf9`), ink text (`#1a1a1a`), one accent (`#2F6B4F`, the plugin brand color), muted borders (`#e2e2dd`), monospace (`ui-monospace, SFMono-Regular, Menlo, monospace`) for code/paths, system sans for body.
- Severity/category colors are muted, not saturated: use the accent + greys; reserve a single warm tone for "risky"/CRITICAL.
- Generous whitespace, a sticky table-of-contents for multi-section navigation, max content width ~960px.
- No tracking scripts, no external assets beyond the CDN libs + (optionally) Google Fonts.

---

## Self-contained HTML skeleton

Generate one file shaped like this (fill the `<!-- … -->` placeholders from `02-plan.md`). Everything is inline; the only network dependency is the Mermaid ESM module, loaded with graceful degradation.

**Escape everything you interpolate (mandatory).** Plan content is full of `<`, `>`, and `&` — `<ticket-folder>`, `<PREFIX>-<N>`, TypeScript generics, shell redirects, `-->`. HTML-entity-escape every value pulled from `02-plan.md` before inserting it: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, and in attribute contexts `"` → `&quot;` / `'` → `&#39;`. Neutralize `</script>` and `</pre>` sequences specifically. This applies to card/table/callout text **and to the Mermaid source** inside the `<pre class="mermaid">` block (the browser decodes the entities back to `<`/`>` in `textContent` before Mermaid parses it, so escaping is safe and necessary — otherwise a node label like `A[<state>]` corrupts the diagram). Unescaped content is both a rendering-corruption bug (the pipeline's own `<…>` tokens vanish from the page) and, via the user-pasted fold-back input, a script-injection vector into a file you open in your browser.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plan — <!-- TICKET-ID: title --></title>
<style>
  :root { --bg:#fbfbf9; --ink:#1a1a1a; --muted:#6b6b66; --line:#e2e2dd; --accent:#2F6B4F; --warn:#9a5b2f; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { display:grid; grid-template-columns:220px minmax(0,960px); gap:32px;
          max-width:1240px; margin:0 auto; padding:32px; }
  nav.toc { position:sticky; top:24px; align-self:start; font-size:14px; }
  nav.toc a { display:block; color:var(--muted); text-decoration:none; padding:2px 0; }
  nav.toc a:hover { color:var(--accent); }
  h1 { font-size:26px; margin:0 0 4px; }
  h2 { font-size:19px; margin:32px 0 12px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:0.9em; }
  .card { border:1px solid var(--line); border-radius:8px; padding:16px; margin:12px 0; background:#fff; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  .badge { display:inline-block; font-size:12px; padding:1px 8px; border-radius:999px;
           border:1px solid var(--line); color:var(--muted); }
  .callout { border-left:3px solid var(--accent); padding:8px 14px; margin:10px 0; background:#fff; }
  .callout.warn { border-left-color:var(--warn); }
  .mermaid-fallback { border:1px dashed var(--line); padding:12px; background:#fff; overflow:auto; }
</style>
</head>
<body>
<div class="wrap">
  <nav class="toc"><!-- anchor links to each section --></nav>
  <main>
    <h1><!-- TICKET-ID: title --></h1>
    <p class="mono"><!-- complexity · priority · file-count --></p>

    <h2 id="architecture">Architecture Decision</h2>
    <!-- prose summary -->
    <pre class="mermaid mermaid-fallback"><!-- mermaid source; shown as text if Mermaid never loads -->
flowchart TD
  A[ ... ] --> B[ ... ]
    </pre>

    <h2 id="files">File-change map</h2>
    <table><!-- one row per created/modified file across all steps: path | create|modify | step --></table>

    <h2 id="steps">Implementation Steps</h2>
    <!-- one .card per step: goal / files / pattern / edge cases -->

    <h2 id="open-questions">Open Questions Resolved</h2>
    <!-- one .card per question; <span class="badge">auto-resolved</span> or "user answer" -->

    <h2 id="tradeoffs">Trade-offs</h2>
    <div class="grid2"><!-- chosen vs alternative, or what-we-gain vs what-we-give-up --></div>

    <h2 id="sequence">Build Sequence</h2>
    <!-- phased checklist -->

    <h2 id="critical">Critical Details</h2>
    <!-- .callout per: error handling / state / testing / perf / security; .callout.warn for risks -->
  </main>
</div>

<!-- Mermaid via the documented ESM build, pinned to an exact version. The dynamic import in a
     try/catch gives graceful degradation: if the fetch fails (offline / blocked), the .mermaid
     blocks keep showing their raw source via .mermaid-fallback styling and the page stays readable. -->
<script type="module">
  try {
    const { default: mermaid } =
      await import('https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs');
    mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
    await mermaid.run({ querySelector: '.mermaid' });
  } catch (e) {
    /* offline or CDN unavailable: .mermaid blocks remain readable as <pre> source */
  }
</script>
</body>
</html>
```

Notes:
- Mermaid v11's documented CDN entry is the **ESM** build (`mermaid.esm.min.mjs`); load it via `<script type="module">` with a dynamic `import()`. A **remote** HTTPS module import works from `file://` because jsDelivr sends CORS headers — the `file://` module restriction only affects *local relative* imports, not CORS-enabled remote ones. (The older `dist/mermaid.min.js` UMD build does not expose a `window.mermaid` global, so a classic-script `onload="mermaid.initialize(...)"` throws — use the ESM build, not the UMD one.)
- Pin an **exact** version (here `@11.16.0`), never a floating `@11` tag — for reproducibility and to shrink supply-chain drift.
- The `.mermaid` blocks carry their (escaped) source as text content; if Mermaid renders, it replaces them; if the import fails, the `catch` leaves them legible as preformatted text. Never put plan content **only** inside a JS-rendered widget — every section must be readable with scripts disabled.
- **Supply-chain note:** the page loads a third-party module from a CDN into a context holding your plan content. The exact-version pin is the baseline mitigation and the content-escaping rule above is the primary injection defense. The artifact is local and gitignored (never committed — see below), so the blast radius is a disposable locally-opened file. For higher-assurance environments, self-host the Mermaid module or use an import-map `integrity` hash; full Subresource Integrity isn't attached inline because a dynamic ESM `import()` can't carry an `integrity` attribute.

---

## gitignore guard (before writing `02-plan.html`)

The HTML is a throwaway surface and must never be swept into a PR. Before writing it:

1. Run `git check-ignore -q <ticket-folder>/02-plan.html`.
2. If it exits non-zero (path is **not** ignored), append a line to the project-root `.gitignore`:
   ```
   claudedocs/tickets/**/*.html
   ```
   and note the addition in the Presentation output.
3. If it exits 0 (already ignored — e.g. the whole `claudedocs/` is ignored, as in this plugin repo), proceed without touching `.gitignore`.

This mirrors the `ui-tester` / `debug` `git check-ignore`-before-write precedent for runtime-state files. (Build's `--pr` staging in `references/pr-creation.md` also excludes the entire `claudedocs/` tree, so this guard is a second line of defense, not the only one.)

---

## Conversational fold-back loop (the review gate)

After `02-plan.html` is generated, **verify it before presenting**: every structured section rendered, all interpolated content escaped, and the page readable with scripts disabled (graceful degradation). Then it is the review gate — run this loop:

1. Tell the user where the file is and to open it in a browser:
   > Visual plan written to `<ticket-folder>/02-plan.html` — open it in your browser to review. Paste any changes here, or add `-> note` marks against the plan and tell me to fold them in. Say "looks good" to proceed.
2. The human reviews in the browser and responds **conversationally** — pasted edits, or `-> note <change>` lines keyed to a section/step (the marks live in chat or in `02-plan.md`, **never** require parsing the rendered HTML).
3. For each requested change, edit the corresponding section of **`02-plan.md`** (the source of truth).
4. After applying edits, append/update a `## Review decisions` section at the end of `02-plan.md` summarizing what changed and why (the audit trail). Describe changes in plain terms — do **not** write the literal token `02-plan.html` or "HTML" into `02-plan.md`, since build's UI-test skip-scan substring-matches `html` against the plan and would otherwise spuriously spawn a browser checkpoint on a non-UI ticket.
5. **Regenerate `02-plan.html`** from the updated `02-plan.md` so the surface never diverges from the source in-session.
6. Repeat until the user approves. Then return control (auto mode → back to flow; interactive mode → exit plan stage).

Never reverse-parse the HTML back into Markdown — annotations are human-emitted text that plan reads, not a file diff. (This is what keeps the feature scoped; literal HTML-file annotation diffing is explicitly out of scope.)
