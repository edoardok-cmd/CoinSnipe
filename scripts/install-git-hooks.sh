#!/usr/bin/env bash
# Installs the push guard for this clone. CSN-002-FOLLOWUP-1-FOLLOWUP-1.
#
# Why: this repo is public. The tracked scripts/git-hooks/pre-push refuses any push whose history
# contains the private cost/price docs. A hook only protects a clone that has it installed, so
# `pnpm install` runs this script (root "prepare" script) on every fresh clone.
#
# How: copies the tracked hook from the checkout you run this in into
#   <git common dir>/coinsnipe-hooks/pre-push   (mode 755)
# and sets the clone's LOCAL `core.hooksPath` to that absolute directory. The git common dir is
# shared by every worktree, and it does not depend on which branch any checkout has out, so an
# old task branch without scripts/git-hooks/ (even in the main checkout) is still guarded.
#
# Limits (a copy and an absolute path, by design):
#   - The copy is refreshed only when this script runs. After updating scripts/git-hooks/pre-push
#     (pull, merge) re-run `pnpm install` or this script. `--check` reports a stale copy.
#   - If you move or rename the clone directory, core.hooksPath still points at the old location
#     and git silently skips the missing hook. Re-run this script. `--check` reports it.
#   - The tracked file in the checkout you run this from is the source of truth; running it from a
#     checkout with an older hook installs that older hook.
#
# Usage:
#   bash scripts/install-git-hooks.sh          install / refresh (idempotent; quiet if nothing to do)
#   bash scripts/install-git-hooks.sh --check  exit 0 only if the guard is active and current, else 1
#
# Exit codes (install):
#   0  installed / already current / not a git checkout (tarball, Vercel, CI without .git) /
#      the git dir or its config is read-only (loud warning on stderr: guard NOT installed;
#      we cannot fail `pnpm install` for an environment the developer cannot change)
#   1  real git checkout but the tracked hook is missing or a write failed, or the LOCAL
#      core.hooksPath is already set to something that is not ours (never clobbered)
#   2  bad usage
# A hooksPath set in global/system config is ignored: the local value we write overrides it.
# Exit codes (--check): 0 guard active and current; 1 not (reason on stderr).
set -u
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR

mode=install
case "${1:-}" in
  "") ;;
  --check) mode=check ;;
  -h | --help)
    sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "usage: bash scripts/install-git-hooks.sh [--check]" >&2
    exit 2
    ;;
esac

warn() { printf 'install-git-hooks: %s\n' "$*" >&2; }

# Not a git checkout: nothing to guard. Install stays silent and succeeds; --check reports it.
not_git() {
  if [ "$mode" = check ]; then
    warn "not a git checkout ($1); the push guard is not active"
    exit 1
  fi
  exit 0
}

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P) || not_git "cannot resolve repo root"
command -v git >/dev/null 2>&1 || not_git "git not found"
top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || not_git "no .git"
top=$(cd "$top" 2>/dev/null && pwd -P) || not_git "no .git"
# A tarball unpacked inside some other repo must not touch that repo's config.
[ "$top" = "$root" ] || not_git "this directory is not the root of a git repo"

common=$(git -C "$root" rev-parse --git-common-dir 2>/dev/null) || not_git "no git dir"
case "$common" in /*) ;; *) common="$root/$common" ;; esac
common=$(cd "$common" 2>/dev/null && pwd -P) || not_git "no git dir"

src="$root/scripts/git-hooks/pre-push"
destdir="$common/coinsnipe-hooks"
dest="$destdir/pre-push"

# LOCAL value only: a global/system hooksPath is overridden by the local one we write, so it is
# neither a conflict (install) nor the effective path once installed (--check).
cur=$(git -C "$root" config --local --get core.hooksPath 2>/dev/null || true)
cur_norm=${cur%/}

if [ "$mode" = check ]; then
  if [ -n "$cur_norm" ]; then
    case "$cur_norm" in /*) target=$cur_norm ;; *) target="$root/$cur_norm" ;; esac
  else
    eff=$(git -C "$root" config --get core.hooksPath 2>/dev/null || true)
    if [ -n "$eff" ]; then
      warn "guard NOT active: core.hooksPath comes from global/system config ($eff) and no local value is set. Run: bash scripts/install-git-hooks.sh"
      exit 1
    fi
    target="$common/hooks"
  fi
  if [ ! -f "$target/pre-push" ]; then
    warn "guard NOT active: no pre-push hook at $target (local core.hooksPath=${cur:-<unset>}). If the clone was moved or renamed, or never installed, run: bash scripts/install-git-hooks.sh"
    exit 1
  fi
  if [ ! -x "$target/pre-push" ]; then
    warn "guard NOT active: $target/pre-push is not executable (git skips it). Run: bash scripts/install-git-hooks.sh"
    exit 1
  fi
  if [ -f "$src" ] && ! cmp -s "$target/pre-push" "$src"; then
    warn "guard STALE: $target/pre-push differs from the tracked scripts/git-hooks/pre-push. Run: bash scripts/install-git-hooks.sh"
    exit 1
  fi
  echo "install-git-hooks: guard active ($target/pre-push)"
  exit 0
fi

# ---- install ----
if [ ! -f "$src" ]; then
  warn "ERROR: $src not found. The tracked pre-push hook is missing from this checkout (restore the file). The push guard is NOT installed."
  exit 1
fi

case "$cur_norm" in
  "" | scripts/git-hooks | ./scripts/git-hooks | */scripts/git-hooks | */coinsnipe-hooks) ;;
  *)
    warn "ERROR: the local core.hooksPath is already set to '$cur' (not a CoinSnipe hooks path); leaving it alone. The push guard is NOT installed. Unset it (git config --local --unset core.hooksPath) or move its hooks, then re-run."
    exit 1
    ;;
esac

need_copy=0
if [ ! -f "$dest" ] || ! cmp -s "$src" "$dest" || [ ! -x "$dest" ]; then need_copy=1; fi
need_cfg=0
[ "$cur_norm" = "$destdir" ] || need_cfg=1
[ "$need_copy" = 0 ] && [ "$need_cfg" = 0 ] && exit 0 # already current

# Read-only git dir / config (sandbox, locked-down CI): we cannot install, but we also must not
# break `pnpm install` for something the developer cannot change. Say so loudly and exit 0.
ro=0
if [ "$need_copy" = 1 ]; then
  if [ -d "$destdir" ]; then [ -w "$destdir" ] || ro=1; else [ -w "$common" ] || ro=1; fi
fi
if [ "$need_cfg" = 1 ]; then
  [ -w "$common" ] || ro=1
  if [ -e "$common/config" ] && [ ! -w "$common/config" ]; then ro=1; fi
fi
if [ "$ro" = 1 ]; then
  warn "WARNING: the git directory or its config is read-only ($common); the push guard is NOT installed or not current. Make it writable and re-run, or check with: bash scripts/install-git-hooks.sh --check"
  exit 0
fi

if [ "$need_copy" = 1 ]; then
  if ! mkdir -p "$destdir" || ! cp "$src" "$destdir/.pre-push.$$" || ! chmod 755 "$destdir/.pre-push.$$" \
    || ! mv -f "$destdir/.pre-push.$$" "$dest"; then
    rm -f "$destdir/.pre-push.$$" 2>/dev/null
    warn "ERROR: could not write $dest. The push guard is NOT installed."
    exit 1
  fi
fi
if [ "$need_cfg" = 1 ]; then
  if ! git -C "$root" config --local core.hooksPath "$destdir"; then
    warn "ERROR: could not write core.hooksPath. The push guard is NOT installed."
    exit 1
  fi
fi
if [ -n "$cur" ] && [ "$need_cfg" = 1 ]; then
  echo "install-git-hooks: core.hooksPath was '$cur', now $destdir"
elif [ "$need_cfg" = 1 ]; then
  echo "install-git-hooks: push guard installed ($dest)"
else
  echo "install-git-hooks: push guard refreshed ($dest)"
fi
exit 0
