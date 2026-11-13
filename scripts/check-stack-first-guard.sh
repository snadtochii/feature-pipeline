#!/usr/bin/env bash
# The stack-first install guard's decision table: every case below feeds a Bash
# tool command to plugins/stack-first/hooks/stack-first-guard.sh as hook input
# and checks whether the guard emits its reminder.
#
# The reminder is only worth reading when it is rare, so a command that adds no
# dependency must stay silent here: lockfile installs with redirected output, a
# manager named in prose or an argument, shadcn scaffolding. Every form that
# does add a package must still fire.
#
# Usage:  scripts/check-stack-first-guard.sh
# Exit:   0 every case matches; 1 on any mismatch, a missing guard or no jq.

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
guard="$repo_root/plugins/stack-first/hooks/stack-first-guard.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq not on PATH" >&2
  exit 1
fi
if [ ! -x "$guard" ]; then
  echo "FAIL: guard not found or not executable at $guard" >&2
  exit 1
fi

failures=0
cases=0

# check <fire|silent> <command>
check() {
  local want="$1" cmd="$2" got out
  cases=$((cases + 1))
  out=$(jq -n --arg c "$cmd" '{tool_input:{command:$c}}' | "$guard")
  if [ -n "$out" ] && jq -e '.systemMessage | startswith("stack-first:")' >/dev/null <<<"$out"; then
    got=fire
  elif [ -z "$out" ]; then
    got=silent
  else
    got="malformed output: $out"
  fi
  if [ "$got" = "$want" ]; then
    echo "ok   $want: $cmd"
  else
    echo "FAIL want $want, got $got: $cmd"
    failures=$((failures + 1))
  fi
}

# Package additions.
check fire 'pnpm add zod'
check fire 'npm install lodash'
check fire 'npm i -D vitest'
check fire 'yarn add react'
check fire 'bun add hono'
check fire 'pnpm i zod'
check fire 'pnpm --filter web add zod'
check fire 'npm -w web install zod'
check fire 'pnpm -w add react'
check fire 'pnpm add -D --save-exact oxlint@1.91.0'
check fire 'pnpm add -D @vitejs/plugin-react@^6.1.1 --save-exact=false'
check fire 'npm install -g typescript'
check fire 'pnpm add zod 2>&1'
check fire 'pnpm add zod@^4.6.5 2>&1 | tail -8 && git diff package.json'
check fire 'pnpm add -D vite >/dev/null 2>&1'
check fire 'pnpm add zod > /tmp/add.log 2>&1'
check fire 'cd app && pnpm add zod'
check fire 'export PATH="$HOME/bin:$PATH" && pnpm add zod'
check fire 'CI=1 pnpm add zod'
check fire 'env CI=1 pnpm add zod'
check fire 'sudo npm install -g pnpm'
check fire 'time pnpm add zod'
check fire 'npx tsc --version 2>/dev/null || npm install --save-dev typescript'
check fire 'pnpm install --frozen-lockfile; pnpm add zod'
check fire 'pnpm dev & pnpm add zod'
check fire 'sleep 1 & npm install lodash'
check fire 'pnpm add zod &'
check fire 'if true; then pnpm add zod; fi'
check fire 'if [ ! -d node_modules/zod ]; then pnpm add zod; fi'
check fire 'if pnpm add zod; then echo ok; fi'
check fire 'if false; then :; else pnpm add zod; fi'
check fire 'for p in zod hono; do pnpm add $p; done'
check fire 'while read -r p; do npm install "$p"; done < deps.txt'
check fire '{ pnpm add zod; }'
check fire '! pnpm add zod'
check fire '( pnpm add zod )'
check fire '(pnpm add zod)'

# Lockfile installs, redirected or not.
check silent 'pnpm install'
check silent 'npm i'
check silent 'pnpm install --frozen-lockfile'
check silent 'pnpm install --filter web'
check silent 'npm install -w web'
check silent 'pnpm install --frozen-lockfile 2>&1 | tail -2'
check silent 'pnpm install --frozen-lockfile >/dev/null 2>&1; pnpm test'
check silent 'pnpm install --frozen-lockfile > /dev/null 2>&1'
check silent 'pnpm install --frozen-lockfile >"$S/i.log" 2>&1'
check silent 'pnpm install 2>&1 || pnpm install --frozen-lockfile 2>&1'
check silent 'npm install --package-lock-only --ignore-scripts >/dev/null 2>&1'
check silent 'pnpm install &>/tmp/install.log'
check silent 'pnpm install &> /tmp/install.log'
check silent 'pnpm install < /dev/null'
check silent 'pnpm install &'
check silent 'pnpm dev & pnpm install'
check silent 'if true; then pnpm install --frozen-lockfile 2>&1; fi'
check silent 'pnpm install # lockfile only'

# A manager that is not the command word.
check silent 'echo pnpm add zod'
check silent 'grep -n "pnpm add --global" AGENTS.md'
check silent 'git commit -m "install: run pnpm install green in the worktree"'
check silent '- rejected: a global pnpm install in setup'
check silent 'pnpm view zod version'
check silent 'pnpm test'

# shadcn scaffolding.
check silent 'npx shadcn@latest add button'
check silent 'pnpm dlx shadcn add card'
check silent 'bunx shadcn-ui add dialog'

if [ "$failures" -gt 0 ]; then
  echo "FAIL: $failures of $cases cases"
  exit 1
fi
echo "OK: $cases cases"
