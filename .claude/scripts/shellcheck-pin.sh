# shellcheck shell=bash
#
# THE SHELLCHECK PIN — the one place the version lives. Sourced, never executed.
#
# `lint:sh` exists so that a green `pnpm verify` predicts a green CI. A linter
# resolved from whatever the machine happens to have installed cannot make that
# prediction, and twice it did not: PR #499 went red on SC2015 and PR #524 on
# SC2120/SC2119, both after a locally green composite, because developers run
# Homebrew's shellcheck while the ubuntu-latest runner image ships an older one
# (the image's versions are stated once, on the `pnpm verify:full` step in
# .github/workflows/ci.yml, which is the only site that cites its source). Each
# release adds checks, so the skew ran in the direction that costs a CI round
# every time (#502).
#
# (A comment line here may not open with the tool's own name: a `#` followed by
# it is how shellcheck spells a DIRECTIVE, and a sentence in that position is
# SC1072/SC1073, an unparseable directive. Found by this repo's own gate.)
#
# So the version is declared here once and READ by both sides — there is no
# mirror and no drift gate, because neither reader carries a literal:
#
#   .claude/scripts/lint-shell.sh          compares `shellcheck --version` to
#                                          SHELLCHECK_PIN_VERSION and refuses on
#                                          a mismatch.
#   .claude/scripts/install-shellcheck.sh  downloads that version's release asset
#                                          and checksums it against the SHA-256
#                                          below for the running platform. CI's
#                                          `checks` job calls it; so does a
#                                          developer whose package manager has
#                                          moved past the pin.
#
# `export`, not bare assignment: a sourced fragment's bare assignments are
# SC2034 ("appears unused") to the shellcheck run that lints this very file, and
# the fix for that is the export the values genuinely want, not a suppression.
#
# WHY THIS VERSION (deliberately not naming it in the heading: the declaration
# below is the only place the number belongs, and a heading carrying it is one a
# bump would have to remember to true): at the time of pinning it was upstream's latest
# release, what `brew install shellcheck` resolves to, and the version both
# failing PRs above had run locally. Given a choice of directions, CI moves up to
# meet local rather than local down to CI — the newer analyser is the stricter
# one, and pinning the older would be choosing to keep finding these defects one
# round later.
#
# BUMPING THE PIN — this file, and nowhere else:
#   1. Pick the release: https://github.com/koalaman/shellcheck/releases
#   2. For each asset named below, download it and take its SHA-256
#      (`shasum -a 256 <file>` on macOS, `sha256sum <file>` on Linux). Upstream
#      publishes no checksum manifest for these assets, so each sum is computed
#      from the artefact rather than copied from the release page.
#   3. Update SHELLCHECK_PIN_VERSION and all three sums together, then run
#      `bash .claude/scripts/install-shellcheck.sh` and `pnpm lint:sh`.
# Everyone is refused until they install the new version, which is the point: the
# bump is a visible, dated commit rather than a silent divergence.
#
# Asset coverage is the three platforms this repo is actually built on — the
# x86_64 Linux runner, and both Mac architectures. A platform with no sum here is
# refused by name in install-shellcheck.sh rather than fetched unverified.

export SHELLCHECK_PIN_VERSION=0.11.0

# One SHA-256 per `shellcheck-v<version>.<platform>.tar.xz` release asset, each
# name carrying the asset's own platform token (upstream ships Apple Silicon as
# `darwin.aarch64`, which is not what `uname -m` there says — install-shellcheck.sh
# owns that translation, and these names follow the download, not the machine).
export SHELLCHECK_PIN_SHA256_LINUX_X86_64=8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198
export SHELLCHECK_PIN_SHA256_DARWIN_AARCH64=56affdd8de5527894dca6dc3d7e0a99a873b0f004d7aabc30ae407d3f48b0a79
export SHELLCHECK_PIN_SHA256_DARWIN_X86_64=3c89db4edcab7cf1c27bff178882e0f6f27f7afdf54e859fa041fca10febe4c6
