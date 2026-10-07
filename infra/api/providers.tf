provider "aws" {
  region = var.aws_region

  # Every resource in every Cumulo stack carries these three tags. `Stack`
  # names the directory under infra/, which is also the state key prefix, so a
  # resource in the console traces back to the code that owns it.
  default_tags {
    tags = {
      Project   = "cumulo"
      ManagedBy = "terraform"
      Stack     = "api"
    }
  }
}

# us-east-1, for the one resource family AWS keeps there: billing metrics, and
# so the billing-trip alarm and the topic it must publish to (cost-guard.tf).
# Same tags, same stack — those resources belong to the api stack wherever they
# live.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "cumulo"
      ManagedBy = "terraform"
      Stack     = "api"
    }
  }
}
