# The run lock and clone preflight

Authoritative text for the two steps every Tidy Loop run performs before it does anything else:
taking the run lock, and putting the loop clone on a known commit. Read by `tidy-survey` and
`tidy-execute`, each of which states in its own body where this file is loaded and adds its own
checks around it.

The two loops run on independent schedules against **one** loop clone, so the lock here is
shared: whichever starts second aborts rather than fast-forwarding a checkout the first is
reading. A reference cannot carry a run-time trigger for a skill that never loads it, which is
why each consuming skill names the load point itself.

This file carries only what both loops do identically. A check that belongs to one of them —
because of what that loop invokes, opens, or creates — lives in that loop's own body, beside
its statement of where this file is loaded.

---

## §1 The run lock

```bash
mkdir "$(git -C "<CLONE>" rev-parse --git-common-dir)/tidy-loop.lock"
```

`mkdir` is the atomicity: it either creates the directory or fails, with no window between the
two. The `-C "<CLONE>"` form is required throughout — `rev-parse --git-common-dir` run without
it returns a path relative to the current working directory, which is not where the lock
belongs.

- **Succeeds** → write `<run-id>` and an ISO-8601 timestamp into a file inside the lock
  directory, and **release the lock on every exit path**, including every abort below and every
  abort the consuming skill adds.
- **Fails, and the lock is younger than 24 hours** → another run is live. Abort, naming the
  lock's recorded run id, and write nothing.
- **Fails, and the lock is older than 24 hours** → no legitimate run takes a day. Remove it,
  take over, and **say so loudly** in whatever the run reports: a stale lock means a previous
  run died, and what it left behind is the consuming skill's own recovery step.

A lock whose recorded run id is missing or unreadable is treated as **live**, not as stale. The
timestamp is what ages a lock; an unreadable one is a run that crashed between `mkdir` and the
write, which was moments ago.

---

## §2 Clone position

```bash
git -C "<CLONE>" status --porcelain          # must be empty
git -C "<CLONE>" symbolic-ref --short HEAD   # must equal <base>
git -C "<CLONE>" fetch origin
git -C "<CLONE>" merge --ff-only "origin/<base>"
```

Dirty, on the wrong branch, or unable to fast-forward → abort with the reason and a remedy.

**Never reset the clone automatically.** A diverged loop clone means something wrote to it by
hand, and discarding that silently is exactly the kind of destructive convenience an unattended
loop must not have.

Record `<BASE_SHA>` as the resolved `origin/<base>` commit. It is the tree every later step
measures against.

---

## §3 The profile re-read

**If the fast-forward moved `HEAD`, re-read and re-validate the profile** from `<CLONE>`'s
updated tree, against every rule in [`profile.md`](profile.md) §3 that the consuming skill
applies. The profile is necessarily read before this step can fetch, so without the re-read a
run executes under the profile as it stood at the *previous* run — a new forbidden path, a
narrowed allowlist, or a tightened cap merged to `base` during the week would take effect one
run late. Harmless for a cosmetic edit, exactly wrong for a safety one. A re-read profile that
now fails validation stops the run.

**The re-read refreshes policy, never run identity.** Three settings have already been *acted
on* by the time this step runs, so rebinding them silently would leave the run holding
resources it never set up:

| Setting | Already acted on | Rebinding it would |
| --- | --- | --- |
| `loop_clone` | locked (§1), checked clean and fast-forwarded (§2) | continue on a checkout this run never locked or fast-forwarded — possibly overlapping a live run there |
| `base` | fetched and fast-forwarded, `<BASE_SHA>` recorded (§2) | pair a new base with a commit resolved from the old one |
| `state_dir` | created before the lock was taken; any state already written into it | split one run's state across two directories |

Compare those three against the values bound before the fetch. **If any differs, release the
lock on the original `<CLONE>`, stop, and report which key changed from what to what.** Do not
re-run preflight against the new values in the same run: the next run starts clean from them,
which costs one cycle and removes a whole class of half-migrated state. Retaining the old
values is not an option either — the run would then act under settings its own profile no
longer declares.

Every other setting rebinds from the re-read copy.
