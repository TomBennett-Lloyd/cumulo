#!/usr/bin/env bash
# Relative-link gate for markdown: every `](target)` written in a markdown file
# git knows about has to resolve to something that actually exists.
#
#   file targets      docs/adr/0003-pv-model-runtime.md is a path git lists, and
#                     is spelled exactly as git lists it
#   directory targets tools/pvlib-fixtures/ has at least one listed file beneath it
#   anchors           #phase-a--configure-and-plan is a heading in the file linked,
#                     under GitHub's heading-slug rules
#   containment       no target escapes the repo root, no target is gitignored
#
# Anchors are in scope because anchor drift is where breakage actually bit:
# infra/README.md is ~1,600 lines of runbook whose sections cross-link each other
# by fragment, and a renamed heading silently 404s every link that named it. A
# gate that resolved only file paths would check the half that rarely moves.
#
# Wired into the root `verify` composite (CLAUDE.md: gates join `verify`, never a
# hand-picked subset), so `pnpm verify`, the CI `checks` job and any human running
# the composite all enforce it. It lives in .claude/scripts/ alongside the repo's
# other shell gates and their harnesses.
#
# What a green run does NOT say, so it is not read for more than it holds:
#
#   * External links are never fetched. Anything matching a URI scheme
#     (`https:`, `mailto:`, …) is counted and skipped — `verify` has no network,
#     by convention, so link *liveness* is out of scope entirely. A dead
#     https://… URL passes this gate.
#   * Anchors are checked against ATX headings only (`# ` … `###### `). An
#     explicit `<a name="…">` or `<h2 id="…">` in raw HTML contributes no anchor
#     here, so a link to one is reported even though GitHub would resolve it.
#   * The slug algorithm below reproduces GitHub's output for every heading in
#     THIS corpus — it is not a general reimplementation of GitHub's slugger. A
#     heading using a shape the byte-wise rule mishandles (a Unicode letter
#     GitHub keeps and `LC_ALL=C` deletes) produces a *false positive* on the PR
#     that adds it. That is the acceptable direction: loud and on the author's
#     desk, never a silent pass.
#   * A path listed in git's index but absent from the working tree is skipped as
#     a source (same reason lint-shell.sh drops them: a `rm foo.md` you have not
#     staged yet must not make the gate report "broken").
#
# Unsupported markdown shapes, none of which exist in the corpus today, and every
# one of which surfaces as a REPORTED LINK rather than a silent pass — that
# direction is the whole reason a bash gate was preferred to a dependency
# (#127 plan; the failure class #101/#158 care about is silent-green):
#
#   * reference-style links `[text][ref]` — the `](…)` scan never sees them, so
#     the link goes unchecked; the definition line `[ref]: path` is likewise not
#     resolved. This is the one shape that fails QUIET, and it is called out here
#     because that makes it the shape to notice in review. That "one" is a claim
#     the fence rule below is load-bearing for, and it was briefly false: the
#     first cut toggled fenced state on any marker, so a `~~~` fence containing a
#     ` ``` ` line flipped parity and skipped every link after it, silently. The
#     close rule fixed that (#127 review cycle 1, pinned by harness cases 18-19),
#     which makes the claim true again.
#   * setext headings (`Title` underlined with `===`) contribute no anchor, so
#     links to them are reported.
#   * link titles — `](path "title")` — the title becomes part of the target,
#     which then fails as a whitespace-bearing malformed target.
#   * closing ATX sequences (`## Title ##`) slug with a trailing hyphen.
#   * multi-backtick code spans (``` ``…`` ```) are not stripped, so a link inside
#     one is checked rather than skipped.
#   * fences indented into a list item do not toggle fenced state — only a marker
#     in column 1 does — so such a block is scanned as prose. The corpus has five
#     such blocks in three files (docs/standards/typing.md x2,
#     docs/standards/react.md x1, .claude/skills/budget-sync/SKILL.md x2) and not
#     one of them contains a link or a column-1 heading. Column-1-only is the
#     deliberate choice rather than an oversight: recognising indented fences
#     would make a link inside one silently unchecked, and scanning one as prose
#     over-reports links — with one qualifier: a column-1 heading inside such a
#     block would also become a phantom anchor a link could resolve against.
#     None of the five blocks contains one; the census above is the evidence.
#   * angle-bracket destinations — `](<path>)`, the spelling CommonMark provides
#     for targets containing spaces — keep their brackets, so the target is
#     `<path>` and no listed file is spelled that way.
#   * percent-encoded paths — `](a%20b.md)` — are never decoded, so a link to a
#     file whose name really does contain a space is reported. (No file in this
#     repo has a space in its name, and the gate reporting one is a fair prompt to
#     keep it that way.)
#   * `#L12` line anchors and `?plain=1` query strings are GitHub-web-only
#     spellings with no on-disk meaning; a fragment on a non-markdown target is
#     reported as unverifiable rather than guessed at. None exist today.
#
# No dependencies: bash (3.2, which macOS ships as /bin/bash, so no associative
# arrays here — sets are newline-delimited strings and the slug cache is a file
# per target), git, tr, grep and mktemp only.
#
# Usage: bash .claude/scripts/check-markdown-links.sh [REPO_ROOT]
#        (or `pnpm check:markdown-links`)
#        REPO_ROOT defaults to the repo root above this script; the argument
#        exists so the test harness can point the gate at throwaway fixtures. It
#        must be the TOPLEVEL of a git work tree — discovery is `git ls-files`,
#        one code path for the repo and for fixtures alike.
# Exit:  0 every link resolves, 1 at least one is broken or malformed, 2 no
#        verdict reached (bad invocation, ROOT is not a work-tree toplevel, or a
#        vacuous census: no markdown files, or no links in them at all).
set -uo pipefail

# Byte-wise, not character-wise, and deliberately: the slug rule below deletes
# every byte outside `[a-z0-9 _-]`, which is what erases an em dash's three UTF-8
# bytes and leaves the double hyphen GitHub produces. Exported so `tr` agrees
# with bash's own pattern matching.
LC_ALL=C
export LC_ALL

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

if [ "$#" -gt 1 ]; then
  printf 'check-markdown-links: usage: check-markdown-links.sh [REPO_ROOT]\n' >&2
  exit 2
fi

ROOT=${1:-"$SCRIPT_DIR/../.."}
if [ ! -d "$ROOT" ]; then
  printf 'check-markdown-links: not a directory: %s\n' "$ROOT" >&2
  exit 2
fi
ROOT=$(cd "$ROOT" && pwd -P) || exit 2

# `git ls-files` reports paths relative to the work tree's toplevel, so pointing
# the gate at a subdirectory would silently validate every link against the wrong
# base. Refuse rather than resolve: a toplevel is the only input this discovery
# path is correct for. `pwd -P` on both sides so a symlinked ROOT still compares.
git_top=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null) || {
  printf 'check-markdown-links: not inside a git work tree: %s\n' "$ROOT" >&2
  exit 2
}
git_top=$(cd "$git_top" && pwd -P) || exit 2
if [ "$git_top" != "$ROOT" ]; then
  printf 'check-markdown-links: %s is not a git work-tree toplevel (that is %s)\n' \
    "$ROOT" "$git_top" >&2
  exit 2
fi

TMP=$(mktemp -d) || exit 2
trap 'rm -rf "$TMP"' EXIT
# Slug caches get their own directory so no encoded path can ever collide with
# write_slugs' scratch file, whatever a markdown file in the repo is called.
mkdir "$TMP/slugs" || exit 2

errors=0
fail() {
  printf '  ERROR %s\n' "$1" >&2
  errors=$((errors + 1))
}

NL='
'

# --- discovery ----------------------------------------------------------------------------
#
# One population rule, `--cached --others --exclude-standard`: tracked files plus
# untracked ones git is not ignoring. --others matters both ways — a doc you have
# just written is exactly the one whose links you want checked, and a file you
# have just added is exactly the target a new link points at. --exclude-standard
# is what keeps node_modules/ and .claude/worktrees/ out of both lists, and it is
# also the rule that makes a link to a GITIGNORED file fail: git does not list it,
# so it is not a valid target — which is honest, because GitHub 404s it too.

all_files=$(git -C "$ROOT" ls-files --cached --others --exclude-standard -z | tr '\0' '\n') || exit 2
md_files=$(git -C "$ROOT" ls-files --cached --others --exclude-standard -z -- '*.md' | tr '\0' '\n') || exit 2

# Bracketed with newlines so `*"$NL$x$NL"*` is an exact whole-line match, and
# `*"$NL$x/"*` is "some listed path lives under this directory". Both are literal
# because the expansion is quoted inside the pattern — a target containing a glob
# character cannot match anything but itself.
ALL="$NL$all_files$NL"

# --- heading slugs ------------------------------------------------------------------------

# The fence rule, defined once because both passes below have to agree on it: if
# the link scan and the heading scan disagreed about which lines are code, a
# heading could exist for one and not the other.
#
# Fenced state is a PAIR — the opening marker's character and its run length —
# rather than a boolean, and CommonMark's close rule is why: a fence ends only on
# a run of the SAME character at least as long as the one that opened it. A
# ` ``` ` line inside a `~~~` fence, or a three-backtick line inside a
# four-backtick one, is fence CONTENT. A boolean toggling on any marker flips
# parity there and then silently skips every link in the rest of the file —
# exactly the silent-green class this gate exists to catch (harness cases 18-19
# are the two shapes).
#
# Only a marker in column 1 is considered at all; see the header's residual list.
# The one place this still parts company with CommonMark is a closing run that
# carries an info string (` ```sh ` closing a ` ``` ` fence), which the spec calls
# content and this rule calls a close — ending a fence early over-reports for
# LINKS, but for HEADINGS it can mint a phantom anchor (a column-1 `# ` line in
# the prematurely-ended fence body becomes a slug a link resolves against where
# GitHub would 404). No corpus fence nests a marker today; the trade-off is
# accepted because the alternative (treating info-string closes as content)
# would leave real links inside mis-closed fences silently unchecked.
#
# In: <line> and the current pair. Out: 0 when <line> is a marker that changes
# state, with the new pair in fence_next_char/fence_next_len (the `norm_result`
# convention above — bash 3.2 has no other way to return two values without a
# subshell per line); 1 when the line is not a state change, i.e. prose or the
# fence content the close rule just protected.
fence_next_char=""
fence_next_len=0
fence_transition() { # fence_transition <line> <cur-char> <cur-len>
  local line="$1" cur_char="$2" cur_len="$3" ch rest len
  case "$line" in
    '```'*) ch='`' ;;
    '~~~'*) ch='~' ;;
    *) return 1 ;;
  esac

  # The run length, peeled one character at a time. The pattern-based spelling
  # (`${line%%[!x]*}`, as the heading parser uses for `#`) would need the marker
  # character interpolated into a pattern, and a backtick reaching a pattern that
  # way is a trap not worth setting to save three lines.
  len=0
  rest="$line"
  while [ "${rest#"$ch"}" != "$rest" ]; do
    rest=${rest#"$ch"}
    len=$((len + 1))
  done

  if [ -z "$cur_char" ]; then
    fence_next_char="$ch"
    fence_next_len="$len"
    return 0
  fi
  if [ "$ch" = "$cur_char" ] && [ "$len" -ge "$cur_len" ]; then
    fence_next_char=""
    fence_next_len=0
    return 0
  fi
  return 1
}

# Writes <file>'s anchor set, one slug per line, in document order.
#
# The algorithm, verified against every anchor link in the repo during planning:
# lowercase ASCII; delete every byte not in [a-z0-9 _-]; each remaining space
# becomes one hyphen; a slug already seen takes the lowest free `-1`, `-2`, …
# suffix. Two consequences worth stating because they look like bugs: `—` (em
# dash) sits between two spaces and vanishes, leaving `--`; and a run of deleted
# punctuation between words leaves however many spaces surrounded it.
write_slugs() { # write_slugs <abs-md-file> <out-file>
  local src="$1" out="$2" line hashes rest text slug cand n seen=""
  # Declared local so a nested call from inside the link scan cannot disturb the
  # scan's own fence state (bash scoping is dynamic).
  local fence_char="" fence_len=0

  # One `tr` per file rather than one per heading: the whole file is lowercased
  # up front and the loop then does pure parameter expansion. Fences and `#` are
  # ASCII punctuation, so case-folding first cannot change what the loop parses.
  tr '[:upper:]' '[:lower:]' <"$src" >"$TMP/lowercased" || return 1

  while IFS= read -r line || [ -n "$line" ]; do
    if fence_transition "$line" "$fence_char" "$fence_len"; then
      fence_char="$fence_next_char"
      fence_len="$fence_next_len"
      continue
    fi
    [ -z "$fence_char" ] || continue
    case "$line" in
      '#'*) ;;
      *) continue ;;
    esac

    hashes=${line%%[!#]*}
    rest=${line#"$hashes"}
    # ATX is one to six hashes followed by a space. `#!/usr/bin/env bash` and
    # `#### #### ####` are not headings, and neither is a bare run of hashes.
    [ "${#hashes}" -le 6 ] || continue
    case "$rest" in
      ' '*) ;;
      *) continue ;;
    esac

    text=${rest#"${rest%%[![:space:]]*}"}
    text=${text%"${text##*[![:space:]]}"}
    slug=${text//[!a-z0-9 _-]/}
    slug=${slug// /-}

    cand=$slug
    n=0
    while :; do
      case "$NL$seen" in
        *"$NL$cand$NL"*) ;;
        *) break ;;
      esac
      n=$((n + 1))
      cand="$slug-$n"
    done
    seen="$seen$cand$NL"
  done <"$TMP/lowercased"

  printf '%s' "$seen" >"$out"
}

# Prints the cache file holding <rel>'s anchor set, computing it on first use.
# infra/README.md is both the densest link source and the most-linked target, so
# without the cache its ~1,600 lines would be re-slugged once per inbound link.
# bash 3.2 has no associative arrays; the key is the repo-relative path with `%`
# and `/` percent-encoded, which is injective and leaves a legal filename.
slug_cache_for() { # slug_cache_for <rel-md-path>
  local rel="$1" key
  key=${rel//%/%25}
  key=${key//\//%2F}
  if [ ! -f "$TMP/slugs/$key" ]; then
    write_slugs "$ROOT/$rel" "$TMP/slugs/$key" || return 1
  fi
  printf '%s' "$TMP/slugs/$key"
}

# --- target resolution --------------------------------------------------------------------

# Resolves <path> against <dir> (the source file's directory, "" at the repo
# root) purely lexically — no filesystem, so a `..` that would be swallowed by a
# symlink is still counted as leaving the repo, and a nonexistent target still
# normalizes. Sets `norm_result`; returns 1 when the path escapes the root.
#
# Escaping is refused as a rule, not diagnosed as a 404: github.com's blob view
# does resolve `../..` above the repo root against the org path (README.md's old
# `[issues](../../issues)` worked). The rule stands because such a target is
# unresolvable from the on-disk tree this gate can see, and because the same
# markdown is read in contexts — a local editor, a mirror, a docs site — where it
# resolves to something else or to nothing.
norm_result=""
normalize_path() { # normalize_path <dir-rel> <path>
  local dir="$1" path="$2" combined rest seg out=""
  case "$path" in
    # GitHub reads a leading slash as repo-root-relative, not filesystem-absolute.
    /*) combined=${path#/} ;;
    *)
      if [ -n "$dir" ]; then combined="$dir/$path"; else combined="$path"; fi
      ;;
  esac
  rest="$combined"
  while [ -n "$rest" ]; do
    seg=${rest%%/*}
    if [ "$seg" = "$rest" ]; then rest=""; else rest=${rest#*/}; fi
    case "$seg" in
      '' | '.') ;;
      '..')
        # Nothing left to pop means the link has walked out of the repository.
        [ -n "$out" ] || return 1
        case "$out" in
          */*) out=${out%/*} ;;
          *) out="" ;;
        esac
        ;;
      *)
        if [ -n "$out" ]; then out="$out/$seg"; else out="$seg"; fi
        ;;
    esac
  done
  norm_result="$out"
  return 0
}

SCHEME_RE='^[A-Za-z][A-Za-z0-9+.-]*:'

# Every link found outside code, classified and resolved. <where> is the
# `file:line` the error message has to point at.
check_link() { # check_link <src-rel> <where> <target>
  local src="$1" where="$2" target="$3"
  local path frag norm cache srcdir

  # A URI scheme — http, https, mailto, and anything else RFC 3986 spells the
  # same way. Out of scope by design (see the header): counted, never resolved.
  if [[ $target =~ $SCHEME_RE ]]; then
    external=$((external + 1))
    return 0
  fi

  if [ -z "$target" ]; then
    fail "$where has an empty link target — '](…)' with nothing in it"
    return 0
  fi
  case "$target" in
    *[[:space:]]*)
      fail "$where links to '$target', which contains whitespace (a link title, or a broken link)"
      return 0
      ;;
  esac

  # Same-file anchor.
  case "$target" in
    '#'*)
      frag=${target#\#}
      if [ -z "$frag" ]; then
        fail "$where links to '#', which names no heading"
        return 0
      fi
      cache=$(slug_cache_for "$src") || {
        fail "$where could not read headings from $src"
        return 0
      }
      if ! grep -Fxq -e "$frag" "$cache"; then
        fail "$where links to '$target', but $src has no heading with that anchor"
      fi
      return 0
      ;;
  esac

  # `path` is necessarily non-empty here: an empty one means a leading `#`, which
  # the same-file-anchor arm above has already returned on.
  path=${target%%#*}
  case "$target" in
    *'#'*) frag=${target#*\#} ;;
    *) frag="" ;;
  esac

  # `${src%/*}` alone would hand back the filename for a root-level source such
  # as README.md, silently resolving every one of its links one level too deep.
  srcdir=""
  case "$src" in
    */*) srcdir=${src%/*} ;;
  esac
  if ! normalize_path "$srcdir" "$path"; then
    fail "$where links to '$target', which escapes the repository root"
    return 0
  fi
  norm=$norm_result

  # `docs/..` and `.` both land here: the repo root itself, which exists.
  if [ -z "$norm" ]; then
    if [ -n "$frag" ]; then
      fail "$where links to '$target': a fragment on a directory cannot be checked"
    fi
    return 0
  fi

  case "$ALL" in
    *"$NL$norm$NL"*)
      # A file git lists. Note the match is on the listing, not on `-e`: macOS's
      # case-insensitive filesystem would happily open Readme.md, and GitHub and
      # every Linux CI runner would not.
      if [ -z "$frag" ]; then
        return 0
      fi
      case "$norm" in
        *.md) ;;
        *)
          fail "$where links to '$target': a fragment on a non-markdown file cannot be checked"
          return 0
          ;;
      esac
      if [ ! -f "$ROOT/$norm" ]; then
        fail "$where links to '$target', but $norm is not present in the working tree to read headings from"
        return 0
      fi
      cache=$(slug_cache_for "$norm") || {
        fail "$where could not read headings from $norm"
        return 0
      }
      if ! grep -Fxq -e "$frag" "$cache"; then
        fail "$where links to '$target', but $norm has no heading with that anchor"
      fi
      return 0
      ;;
  esac

  case "$ALL" in
    *"$NL$norm/"*)
      if [ -n "$frag" ]; then
        fail "$where links to '$target': a fragment on a directory cannot be checked"
      fi
      return 0
      ;;
  esac

  fail "$where links to '$target', and $norm is not a file or directory git lists (missing, or ignored)"
}

# --- the scan -----------------------------------------------------------------------------

files=0
links=0
external=0

while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  # See the header: a path in the index need not be in the working tree.
  [ -f "$ROOT/$rel" ] || continue
  files=$((files + 1))

  fence_char=""
  fence_len=0
  lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    if fence_transition "$line" "$fence_char" "$fence_len"; then
      fence_char="$fence_next_char"
      fence_len="$fence_next_len"
      continue
    fi
    [ -z "$fence_char" ] || continue

    # Strip inline code spans before scanning, shortest match, repeatedly: a
    # backtick span is prose about a link, not a link. docs/adr/README.md:9
    # documents the ADR index row shape as `- [NNNN — Title](NNNN-slug.md)`,
    # which names a file that has never existed. Each pass removes exactly two
    # backticks, so the loop shortens the line every time.
    stripped=$line
    while :; do
      case "$stripped" in
        *'`'*'`'*) ;;
        *) break ;;
      esac
      before=${stripped%%'`'*}
      after=${stripped#*'`'}
      stripped="$before${after#*'`'}"
    done

    rest=$stripped
    while :; do
      case "$rest" in
        *']('*) ;;
        *) break ;;
      esac
      rest=${rest#*"]("}
      case "$rest" in
        *')'*) ;;
        *)
          # An opening `](` with no `)` on the same line. Multi-line links are
          # not supported, and the header says so; this is that shape arriving.
          fail "$rel:$lineno has a '](' that is never closed on the same line"
          break
          ;;
      esac
      target=${rest%%")"*}
      rest=${rest#*")"}
      links=$((links + 1))
      check_link "$rel" "$rel:$lineno" "$target"
    done
  done <"$ROOT/$rel"
done <<EOF
$md_files
EOF

# --- census -------------------------------------------------------------------------------
#
# A check that passes because it found nothing to check is indistinguishable from
# a check that works. Both halves have to be non-vacuous: markdown files were
# discovered, and links were extracted from them.
#
# The order matters, and the middle clause is why. A malformed link — a `](` with
# no closing `)` — is reported but never counted, because nothing was extracted
# from it. A repo whose only link-like text was malformed would therefore reach
# the link census with errors>0 and links=0, and answering "the extractor is
# broken" (2) would bury findings the extractor had just made. A reported problem
# is itself proof the extractor ran, so a verdict of 1 outranks the vacuity guard;
# only a genuinely silent run (no errors, no links) is a no-verdict.

if [ "$files" = 0 ]; then
  printf 'check-markdown-links: no markdown files found in %s — the discovery filter is broken, not the repo\n' \
    "$ROOT" >&2
  exit 2
fi

if [ "$errors" != 0 ]; then
  printf '\ncheck-markdown-links: %d broken link(s) across %d markdown file(s) in %s\n' \
    "$errors" "$files" "$ROOT" >&2
  exit 1
fi

if [ "$links" = 0 ]; then
  printf 'check-markdown-links: found %d markdown file(s) but extracted no links at all from %s — the extractor is broken, not the repo\n' \
    "$files" "$ROOT" >&2
  exit 2
fi

printf 'check-markdown-links: OK — %d markdown file(s), %d link(s) checked (%d external, skipped) (%s)\n' \
  "$files" "$links" "$external" "$ROOT"
