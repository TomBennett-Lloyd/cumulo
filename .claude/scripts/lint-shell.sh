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

repo_root=$(git rev-parse --show-toplevel) || exit 2
cd "$repo_root" || exit 2

if ! command -v shellcheck >/dev/null 2>&1; then
  cat >&2 <<'EOF'

lint:sh: shellcheck is not installed — refusing to report a pass.

  A missing linter is indistinguishable from a clean run if the gate skips, so
  it hard-fails instead. These scripts remove worktrees and delete branches;
  unquoted expansions in them are not a style question.

      macOS:  brew install shellcheck
      Debian: sudo apt-get install -y shellcheck

  GitHub's ubuntu-latest runner image ships it preinstalled, so CI needs no
  install step (see the comment on the verify step in .github/workflows/ci.yml).

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

printf 'lint:sh: shellcheck (%s) over %d file(s)\n' \
  "$(shellcheck --version | awk '/^version:/ {print $2}')" "${#shell_files[@]}"

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
