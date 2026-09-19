# UI Evidence Attachments

Canonical logic for attaching `ui-tester` screenshots to a GitHub pull request with `gh … --attach`: when it is enabled, the capability probe, which captures are selected, the posted-body shape, the command construction, the fallback order and the pre-upload dedupe. Consumers:

- **`close-stage`** ([`../../close-stage/SKILL.md`](../../close-stage/SKILL.md)) — §1 binding, §3 selection, §4 alt text and path gate, and §5 posted bodies, for the PR body its finalizer opens on `--pr`.
- **The `feature:finalizer`**, through [`pr-creation.md`](pr-creation.md) §4 — §2 probe, §6 command and §7 fallback, when it opens that PR.
- **Ship's end-of-run pass** ([`../../ship/references/ui-verification.md`](../../ship/references/ui-verification.md) step 3) — every section, for its evidence comment.

Where the evidence home is, and whether a caller has a hosted-link fallback, stay in each caller's storage file for the mode detected at the caller's start.

## When it runs

Only when attaching is enabled (§1) **and** the run produced screenshots. With attaching disabled, nothing in this file applies: the PR body and the evidence comment are exactly what the caller posts without it. A run with no captures — a skip artifact, `--no-ui-testing`, a repo with no app — attaches nothing and posts no UI-evidence section, enabled or not.

## §1 Enablement

Attaching is **off by default**. Two switches turn it on, and neither turns it off:

- **Config** — `git.attach_screenshots: true|false` in `claudedocs/tickets/config.yaml`, default `false`, model-read from the caller's existing copy of the file like the other `git:` keys. Any other value prints `git.attach_screenshots: <value> is not true|false — treating as false.`
- **Flag** — `--attach-screenshots` enables it for one run.

`attach` is bound on when the config is `true` or the flag is passed. A flag passed to a run with nothing to post to — no `--pr` on a close, no `--ui-test` on ship — prints one line, `--attach-screenshots has no effect — <no PR in this run | no --ui-test pass>.`, and the run continues.

Why off: an upload cannot be undone, and an asset uploaded to a public repository is world-readable. On a private repository it renders only for logged-in users with access to the repository. A project opts in knowing what its captures show.

## §2 Capability probe

The probe reads the help text of the exact subcommand the caller will run — never a version-string parse:

```bash
gh pr create --help 2>/dev/null | grep -q -- '--attach'    # the finalizer's PR body
gh pr comment --help 2>/dev/null | grep -q -- '--attach'   # ship's evidence comment
```

Exit 0 → the flag exists; take the attach tier. Non-zero → skip to the next tier (§7) with reason `gh has no --attach`, and add the upgrade hint to the outcome line (§7).

A passing probe does not promise acceptance. gh refuses the attach itself on a GitHub Enterprise Server host, on a token that is not an OAuth token or a personal access token (a GitHub App or Actions `ghs_` token, among others), and for a role below write — each before any upload. §7 handles that refusal.

## §3 Selection

**Input**: the `*.png` files in the evidence home with their byte sizes, from one Bash listing — `wc -c -- "<evidence-home>"/*.png`, issued only after the evidence home has passed §4's path gate — plus the failed criteria — `05-tests.md`'s `## Failed Criteria` on the close path, the tester's report on ship's.

**Recognized names** — the [`ui-checks.md`](ui-checks.md) §3 grammar, with its optional `<ticket-id>-` epic prefix:

- Acceptance criterion: `[<ticket-id>-]AC-<n>-<desktop|mobile>.png`
- State: `[<ticket-id>-]<screen-slug>-<error|empty|disabled>-<desktop|mobile>.png`

**Filters, in order.** A file goes to the overflow list, never to `--attach`, when any of these holds:

1. Its name does not match `^[A-Za-z0-9-]+\.png$` or neither grammar above.
2. It is empty or larger than 10 MiB (its listed size is `0`, or over `10485760`).

**Tiers.** The remaining files are ordered by tier, then by ticket ID, then by criterion number:

1. Captures of failed or partial criteria — desktop, then mobile.
2. One desktop capture per passed criterion.
3. Mobile captures of passed criteria.
4. State captures (`error`, `empty`, `disabled`).

**Ceiling.** The first **15** files are attached. Everything after them joins the overflow list. One post carries one ceiling: an epic's integration-PR post shares its 15 across every child, and a multi-solo run applies 15 to each ticket's own post. There is no second post.

An empty evidence home, or one holding no recognized name, selects nothing: no UI-evidence section is posted, and the outcome is `none`.

## §4 Alt text and the path gate

**Alt text** is built from the file-name tokens alone, never from tester text:

| File | Alt text |
|---|---|
| `AC-3-desktop.png` | `AC-3 desktop` |
| `FP-12-AC-3-mobile.png` | `FP-12 AC-3 mobile` |
| `settings-empty-mobile.png` | `settings empty mobile` |
| `FP-12-settings-error-desktop.png` | `FP-12 settings error desktop` |

Every token is `[A-Za-z0-9-]`, so alt text never contains `#` — the delimiter between path and alt in an `--attach` value.

**Path gate.** Body references and `--attach` values carry the evidence home's **absolute** path: gh matches a reference against the attached file by resolving it from the process working directory, which is the worktree when one is bound ([`worktree.md`](worktree.md) §3). The absolute evidence-home path must match `^/[A-Za-z0-9._/-]+$`. A path with a space, `#`, a quote, `$` or any other character outside that set skips the attach tier with reason `evidence path not attach-safe` — it is neither quoted around nor escaped.

## §5 Posted body

The caller's body text comes first — on the close path, the `06-summary.md` content, with the epic lead line for an epic child — followed by one section. The **attach variant**:

```
## UI evidence
<!-- feature:ui-evidence <id> -->

![AC-1 desktop](/abs/evidence-home/AC-1-desktop.png)
![AC-1 mobile](/abs/evidence-home/AC-1-mobile.png)

<details><summary>+7 more, local only</summary>

- claudedocs/…/screenshots/settings-empty-mobile.png
- ...
</details>
```

- One `![<alt>](<absolute path>)` line per attached file, in §3 order. gh rewrites each reference to the uploaded asset URL, so the absolute path never reaches the posted text.
- The `<details>` block lists the overflow list — over the ceiling, over 10 MiB, empty or unrecognized — with its count, each path relative to the project root. A listed path is not rewritten by gh, so an absolute one would publish the local username and directory layout. No overflow, no block.
- `<id>` in the marker is the ticket ID; for ship's epic integration-PR post, the epic ID. The marker is the §8 dedupe key.

The **manifest variant** has the same heading and marker, then one line — `Screenshots were not attached; they are local to the run that captured them.` — and every capture's path relative to the project root as a list, in §3 order. It is what a fallback posts, because an attach body posted without `--attach` would leave dangling local image references.

## §6 Command construction

Each attached file is one `--attach` argument, its own double-quoted argv item, `"<absolute path>#<alt text>"`. The body goes through `--body-file`, written with the caller's nonce-heredoc discipline ([`../../review/references/pr-comments.md`](../../review/references/pr-comments.md) §5):

```bash
gh pr create --base "<base>" --title "$PR_TITLE" --body-file "<attach-variant body>" \
  --attach "/abs/evidence-home/AC-1-desktop.png#AC-1 desktop" \
  --attach "/abs/evidence-home/AC-1-mobile.png#AC-1 mobile"

gh pr comment "<N>" --body-file "$WORK/comment.md" \
  --attach "/abs/evidence-home/AC-1-desktop.png#AC-1 desktop"
```

**Injection discipline.** Every character inside an `--attach` value has passed §3's name filter and §4's path gate, and alt text comes from name tokens, so no quote, `$`, backtick or `#` reaches the command line. No tester or model text is ever interpolated into it; `<N>` is a controlled integer; no `eval`. The ceiling keeps every command under gh's 50-file limit.

## §7 Fallback order and outcome

Tiers, in order — each taken only when the one before it cannot run or is refused:

1. **Attach** — §6, after §8's dedupe on a comment post.
2. **Hosted link** — the commit-SHA `?raw=true` embed, only where the caller's storage file says the evidence home is hostable (ship's Tracked outcome). The close path has no such tier.
3. **Path manifest** — the §5 manifest variant, with no `--attach`.

Falling through:

- **Probe fails** (§2) → next tier, reason `gh has no --attach`.
- **Path gate fails** (§4), or selection leaves nothing attachable → next tier, reason `evidence path not attach-safe` / `no attachable captures`.
- **gh exits non-zero on the attach command** → first reconcile whether the post landed, because gh still creates the PR (or posts the edit) with the uploads that succeeded, prints its URL and exits non-zero when a later upload fails:
  - **Post landed** — `gh pr create` printed a PR URL on stdout, or a PR is now open for the branch (`gh pr view "<branch>" --json url,state`); for a comment post, §8's dedupe read now finds the marker. The post stands: no retry, and the outcome is `attached <k> (partial: <gh's first error line>)`, where `<k>` counts the attached captures the post references.
  - **Nothing posted** → reason `gh refused --attach: <gh's first error line>`, then **one** retry with the next tier.

  The GHES, token-type and role refusals happen before any upload. A failure part-way through the uploads (network) can leave uploaded assets no post references; the outcome notes `uploads may be orphaned`, since an upload cannot be deleted.
- A refused attach never fails the stage or the run, and a retry never re-posts to a PR the failed command already created or commented on.

**Outcome line** — the caller reports exactly one:

```
Screenshots: attached <n> (+<m> local only) | attached <k> (partial: <reason>) | tracked | manifest (<reason>) | already posted | none
```

When the reason is `gh has no --attach`, one more line follows: `gh ≥ 2.99.0 adds --attach — upgrade to attach screenshots inline.`

## §8 Dedupe before upload

A post that adds evidence to an existing PR reads the PR first, **before any upload**, because uploads are irreversible:

```bash
if GH_LOGIN=$(gh api user --jq .login) && [ -n "$GH_LOGIN" ] &&
   BODIES=$(GH_LOGIN="$GH_LOGIN" gh pr view "<N>" --json author,body,comments \
     --jq '(if .author.login == env.GH_LOGIN then .body else empty end), (.comments[] | select(.author.login == env.GH_LOGIN) | .body)'); then
  printf '%s\n' "$BODIES" | grep -qF '<!-- feature:ui-evidence <id> -->' && echo MARKER_FOUND || echo MARKER_ABSENT
else
  echo DEDUPE_READ_FAILED
fi
```

Only a marker authored by the account gh posts as counts — the PR's body when that account opened the PR, and that account's comments. A marker anyone else writes into a comment is ignored, so a third party cannot suppress the evidence post. The login reaches the filter through the environment, never interpolated into it.

- Marker found → post nothing; outcome `already posted` (fresh evidence is not re-posted, and the report says so).
- Marker absent → continue to §2.

The dedupe read, the §2 probe and the §3 size listing are read-only and independent, so they go out as parallel calls in one message; their results are acted on only after the marker check, and only the upload waits for it. A probe result holds for the whole run.
- The read itself fails → the attach tier is skipped with reason `dedupe read failed`; the lower tiers upload nothing.

A PR body carries the same marker. Its guard is the finalizer's own idempotency: a finalizer that finds the ticket's PR already open never creates it again, so it never attaches again.
