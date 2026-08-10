import { fetchWithRetry } from "../src/handlers/utils.js";
import { database } from "../src/db.js";

type Response = { status: (code: number) => Response; json: (body: unknown) => void };

/** Hasura Event Trigger target for notification_outbox inserts. Endpoint and token remain server-side. */
export default async function handler(request: { body: { event: { data: { new: { id: string; payload: unknown } } } } }, response: Response): Promise<void> {
  const row = request.body.event.data.new;
  try {
    const endpoint = process.env.NOTIFICATION_WEBHOOK_URL;
    if (!endpoint) throw new Error("NOTIFICATION_WEBHOOK_URL is not configured");
    const result = await fetchWithRetry(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(row.payload) });
    if (!result.ok) throw new Error(`Notification endpoint returned ${result.status}`);
    await database().query("UPDATE public.notification_outbox SET delivered_at = now(), delivery_error = NULL WHERE id = $1", [row.id]);
    response.json({ delivered: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification delivery failed";
    await database().query("UPDATE public.notification_outbox SET delivery_error = $2 WHERE id = $1", [row.id, message]);
    response.status(500).json({ message });
  }
}
