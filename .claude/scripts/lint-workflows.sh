#!/usr/bin/env bash
#
# The static-analysis gate for GitHub Actions workflows — the fourth linter,
# alongside `lint:js` (eslint), `lint:css` (stylelint) and `lint:sh`
# (shellcheck). It hangs off the same `pnpm lint` aggregate they do, so
# `verify` inherits it and with it every caller of the composite (CLAUDE.md: a
# gate that is not in `verify` is a gate somebody will forget to run).
#
# Usage: pnpm lint:workflows   (directly: bash .claude/scripts/lint-workflows.sh)
# Exit:  0 clean · 1 findings · 2 no verdict reached (missing tool, broken
#        discovery, or actionlint itself failing to run).
#
# WHAT IT CHECKS, and why it is not `lint:sh`'s job. lint-shell.sh discovers
# *.sh files and shell shebangs; a workflow's shell lives inside YAML block
# scalars, so all 42 `run:` blocks in .github/workflows — much of it executing
# with OIDC credentials — were invisible to every gate but prettier's YAML
# parse (#129). actionlint parses the workflow schema, substitutes `${{ }}`
# expressions, and hands the resulting script to shellcheck; it also checks the
# expression type system, the `needs:` graph, runner labels and action refs,
# none of which any shell linter can see.
#
# THE SHELLCHECK PREFLIGHT IS NOT DEFENSIVE PADDING — it guards a verified
# silent-degradation hole (the #101 class). Reproduced with actionlint 1.7.12:
# given a workflow whose `run: |` block contains an `if` with no `then`,
# actionlint exits 1 with "shellcheck reported issue" when shellcheck is on
# PATH, and **exits 0 — silently clean — when it is not**. A missing analyser
# must be indistinguishable from nothing, never from a pass, so this script
# hard-fails rather than let the absence read as green.
#
# The file list is DISCOVERED, never enumerated. A gate that hard-codes its own
# inputs goes stale the moment somebody adds a file, and #47 was filed for
# exactly that failure. Every workflow git knows about — tracked, or untracked
# and not ignored — that is present in the working tree is checked, and finding
# nothing at all is treated as a broken filter rather than a pass.
#
# KNOWN RESIDUAL, stated rather than discovered later: actionlint's check of
# action *inputs* reads a popular-actions database baked into the binary at
# release time. 1.7.12 knows `actions/checkout@v4`'s inputs but not `@v7`'s —
# verified: a typo'd input is flagged at v4 and silent at v7. So input typos on
# action majors newer than the pinned actionlint can pass this gate. Every
# other class it reports (shellcheck over `run:`, expression typing, the
# `needs:` graph, workflow syntax) is independent of that database.
#
set -euo pipefail
# Homebrew's prefix is not on a non-interactive shell's default PATH on this
# machine (same reason lint-shell.sh and worktree-lib.sh do it). Harmless on
# Linux, where the directory does not exist.
export PATH="/opt/homebrew/bin:$PATH"

# Overridable so the test harness can point the gate at a nonexistent binary and
# assert the preflights fire, without uninstalling anything.
ACTIONLINT_BIN=${LINT_WORKFLOWS_ACTIONLINT:-actionlint}
SHELLCHECK_BIN=${LINT_WORKFLOWS_SHELLCHECK:-shellcheck}

if ! command -v "$ACTIONLINT_BIN" >/dev/null 2>&1; then
  cat >&2 <<EOF

lint:workflows: actionlint is not installed — refusing to report a pass.

  Workflow files run privileged shell with OIDC credentials, and nothing else
  in \`verify\` reads inside a \`run:\` block. A skipped gate here is the same
  lie as a green one.

      macOS:  brew install actionlint

  CI installs it version-and-checksum-pinned in the \`checks\` job of
  .github/workflows/ci.yml — see the comment on that step.

  (Looked for: $ACTIONLINT_BIN)

EOF
  exit 2
fi

if ! command -v "$SHELLCHECK_BIN" >/dev/null 2>&1; then
  cat >&2 <<EOF

lint:workflows: shellcheck is not installed — refusing to report a pass.

  actionlint does not fail when its shell analyser is missing: it exits 0 on a
  workflow full of broken shell (verified, 1.7.12). Skipping would therefore
  turn "we cannot check this" into "this is clean", which is the one failure
  mode this gate exists to prevent.

      macOS:  brew install shellcheck
      Debian: sudo apt-get install -y shellcheck

  GitHub's ubuntu-latest runner image ships it preinstalled, so CI needs no
  install step for shellcheck (see the comment on the verify step in
  .github/workflows/ci.yml).

  (Looked for: $SHELLCHECK_BIN)

EOF
  exit 2
fi

repo_root=$(git rev-parse --show-toplevel) || exit 2
cd "$repo_root" || exit 2

# The source of paths is `git ls-files --cached --others --exclude-standard`:
# tracked files plus untracked ones git is not ignoring. --others matters — a
# workflow you have just written and not yet staged is precisely the one you
# want linted before it runs with credentials — and --exclude-standard is what
# keeps ignored trees out of the sweep. Both YAML spellings are listed because
# GitHub accepts both.
workflow_files=()
while IFS= read -r -d '' file; do
  # A path in the index need not exist in the working tree (sparse checkout, a
  # deleted-but-unstaged file). Such a path is dropped rather than passed on:
  # actionlint exits 3 on a file it cannot read, which is this gate's "broken,
  # not failing" signal, and an ordinary `rm` you have not staged yet must not
  # be able to raise it.
  [ -f "$file" ] || continue
  workflow_files+=("$file")
done < <(git ls-files --cached --others --exclude-standard -z \
  -- '.github/workflows/*.yml' '.github/workflows/*.yaml')

if [ ${#workflow_files[@]} -eq 0 ]; then
  echo "lint:workflows: found no workflow files to check — the discovery filter is broken, not the repo" >&2
  exit 2
fi

# awk rather than `head -1` on both version reads: under `set -o pipefail` a
# reader that exits early can leave the producer killed by SIGPIPE, and the
# pipeline's 141 would abort this script under `set -e`. awk consumes all of its
# input, so there is no race to lose (the lesson lint-shell.sh records).
printf 'lint:workflows: actionlint (%s) + shellcheck (%s) over %d file(s)\n' \
  "$("$ACTIONLINT_BIN" -version | awk 'NR == 1 { print }')" \
  "$("$SHELLCHECK_BIN" --version | awk '/^version:/ { print $2 }')" \
  "${#workflow_files[@]}"

# Files as positional arguments, and no `--` separator: the bare form is what
# was verified against 1.7.12. `-shellcheck` names the command actionlint hands
# each extracted `run:` script to; passing an empty string there disables the
# integration entirely, which is what the preflight above exists to keep from
# happening by accident.
rc=0
"$ACTIONLINT_BIN" -shellcheck "$SHELLCHECK_BIN" "${workflow_files[@]}" || rc=$?

# actionlint's contract: 0 clean, 1 findings, 2 bad command line, 3 fatal (an
# unreadable or unparseable-as-a-file input). Only the first two are verdicts;
# everything else means the gate did not run, which is exit 2 here — never a
# pass, and distinguishable from findings so a caller can tell "your workflow is
# wrong" from "this gate is wrong".
case "$rc" in
  0) exit 0 ;;
  1) exit 1 ;;
  *)
    echo "lint:workflows: actionlint could not reach a verdict (exit $rc)" >&2
    exit 2
    ;;
esac
