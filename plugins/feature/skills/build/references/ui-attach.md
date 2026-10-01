# UI Evidence Attachments

Canonical logic for attaching `ui-tester` screenshots to a GitHub pull request with `gh … --attach`: when it is enabled, the capability probe, which captures each destination shows and in what order, the posted-body shape, the command construction and its batches, the fallback order and the pre-upload dedupe. Consumers:

- **`close-stage`** ([`../../close-stage/SKILL.md`](../../close-stage/SKILL.md)) — §1 binding, §3 GitHub set, §4 alt text and path gate, §5 posted bodies, and §6 **Batches** to cut the part bodies, for the PR body its finalizer opens on `--pr` and the part comments that follow it.
- **The `feature:finalizer`**, through [`pr-creation.md`](pr-creation.md) §4 — §2 probe, §6 command and batches, §7 fallback, and §8's read before part comments, when it opens that PR.
- **Ship's end-of-run pass** ([`../../ship/references/ui-verification.md`](../../ship/references/ui-verification.md) step 3) — every section, for its evidence comment.
- **The `05-tests.md` `## Screenshots` section**, written by `close-stage`'s test checkpoint and by ship's end-of-run pass — §3's recognized-name grammar, **Artifact order** and safe-name regex, and §4's alt-text grammar, on every browser pass whether or not attaching is enabled. §3's size filter and its **GitHub set** are upload rules and do not bound that section. The entry shapes it renders stay in each writer's storage file.

Where the evidence home is, and whether a caller has a hosted-link fallback, stay in each caller's storage file for the mode detected at the caller's start.

## When it runs

§1, §2 and §5–§8 — the enablement switches, the capability probe, the posted bodies, the command construction, the fallback order and the dedupe — run only when attaching is enabled (§1) **and** the run produced screenshots. With attaching disabled, nothing in those sections applies: the PR body and the evidence comment are exactly what the caller posts without it. A run with no captures — a skip artifact, `--no-ui-testing`, a repo with no app — attaches nothing and posts no UI-evidence section, enabled or not.

§3's recognized-name grammar, Artifact order and safe-name regex, and §4's alt-text grammar, are independent of that switch: they are cited on every browser pass to order and label the `05-tests.md` `## Screenshots` section, so a run with attaching off still reads them. §3's size filter and its GitHub set stay upload rules, and that section applies neither. §4's **path gate** guards an argv that carries the absolute evidence-home path — it is a precondition for that command line, not for the section, whose entries carry no absolute path.

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

Exit 0 → the flag exists; take the attach tier. Non-zero → skip to the next tier (§7) with reason `gh has no --attach`, and add the upgrade hint to the outcome line (§7). A post that will be followed by part comments (§6 **Batches**) probes `gh pr comment` as well, in the same parallel message; a failing comment probe leaves the post to its own probe's result and reports the parts per §7.

A passing probe does not promise acceptance. gh refuses the attach itself on a GitHub Enterprise Server host, on a token that is not an OAuth token or a personal access token (a GitHub App or Actions `ghs_` token, among others), and for a role below write — each before any upload. §7 handles that refusal.

## §3 Selection

**Input**: the `*.png` files in the evidence home with their byte sizes, from one Bash listing — `wc -c -- "<evidence-home>"/*.png`, which quotes the directory and so has no precondition of its own; §4's path gate is a precondition of the command lines that carry that absolute path as an argv value, never of this listing — plus the failed criteria — `05-tests.md`'s `## Failed Criteria` on the close path, the tester's report on ship's — each with its `**Viewport**` line ([`ui-checks.md`](ui-checks.md) §5). A failed entry without that line counts as `both`.

**Recognized names** — the [`ui-checks.md`](ui-checks.md) §3 grammar, with its optional `<ticket-id>-` epic prefix:

- Acceptance criterion: `[<ticket-id>-]AC-<n>-<desktop|mobile>.png`
- State: `[<ticket-id>-]<screen-slug>-<error|empty|disabled>-<desktop|mobile>.png`

**Filters.** Two filters bound what reaches `--attach`:

1. **Name** — a file whose name does not match `^[A-Za-z0-9-]+\.png$`, or matches neither grammar above, is never part of the GitHub set.
2. **Size** — a GitHub-set file that is empty or larger than 10 MiB (its listed size is `0`, or over `10485760`) keeps its place in the set but is not attached; §5 names it in the body's not-attached line.

**GitHub set** — the curated captures a pull request shows. Tickets in ascending order of the ID's numeric part — a home whose names carry no `<ticket-id>-` prefix is one ticket — and within each ticket:

1. For each acceptance criterion `n`, ascending, failed and passed alike: `AC-<n>-desktop`. Its `AC-<n>-mobile` joins the set only
   - **(a)** directly after the desktop capture, when every failed entry for criterion `n` records `**Viewport**: mobile` — it failed at mobile width and passed at desktop width; or
   - **(b)** in the desktop capture's slot, when the pass produced no `AC-<n>-desktop`.
2. The desktop state captures (`error`, `empty`, `disabled`), by name ascending.

No numeric ceiling applies: the whole set is posted, in §6 batches. An epic's integration-PR post applies the rule per child, children in ticket order; a multi-solo run applies it to each ticket's own post.

**Artifact order** — every capture in the evidence home, for the `05-tests.md` `## Screenshots` section, grouped by viewport under three subheadings in this order:

1. `### Desktop` — acceptance-criterion captures by ticket, then criterion number; then state captures by name.
2. `### Mobile` — the same, at mobile width.
3. `### Other` — every name outside the acceptance-criterion and state grammar above, whatever viewport suffix it carries, unsafe names included, alphabetical.

A group with no entry is omitted, and an empty evidence home is the writer's single no-captures line with no subheading. No count ceiling applies.

An empty evidence home, or one holding no recognized name, selects nothing for GitHub: no UI-evidence section is posted, and the outcome is `none`.

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

Full capture set: <pointer>

![AC-1 desktop](/abs/evidence-home/AC-1-desktop.png)
![AC-2 desktop](/abs/evidence-home/AC-2-desktop.png)
![AC-2 mobile](/abs/evidence-home/AC-2-mobile.png)
![settings error desktop](/abs/evidence-home/settings-error-desktop.png)

Not attached (over 10 MiB or empty): settings-empty-desktop.png
```

- One `Full capture set: <pointer>` line per covered ticket — one on a solo post, one per child in ticket order on an epic's integration-PR post. `<pointer>` is the **Pointer** of the caller's storage file for the detected mode: it names where the full set lives and carries no URL, no absolute path and no count.
- One `![<alt>](<absolute path>)` line per attached file in batch 1 (§6), in §3 GitHub-set order. gh rewrites each reference to the uploaded asset URL, so the absolute path never reaches the posted text.
- One `Not attached (over 10 MiB or empty): <name>, <name>` line when §3's size filter held back a GitHub-set file — bare file names, never a path. No such file, no line.
- `<id>` in the marker is the ticket ID; for ship's epic integration-PR post, the epic ID. The marker is the §8 dedupe key.

The **part body** carries batch `<k>` ≥ 2 of a GitHub set over 50 (§6 **Batches**), as a follow-up comment:

```
## UI evidence (part 2 of 3)
<!-- feature:ui-evidence <id> part 2 -->

![FP-14 AC-3 desktop](/abs/evidence-home/FP-14-AC-3-desktop.png)
```

- `<K>` is the number of batches; the post itself is part 1.
- One image line per file in that batch, in §3 GitHub-set order. The pointer and not-attached lines ride batch 1 only, and a part never repeats a file of an earlier batch.

The **manifest variant** has the same heading and marker, then the pointer line(s), then one line — `Screenshots were not attached; they are local to the run that captured them.` — and the GitHub set's paths relative to the project root as a list, in §3 GitHub-set order. A listed path is not rewritten by gh, so an absolute one would publish the local username and directory layout. It is what a fallback posts, because an attach body posted without `--attach` would leave dangling local image references; it has no part bodies.

## §6 Command construction

Each attached file is one `--attach` argument, its own double-quoted argv item, `"<absolute path>#<alt text>"`. The body goes through `--body-file`, written with the caller's nonce-heredoc discipline ([`../../review/references/pr-comments.md`](../../review/references/pr-comments.md) §5):

```bash
gh pr create --base "<base>" --title "$PR_TITLE" --body-file "<attach-variant body>" \
  --attach "/abs/evidence-home/AC-1-desktop.png#AC-1 desktop" \
  --attach "/abs/evidence-home/AC-1-mobile.png#AC-1 mobile"

gh pr comment "<N>" --body-file "$WORK/comment.md" \
  --attach "/abs/evidence-home/AC-1-desktop.png#AC-1 desktop"
```

**Batches.** gh accepts at most 50 `--attach` files per command. The GitHub set's attachable files are cut, in §3 GitHub-set order, into consecutive batches of at most 50. Batch 1 is the post's own `--attach` list. Each later batch is one part comment — its §5 part body and its own `--attach` list — posted after the post exists, in batch order:

```bash
gh pr comment "<N>" --body-file "<part-2 body>" \
  --attach "/abs/evidence-home/FP-14-AC-3-desktop.png#FP-14 AC-3 desktop"
```

A set of 50 or fewer is one batch and posts no part. No selected capture is dropped for count reasons.

**Injection discipline.** Every character inside an `--attach` value has passed §3's name filter and §4's path gate, and alt text comes from name tokens, so no quote, `$`, backtick or `#` reaches the command line. No tester or model text is ever interpolated into it; `<N>` is a controlled integer, parsed from the PR URL gh printed or read with `gh pr view --json number`; no `eval`. Batches of at most 50 keep every command under gh's 50-file limit.

## §7 Fallback order and outcome

Tiers, in order — each taken only when the one before it cannot run or is refused:

1. **Attach** — §6, after §8's dedupe on a comment post.
2. **Hosted link** — the commit-SHA `?raw=true` embed, only where the caller's storage file says the evidence home is hostable (ship's Tracked outcome). The close path has no such tier.
3. **Path manifest** — the §5 manifest variant, with no `--attach`.

Falling through:

- **Probe fails** (§2) → next tier, reason `gh has no --attach`.
- **Path gate fails** (§4), or the GitHub set leaves nothing attachable → next tier, reason `evidence path not attach-safe` / `no attachable captures`.
- **gh exits non-zero on the attach command** → first reconcile whether the post landed, because gh still creates the PR (or posts the edit) with the uploads that succeeded, prints its URL and exits non-zero when a later upload fails:
  - **Post landed** — `gh pr create` printed a PR URL on stdout, or a PR is now open for the branch (`gh pr view "<branch>" --json url,state`); for a comment post, §8's dedupe read now finds the marker. The post stands: no retry, and the outcome is `attached <k> (partial: <gh's first error line>)`, where `<k>` counts the attached captures the post references.
  - **Nothing posted** → reason `gh refused --attach: <gh's first error line>`, then **one** retry with the next tier.

  The GHES, token-type and role refusals happen before any upload. A failure part-way through the uploads (network) can leave uploaded assets no post references; the outcome notes `uploads may be orphaned`, since an upload cannot be deleted.
- **A part comment fails** (§6 **Batches**: its probe fails, or gh exits non-zero on it) → reconcile with §8's read whether its part marker landed. Landed → it stands. Not landed → the post and the parts already landed stand: the part is never retried and never falls back to a manifest, and the parts after it are not posted. The outcome is `attached <k> (partial: part <p> of <K>: <reason>)`, where `<k>` counts the captures the landed post and parts reference.
- A refused attach never fails the stage or the run, and a retry never re-posts to a PR the failed command already created or commented on.

**Outcome line** — the caller reports exactly one:

```
Screenshots: attached <n> | attached <k> (partial: <reason>) | tracked | manifest (<reason>) | already posted | none
```

`<n>` counts the attached captures this run posted, summed across the post and its parts.

When the reason is `gh has no --attach`, one more line follows: `gh ≥ 2.99.0 adds --attach — upgrade to attach screenshots inline.`

## §8 Dedupe before upload

A post that adds evidence to an existing PR reads the PR first, **before any upload**, because uploads are irreversible:

```bash
if GH_LOGIN=$(gh api user --jq .login) && [ -n "$GH_LOGIN" ] &&
   BODIES=$(GH_LOGIN="$GH_LOGIN" gh pr view "<N>" --json author,body,comments \
     --jq '(if .author.login == env.GH_LOGIN then .body else empty end), (.comments[] | select(.author.login == env.GH_LOGIN) | .body)'); then
  echo DEDUPE_READ_OK
  printf '%s\n' "$BODIES" | grep -oE -- '<!-- feature:ui-evidence <id>( part [0-9]+)? -->' | sort -u
else
  echo DEDUPE_READ_FAILED
fi
```

`<id>` matches `^[A-Za-z0-9-]+$`, so the pattern matches each marker literally. The read prints every marker found, one per line: the main marker `<!-- feature:ui-evidence <id> -->` and each part marker `<!-- feature:ui-evidence <id> part <k> -->`. The main marker is never a substring of a part marker, so the two never collide.

Only a marker authored by the account gh posts as counts — the PR's body when that account opened the PR, and that account's comments. A marker anyone else writes into a comment is ignored, so a third party cannot suppress the evidence post. The login reaches the filter through the environment, never interpolated into it.

- Every marker the post needs is found → post nothing; outcome `already posted` (fresh evidence is not re-posted, and the report says so).
- Some are found → post only the missing ones: a found main marker skips the post itself, a found part marker skips that part. The outcome counts only what this run posted.
- None found → continue to §2.

The dedupe read, the §2 probe and the §3 size listing are read-only and independent, so they go out as parallel calls in one message; their results are acted on only after the marker check, and only the upload waits for it. A probe result holds for the whole run.
- The read itself fails → the attach tier is skipped with reason `dedupe read failed`; the lower tiers upload nothing.

A PR body carries the main marker. Its guard is the finalizer's own idempotency: a finalizer that finds the ticket's PR already open never creates it again, so it never attaches batch 1 again. The part comments that follow it are guarded by this read: the finalizer runs it once after the PR is created or found open, re-entry included, and posts only the parts whose markers are absent.
