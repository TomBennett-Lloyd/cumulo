resource "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"

  # The only audience GitHub's official credential action requests.
  client_id_list = ["sts.amazonaws.com"]

  # thumbprint_list is deliberately not set. IAM validates
  # token.actions.githubusercontent.com against its own trusted root CA library
  # and populates this field itself; pinning a leaf thumbprint here would buy no
  # security and schedule an outage for GitHub's next certificate rotation.
}

data "aws_iam_policy_document" "github_actions_trust" {
  statement {
    sid     = "GitHubActionsAssumeViaOIDC"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    # Checking `aud` is necessary but nowhere near sufficient, and mistaking it
    # for sufficient is *the* classic GitHub-OIDC failure: every Actions token
    # on GitHub carries aud=sts.amazonaws.com, so a trust policy that stops here
    # lets any repository in the world assume this role.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # The `sub` condition is the actual security boundary, and its shape is the
    # one thing most GitHub-OIDC material gets wrong. The tokens this repo's
    # runners actually present carry GitHub's *immutable* subject —
    # `repo:<owner>@<owner-id>/<repo>@<repo-id>:<claim>` — embedding the numeric
    # owner and repository ids. The name-only form
    # (`repo:TomBennett-Lloyd/cumulo:...`) that nearly every tutorial shows is
    # stale; a policy written that way matches nothing and every assume fails.
    # The prefix comes from `var.github_subject_prefix`, which is read from
    # GitHub, not assembled from the repo name (see variables.tf).
    #
    # Embedding ids is strictly *stronger* than naming the repo. Names are
    # reassignable: rename this repo or this org and the freed name is available
    # to anyone, whose new repo would then mint tokens matching a name-based
    # policy. Numeric ids are never reissued, so a rename can move the repo but
    # cannot transfer this trust to a stranger.
    #
    # The owner and repo segments must stay literal — a wildcard anywhere left
    # of the last colon reopens exactly the hole the `aud` check above fails to
    # close, while still looking like a condition block that does something.
    #
    # The trailing claim is an exact-match allowlist rather than a `:*`
    # wildcard: a wildcard would let *any* workflow context in this repo assume
    # the role, including tags, non-main branch refs, and whatever event
    # contexts GitHub adds to the `sub` claim in future. One value, no more:
    # **only a push to `main` may assume this role.**
    #
    # That one value used to be two. A PR-context subject sat alongside it for
    # exactly one reason — so the `oidc-smoke` check could run pre-merge — and
    # that was safe only while this role had ZERO attached permissions:
    # assuming it proved the trust path and granted nothing. The comment that
    # used to be here said the change attaching the first permission had to
    # delete that entry in the same PR. Issue #11 attached it
    # (`infra/ingestion/deploy.tf`, updating the ingestion function's code), so
    # the entry is gone. A PR-context run is triggerable by any fork author, so
    # it must never hold deploy permissions (issue #7 security constraints,
    # 2026-07-30).
    #
    # THE RULE OUTLIVES ITS FIRST APPLICATION. Nothing an unmerged contributor
    # controls goes back in this list — not a PR context, not a branch pattern,
    # not a workflow-dispatch-from-a-fork context. Pre-merge OIDC coverage is
    # what was traded away here; recovering it needs a *second* role that is
    # permanently permissionless, not a second entry here. See the header
    # comment in .github/workflows/oidc-smoke.yml.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${var.github_subject_prefix}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name        = "cumulo-github-actions"
  description = "Assumed by GitHub Actions in ${var.github_repository} via OIDC. Deploy permissions are attached per service by later tickets."

  assume_role_policy = data.aws_iam_policy_document.github_actions_trust.json

  # One hour: a workflow that needs longer than this has a different problem.
  max_session_duration = 3600

  # This stack still attaches nothing — no inline policies, no managed policy
  # attachments — and that is by design rather than by not having got round to
  # it: the smoke test this role exists to prove (`aws sts get-caller-identity`)
  # requires zero permissions, so the bootstrap was verifiable end to end before
  # a single grant existed.
  #
  # Grants now do exist. Each service ticket attaches its own least-privilege
  # policy for the resources it owns, from its own stack (ADR 0001:
  # infrastructure ownership follows service boundaries) — `#11` was the first,
  # in `infra/ingestion/deploy.tf`. Keeping them there rather than here is what
  # makes `terraform destroy` on a service take that service's deploy rights
  # with it, and a broad deploy policy in this file would undo all of it.
  #
  # The consequence for anyone reading this file for the role's real
  # permissions: they are not in it, and never will be. The account is the only
  # complete answer —
  # `aws iam list-role-policies --role-name cumulo-github-actions`.
}
