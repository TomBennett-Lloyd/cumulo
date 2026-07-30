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
    # contexts GitHub adds to the `sub` claim in future. Two values, no more.
    #
    # The `pull_request` entry exists for exactly one reason: the `oidc-smoke`
    # check must be able to run pre-merge, and it can only do that while this
    # role has ZERO attached permissions (see below) — assuming it proves the
    # trust path and grants nothing.
    #
    # THEREFORE: the PR that attaches the first permission to this role MUST
    # delete the `pull_request` line in the same change. A pull_request-context
    # run is triggerable by any fork PR author, so it must never hold deploy
    # permissions (issue #7 security constraints, 2026-07-30).
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "${var.github_subject_prefix}:ref:refs/heads/main",
        "${var.github_subject_prefix}:pull_request",
      ]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name        = "cumulo-github-actions"
  description = "Assumed by GitHub Actions in ${var.github_repository} via OIDC. Deploy permissions are attached per service by later tickets."

  assume_role_policy = data.aws_iam_policy_document.github_actions_trust.json

  # One hour: a workflow that needs longer than this has a different problem.
  max_session_duration = 3600

  # No inline policies and no managed policy attachments, by design. The smoke
  # test this role exists to prove (`aws sts get-caller-identity`) requires zero
  # permissions, so the bootstrap can be verified end to end without granting
  # anything. Each later service ticket attaches its own least-privilege policy
  # for the resources it owns (ADR 0001: infrastructure ownership follows
  # service boundaries) — a broad deploy policy here would undo that.
}
