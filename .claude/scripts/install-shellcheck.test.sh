#!/usr/bin/env bash
# Test harness for the pinned-shellcheck installer (.claude/scripts/install-shellcheck.sh).
#
# WHAT IS AND IS NOT COVERED HERE, stated first because the gap is the interesting part.
# The installer's happy path ends in a multi-megabyte download from GitHub, and this harness
# takes no network — the same rule every other harness in this directory keeps. So what
# is asserted here is the whole set of arms that REFUSE BEFORE REACHING THE NETWORK, and
# each case asserts that it never got there (`expect_not_out 'fetching'`), which is also
# what would catch a refusal that had been softened into a warning.
#
# The download path is not therefore unasserted — it is asserted somewhere this harness
# cannot reach and CI cannot avoid: the `Install shellcheck (pinned)` step runs it on
# every single CI run, before `pnpm verify:full`, so a broken fetch, a wrong checksum or
# a bad extraction reds the build immediately and loudly. A mocked download here would
# assert the mock; the real one is already on the critical path of every merge.
#
# Every refusal exits 2 — the installer has no exit 1 — so the cases assert 2 and the
# message, never merely "non-zero": an installer that fell over for an unrelated reason
# would otherwise pass the case for the reason it was meant to prove.
#
# Usage: bash .claude/scripts/install-shellcheck.test.sh   (or `pnpm test:scripts`)
# Exit:  0 every case PASS, 1 at least one FAIL, 2 the harness itself broke.
set -uo pipefail
# Appended, not prepended: prepending outranks a shellcheck the caller put
# ahead of Homebrew on purpose, which is the escape hatch lint-shell.sh's
# version refusal points at — that file's comment on this same line carries
# the reasoning, and every step of this chain has to agree or the one that
# prepends decides. (#502)
export PATH="$PATH:/opt/homebrew/bin"

SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

# shellcheck source=./harness-lib.sh
. "$SCRIPTS/harness-lib.sh"

# Overridable on the same terms as lint-shell.test.sh's LINT_SHELL_GATE, but not yet for
# the same purpose: the installer is new, so there is no pre-fix revision to run these
# cases against as a negative control. What the seam buys today is a mutant copy — break
# one refusal in a scratch copy, point this at it, and watch the matching case go red —
# and the negative control the day a fix here needs one.
INSTALLER=${INSTALL_SHELLCHECK_SCRIPT:-$SCRIPTS/install-shellcheck.sh}

harness_init_tmp

# --- fixtures ----------------------------------------------------------------------

# fixture <name> -> sets DIR to a fresh directory holding a copy of the installer.
# A copy, not the shipped path: the installer resolves its pin with
# `dirname "${BASH_SOURCE[0]}"`, so the directory a case's copy sits in IS the case's
# control over the pin — no seam in the shipped script, and no chance of a case reading
# the repository's real pin by accident.
fixture() {
  DIR="$TMP_ROOT/$1"
  must mkdir -p "$DIR"
  must cp "$INSTALLER" "$DIR/install-shellcheck.sh"
}

write_pin() { # write_pin <dir> <line>... — the pin file, one declaration per argument
  local dir="$1"
  shift
  printf '%s\n' '# shellcheck shell=bash' "$@" >"$dir/shellcheck-pin.sh"
}

run_installer() { # run_installer [extra env assignments...] — dest is always inside $TMP_ROOT
  capture env "$@" bash "$DIR/install-shellcheck.sh" "$DIR/dest"
}

# ====================================================================================
# 1. no pin, no install
# ====================================================================================
# The installer exists to serve one declaration. Without it there is no version, and the
# only alternatives to refusing are inventing a default (a pin nobody wrote) or fetching
# an empty version string (a 404 reported as a download failure, which would send the
# reader looking at their network). It names the file instead.
begin "installer exits 2 when the pin file is absent"
fixture no_pin
run_installer
expect_rc 2 "$rc"
expect_stderr "cannot read the pin"
expect_not_out "fetching"
end

# ====================================================================================
# 2. a pin that parses but declares no version
# ====================================================================================
# The quiet version of case 1: a file that sources cleanly and sets nothing. Left
# unchecked the URL is built around an empty version and the failure arrives as a 404
# three steps later, blaming the download for a bad edit to the pin.
#
# The second variant is why the installer clears the pin names before sourcing. The pin
# EXPORTS its declarations, so anything already in the environment reads as declared —
# and here that means a version AND a SHA-256 the caller supplied, i.e. a download
# verified against a checksum nobody committed. Both are set, so a failure to clear
# either one would carry the case past this refusal.
begin "installer exits 2 when the pin declares no SHELLCHECK_PIN_VERSION"
fixture pin_without_version
must write_pin "$DIR" 'export SHELLCHECK_PIN_SOMETHING=1'
case_ctx="a clean environment"
run_installer
expect_rc 2 "$rc"
expect_stderr "declares no SHELLCHECK_PIN_VERSION"
expect_not_out "fetching"
case_ctx="stale pin values in the environment"
run_installer SHELLCHECK_PIN_VERSION=0.11.0 \
  SHELLCHECK_PIN_SHA256_LINUX_X86_64=deadbeef \
  SHELLCHECK_PIN_SHA256_DARWIN_AARCH64=deadbeef \
  SHELLCHECK_PIN_SHA256_DARWIN_X86_64=deadbeef
expect_rc 2 "$rc"
expect_stderr "declares no SHELLCHECK_PIN_VERSION"
expect_not_out "fetching"
case_ctx=""
end

# ====================================================================================
# 3. an unsupported platform is named, not guessed
# ====================================================================================
# `uname` is stubbed rather than the platform faked at a seam, because the mapping from
# uname's vocabulary to the release asset's is exactly what is under test here — upstream
# ships Apple Silicon as `darwin.aarch64` while the machine says `arm64`, so the table is
# hand-written and a platform missing from it must refuse by name. The alternative
# behaviours are both worse than a refusal: guessing an asset name downloads something
# whose checksum nobody recorded, and skipping installs nothing while exiting 0.
#
# The stub is reachable unconditionally: the installer only ever APPENDS to PATH, so a
# directory the case puts at the front stays at the front.
begin "installer exits 2, naming the platform, when no pinned asset covers it"
fixture unknown_platform
must write_pin "$DIR" 'export SHELLCHECK_PIN_VERSION=1.2.3'
must mkdir -p "$DIR/bin"
cat >"$DIR/bin/uname" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -s) printf 'Plan9\n' ;;
  -m) printf 'sparc\n' ;;
  *) printf 'Plan9\n' ;;
esac
EOF
must chmod +x "$DIR/bin/uname"
run_installer PATH="$DIR/bin:$PATH"
expect_rc 2 "$rc"
expect_stderr "no pinned asset for Plan9/sparc"
expect_not_out "fetching"
end

# ====================================================================================
# 4. a platform in the table with no recorded checksum is refused too
# ====================================================================================
# Case 3's sibling on the other side of the table. A pin carrying a version but no sum
# for the running platform is the state a half-finished bump leaves behind, and the
# tempting reading is "checksum optional here". It is not: an asset with no recorded sum
# would be installed unverified, which is the one thing the checksum exists to prevent.
# Asserted on the real platform, whatever it is, so this case covers the runner and the
# developer's Mac alike.
begin "installer exits 2 when the pin declares no SHA-256 for this platform"
fixture pin_without_sum
must write_pin "$DIR" 'export SHELLCHECK_PIN_VERSION=1.2.3'
run_installer
expect_rc 2 "$rc"
expect_stderr "declares no SHA-256 for $(uname -s)/$(uname -m)"
expect_not_out "fetching"
end

# ====================================================================================

finish
