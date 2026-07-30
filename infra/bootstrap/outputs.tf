# These outputs are the only sanctioned source for the values the runbook feeds
# into backend.hcl and the GitHub repo variables — read them with
# `terraform output`, never hand-construct them from an account id.
#
# Three of the five embed the AWS account id. It is an identifier rather than a
# credential, so it is not marked `sensitive` (that would only make the runbook
# reach for `-raw` everywhere while protecting nothing), but it stays out of the
# public repo by decision: do not paste raw output into committed files, PR
# bodies, or issue comments. See infra/README.md.

output "state_bucket_name" {
  description = "S3 bucket holding Terraform state for every Cumulo stack (key: <stack>/terraform.tfstate). Goes in backend.hcl."
  value       = aws_s3_bucket.tfstate.bucket
}

output "github_oidc_provider_arn" {
  description = "ARN of the IAM OIDC provider for GitHub Actions."
  value       = aws_iam_openid_connect_provider.github.arn
}

output "github_actions_role_arn" {
  description = "ARN of the role GitHub Actions assumes. Published to the repo variable AWS_OIDC_ROLE_ARN."
  value       = aws_iam_role.github_actions.arn
}

output "aws_region" {
  description = "Region this stack was applied to (echoes var.aws_region). Exists so runbook step B6 can publish the AWS_REGION repo variable with `terraform output -raw aws_region` instead of a retyped literal that could drift from backend.hcl."
  value       = var.aws_region
}

output "aws_account_id" {
  description = "Account the stack was applied to. Confirm this matches the intended account before trusting anything else here."
  value       = data.aws_caller_identity.current.account_id
}
