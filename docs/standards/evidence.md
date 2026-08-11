# Evidence standards

**Trigger:** offering command output — a grep, an exit status, a diff — as evidence that something worked, that something matches, or that nothing remains.

Every idiom catalogued below printed something that read as proof and was not. Use the sanctioned forms; when you recognise a member of the catalogue, replace it rather than annotate it.

## Sanctioned forms

1. **Capture, then read.** `cmd > out 2>&1; rc=$?; tail out; echo RC=$rc`. Capture `$?` on the line immediately after the command, before anything else can overwrite it, and report the number. Never read a pipeline's exit status as the status of the command that mattered.

2. **Counts are numbers, not statuses.** `n=$(command grep -cE <pat> <file>)`, then echo or compare `$n`. Never `command grep -c <pat> <file> && <next>`.

3. **Removal counts come from `git diff --numstat`**, which counts lines structurally, rather than from a pattern matched against diff text.

4. **Verify a write by reading it back.** A write made through an API is unproven until the resource is fetched again and inspected. A returned URL and a zero exit prove the request was accepted, not that the intended content landed.

5. **Every emptiness claim ships with a positive control** — the same pattern, run in the same report against a case known to contain a match. Without it, "no occurrences remain" and "my pattern is broken" produce identical output.

## Member catalogue

1. **A pipe's exit status is its last command's.** `… | grep | head; rc=$?` reports `head`'s status, and `head` almost always succeeds. A piped `pnpm verify | grep | head` reported green over a failed `format:check` (#166), and `gh pr update-branch` / `gh pr merge` failures read as success through a piped tail (#224). The form is treacherous enough to be fallen into while quoting the rule against it (#331). Replacement: sanctioned form 1 — redirect to a file, capture `$?`, then read the file.

2. **`command grep -c <pat> <file> && <next>`.** `grep -c` exits 1 on a legitimate zero even though it printed `0` and answered the question correctly, so the `&&` chain stops silently while the visible output looks successful (#295). Replacement: sanctioned form 2 — assign the count to a variable and read it as a number.

3. **`diff -q backup file`.** It proves the two files match; it does not prove the backup holds the content you intended to preserve. Against a backup already clobbered by a concurrent writer in the shared scratchpad it passes identically (#295). Replacement: assert content, not equality — read the backup and check for a known marker of the intended version.

4. **`git diff | grep '^-[^-]'` as a removal check.** Removed markdown list items render as `--` in the diff and match nothing, producing a false "no removals"; the error surfaced only because a `--numstat` count disagreed (#368). Replacement: sanctioned form 3.

5. **Bare `grep` is ugrep on this machine, and it searches a narrower set of files than you asked for.** The shim invokes `ugrep … --ignore-files --hidden -I --exclude-dir=.git`, so a recursive bare `grep` honours `.gitignore` and skips binary files: it answers "is it in the tracked tree?" while the caller asked "is it anywhere?", and an untracked or ignored hit vanishes with no sign that anything was skipped. Fixture: in a repo whose `.gitignore` lists `ignored.txt`, `grep -rn 'needle' .` returned only `tracked.txt` where `command grep -rn 'needle' .` returned both files. The pattern engine is not the trap — the same fixture's `grep -E 'alpha|gamma'` is byte-identical under both, as are anchored, `-i`, `-w` and `{n,m}` shapes — so the file set is the thing to distrust. #206 is the incident this rule was written from. Replacement: every evidence grep runs as `command grep -E`.

6. **A BRE alternation with `$` anchors, on BSD grep.** In `'^<<<<<<<\|^=======$\|^>>>>>>>'` the `$` anchors the whole pattern rather than its branch, so a lone `=======` line is invisible (#396). A laundered conflict marker shipped through #211 on exactly this hole and was found only in #253. Replacement: write marker sweeps as ERE — `command grep -nE '^(<<<<<<<|=======|>>>>>>>)'`.

7. **An emptiness claim with no positive control** is indistinguishable from a broken pattern: "nothing remains" and "this pattern never matched anything" print the same empty output, and nothing in the output tells them apart. Members 5 and 6 above are each a way the second happens while looking like the first — a silently narrowed file set, and an anchor binding the wrong scope. Replacement: sanctioned form 5 — the same pattern, in the same report, run against a case known to hold a match.

8. **`git diff --check` is staging-sensitive — and `--cached` is its exact mirror, not its fix.** The bare form reads unstaged worktree changes only, so once resolved files are `git add`-ed — which `git rebase --continue` requires — it exits 0 having inspected nothing (fixture-reproduced, #414 review cycle 3). `git diff --cached --check` reads staged content only, so it returns that same silent zero on the same defect whenever the sweep runs _before_ `git add`: one blind spot traded for its mirror. Replacement: **`git diff HEAD --check`**, which reads staged and unstaged content together and so is correct in both states. Fixture (branch `412-workflow-debt-batch`, review cycle 3) — one tracked file carrying a trailing space and three conflict markers, exit codes: unstaged, bare `2` / `--cached` `0` / `HEAD` `2`; after `git add`, bare `0` / `--cached` `2` / `HEAD` `2`. What no form of `diff --check` sees is an **untracked** file — the same marker-laden file gives `HEAD` `0` before it is added and `2` after — so a resolution that creates a new file is covered only once that file is staged. General lesson: name the state a check is asserted in, and confirm the check reads that state.

9. **`gh api -X PATCH … -f body=@file` does not expand `@file`.** It writes the literal path string as the body and exits 0, so an `||` fallback never fires (owner, #412 comment 2). Replacement: `-F body=@file` is the expanding form — and confirm it by readback, sanctioned form 4, which is how the failure was caught.

## Adding a member

Adding a member is one entry on this page and zero edits anywhere else. Agent and skill files cite this page by path (`docs/standards/evidence.md`) and never restate a member's rationale — a restated rule drifts from the page, and then two claims about the same idiom disagree with each other.

## Why

Agent-run work is trusted on the strength of pasted output, so an idiom that reports success independently of the thing being tested does not merely fail: it converts a broken change into a confident DONE, and the failure surfaces downstream where it is expensive. Each member here cost at least one such cycle. The sanctioned forms all share one property — the number that reaches the report is produced by the check itself, not by whatever ran last.
