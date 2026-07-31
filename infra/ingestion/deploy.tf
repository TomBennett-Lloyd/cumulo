# The deploy grant: the two Lambda API calls that
# .github/workflows/deploy-ingestion.yml makes, on this stack's function, and
# nothing else.
#
# This is the FIRST permission ever attached to `cumulo-github-actions`, and
# attaching it is what forced the trust-policy change in the same pull request
# (infra/bootstrap/oidc.tf, infra/README.md convention 8): the role was
# assumable from a PR context only while it granted nothing, and a PR-context
# run is triggerable by any fork author. Only pushes to main may assume it now.
#
# It lives in this stack rather than in bootstrap because of ADR 0001: a
# resource exactly one service would notice belongs to that service's stack.
# The practical consequence is the one worth having — `terraform destroy` here
# takes the deploy permission with it, so a torn-down service cannot leave a
# live grant behind on a role that outlives it.

# Bootstrap creates this role; this stack only attaches to it. Looked up by
# name, for the same reason iam.tf assembles table ARNs rather than reading
# storage's outputs: a `terraform_remote_state` data source would give this
# stack read access to the whole of bootstrap's state — which includes the
# account id and every output — to learn one string it already knows. The
# coupling is a naming convention, not a wire.
#
# Unlike the DynamoDB names, this one is a real prerequisite rather than a
# runtime one: bootstrap is already applied before this stack (its state lives
# in bootstrap's bucket), and if it somehow were not, this data source fails at
# plan time naming the missing role. `terraform validate` never reads data
# sources, so CI still validates this stack without an AWS call.
data "aws_iam_role" "github_actions" {
  name = "cumulo-github-actions"
}

data "aws_iam_policy_document" "github_actions_deploy" {
  # Two actions, one resource. `lambda:UpdateFunctionCode` is the deploy itself;
  # `lambda:GetFunction` is what the workflow's `wait function-updated-v2`
  # polls, so the run fails loudly on a rejected update instead of exiting green
  # the moment the API accepted the upload.
  #
  # What is deliberately absent is the whole of the rest of the Lambda API.
  # There is no `lambda:UpdateFunctionConfiguration`, so a workflow cannot move
  # the timeout, the memory, the environment variables, or the execution role
  # out from under Terraform — the code is the one field CI owns and every other
  # field stays a reviewable diff in this directory. There is no
  # `lambda:InvokeFunction` either: deploying is not running.
  statement {
    sid = "UpdateIngestionFunctionCode"
    actions = [
      "lambda:UpdateFunctionCode",
      "lambda:GetFunction",
    ]

    # The resource attribute, not an assembled string: it is the unqualified
    # function ARN the API expects, and reading it from the resource keeps the
    # account id out of this repository entirely (infra/README.md convention 7)
    # without even the interpolation iam.tf needs for the storage stack's
    # tables. A `*` here would grant deploy rights over every function in the
    # account, including ones later tickets have not written yet.
    resources = [aws_lambda_function.ingestion.arn]
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  # The environment suffix is in the *policy* name, not just the function name
  # it grants on, because the role is shared and this stack is not a singleton:
  # applying ingestion a second time with `environment = "staging"` must add a
  # second inline policy rather than silently overwrite the first one and leave
  # the dev function undeployable.
  name = "cumulo-ingestion-deploy-${var.environment}"

  role   = data.aws_iam_role.github_actions.name
  policy = data.aws_iam_policy_document.github_actions_deploy.json
}
