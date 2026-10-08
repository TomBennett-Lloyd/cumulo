---
name: incident-watch
description: Read Cumulo's CloudWatch state as the read-only observer identity — alarms in ALARM, recent alarm transitions, the API's 5xx count for the last hour, and the matching log lines — and turn it into the orchestrating session's next action. Run on the session's hourly wake-up, or when asked whether production is healthy. Never writes to AWS, never edits code.
---

You are the orchestrating session's eyes on production (#604). Alarm emails reach the owner; this is what reaches you.

## Run it

```bash
AWS_PROFILE=cumulo-observer bash .claude/scripts/incident-watch.sh
```

Its options and defaults are in `bash .claude/scripts/incident-watch.sh --help`. The script refuses any identity but `user/cumulo-observer-<env>`, so it cannot run on the operator's own login. The profile, the access key and every action the identity holds are in `infra/README.md`'s observer runbook — the key lives only in `~/.aws/credentials`; never print, paste or copy it anywhere, including into this chat.

## What it covers

Every `cumulo-*` alarm in ALARM, or raised within the hour, in the home region and in us-east-1 — so the cost guard's composite trip and its billing alarm ([#613](https://github.com/TomBennett-Lloyd/cumulo/pull/613)) appear beside the service alarms. The listing is by name prefix, so a new `cumulo-*` alarm (a p95 latency alarm, say) is reported with no change here. A cost-guard alarm also prints the trip function's log lines and names the api runbook's "Reset after a cost trip" section: a trip throttles the API to zero until the owner resets it, so tell the owner first, quoting the alarm and the reason text, then decide among the three outcomes below.

## The wake-up

The orchestrating session starts one recurring check when it begins a working stretch:

```
/loop 60m /incident-watch
```

It is session-local by design: when no session is running, the alarm email to the owner is the fallback. Do not schedule it from a lane — the lane cannot open other lanes, and two watchers double the reads for nothing.

On a machine holding the `cumulo-observer` profile, `.claude/hooks/ensure-deps.sh` prints one line when a session starts or is resumed (not after a compaction, when the loop is still scheduled) saying no observer is running. That is the prompt to ask the owner whether to start the loop in this session.

## Resuming

A session picking up again after a usage-limit cut or a stall may have missed hours of wake-ups, and no hook fires for that case. So this rule is the session's: run `/incident-watch` once straight away and report its verdict, then re-arm `/loop 60m /incident-watch` only if the session's scheduled jobs do not already list it.

## Read the report

Exit 0 (`VERDICT quiet`): say nothing beyond one line, then return to the work in flight.

Exit 1 (`VERDICT act`): for each alarm under `IN ALARM` or `RAISED IN THE LAST HOUR` (raised and possibly already cleared), and for a non-zero `API 5XX, LAST HOUR`, decide one of:

1. **An open lane already covers it** — its issue names this alarm, route or log line. Note it on that issue (alarm, since, count); nothing else.
2. **An open lane caused it** — the transition follows that lane's merge. Bounce it: `FIX — <alarm> since <time>: <log line>` via SendMessage.
3. **Nothing covers it** — open an issue labelled `discovered` quoting the alarm name, the since time, the reason text and the log lines, then run it through `/run-issue` as a hotfix lane.

Exit 2 (no verdict): the stderr line names the failed call. `AccessDenied` or an expired/missing profile is the owner's to fix — tell them once, quoting the line, and stop the loop until they do. Never retry as another identity.

## Never

- Write to AWS, or widen the observer's policy from this skill — changes go through `infra/bootstrap/observer.tf` and the owner's apply.
- Edit code. A finding becomes an issue or a bounce; a lane does the fix.
