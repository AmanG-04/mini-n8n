import { ActionError, createWebhookRun } from "../src/actions.js";

type Response = { status: (code: number) => Response; json: (body: unknown) => void };

/** Public endpoint: POST { trigger_id, secret, payload }. The secret is verified against a stored SHA-256 hash. */
export default async function handler(request: { body: { trigger_id?: string; secret?: string; payload?: object } }, response: Response): Promise<void> {
  try {
    const { trigger_id, secret, payload = {} } = request.body;
    if (!trigger_id || !secret) throw new ActionError("trigger_id and secret are required", 400);
    response.json(await createWebhookRun(trigger_id, secret, payload));
  } catch (error) {
    const known = error instanceof ActionError;
    response.status(known ? error.status : 500).json({ message: known ? error.message : "Webhook failed" });
  }
}
