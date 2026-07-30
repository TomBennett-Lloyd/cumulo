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

    # The `sub` condition is the actual security boundary. Its shape is
    # `repo:<owner>/<repo>:<ref-or-environment-claim>`, and the owner and repo
    # segments must stay literal — a wildcard anywhere left of the last colon
    # (`repo:*`, `repo:TomBennett-Lloyd/*`) reopens exactly the hole the `aud`
    # check above fails to close, while still looking like a condition block
    # that does something.
    #
    # Only the trailing claim is wildcarded, so any branch, tag, pull request or
    # environment in this one repo may assume the role. That is the right scope
    # while the role has no permissions attached; narrowing it per branch or
    # environment is tracked as follow-up work and becomes necessary at the same
    # moment the first deploy permission is granted.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:*"]
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
