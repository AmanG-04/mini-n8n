import type { DbClient } from "../db.js";
import type { StepContext, StepResult } from "../types.js";

export async function runDbWrite(client: DbClient, context: StepContext): Promise<StepResult> {
  const payload = { input: context.input, previous_output: context.previousOutput, config: context.step.config };
  const result = await client.query<{ id: string }>(
    `INSERT INTO public.workflow_data_writes (org_id, workflow_run_id, workflow_step_id, payload)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [context.run.org_id, context.run.id, context.step.id, JSON.stringify(payload)]
  );
  return { output: { write_id: result.rows[0].id } };
}
