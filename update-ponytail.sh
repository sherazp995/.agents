#!/usr/bin/env bash
# Install or update the one shared Ponytail copy from upstream, keep the
# explicit-only edits, and point Claude Code and Codex at the new version.
#
#   ~/.agents/update-ponytail.sh           # latest main
#   ~/.agents/update-ponytail.sh v4.11.0   # a tag or branch
#
# PONYTAIL_REPO overrides the upstream clone URL (tests use a local repo).
set -euo pipefail

ref="${1:-main}"
repo="${PONYTAIL_REPO:-https://github.com/DietrichGebert/ponytail.git}"
hub="$HOME/.agents"
shared="$hub/plugins/ponytail"
patch_file="$hub/ponytail-explicit-only.patch"
skill_names=(ponytail ponytail-audit ponytail-debt ponytail-gain ponytail-help ponytail-review)
config_link="$HOME/.config/ponytail/config.json"
config_target="../../.agents/ponytail.json"
claude_target="../../../../../.agents/plugins/ponytail"
installed_path="$HOME/.claude/plugins/installed_plugins.json"
selected_path="$hub/selected-skills.json"
codex_cache="$HOME/.codex/plugins/cache/ponytail/ponytail"

work="$(mktemp -d)"
backup=""
armed=0             # set once the first real change is about to happen
shared_state=""     # replaced | created
created_links=()    # links this run made; removed again on failure
codex_touched=0

# On failure after the first change, put back everything this run changed and
# say plainly what could not be put back.
restore() {
  set +e
  local failed=()
  if [ "$shared_state" = replaced ]; then
    rsync -a --delete --exclude .git "$backup/shared/" "$shared/" || failed+=("shared copy $shared")
  elif [ "$shared_state" = created ]; then
    rm -rf "$shared" || failed+=("new shared copy $shared")
  fi
  local link
  for link in ${created_links[@]+"${created_links[@]}"}; do
    if [ -L "$link" ]; then rm "$link" || failed+=("link $link"); fi
  done
  if [ -f "$backup/files/installed_plugins.json" ]; then
    cp "$backup/files/installed_plugins.json" "$installed_path" || failed+=("$installed_path")
  elif [ -f "$backup/files/installed_plugins.json.absent" ]; then
    rm -f "$installed_path" || failed+=("$installed_path")
  fi
  if [ -f "$backup/files/selected-skills.json" ]; then
    cp "$backup/files/selected-skills.json" "$selected_path" || failed+=("$selected_path")
  fi
  local old
  for old in "$backup"/codex-cache/*; do
    [ -e "$old" ] || continue
    if [ -e "$codex_cache/$(basename "$old")" ]; then
      failed+=("Codex cache $(basename "$old") (kept in $backup/codex-cache)")
    else
      mv "$old" "$codex_cache/" || failed+=("Codex cache $(basename "$old")")
    fi
  done
  echo "Update failed; restored the previous Ponytail state (backup: $backup)." >&2
  if [ "$codex_touched" = 1 ]; then
    echo "Codex's own plugin record was changed by 'codex plugin add' and is not restored; rerun this script once the cause is fixed." >&2
  fi
  if [ "${#failed[@]}" -gt 0 ]; then
    echo "Could not restore:" >&2
    printf '  %s\n' "${failed[@]}" >&2
  fi
}
on_exit() {
  local status=$?
  if [ "$armed" = 1 ] && [ "$status" -ne 0 ]; then restore; fi
  rm -rf "$work"
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

read_version() {
  python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$1"
}

# True when $1 is a symlink whose target text is one of the remaining arguments
# or lies under one of them.
link_points_into() {
  local path="$1" target allowed
  shift
  [ -L "$path" ] || return 1
  target="$(readlink "$path")"
  for allowed in "$@"; do
    case "$target" in "$allowed" | "$allowed"/*) return 0 ;; esac
  done
  return 1
}

# ---- Preflight: nothing on disk changes until every check has passed. ----

conflicts=()
for name in "${skill_names[@]}"; do
  path="$hub/skills/$name"
  if [ -e "$path" ] || [ -L "$path" ]; then
    link_points_into "$path" ../plugins/ponytail "$shared" || conflicts+=("$path (not a link into plugins/ponytail)")
  fi
done
if [ -e "$config_link" ] || [ -L "$config_link" ]; then
  link_points_into "$config_link" "$config_target" "$hub/ponytail.json" || conflicts+=("$config_link (not a link to ~/.agents/ponytail.json)")
fi

git clone --quiet --depth 1 --branch "$ref" "$repo" "$work/upstream"
rsync -a --exclude .git "$work/upstream/" "$work/new/"

# Stop before touching anything if the edits no longer fit upstream.
if ! (cd "$work/new" && patch -p1 --dry-run --silent < "$patch_file"); then
  echo "The explicit-only patch no longer applies to upstream $ref." >&2
  echo "Update $patch_file by hand, then rerun." >&2
  exit 1
fi
(cd "$work/new" && patch -p1 --silent --no-backup-if-mismatch < "$patch_file")

version="$(read_version "$work/new/.claude-plugin/plugin.json")"
old_version=""
if [ -f "$shared/.claude-plugin/plugin.json" ]; then
  old_version="$(read_version "$shared/.claude-plugin/plugin.json")"
elif [ -e "$shared" ]; then
  conflicts+=("$shared (exists but has no .claude-plugin/plugin.json)")
fi

use_claude=0
claude_link="$HOME/.claude/plugins/cache/ponytail/ponytail/$version"
if [ -d "$HOME/.claude" ]; then
  use_claude=1
  if [ -e "$claude_link" ] || [ -L "$claude_link" ]; then
    link_points_into "$claude_link" "$claude_target" "$shared" || conflicts+=("$claude_link (not a link to the shared copy)")
  fi
else
  echo "Skipping Claude Code: ~/.claude does not exist."
fi
use_codex=0
if command -v codex >/dev/null 2>&1; then
  use_codex=1
else
  echo "Skipping Codex: the codex command is not installed."
fi

if [ "${#conflicts[@]}" -gt 0 ]; then
  echo "Nothing changed. Move these aside, then rerun:" >&2
  printf '  %s\n' "${conflicts[@]}" >&2
  exit 1
fi

# ---- Changes: from here a failure restores what was changed. ----

backup="$hub/backup/ponytail-${old_version:-none}-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$backup/files" "$backup/codex-cache"
if [ -n "$old_version" ]; then
  rsync -a --exclude .git "$shared/" "$backup/shared/"
fi
cp "$selected_path" "$backup/files/selected-skills.json"
if [ "$use_claude" = 1 ]; then
  if [ -f "$installed_path" ]; then
    cp "$installed_path" "$backup/files/installed_plugins.json"
  else
    touch "$backup/files/installed_plugins.json.absent"
  fi
fi

armed=1
if [ -n "$old_version" ]; then shared_state=replaced; else shared_state=created; fi
mkdir -p "$shared"
rsync -a --delete --exclude .git --exclude .DS_Store "$work/new/" "$shared/"

# Make or repair a relative link. Preflight already refused anything that is
# not one of our own links.
ensure_link() {
  local path="$1" target="$2"
  [ -L "$path" ] && [ "$(readlink "$path")" = "$target" ] && return 0
  mkdir -p "$(dirname "$path")"
  if [ -L "$path" ]; then
    rm "$path"  # a stale link of ours; repaired, so not undone on failure
  else
    created_links+=("$path")
  fi
  ln -s "$target" "$path"
}
for name in "${skill_names[@]}"; do
  ensure_link "$hub/skills/$name" "../plugins/ponytail/skills/$name"
done
ensure_link "$config_link" "$config_target"

if [ "$use_claude" = 1 ]; then
  # Claude Code: link the version folder to the shared install and record it.
  ensure_link "$claude_link" "$claude_target"
  python3 - "$installed_path" "$claude_link" "$version" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

path, install_path, version = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
installed = json.loads(path.read_text()) if path.exists() else {'version': 2, 'plugins': {}}
records = installed.setdefault('plugins', {}).setdefault('ponytail@ponytail', [])
if not records:
    records.append({'scope': 'user', 'installedAt': now})
for record in records:
    record['installPath'] = install_path
    record['version'] = version
    record['lastUpdated'] = now
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(installed, indent=2) + '\n')
PY
fi

python3 - "$selected_path" "$version" <<'PY'
import json
import sys
from pathlib import Path

path, version = Path(sys.argv[1]), sys.argv[2]
selected = json.loads(path.read_text())
# Only the active version is checked; older Claude links still point at the shared copy.
selected['ponytail_plugin_paths'] = [f'.claude/plugins/cache/ponytail/ponytail/{version}',
                                     f'.codex/plugins/cache/ponytail/ponytail/{version}']
path.write_text(json.dumps(selected, indent=2) + '\n')
PY

if [ "$use_codex" = 1 ]; then
  # Codex: install from the local marketplace (~/.agents/plugins), which copies the
  # shared folder into its cache. Codex treats a linked cache folder as missing.
  codex_touched=1
  codex plugin add ponytail@ponytail >/dev/null
  codex_root="$codex_cache/$version"
  # Older Codex copies would be loaded by nothing but still fail check.py; keep them in the backup.
  for old in "$codex_cache"/*; do
    [ -e "$old" ] || continue
    [ "$old" = "$codex_root" ] || mv "$old" "$backup/codex-cache/"
  done
  mkdir -p "$codex_root"
  rsync -a --delete --exclude .git --exclude .DS_Store "$shared/" "$codex_root/"
fi

armed=0
if [ -n "$old_version" ]; then
  echo "Ponytail $old_version -> $version. Previous copy saved in $backup/shared"
else
  echo "Ponytail $version installed."
fi
python3 "$hub/check.py"
