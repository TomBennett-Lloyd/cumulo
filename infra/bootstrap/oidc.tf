resource "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"

  # The only audience GitHub's official credential action requests.
  client_id_list = ["sts.amazonaws.com"]

  # thumbprint_list is deliberately not set. IAM validates
  # token.actions.githubusercontent.com against its own trusted root CA library
  # and populates this field itself; pinning a leaf thumbprint here would buy no
  # security and schedule an outage for GitHub's next certificate rotation.
}

locals {
  # The workflow files under .github/workflows/ that may assume the deploy role.
  # .claude/scripts/check-oidc-workflows.sh reads this list; keep one quoted
  # file name per line.
  deploy_role_workflows = [
    "deploy-api.yml",
    "deploy-forecast.yml",
    "deploy-ingestion.yml",
    "deploy-web.yml",
    "oidc-smoke.yml",
  ]
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

    # The `sub` condition is the security boundary: these workflow files, as
    # they are on main, running in main's branch context — one exact value per
    # file, no wildcard. It holds only under the repository's customised subject
    # template (repo, context, job_workflow_ref); the switch and its ordering are
    # infra/README.md's "Runbook: switch the OIDC subject template" (#605).
    # Nothing an unmerged contributor controls belongs in this list (#7, #11);
    # .claude/scripts/check-oidc-workflows.sh is its gate.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        for workflow in local.deploy_role_workflows :
        "${var.github_subject_prefix}:ref:refs/heads/main:job_workflow_ref:${var.github_repository}/.github/workflows/${workflow}@refs/heads/main"
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
