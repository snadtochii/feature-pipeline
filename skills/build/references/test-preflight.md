# Test Pre-flight

Build invokes this at the test checkpoint (SKILL.md §3) on the path where a `ui-tester` spawn was about to happen — i.e. **after** the `--no-ui-testing` short-circuit and **after** the skip-detection scan has decided the plan has UI signals, but **before** the `ui-tester` `Task` call. It runs a cheap reachability gate so the expensive Opus browser subagent is never spawned against an app that can't be reached, and it hands the agent a declared auth recipe instead of letting it guess.

`--no-ui-testing` and the no-UI-signal skip both bypass this reference entirely — neither resolves a URL, curls, nor boots a `start` command. Pre-flight only runs when a spawn was actually going to happen (this is what keeps the cheap gate ahead of the expensive spawn — AC9).

Build reads the `test:` block by **model-reading** the flat YAML in `claudedocs/tickets/config.yaml`; it does **not** shell out to `yq`/`jq`, and `hooks/validate.sh` is never involved (the hook reads only the `validate:` block).

## The `test:` block (all keys optional)

```yaml
test:
  url: http://localhost:4200          # pre-flight curls this
  start: "npm start"                  # run (backgrounded) only if url is down
  auth:
    storage_state: .auth/admin.json   # Playwright saved session — gitignored, never committed
    attach_tab: true                  # fallback: attach to a running authenticated tab
```

Absent block, or any absent key → that part of the gate degrades to today's behavior (URL discovery falls through to the CLAUDE.md → port-probe path; no `start` boot; the agent's own auth fallback applies). Backward compatibility is the absence of every key.

## §1 Resolve a candidate URL

In order, first hit wins:

1. `test.url`, if present.
2. Else a URL documented in the project `CLAUDE.md` (e.g. `npm start # http://localhost:4200`).
3. Else **probe** common dev ports — this path resolves by reachability, so it doubles as §2:
   ```bash
   for port in 4200 4321 3000 5173 8080 5000; do
     code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:$port" || echo 000)
     case "$code" in
       200|301|302|401|403) echo "http://localhost:$port"; break ;;
     esac
   done
   ```
   First port returning a reachable status is the resolved-and-reachable URL. None respond → no URL resolved → unreachable (→ §3).

## §2 Reachability check

For a URL resolved via `test.url` or `CLAUDE.md` (the port-probe path already established reachability in §1). **Hold the resolved URL as data** — assign it to `url` as a literal value and reference `"$url"` in every `curl`; never paste the resolved string directly into the `curl … <here>` command position. A URL resolved from `CLAUDE.md` prose is lower-trust than `test.url` (a consumer repo's `CLAUDE.md` is editable by anyone who can open a PR), so treat it as data — mirroring the command-substitution discipline in `pr-creation.md` §4:

```bash
url='<resolved-url>'   # literal data value — never pasted into the curl command position
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || echo 000)
case "$code" in
  200|301|302|401|403) : reachable ;;   # 401/403 = auth-gated but UP — still reachable
  *) : unreachable ;;
esac
```

Reachable status set is `200 301 302 401 403` — this reference is its single source of truth. The gate interprets reachability only; it does **not** infer auth state (a `curl` returns `200` for a client-rendered SPA shell that redirects to login in JS, so auth-gating can't be detected here — that is solved by the recipe handoff in §5, not by this curl).

- **Reachable** → go to §5 (compose recipe) and spawn `ui-tester`.
- **Unreachable** → §3.

## §3 Unreachable handling

- **`test.start` is set** → boot it and poll (bounded). Use a **fixed, ticket-keyed** path (not `mktemp`) so the separate §4 teardown `Bash` call can reconstruct it — shell variables do not persist across `Bash` tool calls, so a random `mktemp` path would be lost and teardown would silently no-op (leaking the server). **Write `test.start` verbatim into a launch script with the `Write` tool** (not a shell heredoc): create `/tmp/fp-test-preflight-<ticket-id>.sh` whose entire body is the `test.start` value. Writing it as file content — rather than substituting it into a shell command — means any quotes / `$()` / backticks in the declared command can't break out of quoting or be re-evaluated. `test.start` is the user's own declared command (same trust tier as `validate.lint`); never put untrusted ticket text (spec title, AC text) in this file. Then launch it and capture the PID via `Bash`:
  ```bash
  PIDFILE="/tmp/fp-test-preflight-<ticket-id>.pid"     # fixed path — reconstructable in the §4 teardown call
  nohup bash "/tmp/fp-test-preflight-<ticket-id>.sh" >"/tmp/fp-test-preflight-<ticket-id>.log" 2>&1 &
  echo $! > "$PIDFILE"
  ```
  Then poll the resolved URL on a bounded loop (~60s ceiling — 20 polls, each up to ~3s — no unbounded wait):
  ```bash
  i=0
  while [ "$i" -lt 20 ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" || echo 000)
    case "$code" in
      200|301|302|401|403) echo "reachable:$code"; break ;;
    esac
    i=$((i + 1))
    sleep 1
  done
  ```
  - First reachable response → go to §5 and spawn `ui-tester`; the captured PID is marked for §4 teardown.
  - Loop ceiling reached without a reachable response → §4 teardown, then fall through to §6 skip.
- **No `test.start`** (or no URL resolved at all) → §6 skip. No prompt, no hard-pause.

## §4 Teardown contract

A dev server **started by pre-flight** (a PID was captured in §3) is torn down after the test checkpoint, **even if the checkpoint errors** and **including the boot-then-timeout path** (the trigger is "pre-flight started a process," not "the app became reachable" — a half-booted, timed-out server must not leak). Because §3 and §4 run in **separate `Bash` calls**, reconstruct the **same fixed path** literally — do not rely on the `$PIDFILE` variable from §3, which does not persist:

```bash
PIDFILE="/tmp/fp-test-preflight-<ticket-id>.pid"     # same literal path written in §3
if [ -f "$PIDFILE" ]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true       # best-effort; ignore if already exited
  rm -f "$PIDFILE" "/tmp/fp-test-preflight-<ticket-id>.sh"
fi
```

A server that was **already running** when pre-flight first probed (no PID captured) is **never** touched. Teardown is best-effort: `kill` of the captured PID may leave orphaned child processes (e.g. a launcher that forks a server) — that is acceptable per the spec's best-effort contract.

## §5 Compose the auth recipe + resolved URL into the spawn prompt

Build composes the recipe into the `ui-tester` spawn prompt (mirrors how the review checkpoint injects the confidence scale verbatim — single source of truth, the `ui-tester` body stays recipe-schema-free). Inject:

- **Resolved URL** — the pre-flight-resolved, reachable URL. The `ui-tester` spawn prompt receives this URL directly; the agent does not re-discover it.
- **`auth.attach_tab`** (when truthy) — instruct the agent to prefer attaching to an already-authenticated same-origin tab.
- **`auth.storage_state`** (when present) — inject the path. The agent loads it with the Playwright MCP `browser_set_storage_state` tool (it restores cookies/localStorage from the file before navigating to the protected route). That tool is additive-optional: on a Playwright MCP version that exposes it, `storage_state` is the first-choice auth path; on older versions the agent falls back to `attach_tab`. The path must point at a file inside the project/workspace root (Playwright MCP restricts file access to the workspace root unless launched with `--allow-unrestricted-file-access`). The `--storage-state` server-launch flag is a session-global alternative, not used here.

The agent consumes this recipe with priority `storage_state → attach_tab → existing fallback (CLAUDE.md hint → ask)`; see `agents/ui-tester.md`.

## §6 Skip artifact (app unreachable)

When unreachable with no `start` (or `start` timed out), write `<ticket-folder>/05-tests.md` and proceed to the verdict **without** spawning `ui-tester`, **without** any mid-loop prompt or hard-pause. `skipped` is a test-checkpoint label, not a fourth build verdict — build can still exit `pass`. The skip is recorded in `06-summary.md` / the exit summary (surfaced, not hidden):

```
verdict: skipped (app unreachable)

## Reason
The application could not be reached by the pre-flight gate (resolved URL: <url, or "none — no test.url, no CLAUDE.md URL, no responding dev port">). <"No test.start declared." | "test.start was booted but did not respond within the ~60s poll ceiling.">
The Opus ui-tester subagent was not spawned. Browser-level acceptance-criteria verification is deferred.

## Manual steps to verify
1. Start the app (e.g. `<test.start, or the project's dev command>`).
2. Re-run `/feature:build <ticket-id>` once it is reachable, or declare `test.url` / `test.start` in claudedocs/tickets/config.yaml so the pre-flight can reach (or boot) it next time.

## Acceptance Criteria
- [ ] AC 1 — not-tested (app unreachable)
- [ ] AC 2 — not-tested (app unreachable)
...
```

## Boundaries

- **Cheap gate, always first** — a `curl` (and at most a bounded `start` poll) is always paid before the Opus `ui-tester` spawn; the agent is never spawned against an unreachable, un-bootable app (AC9).
- **No auth detection** — reachability only; the gate never interprets `401`/`403`/a `200` SPA shell as "auth-gated." Auth-gated-with-no-recipe still spawns the agent (it's reachable), which fails fast and is recorded as a non-blocking skip by the agent's own report.
- **No literal secrets** — `config.yaml` is committed; `auth.storage_state` is a path to a gitignored session file and `auth.attach_tab` is a bool. Credentials are never read from or written into `config.yaml`.
- **Model-read, not hook-read** — the `test:` block is consumed by build (this reference + the injected spawn prompt). `hooks/validate.sh` is not modified and never reads it.
- **bash-3.2 / macOS-default portable** — `curl`, `nohup`, `$!` PID capture, `kill`, POSIX `while`/`case`; no associative arrays, no `mapfile`, no `setsid` (absent on macOS).
