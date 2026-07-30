# Table names are safe to quote anywhere; the ARNs embed the AWS account id.
# Per infra/README.md convention 7, do not paste raw ARN output into committed
# files, PR bodies, or issue comments — quote the shape
# (`arn:aws:dynamodb:<region>:<account-id>:table/cumulo-series-dev`), not the
# digits. They are not marked `sensitive`: the account id is an identifier
# rather than a credential, and marking it would only push every consumer to
# `-raw` while protecting nothing.
#
# Maps rather than one output per table, keyed by the same four words the
# adapters use (`StorageTable` in @cumulo/storage): a consumer that gains a
# table gains a map entry, not a new output name to wire up.

output "table_names" {
  description = "DynamoDB table names by concept. Matches storageTableName() in @cumulo/storage — cumulo-<table>-<environment>."
  value = {
    sites   = aws_dynamodb_table.sites.name
    series  = aws_dynamodb_table.series.name
    weather = aws_dynamodb_table.weather.name
    metrics = aws_dynamodb_table.metrics.name
  }
}

output "table_arns" {
  description = "DynamoDB table ARNs by concept. These are the least-privilege boundaries for the service IAM policies that arrive with the deploy tickets (ADR 0001): ingestion reads sites and writes weather; forecast reads sites and weather and writes series and metrics; the fleet API writes sites and reads the rest. Contains the account id — see the note in outputs.tf."
  value = {
    sites   = aws_dynamodb_table.sites.arn
    series  = aws_dynamodb_table.series.arn
    weather = aws_dynamodb_table.weather.arn
    metrics = aws_dynamodb_table.metrics.arn
  }
}

output "sites_index_arns" {
  description = "ARNs of the two sites GSIs. A policy granting Query on a table does not cover its indexes — an index ARN is the table ARN plus /index/<name> — so the forecast service's read grant needs by-location listed explicitly. Contains the account id."
  value = {
    "by-location"       = "${aws_dynamodb_table.sites.arn}/index/by-location"
    "user-sites-by-age" = "${aws_dynamodb_table.sites.arn}/index/user-sites-by-age"
  }
}

output "environment" {
  description = "Environment suffix this stack was applied with (echoes var.environment). Exists so the smoke script and future deploy steps can read the value Terraform actually used instead of a retyped literal that could drift from storage.auto.tfvars."
  value       = var.environment
}
