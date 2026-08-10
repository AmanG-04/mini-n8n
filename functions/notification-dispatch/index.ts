import { fetchWithRetry } from "../_src/handlers/utils.js";
import { hasura } from "../_src/hasura.js";

type Response = { status: (code: number) => Response; json: (body: unknown) => void };

/** Hasura Event Trigger target for notification_outbox inserts. Endpoint and token remain server-side. */
export default async function handler(request: { body: { event: { data: { new: { id: string; payload: unknown } } } } }, response: Response): Promise<void> {
  const row = request.body.event.data.new;
  try {
    const endpoint = process.env.NOTIFICATION_WEBHOOK_URL;
    if (!endpoint) throw new Error("NOTIFICATION_WEBHOOK_URL is not configured");
    const result = await fetchWithRetry(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(row.payload) });
    if (!result.ok) throw new Error(`Notification endpoint returned ${result.status}`);
    await hasura(`mutation Delivered($id: uuid!, $time: timestamptz!) { update_notification_outbox_by_pk(pk_columns: { id: $id }, _set: { delivered_at: $time, delivery_error: null }) { id } }`, { id: row.id, time: new Date().toISOString() });
    response.json({ delivered: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification delivery failed";
    await hasura(`mutation Failed($id: uuid!, $error: String!) { update_notification_outbox_by_pk(pk_columns: { id: $id }, _set: { delivery_error: $error }) { id } }`, { id: row.id, error: message });
    response.status(500).json({ message });
  }
}
