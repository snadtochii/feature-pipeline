# Run preflight

Authoritative text for what every `deepen:run` does before its first stage: validate the
profile, take the run lock, put the loop clone on a known commit, re-read the profile, and copy
the readiness tier line. The run skill names the point where this file is loaded; `deepen:setup`
never executes it.

The sections run in order. Each abort names its reason and a remedy. Once §2 has taken the
lock, every abort releases it, and releasing the lock is the abort's last action.

`<CLONE>` is the loop clone: the top level of the directory the run was invoked in. A run
operates in the loop clone and never in the user's own checkout.

---

## §1 Profile validation

1. Bind `<CLONE>` to `git rev-parse --show-toplevel` of the invocation directory.
2. `Read` `<CLONE>/.deepen.yaml`. Absent, or `version` other than `1` → stop:
   `profile: .deepen.yaml — missing or not version 1 in the loop clone — push the committed profile to origin/<base> and fast-forward <CLONE>, or run /deepen:setup`.
3. Evaluate every rule in [profile.md](../../setup/references/profile.md) §4 **in its order**, and
   **stop on the first failure** with that rule's one-line message. The run never repairs the
   profile.
4. Expand `~` in `loop_clone`; it must equal `<CLONE>`. A mismatch stops the run:
   `profile: loop_clone — this run was started outside the loop clone — run from <loop_clone>`.
5. `state_dir` must exist, created by `deepen:setup` with the layout in
   [profile.md](../../setup/references/profile.md) §5. Missing → stop, naming the path and pointing
   at `/deepen:setup`.

Nothing has been taken yet, so a stop in this section releases nothing.

---

## §2 The run lock

```bash
mkdir "$(git -C "<CLONE>" rev-parse --path-format=absolute --git-common-dir)/deepen.lock"
```

`mkdir` is the atomicity: it creates the directory or fails, with no window between the two.
`--path-format=absolute` is load-bearing: `-C` selects the directory git resolves *from*, but
`--git-common-dir` still prints a path relative to it — plain `.git` for a non-linked checkout —
so without it the `mkdir` resolves against the shell's current directory and either fails or
takes a lock inside an unrelated repository. Every worktree of the clone shares one common dir,
so the absolute form also makes the lock cover the clone and all its run worktrees together.

- **Succeeds** → write `<run-id>` and an ISO-8601 timestamp into a file inside the lock
  directory, and **release the lock on every exit path** — a completed run, every abort in this
  file, and every abort a later stage adds.
- **Fails, and the lock is younger than 24 hours** → another run is live. Abort, naming the
  lock's recorded run id, and write nothing.
- **Fails, and the lock is older than 24 hours** → no legitimate run takes a day. Remove it,
  take over, and **say so loudly**: the takeover is the first line of the stage 1 report and a
  line in the evidence pack, naming the stale run id and its timestamp. A stale lock means a
  previous run died, and what it left behind is residue a human should look at.

A lock whose recorded run id or timestamp is missing or unreadable is treated as **live**, not
as stale: the timestamp is what ages a lock, and an unreadable one belongs to a run that died
between `mkdir` and the write, which was moments ago.

---

## §3 Clone position

```bash
git -C "<CLONE>" status --porcelain          # must be empty
git -C "<CLONE>" symbolic-ref --short HEAD   # must equal <base>
git -C "<CLONE>" fetch origin
git -C "<CLONE>" merge --ff-only "origin/<base>"
```

Dirty, on the wrong branch, or unable to fast-forward → abort with the reason and a remedy,
releasing the lock.

**Never reset the clone automatically.** A dirty or diverged loop clone means something wrote to
it by hand, and discarding that silently is a destructive convenience the loop must not have.

Bind `<BASE_SHA>` to the resolved `origin/<base>` commit. Every run worktree forks from it, and
the inventory commit lands on it.

---

## §4 The profile re-read

**If the fast-forward moved `HEAD`, re-read and re-validate the profile** from `<CLONE>`'s updated
tree, against every rule in [profile.md](../../setup/references/profile.md) §4 in order. The profile
was necessarily read before the fetch, so without the re-read a run would execute under the profile
as it stood before `base` moved — a new forbidden path merged since the last run would take effect
one run late. A re-read profile that now fails validation stops the run, releasing the lock.

**The re-read refreshes policy, never run identity.** Three settings have already been acted on by
the time this step runs:

| Setting | Already acted on | Rebinding it would |
| --- | --- | --- |
| `loop_clone` | locked (§2), checked clean and fast-forwarded (§3) | continue on a checkout this run never locked or fast-forwarded |
| `base` | fetched and fast-forwarded, `<BASE_SHA>` bound (§3) | pair a new base with a commit resolved from the old one |
| `state_dir` | checked in §1; the lock's run id is about to key directories inside it | split one run's state across two directories |

Compare those three against the values bound in §1. **If any differs, release the lock on the
original `<CLONE>`, stop, and report which key changed from what to what.** Do not re-run
preflight against the new values in the same run; the next run starts clean from them.

Every other setting rebinds from the re-read copy.

---

## §5 Readiness tier line

Read `<state_dir>/readiness.md` and take its tier line — the single line matching `^Tier: `, in
the format [readiness.md](../../setup/references/readiness.md) §3 defines — **verbatim**, and copy
it into the stage 1 report. The line tells the reader of every run which checks this project could
support when the report was last refreshed.

A missing `readiness.md`, or one without a tier line, stops the run, releasing the lock:
`readiness: <state_dir>/readiness.md — missing or has no tier line — run /deepen:setup --check`.
