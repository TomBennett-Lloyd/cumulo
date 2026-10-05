#!/usr/bin/env bash
# Test harness for the pinned-shellcheck installer (.claude/scripts/install-shellcheck.sh).
#
# WHAT IS AND IS NOT COVERED HERE, stated first because the gap is the interesting part
# and because the sentence that used to sit here overclaimed it.
#
# The installer's happy path ends in a multi-megabyte download from GitHub, and this
# harness takes no network — the same rule every other harness in this directory keeps.
# Cases 1-4 are therefore pre-network refusals, and each asserts it never got there
# (`expect_not_out 'fetching'`), which is also what would catch a refusal softened into a
# warning. They are NOT every pre-network refusal, and this is a FLOOR rather than a list:
# the arms for a missing `curl`/`tar` and for a machine with neither `sha256sum` nor
# `shasum` need a tool taken off PATH that the harness itself depends on, an unwritable
# `DEST_DIR` is reachable and simply has no case yet, and the bare `|| exit 2` arms have
# none either. Naming a closed set here would be the overclaim this paragraph replaced.
#
# Cases 5 and 6 get PAST the fetch without taking it, and read the checksum comparison
# from both sides — the one post-network arm whose failure side costs something other than
# a worse error message, since it is what stands between a re-tagged or tampered release
# and a linter binary `pnpm verify` then runs (#534). The objection the note here used to
# record — that a mocked download would assert the mock — is why `stub_fetch` stops at
# delivering bytes: it decides nothing, and nothing asserts on it, while the archive it
# serves is real enough to be hashed, extracted and run. What those two cases read is the
# installer's own comparison and the installer's own refusal.
#
# The remaining post-network arms — the download's own failure, extraction, chmod, and the
# version readback's mismatch — have their SUCCESS side exercised on every CI run, because
# the `Install shellcheck (pinned)` step runs the whole happy path before
# `pnpm verify:full`; a broken fetch or a bad extraction reds the build at once. Their
# failure sides are unasserted. #534 does not own them — it names this script's checksum
# block and nothing else — so they are #550's, together with the pre-network arms above,
# and `stub_fetch` is what makes them a fixture variation rather than new machinery.
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

# Overridable on the same terms, and for the same purpose, as lint-shell.test.sh's
# LINT_SHELL_GATE — testing.md rule 4's negative control:
#
#   git show <rev>:.claude/scripts/install-shellcheck.sh >/tmp/pre.sh
#   INSTALL_SHELLCHECK_SCRIPT=/tmp/pre.sh bash .claude/scripts/install-shellcheck.test.sh
#
# Case 2's environment variant was pinned that way against the revision before the fix
# (3 passed, 1 failed). It also takes a mutant copy, which is how the arms with no
# pre-fix revision behind them get checked. One caution that comes with both: a mutant
# that breaks an EARLY refusal lets cases 1-4 run on to the download, so a run against a
# deliberately broken copy is not network-free the way the shipped configuration is. The
# checksum mutants are the exception — cases 5 and 6 serve the fetch themselves, so a
# mutant of the arm they cover stays as offline as the shipped configuration.
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

# FIXTURE_VERSION is a version upstream has never released, and that is load-bearing
# rather than tidy. Cases 5 and 6 substitute the fetch, and the hazard they have to be
# proof against is the substitution NOT taking effect — at which point the real curl
# answers and the case is graded on bytes from the network. A version with no release
# behind it cannot produce an archive at all: the real curl 404s, `-f` makes that a
# failure, and the case reds on "download failed" instead of passing for a reason nobody
# chose. Case 5's assertion on the reported `actual:` sum is the second guard.
#
# Every case that writes a version uses this one, cases 3 and 4 included. They refuse
# before the fetch and do not need the property — until a mutant breaks their refusal and
# carries them on to the download, which is the caution the INSTALL_SHELLCHECK_SCRIPT note
# above states and the one moment the property protects them too.
FIXTURE_VERSION=1.2.3

# A sum nobody computed, for the pin that must not match. All zeroes rather than a
# plausible-looking digest: it cannot collide with a real one, and it reads in a failure
# dump as the deliberate value it is.
UNMATCHED_SUM=0000000000000000000000000000000000000000000000000000000000000000

# fixture_archive -> $DIR/fixture.tar.xz, holding shellcheck-v$FIXTURE_VERSION/shellcheck,
# and FIXTURE_SUM, its SHA-256.
#
# A real xz-compressed tar with the member path the installer extracts by name, not a
# stand-in: the archive has to survive being hashed, extracted with --strip-components=1,
# chmod'd and run for `--version`, which is everything case 6 asserts past the comparison.
# The sum is COMPUTED here rather than recorded, because xz output is not stable across
# compressor versions and a recorded digest would red this harness on somebody else's box.
#
# `tar -cJf` needs an xz compressor. That is a fair hard requirement rather than a case to
# skip: upstream ships these assets as .tar.xz, so any machine where the installer's happy
# path works has one, and a machine without it fails here loudly through `must`.
fixture_archive() {
  local stage="$DIR/stage/shellcheck-v$FIXTURE_VERSION"
  must mkdir -p "$stage"
  printf '%s\n' '#!/usr/bin/env bash' "printf 'version: $FIXTURE_VERSION\\n'" >"$stage/shellcheck"
  must chmod +x "$stage/shellcheck"
  must tar -cJf "$DIR/fixture.tar.xz" -C "$DIR/stage" "shellcheck-v$FIXTURE_VERSION"
  # Whichever digest tool this box has, by the same two-name rule the installer applies for
  # the same reason — the runner ships sha256sum, macOS ships shasum.
  if command -v sha256sum >/dev/null 2>&1; then
    FIXTURE_SUM=$(sha256sum "$DIR/fixture.tar.xz" | awk '{print $1}')
  else
    FIXTURE_SUM=$(shasum -a 256 "$DIR/fixture.tar.xz" | awk '{print $1}')
  fi
  [ -n "$FIXTURE_SUM" ] || {
    printf 'FATAL harness setup failed: no SHA-256 for %s\n' "$DIR/fixture.tar.xz" >&2
    exit 2
  }
}

# stub_fetch -> $DIR/bin/curl, a curl that copies the fixture archive to the installer's
# -o destination and touches no network.
#
# No seam in the shipped script, and none wanted: the installer resolves `curl` by name,
# and every script on this chain APPENDS to PATH rather than prepending (the comment above
# this harness's own PATH line carries why), so a directory a case puts at the front stays
# at the front. Case 3 already leans on exactly that to stub `uname`. A substitution that
# lives only in a case's PATH is one the shipped installer cannot be pointed at by mistake.
#
# It parses only `-o`, which is all it needs to decide anything, and ignores the rest of
# the installer's argv. Asserting the flags would make this a mock with opinions; the
# installer's fetch line is already read by the `fetching` assertions in every case.
stub_fetch() {
  must mkdir -p "$DIR/bin"
  cat >"$DIR/bin/curl" <<'EOF'
#!/usr/bin/env bash
dest=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o)
      dest="${2:-}"
      shift 2 || exit 2
      ;;
    *) shift ;;
  esac
done
[ -n "$dest" ] || {
  printf 'curl stub: the installer passed no -o destination\n' >&2
  exit 2
}
[ -n "${CURL_FIXTURE_ARCHIVE:-}" ] || {
  printf 'curl stub: CURL_FIXTURE_ARCHIVE is unset — the case did not build an archive\n' >&2
  exit 2
}
cp "$CURL_FIXTURE_ARCHIVE" "$dest"
EOF
  must chmod +x "$DIR/bin/curl"
}

# run_installer_offline — the fetch served from $DIR/fixture.tar.xz instead of the network.
#
# GITHUB_PATH is passed EMPTY so that a test never writes to the runner's own PATH file.
# Set, the installer appends $dest to it; harness-lib.sh's EXIT trap then deletes $dest
# with the rest of TMP_ROOT, so what would be left behind is a PATH entry pointing at
# nothing. Today that is inert — `pnpm verify:full` is the LAST step of the `checks` job in
# .github/workflows/ci.yml, and GITHUB_PATH only reaches later steps — which is exactly why
# the guard needs an assertion rather than an argument: nothing would go red if it went.
# Case 6 reads the local branch's advice line, which only an empty GITHUB_PATH produces.
run_installer_offline() {
  run_installer PATH="$DIR/bin:$PATH" \
    CURL_FIXTURE_ARCHIVE="$DIR/fixture.tar.xz" \
    GITHUB_PATH=
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
must write_pin "$DIR" "export SHELLCHECK_PIN_VERSION=$FIXTURE_VERSION"
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
must write_pin "$DIR" "export SHELLCHECK_PIN_VERSION=$FIXTURE_VERSION"
run_installer
expect_rc 2 "$rc"
expect_stderr "declares no SHA-256 for $(uname -s)/$(uname -m)"
expect_not_out "fetching"
end

# ====================================================================================
# 5. an archive whose SHA-256 is not the pinned one is refused, and nothing is installed
# ====================================================================================
# The security arm: the thing standing between a re-tagged or tampered release and a
# linter binary that `pnpm verify` goes on to run. Until this case it was asserted by
# nothing anywhere — the harness stopped before the network and CI only ever walks the
# matching path, so flipping `!=` to `=` was green everywhere (#534).
#
# All three platform sums are written, not just the running platform's, so the case asserts
# the same thing on the Linux runner and on either Mac.
#
# Two assertions beyond the headline carry their own weight. The `actual:` line is read BY
# VALUE against the fixture's own sum: it is what proves the fetch served the fixture's
# bytes rather than something else's. And the destination is read from the filesystem,
# because "nothing is installed" is a claim about the tree, not about the message that
# makes it — a refusal that printed correctly after extracting would satisfy every string
# assertion here.
#
# The labels are asserted with the installer's own spacing rather than the two sums
# unlabelled, which would pass a diff that swapped expected for actual.
begin "installer exits 2 and installs nothing when the archive's SHA-256 is not the pinned one"
fixture checksum_mismatch
fixture_archive
stub_fetch
must write_pin "$DIR" "export SHELLCHECK_PIN_VERSION=$FIXTURE_VERSION" \
  "export SHELLCHECK_PIN_SHA256_LINUX_X86_64=$UNMATCHED_SUM" \
  "export SHELLCHECK_PIN_SHA256_DARWIN_AARCH64=$UNMATCHED_SUM" \
  "export SHELLCHECK_PIN_SHA256_DARWIN_X86_64=$UNMATCHED_SUM"
run_installer_offline
expect_rc 2 "$rc"
expect_out "fetching"
expect_stderr "CHECKSUM MISMATCH"
expect_stderr "expected: $UNMATCHED_SUM"
expect_stderr "actual:   $FIXTURE_SUM"
[ ! -e "$DIR/dest/shellcheck" ] || bad "refused, but left a binary at $DIR/dest/shellcheck"
end

# ====================================================================================
# 6. the matching archive installs — the comparison's other side
# ====================================================================================
# Case 5 alone would be satisfied by a comparison that refuses everything, so this is the
# half that makes the arm bidirectional: flipping `!=` to `=` reds BOTH cases, one by
# installing what it should refuse and one by refusing what it should install.
#
# It also reads the steps past the comparison — extraction by member name, the chmod, and
# the version readback — because the fixture binary has to actually run and report
# $FIXTURE_VERSION for the installer to reach its final line. Those steps are not this
# slice's arms; they come along because the only honest way to assert the matching side is
# to let it finish.
#
# The last two assertions are what hold run_installer_offline's empty GITHUB_PATH, for the
# reason stated over there: the installed-at line is printed by BOTH report branches, so
# without these the guard is prose and a later edit dropping it reds nothing.
begin "installer installs the archive whose SHA-256 is the pinned one"
fixture checksum_match
fixture_archive
stub_fetch
must write_pin "$DIR" "export SHELLCHECK_PIN_VERSION=$FIXTURE_VERSION" \
  "export SHELLCHECK_PIN_SHA256_LINUX_X86_64=$FIXTURE_SUM" \
  "export SHELLCHECK_PIN_SHA256_DARWIN_AARCH64=$FIXTURE_SUM" \
  "export SHELLCHECK_PIN_SHA256_DARWIN_X86_64=$FIXTURE_SUM"
run_installer_offline
expect_rc 0 "$rc"
expect_out "fetching"
expect_not_out "CHECKSUM MISMATCH"
expect_stdout "shellcheck $FIXTURE_VERSION installed at $DIR/dest"
[ -x "$DIR/dest/shellcheck" ] || bad "installed nothing executable at $DIR/dest/shellcheck"
expect_stdout "put it ahead of any other shellcheck"
expect_not_stdout "GITHUB_PATH"
end

# ====================================================================================

finish
