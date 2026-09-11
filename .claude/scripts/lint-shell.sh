#!/usr/bin/env bash
#
# The static-analysis gate for shell — the third linter, alongside `lint:js`
# (eslint) and `lint:css` (stylelint). It hangs off the same `pnpm lint`
# aggregate they do rather than off `verify` directly, so "the linters" stays one
# name; `verify` inherits it through `lint`, and with it every caller of the
# composite — CI, an agent, a human about to commit (CLAUDE.md: a gate that is
# not in `verify` is a gate somebody will forget to run).
#
# The file list is DISCOVERED, never hard-coded. A gate that enumerates its own
# inputs goes stale the moment somebody adds a script, and #47 was filed for
# exactly that failure: `pnpm test:scripts` was added to `verify` but never
# reached CI, so the shell harness was green by absence. Every file git knows
# about — tracked, or untracked and not ignored — that is present in the working
# tree and is named *.sh or carries a shell shebang is checked, and finding
# nothing at all is treated as a broken filter rather than a pass.
#
# THE VERSION THIS GATE IS A PREDICTION FOR is the one declared in
# .claude/scripts/shellcheck-pin.sh, which this script sources and holds the
# installed shellcheck to; no version literal appears here, because that file is
# the single owner and its docblock carries the why and the bump procedure. The
# census line below prints the version actually in use on every run.
#
# Why a refusal rather than a warning when they differ (#502). `verify` exists so
# that green locally predicts green in CI, and a leg that analyses with whatever
# the machine has installed cannot make that prediction: PR #499 went red on
# SC2015 and PR #524 on SC2120/SC2119, each after a locally green composite, each
# costing a CI round and a resume. A warning would have printed on both of those
# runs and changed neither outcome — the whole content of the promise is that the
# gate is unwilling to report a pass it cannot stand behind, which is why this
# lands on exit 2 (the gate is broken, no verdict) alongside the missing-linter
# refusal below rather than on exit 1 (shellcheck found something).
#
set -euo pipefail
# Homebrew's prefix is not on a non-interactive shell's default PATH on this
# machine (same reason worktree-lib.sh does it). Harmless on Linux, where the
# directory does not exist.
export PATH="/opt/homebrew/bin:$PATH"

# The seam the harness needs: discovery has a failure mode (a partial listing)
# that cannot be provoked with a real git, so the command is injectable and the
# harness substitutes a stub that lists some files and then exits non-zero.
# Precedent: WORKTREE_GH_CMD in worktree-lib.sh, LINT_SHELL_GATE in the harness.
# It covers the `ls-files` discovery call ONLY — the repo-identity `rev-parse`
# below stays plain git, because a gate that can be pointed at another repo by
# an environment variable is a different hazard from the one this seam buys.
: "${LINT_SHELL_GIT_CMD:=git}"

# The pin is read from THIS script's directory rather than from the repo root or
# an environment variable — a version an env var could redirect is not a pin. It
# is also what gives the harness its seam without one existing in shipped code:
# a fixture copies this gate and writes the pin it wants to test alongside it.
gate_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

repo_root=$(git rev-parse --show-toplevel) || exit 2
cd "$repo_root" || exit 2

pin_file="$gate_dir/shellcheck-pin.sh"
if [ ! -r "$pin_file" ]; then
  printf '%s\n' \
    'lint:sh: cannot read the shellcheck pin at .claude/scripts/shellcheck-pin.sh.' \
    '  Without it this gate has no version to hold the linter to, and a run whose' \
    '  analyser is unknown is exactly what #502 removed. Restore the file from git.' >&2
  exit 2
fi
# shellcheck source=./shellcheck-pin.sh
. "$pin_file"
if [ -z "${SHELLCHECK_PIN_VERSION:-}" ]; then
  printf '%s\n' \
    'lint:sh: the pin file declares no SHELLCHECK_PIN_VERSION.' \
    '  A pin that parses but declares nothing would compare every installed version' \
    '  against the empty string and refuse them all. See .claude/scripts/shellcheck-pin.sh.' >&2
  exit 2
fi

if ! command -v shellcheck >/dev/null 2>&1; then
  cat >&2 <<EOF

lint:sh: shellcheck is not installed — refusing to report a pass.

  A missing linter is indistinguishable from a clean run if the gate skips, so
  it hard-fails instead. These scripts remove worktrees and delete branches;
  unquoted expansions in them are not a style question.

  This gate is a prediction for shellcheck $SHELLCHECK_PIN_VERSION and accepts no
  other version (.claude/scripts/shellcheck-pin.sh owns that number):

      macOS:  brew install shellcheck      # while Homebrew resolves to the pin
      any:    bash .claude/scripts/install-shellcheck.sh

  CI installs the same pinned release, from the same declaration — see the
  'Install shellcheck (pinned)' step in .github/workflows/ci.yml.

EOF
  exit 2
fi

# The version gate. Held on stdout's own terms: `shellcheck --version` prints a
# `version: <x>` line, and the awk takes that field rather than the last word of
# the banner, so a reworded header line yields an empty string and a refusal
# instead of a silent match.
installed_version=$(shellcheck --version | awk '/^version:/ {print $2}')
if [ "$installed_version" != "$SHELLCHECK_PIN_VERSION" ]; then
  cat >&2 <<EOF

lint:sh: shellcheck ${installed_version:-<unreadable>} is installed, but this gate is pinned to $SHELLCHECK_PIN_VERSION.

  Refusing rather than warning, and refusing rather than running. A pass reported
  by a different analyser than CI's is not a prediction about CI, and that is the
  only thing this gate is for: #499 and #524 each shipped a locally green tree
  that CI's older shellcheck rejected. A warning would have printed on both and
  saved neither.

  Install the pinned release — it lands in a directory of its own, nothing is
  written to a shared prefix, and the last line it prints is the PATH export:

      bash .claude/scripts/install-shellcheck.sh

  On macOS, 'brew install shellcheck' is the shorter route for as long as
  Homebrew's current version is the pinned one.

  If the pin itself is what should move, that is one commit in one file:
  .claude/scripts/shellcheck-pin.sh carries the bump procedure. Both sides read
  it, so CI follows in the same commit.

EOF
  exit 2
fi

# Two populations, one list: files named *.sh, plus files whose first line is a
# shell shebang — that second group is how .githooks/pre-commit, which git
# requires to be extensionless, gets checked at all.
#
# zsh is in the pattern on purpose even though shellcheck cannot parse it: a zsh
# script added here should stop the build with "ShellCheck only supports
# sh/bash/dash/ksh", forcing a decision, rather than slip past the gate unseen.
#
# The source of paths is `git ls-files --cached --others --exclude-standard`:
# tracked files plus untracked ones git is not ignoring. --others matters — a
# script you have just written and not yet staged is precisely the one you want
# linted — and --exclude-standard is what keeps node_modules out of the sweep.
shebang_re='^#!.*[[:space:]/](ba|da|k|z|a)?sh([[:space:]]|$)'

# Discovery is written to a spool file and its exit status checked, rather than
# read straight out of a process substitution — the idiom run-script-tests.sh
# lines ~100-108 use for its `find`, adopted here for the same reason. A
# `git ls-files` that fails partway (an unreadable directory, a broken index)
# still prints everything it did reach, and a process substitution's status is
# invisible to the parent shell, so that partial listing would be linted and
# reported as the whole repository: "over 12 file(s)", clean, with the file that
# was never read nowhere in the census. A subset announced as the whole is the
# one outcome worse than no answer, so it is refused outright.
#
# `if !` rather than a bare command: this script runs `set -e`, under which a
# failing producer would abort before the explanation could be printed.
spool=$(mktemp "${TMPDIR:-/tmp}/lint-shell.XXXXXX") || exit 2
trap 'rm -f "$spool"' EXIT INT TERM

if ! "$LINT_SHELL_GIT_CMD" ls-files --cached --others --exclude-standard -z >"$spool"; then
  printf '%s\n' 'lint:sh: file discovery failed — git ls-files exited non-zero, and a partial listing would lint a subset and report it as the whole. No verdict.' >&2
  exit 2
fi

shell_files=()
while IFS= read -r -d '' file; do
  # First, before either population: a path in the index need not exist in the
  # working tree (sparse checkout, a deleted-but-unstaged file). Such a path is
  # dropped rather than passed on — shellcheck exits 2 on a nonexistent file,
  # which is this gate's "broken, not failing" signal, and an ordinary
  # `rm foo.sh` you have not staged yet must not be able to raise it.
  [ -f "$file" ] || continue
  case "$file" in
    *.sh)
      shell_files+=("$file")
      continue
      ;;
  esac
  # A bare `read` and a bash-native match, deliberately not `head | grep -q`:
  # under `set -o pipefail` a grep that exits early can leave head killed by
  # SIGPIPE, and the pipeline's 141 would then read as "no shebang" for a file
  # that has one. No pipeline, no way to lose that race.
  first_line=""
  read -r first_line <"$file" 2>/dev/null || true
  if [[ $first_line =~ $shebang_re ]]; then
    shell_files+=("$file")
  fi
done <"$spool"

if [ ${#shell_files[@]} -eq 0 ]; then
  echo "lint:sh: found no shell scripts to check — the discovery filter is broken, not the repo" >&2
  exit 2
fi

# The census reports the version it was held to a moment ago, not a second read of
# it: one `shellcheck --version` per run, and the number printed here is by
# construction the number the pin check passed.
printf 'lint:sh: shellcheck (%s, pinned) over %d file(s)\n' \
  "$installed_version" "${#shell_files[@]}"

# -x follows sourced files, so worktree-lib.sh is analysed in the context of each
# script that sources it rather than skipped as SC1091. -P SCRIPTDIR is what makes
# the existing `# shellcheck source=./worktree-lib.sh` directives resolve: without
# it a relative source path is looked up from the caller's working directory, and
# this gate runs from the repo root, not from .claude/scripts.
#
# `exec` replaces this shell, which discards the EXIT trap along with it, so the
# spool is removed here rather than left to a trap that will never fire.
rm -f "$spool"
exec shellcheck --external-sources --source-path=SCRIPTDIR -- "${shell_files[@]}"
