#!/usr/bin/env bash

set -euo pipefail
umask 077

# The plugins this helper stages into the local marketplace, in install order.
# Every required plugin is installed on each run. An optional plugin is
# installed when it was already installed from either marketplace, or when it
# is named with --with; otherwise it is staged only. Each plugin installs as its
# own transaction: a failure restores that plugin alone.
required_plugins="feature"
optional_plugins="verify"
plugin_names="$required_plugins $optional_plugins"

usage() {
  echo "Usage: scripts/install-codex-local.sh [--with <plugin>]..."
  echo "Optional plugins: $optional_plugins"
}

requested_plugins=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --with)
      if [ "$#" -lt 2 ]; then
        usage >&2
        exit 1
      fi
      case " $optional_plugins " in
        *" $2 "*) requested_plugins="$requested_plugins $2" ;;
        *)
          echo "Not an optional plugin: $2" >&2
          usage >&2
          exit 1
          ;;
      esac
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

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
refuse_symlink() {
  if [ -L "$1" ]; then
    echo "Local marketplace paths must not be symbolic links: $1" >&2
    exit 1
  fi
}
for protected_path in \
  "$ownership_marker" \
  "$agents_dir" \
  "$agents_plugins_dir" \
  "$marketplace_manifest" \
  "$marketplace_root/plugins"; do
  refuse_symlink "$protected_path"
done
for name in $plugin_names; do
  refuse_symlink "$marketplace_root/plugins/$name"
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

# The version a plugin manifest declares.
manifest_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

# The local version a staged plugin carries in the marketplace.
local_version_of() {
  manifest_version "$marketplace_root/plugins/$1/.codex-plugin/plugin.json"
}

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
  base_version=$(manifest_version "$staged_plugin_manifest")
  if [ -z "$base_version" ]; then
    echo "Could not read the staged $name plugin version." >&2
    exit 1
  fi
  base_version=${base_version%%+*}
  local local_version="$base_version+codex.local-$(date -u +%Y%m%d-%H%M%S)-$$-$RANDOM"

  sed 's/^\([[:space:]]*"version":[[:space:]]*\)"[^"]*"/\1"'"$local_version"'"/' \
    "$staged_plugin_manifest" >"$staged_plugin_manifest.tmp"
  mv "$staged_plugin_manifest.tmp" "$staged_plugin_manifest"
}

for name in $plugin_names; do
  stage_plugin "$name"
done

{
  printf '{\n  "name": "feature-local",\n  "interface": {\n    "displayName": "Feature Pipeline (local checkout)"\n  },\n  "plugins": [\n'
  separator=
  for name in $plugin_names; do
    printf '%s    {\n      "name": "%s",\n      "source": {\n        "source": "local",\n        "path": "./plugins/%s"\n      },\n      "policy": {\n        "installation": "AVAILABLE",\n        "authentication": "ON_INSTALL"\n      },\n      "category": "Productivity"\n    }' \
      "$separator" "$name" "$name"
    separator=$',\n'
  done
  printf '\n  ]\n}\n'
} >"$marketplace_manifest"

codex plugin marketplace add "$marketplace_root"
if ! initial_plugin_list=$(codex plugin list); then
  echo "Could not read the current plugin installation state." >&2
  exit 1
fi

# Whether <plugin>@<marketplace> was installed before this run changed anything.
was_installed() {
  printf '%s\n' "$initial_plugin_list" | grep -E "^$1[[:space:]]+installed" >/dev/null
}

selected_plugins=$required_plugins
for name in $optional_plugins; do
  case " $requested_plugins " in
    *" $name "*)
      selected_plugins="$selected_plugins $name"
      continue
      ;;
  esac
  if was_installed "$name@feature-local" || was_installed "$name@feature"; then
    selected_plugins="$selected_plugins $name"
  fi
done

is_selected() {
  case " $selected_plugins " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

# Move a plugin's fresh stage into the marketplace, keeping its previous
# sources beside it until its install is verified. A failed move leaves the
# previous sources in place.
swap_in_plugin() {
  local name=$1
  local staged_plugin="$marketplace_root/plugins/$name"
  local previous_plugin="$marketplace_root/plugins/.$name.previous"
  if [ -e "$previous_plugin" ] || [ -L "$previous_plugin" ]; then
    rm -rf -- "$previous_plugin"
  fi
  if [ -d "$staged_plugin" ]; then
    mv "$staged_plugin" "$previous_plugin" || return 1
  fi
  if ! mv "$fresh_root/$name" "$staged_plugin"; then
    if [ -d "$previous_plugin" ]; then
      mv "$previous_plugin" "$staged_plugin"
    fi
    return 1
  fi
}

# A plugin nothing installs from this run is staged without a transaction.
for name in $plugin_names; do
  if ! is_selected "$name"; then
    if ! swap_in_plugin "$name"; then
      echo "Could not move the staged $name into the local marketplace; its previous local sources were left in place." >&2
      exit 1
    fi
    rm -rf -- "$marketplace_root/plugins/.$name.previous"
  fi
done

# Return one plugin to its state before this run: its previous local sources
# and whichever installs it had.
restore_plugin() {
  local name=$1
  local staged_plugin="$marketplace_root/plugins/$name"
  local previous_plugin="$marketplace_root/plugins/.$name.previous"
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
}

# The plugin is listed under the local marketplace at its local version.
local_install_listed() {
  printf '%s\n' "$2" | grep -F "$1@feature-local" >/dev/null || return 1
  printf '%s\n' "$2" | grep -F "$(local_version_of "$1")" >/dev/null || return 1
}

# The plugin is still installed from the stable marketplace.
stable_install_listed() {
  printf '%s\n' "$2" | grep -E "^$1@feature[[:space:]]+installed" >/dev/null
}

# Install one plugin from the local marketplace, verify it, then drop its
# stable install. A failure restores this plugin alone and returns 1.
install_plugin() {
  local name=$1
  local plugin_list
  if ! swap_in_plugin "$name"; then
    echo "Could not move the staged $name into the local marketplace; its previous local sources were left in place." >&2
    return 1
  fi
  codex plugin remove "$name@feature-local" >/dev/null 2>&1 || true
  if ! codex plugin add "$name@feature-local"; then
    restore_plugin "$name"
    echo "Local install of $name failed; its previous local sources were restored when available." >&2
    return 1
  fi
  if ! plugin_list=$(codex plugin list); then
    restore_plugin "$name"
    echo "Local install verification of $name could not list plugins; its previous local sources were restored when available." >&2
    return 1
  fi
  if ! local_install_listed "$name" "$plugin_list"; then
    restore_plugin "$name"
    echo "Local install verification of $name failed; its previous local sources were restored when available." >&2
    return 1
  fi
  if was_installed "$name@feature"; then
    if ! codex plugin remove "$name@feature"; then
      restore_plugin "$name"
      echo "Could not remove the stable $name install; its previous plugin state was restored." >&2
      return 1
    fi
  fi
  if ! plugin_list=$(codex plugin list); then
    restore_plugin "$name"
    echo "Could not verify the final $name plugin source; its previous plugin state was restored." >&2
    return 1
  fi
  if ! local_install_listed "$name" "$plugin_list" || stable_install_listed "$name" "$plugin_list"; then
    restore_plugin "$name"
    echo "Final $name plugin source verification failed; its previous plugin state was restored." >&2
    return 1
  fi
  rm -rf -- "$marketplace_root/plugins/.$name.previous"
}

installed_plugins=
failed_plugins=
for name in $selected_plugins; do
  if install_plugin "$name"; then
    installed_plugins="$installed_plugins $name"
    continue
  fi
  case " $required_plugins " in
    *" $name "*) exit 1 ;;
  esac
  failed_plugins="$failed_plugins $name"
done
rm -rf -- "$fresh_root"
fresh_root=
trap - EXIT

codex plugin list || true

echo
for name in $installed_plugins; do
  echo "Installed $name $(local_version_of "$name") from checkout: $repo_root"
done
for name in $optional_plugins; do
  if ! is_selected "$name"; then
    echo "Staged $name without installing it; re-run with --with $name to install it."
  fi
done
if [ -n "$failed_plugins" ]; then
  echo "Not installed:$failed_plugins — the plugins above stay installed." >&2
  exit 1
fi
echo "Start a new Codex task to load the refreshed local plugins."
