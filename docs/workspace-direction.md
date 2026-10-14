# Agent Desk: a work inbox with agents behind it

Agent Desk should bring work in, let agents act within a defined scope, and return a concrete result for the user to review. Terminals, automation configuration, and annotation tools support that workflow.

## Navigation

- **Sessions:** active terminal work, projects, controllers, and permission requests.
- **Automations:** saved workflows, their triggers, scope, agent configuration, and run history.
- **Inbox:** requests that need an answer, blocked runs, findings, and work ready for review.
- **Tools:** persistent annotation and review surfaces associated with the task being reviewed.

Automations currently run on demand. The UI must say “Manual trigger” until a real scheduler or event source is connected. An empty inbox must never imply that a disconnected source was checked successfully.

## Current implementation

The Inbox combines current session requests with durable automation findings and reports. It offers Open, Needs you, Ready for review, History, and All views; text search; a detail pane; source links; session navigation; and reviewed, dismissed, and reopened states. Live session requests clear when their reported need clears; they are not yet a persistent notification history. Reviewing an item is separate from opening it. Opening a session never answers its permission prompt.

## Next milestones, in order

1. **Reliable sessions and notifications.** Managed local PTYs now live in a persistent supervisor, with reconnection after graceful backend exit or crash. Prefer harness lifecycle events where available; retain screen recognition as a fallback. Persist request identities and notification history, preserve exact session routing, and let the user jump to the next unresolved request. Make unavailable or stale signals visible.
2. **One operational Slack watcher.** Define channels, lookback, actionable criteria, and notification destination. Persist source cursors and stable event IDs. Schedule bounded passes, expose last successful check and next run, and support pause, retry, and connector errors. Messages are source data, not permission to expand scope.
3. **Alert-to-fix workflow.** Match eligible findings to an explicitly configured repository and worker. Use an isolated checkout per task, prevent conflicting assignments, bound concurrency and cost, and require durable completion callbacks. A quiet or exited terminal is not proof of completion.
4. **Review in context.** Attach the source thread, task, diff, test results, and annotation tool to the same inbox item. Feedback returns to the originating worker with an acknowledged delivery. Review status, approval to merge, and actual merge outcome remain separate actions.
5. **Work-wide orchestration.** Add other alert sources and reusable workflow templates only after the first complete watcher → worker → review loop is reliable. Show run history, failures, and delivery outcomes in the same app.

## Product references

[Herdr agent state and navigation](https://herdr.dev/docs/agents/) demonstrates state rollups and direct navigation to the pane needing attention. [Herdr's community inbox](https://github.com/douglascorrea/herdr-agent-inbox) adds explicit triage and workspace rollups. [cmux](https://www.cmux.dev/) uses pane indicators, sidebar badges, and notifications to surface attention requests. These are references for interaction and reliability; Agent Desk does not currently implement their full capabilities.

The standard is end-to-end behavior: a request arrives once, reaches the right agent, produces a reviewable result, and stays visible until handled. More launch buttons alone do not meet that standard.

## Agent map, project Run, and Schedule

The first implementation includes the agent map, launch configurations, scheduled task DAGs, cron table, and run history. See the README for operational behavior and limitations. The paragraphs below describe the intended product direction, including refinements beyond this first implementation.

**Agent map.** Add a List / Map switch to Sessions. Root agents and controllers connect to their spawned children; nodes show agent name, task, project, and current status. Clicking a node opens its terminal; branches collapse, and the map supports pan, zoom, and filters. Record parent agent ID and launch/run ID at creation. Keep spawn lineage distinct from delegation: assigning a task to an existing agent does not make it a child. Harness-internal subagents need an adapter to report identity and relationships; do not infer them from terminal text or make up missing edges. Unlinked sessions remain visible as independent nodes.

**Universal project Run.** Each project/app gets Run, Open, Logs, Stop, and Schedule actions. Discover candidate commands, but save the selected command, cwd, environment variable names, port argument/environment convention, and readiness check as a launch configuration. A monorepo may have multiple app configurations. Run selects an unused port, starts the process, verifies readiness and ownership, then exposes its URL. Reuse an existing healthy instance by default. Socket-capable apps can inherit a reserved socket as current skill UIs do; other apps need strict port binding and bounded retries after confirmed bind conflicts. Never claim that choosing a free port alone prevents another process from claiming it. Apps with fixed ports or multiple services need explicit configuration.

**Schedule.** Schedule invokes the same saved launch configuration as Run: one time, recurring, or eventually an event trigger. Persist timezone, next run, last outcome, pause state, overlap policy, and missed-run policy. Default to no overlapping runs of the same configuration. Distinguish starting a persistent app from running a finite agent job: a healthy app should not get another instance on every tick. Agent jobs report findings and reviewable results to Inbox; app launches expose readiness and failures there. Show clearly that a local scheduler cannot execute while its host is off or asleep; queued catch-up behavior must be explicit.

Build the shared run/parent identity model first, then the clickable agent map, reusable project launch configurations with port handling, and finally schedules on the same runtime. Keep the session-supervisor reliability milestone ahead of unattended operation.

## Further directions

**Agents building their own automations.** The runtime already exposes automations over HTTP (`/api/workflows/*`, `/api/special-agents/*`), and `scripts/agent_control.py` is the agent-facing CLI for terminals, tasks and the inbox. Extend that CLI first, with an `automation` group: `list`, `show`, `create` (from a JSON definition), `update`, `run`, `schedule`, `disable`, `delete`, plus `runs` for history and `logs` for output. The CLI works in every harness with no per-harness setup, which is the same reason skills are shared rather than installed per agent. An MCP server is a thin second wrapper over the same endpoints for harnesses that prefer tools over shell, and should not become a separate implementation. Guardrails: an automation an agent created is marked with the agent and coordinator that created it, is disabled until a human enables it, cannot schedule itself more often than a configured floor, and cannot delete automations it did not create.

**Event-driven agents.** Triggers today are manual, once and cron (`workflow_runtime.save_workflow`). Add an `event` trigger backed by a small local event bus: a loopback webhook endpoint with a per-source token, file and directory changes, and the URL and PR watches that coordinators already run (`coordinator_watches`). Slack arrives through an adapter process that posts into the webhook, so the bus stays local and no third-party credentials enter Agent Desk. An event carries a stable source event ID for deduplication, and a rule matches source plus a field predicate, then starts a workflow or automation with the event payload available to the prompt. It needs the same protections as the scheduler: no overlapping runs of one configuration, a bounded queue, a visible last-seen and last-error per source, and an explicit missed-event policy while the host is asleep.

**Controller reliability.** Coordinator failures fall into four groups:

1. *Any failed turn pauses the coordinator.* `coordinator_runtime.turn` sets `state='error',paused=1` on every exception, including a provider timeout ("Coordinator provider exceeded its response time or output limit"). One transient error stops the coordinator until the user resumes it by hand. Retry a transient provider failure once with backoff, and pause only after a repeat or a non-transient error.
2. *Tool launches fail on rules the model cannot see.* `launch_tool` and `launch_hook_tool` fail with errors such as "Review project is not enabled for this coordinator", "Choose an enabled hook with a tool UI", the wrong ID space, or a target outside the project. The errors describe UI a coordinator cannot open. Each should name the valid IDs and, where the target is the coordinator's own project, enable it rather than refuse.
3. *Delivery stalls when the worker screen is not recognised.* "Waiting to deliver: worker is unknown; an empty stable prompt is required", "Worker screen observer is unavailable" and "Worker prompt is busy, contains a draft, or is not recognized". Follow-ups queue and never arrive. Surface a waiting delivery in the UI with its reason and how long it has waited, and offer to deliver anyway or cancel.
4. *Memory guardrails reject the model repeatedly.* `remember` calls are rejected with "Use a user or coordinator message as the source; worker output is not an instruction". The rule is reasonable, but the tool schema should carry it so the call is right the first time.
