import type { DbClient } from "../db.js";
import type { StepContext, StepResult } from "../types.js";

export async function runNotify(client: DbClient, context: StepContext): Promise<StepResult> {
  const channel = context.step.config.channel === "slack" ? "slack" : "webhook";
  const payload = { message: context.step.config.message ?? "Workflow notification", input: context.input, previous_output: context.previousOutput };
  const result = await client.query<{ id: string }>(
    `INSERT INTO public.notification_outbox (org_id, workflow_run_id, workflow_step_id, channel, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [context.run.org_id, context.run.id, context.step.id, channel, JSON.stringify(payload)]
  );
  return { output: { notification_id: result.rows[0].id, queued: true } };
}
