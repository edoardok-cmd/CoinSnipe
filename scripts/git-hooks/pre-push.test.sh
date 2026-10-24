#!/usr/bin/env bash
# Tests for scripts/install-git-hooks.sh and scripts/git-hooks/pre-push (CSN-002-FOLLOWUP-1-FOLLOWUP-1).
# Run: pnpm test:hooks   (or: bash scripts/git-hooks/pre-push.test.sh)
# Builds throwaway repos under mktemp -d; never touches this repo's git config.
# The guard is a COPY of the tracked hook in <git common dir>/coinsnipe-hooks (see install-git-hooks.sh).
set -u
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
# A space in the path proves quoting end to end (the real checkout lives under "AI Projects").
TMP=$(mktemp -d "${TMPDIR:-/tmp}/csn hooks.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "  PASS  $1"; }
no() { fail=$((fail + 1)); echo "  FAIL  $1"; }
# expect_rc <want: 0|nz> <label> <cmd...>
expect_rc() {
  local want=$1 label=$2 rc
  shift 2
  "$@" >"$TMP/last.out" 2>&1
  rc=$?
  if { [ "$want" = 0 ] && [ "$rc" = 0 ]; } || { [ "$want" = nz ] && [ "$rc" != 0 ]; }; then
    ok "$label (exit $rc)"
  else
    no "$label (exit $rc, wanted $want)"
    sed 's/^/        | /' "$TMP/last.out"
  fi
}
# expect_refused <label> <cmd...>: non-zero AND the failure came from OUR hook, not some other git error.
expect_refused() {
  local label=$1
  shift
  expect_rc nz "$label" "$@"
  grep -q 'pre-push: refusing' "$TMP/last.out" && ok "  ...refused by the pre-push guard" || no "  ...refused by the pre-push guard"
}
# Expected install location for a clone (resolved like the installer: physical path of the common dir).
hdir() { echo "$(cd "$(git -C "$1" rev-parse --git-common-dir | sed "s|^[^/]|$1/&|")" && pwd -P)/coinsnipe-hooks"; }
g() { git -C "$1" "${@:2}"; }

# A source repo whose first commit has NO scripts/ (the "old task branch" shape), then a second
# commit that adds the installer + hook. Published to a bare remote; each test clones fresh.
N=0
mk_remote() { # sets BARE (fresh bare remote + source repo each call; the name arg is a label only)
  N=$((N + 1))
  local n="$1$N" s="$TMP/$1$N-src"
  BARE="$TMP/$n.git"
  git init -q -b main "$s"
  echo base >"$s/README.md"
  g "$s" add -A && g "$s" commit -qm base
  g "$s" branch old
  mkdir -p "$s/scripts/git-hooks"
  cp "$SRC/scripts/install-git-hooks.sh" "$s/scripts/"
  cp "$SRC/scripts/git-hooks/pre-push" "$s/scripts/git-hooks/"
  chmod +x "$s/scripts/install-git-hooks.sh" "$s/scripts/git-hooks/pre-push"
  g "$s" add -A && g "$s" commit -qm "add guard"
  git init -q --bare "$BARE"
  g "$s" push -q "$BARE" main old
}
mk_clone() { # <name> -> sets C (clone of $BARE on main)
  C="$TMP/$1$N-clone"
  git clone -q "$BARE" "$C"
}
commit_file() { # <repo> <path> <content>
  mkdir -p "$(dirname "$1/$2")"
  echo "$3" >"$1/$2"
  g "$1" add -A && g "$1" commit -qm "add $2"
}

echo "(i) fresh clone + installer: branch containing docs/decisions.md is refused"
mk_remote a; mk_clone a
expect_rc 0 "installer runs" bash "$C/scripts/install-git-hooks.sh"
g "$C" checkout -q -b leak
commit_file "$C" docs/decisions.md "internal"
expect_refused "push of docs/decisions.md branch refused" g "$C" push origin leak
grep -q 'docs/decisions.md' "$TMP/last.out" && ok "refusal names the file" || no "refusal names the file"
expect_rc nz "remote did NOT receive the branch" g "$BARE" rev-parse --verify -q refs/heads/leak

echo "(ii) same shape WITHOUT the installer: push succeeds (control: the guard comes from the installer)"
mk_remote b; mk_clone b
g "$C" checkout -q -b leak
commit_file "$C" docs/decisions.md "internal"
expect_rc 0 "push without installer goes through" g "$C" push origin leak

echo "(iii) clean branch pushes fine after install"
mk_remote c; mk_clone c
bash "$C/scripts/install-git-hooks.sh" >/dev/null 2>&1
g "$C" checkout -q -b clean
commit_file "$C" docs/other.md "fine"
expect_rc 0 "clean push allowed" g "$C" push origin clean

echo "(iv) renamed-directory / root / case-variant copies are refused"
for p in notes/decisions.md data-licensing.md deep/er/data-licensing.md docs/Decisions.md; do
  mk_remote d; mk_clone d
  bash "$C/scripts/install-git-hooks.sh" >/dev/null 2>&1
  g "$C" checkout -q -b mv
  commit_file "$C" "$p" "internal"
  expect_refused "push with $p refused" g "$C" push origin mv
done
mk_remote d; mk_clone d
bash "$C/scripts/install-git-hooks.sh" >/dev/null 2>&1
g "$C" checkout -q -b near
commit_file "$C" docs/decisions-log.md "x"; commit_file "$C" docs/my-decisions.mdx "x"
expect_rc 0 "look-alike names (decisions-log.md, .mdx) are NOT refused" g "$C" push origin near
echo "      ancestor-only: docs added then removed in a later commit"
mk_remote d; mk_clone d
bash "$C/scripts/install-git-hooks.sh" >/dev/null 2>&1
g "$C" checkout -q -b anc
commit_file "$C" docs/decisions.md "internal"
g "$C" rm -q docs/decisions.md && g "$C" commit -qm "remove"
expect_refused "push refused when the docs sit only in an ancestor commit" g "$C" push origin anc

echo "(v) F2 regression: guard survives the MAIN checkout being on an OLD branch without scripts/git-hooks"
mk_remote e; mk_clone e
bash "$C/scripts/install-git-hooks.sh" >/dev/null 2>&1
WT="$TMP/e$N-wt"
g "$C" worktree add -q "$WT" -b wtbranch origin/main # linked worktree that still has the installer
g "$C" checkout -q old                                 # main checkout now lacks scripts/
[ ! -e "$C/scripts/git-hooks" ] && ok "precondition: main checkout has no scripts/git-hooks" || no "precondition: main checkout has no scripts/git-hooks"
commit_file "$C" docs/decisions.md "internal"
expect_refused "push from the old-branch MAIN checkout refused" g "$C" push origin old:leak-old
commit_file "$WT" notes/decisions.md "internal"
expect_refused "push from the linked worktree (main checkout on old branch) refused" g "$WT" push origin wtbranch
expect_rc 0 "--check from the linked worktree is 0" bash "$WT/scripts/install-git-hooks.sh" --check
echo "      linked worktree itself on an old branch"
mk_remote e; mk_clone e
bash "$C/scripts/install-git-hooks.sh" >/dev/null 2>&1
WT2="$TMP/e$N-wt2"
g "$C" worktree add -q "$WT2" -b oldwork origin/old
[ ! -e "$WT2/scripts/git-hooks" ] && ok "precondition: worktree has no scripts/git-hooks" || no "precondition: worktree has no scripts/git-hooks"
commit_file "$WT2" docs/decisions.md "internal"
expect_refused "push from the old-branch linked worktree refused" g "$WT2" push origin oldwork

echo "(v-b) F3: installer run from a LINKED worktree installs into the shared common dir"
mk_remote k; mk_clone k
WT3="$TMP/k$N-wt"
g "$C" worktree add -q "$WT3" -b wt3 origin/main
expect_rc 0 "installer from the linked worktree" bash "$WT3/scripts/install-git-hooks.sh"
want=$(hdir "$C")
[ "$(g "$C" config --local --get core.hooksPath)" = "$want" ] && ok "hooksPath == shared common-dir location ($want)" || no "hooksPath == shared common-dir location (got '$(g "$C" config --local --get core.hooksPath)', want '$want')"
[ -x "$want/pre-push" ] && cmp -s "$want/pre-push" "$WT3/scripts/git-hooks/pre-push" && ok "copy exists, executable, identical to the tracked hook" || no "copy exists, executable, identical to the tracked hook"
case "$(g "$C" config --local --get core.hooksPath)" in "$WT3"*) no "hooksPath is not inside the worktree" ;; *) ok "hooksPath is not inside the worktree" ;; esac
g "$C" checkout -q -b leak3
commit_file "$C" docs/decisions.md "internal"
expect_refused "push from the main clone refused" g "$C" push origin leak3

echo "(vi) installer is idempotent and exits 0 outside git"
mk_remote f; mk_clone f
expect_rc 0 "first install" bash "$C/scripts/install-git-hooks.sh"
v1=$(g "$C" config --get core.hooksPath)
expect_rc 0 "second install" bash "$C/scripts/install-git-hooks.sh"
[ -z "$(cat "$TMP/last.out")" ] && ok "second install is silent" || no "second install is silent"
v2=$(g "$C" config --get core.hooksPath)
[ -n "$v1" ] && [ "$v1" = "$v2" ] && [ "$(g "$C" config --get-all core.hooksPath | wc -l | tr -d ' ')" = 1 ] \
  && ok "hooksPath unchanged and single-valued ($v1)" || no "hooksPath unchanged and single-valued ($v1 / $v2)"
case "$v1" in /*) ok "hooksPath is absolute" ;; *) no "hooksPath is absolute ($v1)" ;; esac
[ "$v1" = "$(hdir "$C")" ] && ok "hooksPath is <common dir>/coinsnipe-hooks" || no "hooksPath is <common dir>/coinsnipe-hooks ($v1)"
NG="$TMP/nogit"; mkdir -p "$NG/scripts"; cp "$SRC/scripts/install-git-hooks.sh" "$NG/scripts/"
expect_rc 0 "non-git directory exits 0" bash "$NG/scripts/install-git-hooks.sh"
[ -z "$(cat "$TMP/last.out")" ] && ok "non-git directory is silent" || no "non-git directory is silent"
OUTER="$TMP/outer"; git init -q "$OUTER"; mkdir -p "$OUTER/vendor/pkg/scripts"; cp "$SRC/scripts/install-git-hooks.sh" "$OUTER/vendor/pkg/scripts/"
expect_rc 0 "tarball nested inside ANOTHER repo exits 0" bash "$OUTER/vendor/pkg/scripts/install-git-hooks.sh"
[ -z "$(g "$OUTER" config --get core.hooksPath)" ] && ok "the outer repo's config was not touched" || no "the outer repo's config was not touched"
expect_rc nz "--check in a non-git directory is 1" bash "$NG/scripts/install-git-hooks.sh" --check

echo "(vii) --check: 1 before install, 0 after"
mk_remote g; mk_clone g
expect_rc nz "--check before install" bash "$C/scripts/install-git-hooks.sh" --check
bash "$C/scripts/install-git-hooks.sh" >/dev/null 2>&1
expect_rc 0 "--check after install" bash "$C/scripts/install-git-hooks.sh" --check
chmod -x "$(hdir "$C")/pre-push"
expect_rc nz "--check with a non-executable installed hook" bash "$C/scripts/install-git-hooks.sh" --check
expect_rc 0 "re-running the installer repairs the mode" bash "$C/scripts/install-git-hooks.sh"
expect_rc 0 "--check after repair" bash "$C/scripts/install-git-hooks.sh" --check
echo "      stale copy"
echo "# newer hook" >>"$C/scripts/git-hooks/pre-push"
expect_rc nz "--check reports a STALE copy" bash "$C/scripts/install-git-hooks.sh" --check
grep -q 'STALE' "$TMP/last.out" && grep -q 'bash scripts/install-git-hooks.sh' "$TMP/last.out" && ok "stale message tells you to re-run the installer" || no "stale message tells you to re-run the installer"
expect_rc 0 "installer refreshes the copy" bash "$C/scripts/install-git-hooks.sh"
cmp -s "$(hdir "$C")/pre-push" "$C/scripts/git-hooks/pre-push" && ok "copy now identical to the tracked hook" || no "copy now identical to the tracked hook"
expect_rc 0 "--check after refresh" bash "$C/scripts/install-git-hooks.sh" --check

echo "(viii) a foreign core.hooksPath is not clobbered"
mk_remote h; mk_clone h
g "$C" config core.hooksPath /somewhere/else
expect_rc nz "installer refuses to replace a foreign hooksPath" bash "$C/scripts/install-git-hooks.sh"
[ "$(g "$C" config --get core.hooksPath)" = /somewhere/else ] && ok "foreign value untouched" || no "foreign value untouched"
grep -q '/somewhere/else' "$TMP/last.out" && ok "message names the existing value" || no "message names the existing value"
g "$C" config core.hooksPath scripts/git-hooks
expect_rc 0 "a relative CoinSnipe path is upgraded" bash "$C/scripts/install-git-hooks.sh"
case "$(g "$C" config --get core.hooksPath)" in /*) ok "...to an absolute path" ;; *) no "...to an absolute path" ;; esac

g "$C" config core.hooksPath "$TMP/old/clone/scripts/git-hooks"
expect_rc 0 "a previous-installer absolute scripts/git-hooks path is upgraded" bash "$C/scripts/install-git-hooks.sh"
[ "$(g "$C" config --local --get core.hooksPath)" = "$(hdir "$C")" ] && ok "...to the common-dir copy" || no "...to the common-dir copy"

echo "(F1) global/system hooksPath does not break the installer; local settings decide"
mk_remote m; mk_clone m
printf '[core]\n\thooksPath = /opt/company/hooks\n' >"$TMP/global.cfg"
GIT_CONFIG_GLOBAL="$TMP/global.cfg" expect_rc 0 "installer exits 0 despite a global hooksPath" bash "$C/scripts/install-git-hooks.sh"
[ "$(g "$C" config --local --get core.hooksPath)" = "$(hdir "$C")" ] && ok "local hooksPath written" || no "local hooksPath written"
GIT_CONFIG_GLOBAL="$TMP/global.cfg" expect_rc 0 "--check is 0 with a global hooksPath once installed" bash "$C/scripts/install-git-hooks.sh" --check
mk_remote m; mk_clone m
GIT_CONFIG_GLOBAL="$TMP/global.cfg" expect_rc nz "--check before install is 1 and blames the global value" bash "$C/scripts/install-git-hooks.sh" --check
grep -q '/opt/company/hooks' "$TMP/last.out" && ok "message names the global value" || no "message names the global value"
echo "      read-only git config: loud warning, exit 0 (decision: cannot fail pnpm install for it)"
mk_remote m; mk_clone m
chmod a-w "$C/.git/config"
expect_rc 0 "read-only config: installer exits 0" bash "$C/scripts/install-git-hooks.sh"
grep -q 'NOT installed' "$TMP/last.out" && ok "...with a loud NOT-installed warning" || no "...with a loud NOT-installed warning"
expect_rc nz "...and --check still reports the guard inactive" bash "$C/scripts/install-git-hooks.sh" --check
chmod u+w "$C/.git/config"
bash "$C/scripts/install-git-hooks.sh" >/dev/null 2>&1
chmod a-w "$C/.git/config"
expect_rc 0 "already installed + read-only config: silent no-op" bash "$C/scripts/install-git-hooks.sh"
[ -z "$(cat "$TMP/last.out")" ] && ok "...silent" || no "...silent"
chmod u+w "$C/.git/config"

echo "(F4) a moved clone is detected by --check and repaired by re-running the installer"
mk_remote n; mk_clone n
bash "$C/scripts/install-git-hooks.sh" >/dev/null 2>&1
mv "$C" "$TMP/moved clone"
C="$TMP/moved clone"
expect_rc nz "--check in the moved clone is 1" bash "$C/scripts/install-git-hooks.sh" --check
grep -q 'bash scripts/install-git-hooks.sh' "$TMP/last.out" && ok "message tells you to re-run the installer" || no "message tells you to re-run the installer"
expect_rc 0 "installer re-run in the moved clone" bash "$C/scripts/install-git-hooks.sh"
expect_rc 0 "--check after repair" bash "$C/scripts/install-git-hooks.sh" --check
g "$C" checkout -q -b leak4
commit_file "$C" docs/decisions.md "internal"
expect_refused "push from the repaired moved clone refused" g "$C" push origin leak4

echo "(ix) real git checkout with the tracked hook missing: installer exits 1, config untouched"
mk_remote i; mk_clone i
rm "$C/scripts/git-hooks/pre-push"
expect_rc nz "missing hook is an error" bash "$C/scripts/install-git-hooks.sh"
[ -z "$(g "$C" config --get core.hooksPath)" ] && ok "hooksPath left unset" || no "hooksPath left unset"

echo "(x) only objects the remote lacks are scanned (--not --remotes)"
mk_remote j; mk_clone j
g "$C" checkout -q -b pub
commit_file "$C" docs/decisions.md "internal"
g "$C" push -q origin pub # no installer yet: the remote now already has the docs
bash "$C/scripts/install-git-hooks.sh" >/dev/null 2>&1
commit_file "$C" docs/new.md "fine"
expect_rc 0 "new clean commit on top of already-published history is allowed" g "$C" push origin pub

echo
echo "pre-push guard tests: $pass passed, $fail failed"
[ "$fail" = 0 ]
