# FlowForge — mini n8n assignment

FlowForge is an organization-isolated workflow builder using Nhost Auth, PostgreSQL, Hasura GraphQL, server-side functions, and a Next.js client. It implements sequential Groq/HTTP/database/notification/branch/approval steps, live `step_runs` subscriptions, and a webhook execution path.

## Local setup

1. Nhost Git deployments automatically apply the committed `nhost/migrations` and `nhost/metadata` files. This repository intentionally does not override Nhost's managed platform configuration, so its Auth/JWT settings remain in Nhost Cloud. Do not use a database URL in the browser.
2. Nhost automatically provides `NHOST_GRAPHQL_URL` and `NHOST_ADMIN_SECRET` to Functions. Add `GROQ_API_KEY` as a Function secret, and set `WORKFLOW_ACTIONS_URL` and `NOTIFICATION_DISPATCH_URL` to the deployed/local function URLs. No direct `DATABASE_URL` is needed, so this works on the Nhost Free plan. Without a Groq key, `llm_call` intentionally waits 700 ms and returns a clearly labelled stub response.
3. `cd functions && npm install && npm run typecheck && npm test`
4. `cd web && npm install && npm run dev`. For a production check run `npm run build`.
5. Create two auth users, then use [`scripts/bootstrap-demo.sql`](scripts/bootstrap-demo.sql) as an admin-only seed template to create Org A / Org B membership. Never grant the service role to an application client.

## Function endpoints

- `workflow-actions`: Hasura Actions `triggerWorkflowRun(workflow_id)` and `approveStep(step_run_id)`.
- `workflow-webhook`: `POST { "trigger_id", "secret", "payload" }`. Store only `sha256(secret)` in `workflow_triggers.secret_hash`; the secret should be shown to the owner once and never stored in `config`.
- `notification-dispatch`: Hasura Event Trigger target for a `notification_outbox` insert. Set `NOTIFICATION_WEBHOOK_URL` to a Slack-compatible webhook or internal endpoint.

## Final demo procedure

1. Sign in as Org A owner and select Org A. Create a workflow. Add `llm_call`, `conditional_branch`, `http_request`, and `approval_gate` in that order. A branch config can inspect `approved` from the no-key stub (`{ "path": "approved", "equals": true }`), proving it uses previous LLM output.
2. Run it. The UI’s GraphQL WebSocket subscription updates each `step_runs` row without refresh. It pauses at the gate.
3. Approve as the Org A owner/editor. The same run resumes and completes. Observe usage increment after completion.
4. Add an owner-only webhook trigger with a generated SHA-256 secret hash, then `POST` to `workflow-webhook`; it creates another run without a UI button.
5. Sign in as the Org B user. Org A is absent from the organization/workflow list. Attempting a direct `workflows_by_pk`, `step_runs`, `triggerWorkflowRun`, or `approveStep` request using Org A IDs returns no data or a forbidden Action response because both Hasura and Actions resolve membership server-side.

See [ARCHITECTURE_SECURITY.md](ARCHITECTURE_SECURITY.md) for the permission model and pause/resume design.
