---
name: incident-watch
description: Read Cumulo's CloudWatch state as the read-only observer identity — alarms in ALARM, recent alarm transitions, the API's 5xx count for the last hour, and the matching log lines — and turn it into the orchestrating session's next action. Run on the session's hourly wake-up, or when asked whether production is healthy. Never writes to AWS, never edits code.
---

You are the orchestrating session's eyes on production (#604). Alarm emails reach the owner; this is what reaches you.

## Run it

```bash
AWS_PROFILE=cumulo-observer bash .claude/scripts/incident-watch.sh
```

`AWS_PROFILE` defaults to `cumulo-observer` and `CUMULO_ENV` to `dev`; `--history N` sets how many transitions print (default 10). The script refuses any identity but `user/cumulo-observer-<env>`, so it cannot run on the operator's own login. The profile, the access key and every action the identity holds are in `infra/README.md`'s observer runbook — the key lives only in `~/.aws/credentials`; never print, paste or copy it anywhere, including into this chat.

## The wake-up

The orchestrating session starts one recurring check when it begins a working stretch:

```
/loop 60m /incident-watch
```

It is session-local by design: when no session is running, the alarm email to the owner is the fallback. Do not schedule it from a lane — the lane cannot open other lanes, and two watchers double the reads for nothing.

## Read the report

Exit 0 (`VERDICT quiet`): say nothing beyond one line, then return to the work in flight.

Exit 1 (`VERDICT act`): for each alarm under `IN ALARM`, and for a non-zero `API 5XX, LAST HOUR`, decide one of:

1. **An open lane already covers it** — its issue names this alarm, route or log line. Note it on that issue (alarm, since, count); nothing else.
2. **An open lane caused it** — the transition follows that lane's merge. Bounce it: `FIX — <alarm> since <time>: <log line>` via SendMessage.
3. **Nothing covers it** — open an issue labelled `discovered` quoting the alarm name, the since time, the reason text and up to five log lines, then run it through `/run-issue` as a hotfix lane.

An alarm that has already flapped back to OK appears only under the transitions: treat a pair of OK→ALARM→OK transitions within the hour like an alarm still firing.

Exit 2 (no verdict): the stderr line names the failed call. `AccessDenied` or an expired/missing profile is the owner's to fix — tell them once, quoting the line, and stop the loop until they do. Never retry as another identity.

## Never

- Write to AWS, or widen the observer's policy from this skill — changes go through `infra/bootstrap/observer.tf` and the owner's apply.
- Edit code. A finding becomes an issue or a bounce; a lane does the fix.
