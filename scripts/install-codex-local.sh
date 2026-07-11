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
staged_plugin="$marketplace_root/plugins/feature"
marketplace_manifest="$marketplace_root/.agents/plugins/marketplace.json"
ownership_marker="$marketplace_root/.feature-pipeline-local-marketplace"
agents_dir="$marketplace_root/.agents"
agents_plugins_dir="$agents_dir/plugins"

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
  "$staged_plugin"; do
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
fresh_plugin="$fresh_root/feature"
mkdir -p "$fresh_plugin"
cleanup_fresh_root() {
  if [ -n "${fresh_root:-}" ] && [ -d "$fresh_root" ]; then
    rm -rf -- "$fresh_root"
  fi
}
trap cleanup_fresh_root EXIT

git -C "$repo_root" ls-files --cached --others --exclude-standard -z | \
  while IFS= read -r -d '' source_path; do
    if [ -e "$repo_root/$source_path" ] || [ -L "$repo_root/$source_path" ]; then
      printf '%s\0' "$source_path"
    fi
  done | rsync -a --from0 --files-from=- "$repo_root/" "$fresh_plugin/"

staged_plugin_manifest="$fresh_plugin/.codex-plugin/plugin.json"
if [ ! -f "$staged_plugin_manifest" ]; then
  echo "Staged plugin manifest not found: $staged_plugin_manifest" >&2
  exit 1
fi

base_version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$staged_plugin_manifest" | head -n 1)
if [ -z "$base_version" ]; then
  echo "Could not read the staged plugin version." >&2
  exit 1
fi
base_version=${base_version%%+*}
local_version="$base_version+codex.local-$(date -u +%Y%m%d-%H%M%S)-$$-$RANDOM"

sed 's/^\([[:space:]]*"version":[[:space:]]*\)"[^"]*"/\1"'"$local_version"'"/' \
  "$staged_plugin_manifest" >"$staged_plugin_manifest.tmp"
mv "$staged_plugin_manifest.tmp" "$staged_plugin_manifest"

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
    }
  ]
}
JSON

codex plugin marketplace add "$marketplace_root"
if ! initial_plugin_list=$(codex plugin list); then
  echo "Could not read the current plugin installation state." >&2
  exit 1
fi
stable_was_installed=false
local_was_installed=false
if printf '%s\n' "$initial_plugin_list" | grep -E '^feature@feature[[:space:]]+installed' >/dev/null; then
  stable_was_installed=true
fi
if printf '%s\n' "$initial_plugin_list" | grep -E '^feature@feature-local[[:space:]]+installed' >/dev/null; then
  local_was_installed=true
fi

previous_plugin="$marketplace_root/plugins/.feature.previous"
if [ -e "$previous_plugin" ] || [ -L "$previous_plugin" ]; then
  rm -rf -- "$previous_plugin"
fi
if [ -d "$staged_plugin" ]; then
  mv "$staged_plugin" "$previous_plugin"
fi
mv "$fresh_plugin" "$staged_plugin"
rm -rf -- "$fresh_root"
fresh_root=
trap - EXIT

codex plugin remove feature@feature-local >/dev/null 2>&1 || true
restore_previous_local() {
  codex plugin remove feature@feature-local >/dev/null 2>&1 || true
  rm -rf -- "$staged_plugin"
  if [ -d "$previous_plugin" ]; then
    mv "$previous_plugin" "$staged_plugin"
    if [ "$local_was_installed" = true ]; then
      codex plugin add feature@feature-local >/dev/null 2>&1 || true
    fi
  fi
  if [ "$stable_was_installed" = true ]; then
    codex plugin add feature@feature >/dev/null 2>&1 || true
  fi
}
if ! codex plugin add feature@feature-local; then
  restore_previous_local
  echo "Local install failed; the previous local source was restored when available." >&2
  exit 1
fi

if ! plugin_list=$(codex plugin list); then
  restore_previous_local
  echo "Local install verification could not list plugins; the previous local source was restored when available." >&2
  exit 1
fi
if ! printf '%s\n' "$plugin_list" | grep -F 'feature@feature-local' >/dev/null || \
  ! printf '%s\n' "$plugin_list" | grep -F "$local_version" >/dev/null; then
  restore_previous_local
  echo "Local install verification failed; the previous local source was restored when available." >&2
  exit 1
fi

if [ "$stable_was_installed" = true ]; then
  if ! codex plugin remove feature@feature; then
    restore_previous_local
    echo "Could not remove the stable Feature Pipeline install; the previous plugin state was restored." >&2
    exit 1
  fi
fi
if ! plugin_list=$(codex plugin list); then
  restore_previous_local
  echo "Could not verify the final plugin source; the previous plugin state was restored." >&2
  exit 1
fi
if ! printf '%s\n' "$plugin_list" | grep -F 'feature@feature-local' >/dev/null || \
  ! printf '%s\n' "$plugin_list" | grep -F "$local_version" >/dev/null || \
  printf '%s\n' "$plugin_list" | grep -E '^feature@feature[[:space:]]+installed' >/dev/null; then
  restore_previous_local
  echo "Final plugin source verification failed; the previous plugin state was restored." >&2
  exit 1
fi

rm -rf -- "$previous_plugin"
printf '%s\n' "$plugin_list"

echo
echo "Installed Feature Pipeline $local_version from checkout: $repo_root"
echo "Start a new Codex task to load the refreshed local plugin."
