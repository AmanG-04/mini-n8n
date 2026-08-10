import type { StepContext, StepResult } from "../types.js";
import { hasura } from "../hasura.js";

export async function runDbWrite(context: StepContext): Promise<StepResult> {
  const payload = { input: context.input, previous_output: context.previousOutput, config: context.step.config };
  const result = await hasura<{ insert_workflow_data_writes_one: { id: string } }>(
    `mutation Write($object: workflow_data_writes_insert_input!) { insert_workflow_data_writes_one(object: $object) { id } }`,
    { object: { org_id: context.run.org_id, workflow_run_id: context.run.id, workflow_step_id: context.step.id, payload } }
  );
  return { output: { write_id: result.insert_workflow_data_writes_one.id } };
}
