#!/usr/bin/env bash
#
# Installs the pinned shellcheck — the half of #502 that makes the pin reachable.
#
# `lint-shell.sh` refuses when the installed shellcheck is not the pinned one; a
# refusal with no way out is a wall, so this is the way out, and it is the same
# way out for both sides. CI's `checks` job calls it because the runner image's
# own shellcheck is older than the pin (the image's versions are stated on the
# `pnpm verify:full` step in .github/workflows/ci.yml and nowhere else); a
# developer calls it when their package
# manager has moved past the pin (while Homebrew still resolves to the pinned
# version, `brew install shellcheck` is the shorter route and the refusal says
# so). Neither caller states a version: .claude/scripts/shellcheck-pin.sh owns it
# and this script reads it, so a bump is one commit in one file.
#
# The shape is lifted from the `Install actionlint (pinned)` step in
# .github/workflows/ci.yml, whose comments (a)-(d) carry the reasoning this
# script inherits and does not restate: a direct release download rather than an
# upstream install script fetched from a moving ref, and version AND checksum
# together, because a tag can be re-pointed at a different binary while a
# checksum cannot. Upstream publishes no checksum manifest for these assets, so
# the sums in the pin file are computed from the artefacts — see that file's bump
# procedure.
#
# Extraction target: the binary is left in a directory of its own and NOT copied
# into /usr/local/bin or any other shared prefix. Writing outside a temp tree is
# a side effect a linter's installer has no business having, and it is what makes
# this safe to run from a checkout. Under Actions the directory is appended to
# $GITHUB_PATH, which is the runner's own sanctioned way of extending PATH for
# later steps; everywhere else the path is printed and the caller decides.
#
# Usage: bash .claude/scripts/install-shellcheck.sh [DEST_DIR]
#        DEST_DIR defaults to a version-named directory under $RUNNER_TEMP (CI)
#        or $TMPDIR. It is created if absent.
# Exit:  0 the pinned binary is in DEST_DIR and reported the pinned version,
#        2 anything else — an unsupported platform, a missing tool, a failed
#        download, a checksum mismatch. There is no exit 1: this script either
#        installs the pin or explains why it could not.
#
set -euo pipefail
# Same reason as lint-shell.sh: Homebrew's prefix is not on a non-interactive
# shell's default PATH on this machine, and curl/shasum may live there. Appended
# rather than prepended, like every other link in that chain — this script never
# resolves `shellcheck` by name (the binary it installs is run by absolute path),
# so nothing here turns on it, but a line that reads identically everywhere is
# one fewer place for the next reader to wonder whether the difference meant
# something. See lint-shell.sh's comment on the same line for the case where it
# does mean something.
export PATH="$PATH:/opt/homebrew/bin"

# die <headline> [detail-line]... — every refusal exits 2, so the caller never has
# to guess. Only the headline is prefixed; detail lines print as written, which is
# what lets them carry indented commands a reader can copy.
die() {
  printf 'install-shellcheck: %s\n' "$1" >&2
  shift
  [ $# -eq 0 ] || printf '%s\n' "$@" >&2
  exit 2
}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

# The pin is resolved from THIS script's directory, not from the repo root and
# not from an environment variable. A version an env var could redirect is not a
# pin, and resolving beside the script is also what lets the test harness next
# door drive this file: a fixture copies the script and writes whatever pin it
# wants to test alongside it, with no seam in the shipped code to arrange it.
pin_file="$here/shellcheck-pin.sh"
[ -r "$pin_file" ] || die "cannot read the pin at $pin_file" \
  '  Without it there is no version to install. Restore the file from git.'
# Cleared before the source, for the reason lint-shell.sh's twin of this line gives: the
# pin EXPORTS its declarations, so an inherited value is indistinguishable from a declared
# one, and a pin file that declares nothing would quietly defer to the environment. Here
# the stakes are a notch higher than at the gate — an inherited SHA-256 is a checksum
# nobody committed, verifying a download against a number supplied by the caller.
unset SHELLCHECK_PIN_VERSION \
  SHELLCHECK_PIN_SHA256_LINUX_X86_64 \
  SHELLCHECK_PIN_SHA256_DARWIN_AARCH64 \
  SHELLCHECK_PIN_SHA256_DARWIN_X86_64
# shellcheck source=./shellcheck-pin.sh
. "$pin_file"
[ -n "${SHELLCHECK_PIN_VERSION:-}" ] || die \
  "$pin_file declares no SHELLCHECK_PIN_VERSION" \
  '  A pin file that parses but declares nothing would install an empty version.'

# `uname -m` and the release asset's platform token are not the same vocabulary —
# Apple Silicon reports arm64 and upstream ships darwin.aarch64 — so the mapping
# is written out rather than derived. A platform with no entry is refused by name:
# guessing an asset would download something whose checksum nobody has recorded,
# and skipping would install nothing while exiting 0.
platform=$(uname -s)/$(uname -m) || exit 2
case "$platform" in
  Linux/x86_64) asset=linux.x86_64 expected=${SHELLCHECK_PIN_SHA256_LINUX_X86_64:-} ;;
  Darwin/arm64) asset=darwin.aarch64 expected=${SHELLCHECK_PIN_SHA256_DARWIN_AARCH64:-} ;;
  Darwin/x86_64) asset=darwin.x86_64 expected=${SHELLCHECK_PIN_SHA256_DARWIN_X86_64:-} ;;
  *)
    die "no pinned asset for $platform" \
      '  The pin covers the x86_64 Linux runner and both Mac architectures. Add the' \
      '  asset and its SHA-256 to .claude/scripts/shellcheck-pin.sh, following the bump' \
      "  procedure in that file, or install shellcheck $SHELLCHECK_PIN_VERSION by hand."
    ;;
esac
[ -n "$expected" ] || die \
  "the pin file declares no SHA-256 for $platform (asset $asset)" \
  '  An asset with no recorded sum would be installed unverified, which is the whole' \
  '  thing the checksum is here to prevent. Add it to .claude/scripts/shellcheck-pin.sh.'

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed — cannot fetch the pinned release"
done
# Two names for one job, and neither is universal: GNU coreutils ships sha256sum
# (the runner has it), macOS ships shasum. Whichever is present is used, and the
# absence of both is a refusal rather than a download nobody checked.
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die 'neither sha256sum nor shasum is installed — refusing to install an unverified binary'
fi

dest=${1:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/shellcheck-$SHELLCHECK_PIN_VERSION}
mkdir -p "$dest" || die "cannot create $dest"
dest=$(cd "$dest" && pwd) || exit 2

work=$(mktemp -d "${TMPDIR:-/tmp}/install-shellcheck.XXXXXX") || exit 2
trap 'rm -rf "$work"' EXIT INT TERM

tarball="$work/shellcheck.tar.xz"
url="https://github.com/koalaman/shellcheck/releases/download/v$SHELLCHECK_PIN_VERSION/shellcheck-v$SHELLCHECK_PIN_VERSION.$asset.tar.xz"
printf 'install-shellcheck: fetching %s\n' "$url"
curl -fsSL --retry 3 --retry-delay 2 -o "$tarball" "$url" ||
  die "download failed: $url" '  Check the version in .claude/scripts/shellcheck-pin.sh names a real release.'

actual=$(sha256_of "$tarball") || exit 2
if [ "$actual" != "$expected" ]; then
  die 'CHECKSUM MISMATCH — the downloaded archive is not the pinned one' \
    "  asset:    $asset" \
    "  expected: $expected" \
    "  actual:   $actual" \
    '  Either the release was re-tagged against a different binary, or the download was' \
    '  tampered with in transit. Nothing is installed. Do not update the sum to match' \
    '  what arrived — establish first which artefact is the real one.'
fi

# `tar -xf` without an explicit compression flag: both GNU tar and macOS bsdtar
# detect xz from the stream, and -J is the flag whose spelling differs between
# them. --strip-components drops the shellcheck-v<version>/ prefix the archive
# carries, so the binary lands directly in $dest.
tar -xf "$tarball" -C "$dest" --strip-components=1 "shellcheck-v$SHELLCHECK_PIN_VERSION/shellcheck" ||
  die "could not extract shellcheck-v$SHELLCHECK_PIN_VERSION/shellcheck from the archive"
chmod +x "$dest/shellcheck" || die "cannot make $dest/shellcheck executable"

# Read the result back rather than trusting the install (docs/standards/evidence.md
# sanctioned form 4): a correct checksum proves what was downloaded, not that the
# binary in $dest runs and is the version claimed.
installed=$("$dest/shellcheck" --version | awk '/^version:/ {print $2}') || exit 2
[ "$installed" = "$SHELLCHECK_PIN_VERSION" ] || die \
  "installed binary reports $installed, not the pinned $SHELLCHECK_PIN_VERSION" \
  "  $dest/shellcheck is not what the pin names. Nothing downstream should trust it."

# Both arms print through a heredoc rather than printf: the local arm's whole
# payload is a PATH export, whose literal `$PATH` inside a single-quoted printf
# format is SC2016 ("expressions don't expand in single quotes") — correct in
# general and wrong here, and the escape a heredoc offers is the fix rather than
# a suppression.
if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$dest" >>"$GITHUB_PATH"
  cat <<EOF
install-shellcheck: shellcheck $installed installed at $dest
install-shellcheck: appended to the runner's GITHUB_PATH file, so every later
  step in this job resolves shellcheck to the pinned binary.
EOF
else
  cat <<EOF
install-shellcheck: shellcheck $installed installed at $dest
install-shellcheck: put it ahead of any other shellcheck to satisfy lint:sh —

    export PATH="$dest:\$PATH"

EOF
fi
