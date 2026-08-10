import { approveRunStep, ActionError, createRun, createWebhookTrigger } from "../_src/actions.js";

type HasuraRequest = {
  action: { name: "triggerWorkflowRun" | "approveStep" | "createWebhookTrigger" };
  input: { workflow_id?: string; step_run_id?: string };
  session_variables?: Record<string, string>;
};
type Response = { status: (code: number) => Response; json: (body: unknown) => void };

export default async function handler(request: { body: HasuraRequest }, response: Response): Promise<void> {
  try {
    const userId = request.body.session_variables?.["x-hasura-user-id"];
    if (!userId) throw new ActionError("Authentication is required", 401);
    if (request.body.action.name === "createWebhookTrigger") {
      if (!request.body.input.workflow_id) throw new ActionError("workflow_id is required");
      response.json(await createWebhookTrigger(request.body.input.workflow_id, userId));
      return;
    }
    if (request.body.action.name === "triggerWorkflowRun") {
      if (!request.body.input.workflow_id) throw new ActionError("workflow_id is required");
      response.json(await createRun(request.body.input.workflow_id, userId, "manual"));
      return;
    }
    if (request.body.action.name === "approveStep") {
      if (!request.body.input.step_run_id) throw new ActionError("step_run_id is required");
      response.json(await approveRunStep(request.body.input.step_run_id, userId));
      return;
    }
    throw new ActionError("Unsupported action", 400);
  } catch (error) {
    const known = error instanceof ActionError;
    response.status(known ? error.status : 500).json({ message: known ? error.message : "Internal workflow action error" });
  }
}
