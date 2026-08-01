provider "aws" {
  region = var.aws_region

  # Every resource in every Cumulo stack carries these three tags. `Stack`
  # names the directory under infra/, which is also the state key prefix, so a
  # resource in the console traces back to the code that owns it.
  default_tags {
    tags = {
      Project   = "cumulo"
      ManagedBy = "terraform"
      Stack     = "alerting"
    }
  }
}
