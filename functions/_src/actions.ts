import { hasura } from "./hasura.js";
import { WorkflowExecutor } from "./executor.js";

export class ActionError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type StartResult = { run_id: string; status: string };

export async function createRun(workflowId: string, userId: string, triggerType: "manual" | "webhook", input: object = {}): Promise<StartResult> {
  try {
    const data = await hasura<{ start_workflow_run: StartResult[] }>(
      `mutation Start($workflow: uuid!, $user: uuid!, $trigger: String!, $input: jsonb!) { start_workflow_run(args: { p_workflow_id: $workflow, p_user_id: $user, p_trigger_type: $trigger, p_input: $input }) { run_id: id status } }`,
      { workflow: workflowId, user: userId, trigger: triggerType, input }
    );
    const run = data.start_workflow_run[0];
    if (!run) throw new ActionError("Unable to start workflow", 403);
    queueExecution(run.run_id);
    return run;
  } catch (error) { throw asActionError(error); }
}

export async function approveRunStep(stepRunId: string, userId: string): Promise<StartResult> {
  try {
    const data = await hasura<{ approve_workflow_step: StartResult[] }>(
      `mutation Approve($step: uuid!, $user: uuid!) { approve_workflow_step(args: { p_step_run_id: $step, p_user_id: $user }) { run_id: id status } }`, { step: stepRunId, user: userId }
    );
    const run = data.approve_workflow_step[0];
    if (!run) throw new ActionError("Approval step not found or you do not have permission", 403);
    queueExecution(run.run_id);
    return run;
  } catch (error) { throw asActionError(error); }
}

export async function createWebhookRun(triggerId: string, secret: string, input: object = {}): Promise<StartResult> {
  try {
    const data = await hasura<{ start_webhook_workflow_run: StartResult[] }>(
      `mutation Webhook($trigger: uuid!, $secret: String!, $input: jsonb!) { start_webhook_workflow_run(args: { p_trigger_id: $trigger, p_secret: $secret, p_input: $input }) { run_id: id status } }`, { trigger: triggerId, secret, input }
    );
    const run = data.start_webhook_workflow_run[0];
    if (!run) throw new ActionError("Invalid webhook credentials", 401);
    queueExecution(run.run_id);
    return run;
  } catch (error) { throw asActionError(error); }
}

function queueExecution(runId: string): void {
  setTimeout(() => {
    void new WorkflowExecutor().execute(runId).then(async (result) => {
      if (result.status === "completed") {
        await hasura(`mutation Usage($run: uuid!) { record_workflow_usage(args: { p_run_id: $run }) { usage_id: id } }`, { run: runId });
      }
    }).catch((error: unknown) => console.error("Workflow execution failed", { runId, error }));
  }, 0);
}

function asActionError(error: unknown): ActionError {
  const message = error instanceof Error ? error.message : "Workflow action failed";
  if (message.includes("QUOTA_EXHAUSTED")) return new ActionError("Organization workflow quota is exhausted", 429);
  if (message.includes("FORBIDDEN")) return new ActionError("Resource not found or you do not have permission", 403);
  return error instanceof ActionError ? error : new ActionError(message, 500);
}
