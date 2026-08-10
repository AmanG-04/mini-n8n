# Architecture and security

The application separates authored workflow definitions from execution history. `organizations` own `workflows`; ordered `workflow_steps` and `workflow_triggers` belong to a workflow; `workflow_runs` and one `step_runs` record per defined step form an immutable execution trail. `usage_events` feeds the tracked `organization_usage_monthly` view, which exposes calls used, allowance, and remaining calls.

## Two permission layers

**Layer 1 is Hasura row permissions.** Every public table select filter reaches `organizations.members` and requires `user_id = X-Hasura-User-Id`. This means an ID from Org A cannot return any data to an Org B member, including `step_runs` queried directly. Owners may manage members; owners and editors may edit workflows. Execution records have no client insert/update permissions, so a browser cannot forge a run state.

**Layer 2 is sensitive-operation gating.** The Hasura checks permit `db_write` and `notify` workflow steps, and `webhook` triggers, only if the relevant membership row is an owner. The Action handlers repeat authorization from database joins: `triggerWorkflowRun` requires owner/editor on the workflow's real organization; `approveStep` requires owner/editor on the paused gate's real run organization. Neither accepts an organization ID. The inbound webhook authenticates against a SHA-256 secret hash held in `workflow_triggers`, not a client-provided organization.

## Execution and pause/resume

`triggerWorkflowRun` calls a tracked Postgres RPC that creates the run and all ordered `step_runs` in one transaction, then queues the server-side executor. Functions access this RPC and other persistence only through Hasura's internal admin GraphQL credentials; no direct database connection string is needed. The executor marks each step running/completed/failed, passes the prior output to the next step, retries external Groq/HTTP failures once with a timeout, and writes error details on failure. An `approval_gate` changes both the step and run to `paused`; no later step runs. `approveStep` calls a second RPC that verifies role and records approver identity/time before it queues the same executor to continue.

`notification_outbox` is delivered by the committed Hasura Event Trigger configuration. The event target reads its outbound endpoint only from the function environment. The client subscribes to `step_runs` by `workflow_run_id`; its Hasura select permission still applies to that subscription.
