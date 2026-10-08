#!/usr/bin/env bash

set -euo pipefail
umask 077

for command_name in codex git rsync sed date mktemp; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
done

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd "$script_dir/.." && pwd -P)
codex_home=${CODEX_HOME:-"$HOME/.codex"}
marketplace_root_input=${FEATURE_CODEX_LOCAL_MARKETPLACE:-"$codex_home/dev-marketplaces/feature-local"}
marketplace_parent=$(dirname "$marketplace_root_input")
marketplace_name=$(basename "$marketplace_root_input")
mkdir -p "$marketplace_parent"
marketplace_parent=$(cd "$marketplace_parent" && pwd -P)
marketplace_root="$marketplace_parent/$marketplace_name"
marketplace_manifest="$marketplace_root/.agents/plugins/marketplace.json"
ownership_marker="$marketplace_root/.feature-pipeline-local-marketplace"
agents_dir="$marketplace_root/.agents"
agents_plugins_dir="$agents_dir/plugins"

# The plugins this helper stages and installs, in install order. Each one goes
# through the same stage, swap, add and verify path, and a failure restores all
# of them.
plugin_names="feature verify"

case "$marketplace_root/" in
  "$repo_root/"*)
    echo "Local marketplace must be outside the Feature Pipeline checkout: $marketplace_root" >&2
    exit 1
    ;;
esac

if [ -L "$marketplace_root" ]; then
  echo "Local marketplace root must not be a symbolic link: $marketplace_root" >&2
  exit 1
fi
for protected_path in \
  "$ownership_marker" \
  "$agents_dir" \
  "$agents_plugins_dir" \
  "$marketplace_manifest" \
  "$marketplace_root/plugins" \
  "$marketplace_root/plugins/feature" \
  "$marketplace_root/plugins/verify"; do
  if [ -L "$protected_path" ]; then
    echo "Local marketplace paths must not be symbolic links: $protected_path" >&2
    exit 1
  fi
done
if [ -d "$marketplace_root" ] && [ ! -f "$ownership_marker" ]; then
  if [ -n "$(find "$marketplace_root" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "Refusing to overwrite a marketplace not owned by this helper: $marketplace_root" >&2
    exit 1
  fi
fi

mkdir -p "$marketplace_root" "$agents_plugins_dir" "$marketplace_root/plugins"
: >"$ownership_marker"

fresh_root=$(mktemp -d "$marketplace_root/.feature-stage.XXXXXX")
cleanup_fresh_root() {
  if [ -n "${fresh_root:-}" ] && [ -d "$fresh_root" ]; then
    rm -rf -- "$fresh_root"
  fi
}
trap cleanup_fresh_root EXIT

feature_local_version=
verify_local_version=

# Copy one plugin's tracked and unignored files into the fresh stage, then give
# its staged Codex manifest a unique local version so Codex reloads it.
stage_plugin() {
  local name=$1
  local plugin_source_root="$repo_root/plugins/$name"
  local fresh_plugin="$fresh_root/$name"
  mkdir -p "$fresh_plugin"
  git -C "$plugin_source_root" ls-files --cached --others --exclude-standard -z | \
    while IFS= read -r -d '' source_path; do
      if [ -e "$plugin_source_root/$source_path" ] || [ -L "$plugin_source_root/$source_path" ]; then
        printf '%s\0' "$source_path"
      fi
    done | rsync -a --from0 --files-from=- "$plugin_source_root/" "$fresh_plugin/"

  local staged_plugin_manifest="$fresh_plugin/.codex-plugin/plugin.json"
  if [ ! -f "$staged_plugin_manifest" ]; then
    echo "Staged plugin manifest not found: $staged_plugin_manifest" >&2
    exit 1
  fi

  local base_version
  base_version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$staged_plugin_manifest" | head -n 1)
  if [ -z "$base_version" ]; then
    echo "Could not read the staged $name plugin version." >&2
    exit 1
  fi
  base_version=${base_version%%+*}
  local local_version="$base_version+codex.local-$(date -u +%Y%m%d-%H%M%S)-$$-$RANDOM"

  sed 's/^\([[:space:]]*"version":[[:space:]]*\)"[^"]*"/\1"'"$local_version"'"/' \
    "$staged_plugin_manifest" >"$staged_plugin_manifest.tmp"
  mv "$staged_plugin_manifest.tmp" "$staged_plugin_manifest"

  case "$name" in
    feature) feature_local_version=$local_version ;;
    verify) verify_local_version=$local_version ;;
  esac
}

local_version_of() {
  case "$1" in
    feature) printf '%s' "$feature_local_version" ;;
    verify) printf '%s' "$verify_local_version" ;;
  esac
}

for name in $plugin_names; do
  stage_plugin "$name"
done

cat >"$marketplace_manifest" <<'JSON'
{
  "name": "feature-local",
  "interface": {
    "displayName": "Feature Pipeline (local checkout)"
  },
  "plugins": [
    {
      "name": "feature",
      "source": {
        "source": "local",
        "path": "./plugins/feature"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    },
    {
      "name": "verify",
      "source": {
        "source": "local",
        "path": "./plugins/verify"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
JSON

codex plugin marketplace add "$marketplace_root"
if ! initial_plugin_list=$(codex plugin list); then
  echo "Could not read the current plugin installation state." >&2
  exit 1
fi

# Whether <plugin>@<marketplace> was installed before this run changed anything.
was_installed() {
  printf '%s\n' "$initial_plugin_list" | grep -E "^$1[[:space:]]+installed" >/dev/null
}

for name in $plugin_names; do
  staged_plugin="$marketplace_root/plugins/$name"
  previous_plugin="$marketplace_root/plugins/.$name.previous"
  if [ -e "$previous_plugin" ] || [ -L "$previous_plugin" ]; then
    rm -rf -- "$previous_plugin"
  fi
  if [ -d "$staged_plugin" ]; then
    mv "$staged_plugin" "$previous_plugin"
  fi
  mv "$fresh_root/$name" "$staged_plugin"
done
rm -rf -- "$fresh_root"
fresh_root=
trap - EXIT

for name in $plugin_names; do
  codex plugin remove "$name@feature-local" >/dev/null 2>&1 || true
done
restore_previous_local() {
  local name staged_plugin previous_plugin
  for name in $plugin_names; do
    staged_plugin="$marketplace_root/plugins/$name"
    previous_plugin="$marketplace_root/plugins/.$name.previous"
    codex plugin remove "$name@feature-local" >/dev/null 2>&1 || true
    rm -rf -- "$staged_plugin"
    if [ -d "$previous_plugin" ]; then
      mv "$previous_plugin" "$staged_plugin"
      if was_installed "$name@feature-local"; then
        codex plugin add "$name@feature-local" >/dev/null 2>&1 || true
      fi
    fi
    if was_installed "$name@feature"; then
      codex plugin add "$name@feature" >/dev/null 2>&1 || true
    fi
  done
}

# Every staged plugin is listed under the local marketplace at its local version.
local_installs_listed() {
  local name
  for name in $plugin_names; do
    printf '%s\n' "$1" | grep -F "$name@feature-local" >/dev/null || return 1
    printf '%s\n' "$1" | grep -F "$(local_version_of "$name")" >/dev/null || return 1
  done
}

# Any plugin is still installed from the stable marketplace.
stable_install_listed() {
  local name
  for name in $plugin_names; do
    if printf '%s\n' "$1" | grep -E "^$name@feature[[:space:]]+installed" >/dev/null; then
      return 0
    fi
  done
  return 1
}

for name in $plugin_names; do
  if ! codex plugin add "$name@feature-local"; then
    restore_previous_local
    echo "Local install of $name failed; the previous local sources were restored when available." >&2
    exit 1
  fi
done

if ! plugin_list=$(codex plugin list); then
  restore_previous_local
  echo "Local install verification could not list plugins; the previous local sources were restored when available." >&2
  exit 1
fi
if ! local_installs_listed "$plugin_list"; then
  restore_previous_local
  echo "Local install verification failed; the previous local sources were restored when available." >&2
  exit 1
fi

for name in $plugin_names; do
  if was_installed "$name@feature"; then
    if ! codex plugin remove "$name@feature"; then
      restore_previous_local
      echo "Could not remove the stable $name install; the previous plugin state was restored." >&2
      exit 1
    fi
  fi
done
if ! plugin_list=$(codex plugin list); then
  restore_previous_local
  echo "Could not verify the final plugin sources; the previous plugin state was restored." >&2
  exit 1
fi
if ! local_installs_listed "$plugin_list" || stable_install_listed "$plugin_list"; then
  restore_previous_local
  echo "Final plugin source verification failed; the previous plugin state was restored." >&2
  exit 1
fi

for name in $plugin_names; do
  rm -rf -- "$marketplace_root/plugins/.$name.previous"
done
printf '%s\n' "$plugin_list"

echo
echo "Installed Feature Pipeline $feature_local_version and verify $verify_local_version from checkout: $repo_root"
echo "Start a new Codex task to load the refreshed local plugins."
