import type { StepContext, StepResult } from "../types.js";
import { hasura } from "../hasura.js";

export async function runNotify(context: StepContext): Promise<StepResult> {
  const channel = context.step.config.channel === "slack" ? "slack" : "webhook";
  const payload = { message: context.step.config.message ?? "Workflow notification", input: context.input, previous_output: context.previousOutput };
  const result = await hasura<{ insert_notification_outbox_one: { id: string } }>(
    `mutation Notify($object: notification_outbox_insert_input!) { insert_notification_outbox_one(object: $object) { id } }`,
    { object: { org_id: context.run.org_id, workflow_run_id: context.run.id, workflow_step_id: context.step.id, channel, payload } }
  );
  return { output: { notification_id: result.insert_notification_outbox_one.id, queued: true } };
}
