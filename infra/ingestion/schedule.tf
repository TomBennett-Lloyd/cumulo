# The clock. ADR 0001 splits the platform by trigger model, and ingestion is
# the cron-triggered deployable: it runs on a schedule, not on data arriving and
# not on a request.

resource "aws_cloudwatch_event_rule" "hourly_cycle" {
  name = "cumulo-ingestion-hourly-${var.environment}"

  # Minute 7, not minute 0. Every scheduled job in every account defaults to the
  # top of the hour, and Open-Meteo's free tier is a shared 600-calls/minute
  # ceiling — so the top of the hour is the one minute in sixty most likely to
  # meet somebody else's burst. Minute 7 costs nothing and steps off the herd.
  # It is also far enough from :00 that a cycle running the full 300 s cannot
  # overlap the next hour's model run publication.
  schedule_expression = "cron(7 * * * ? *)"

  description = "Hourly Cumulo ingestion cycle: fetch each active fleet location's 48-hour forecast, write cumulo-weather, publish one message per location."
}

resource "aws_cloudwatch_event_target" "ingestion" {
  rule = aws_cloudwatch_event_rule.hourly_cycle.name
  arn  = aws_lambda_function.ingestion.arn

  # No `input`: the handler takes no event payload at all, deliberately (see the
  # IngestionHandler docstring in apps/ingestion) — what to fetch comes from the
  # fleet, not from the invocation. Sending a payload here would only invite
  # somebody to start branching on it.
}

# EventBridge invoking a function is a resource policy on the *function*, not a
# grant on the rule. Without this the rule fires, EventBridge is refused, and
# the only evidence is the rule's FailedInvocations metric — a schedule that is
# silently doing nothing.
resource "aws_lambda_permission" "eventbridge" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingestion.function_name
  principal     = "events.amazonaws.com"

  # Scoped to this rule's ARN rather than left open to the service: without
  # source_arn, any EventBridge rule in any account could invoke this function.
  source_arn = aws_cloudwatch_event_rule.hourly_cycle.arn
}
