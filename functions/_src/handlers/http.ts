import type { StepContext, StepResult } from "../types.js";
import { fetchWithRetry } from "./utils.js";

export async function runHttpRequest(context: StepContext): Promise<StepResult> {
  const { url, method = "GET", headers = {}, body, timeout_ms } = context.step.config;
  if (typeof url !== "string" || !/^https:\/\//.test(url)) throw new Error("http_request requires an HTTPS url");
  const response = await fetchWithRetry(url, {
    method: typeof method === "string" ? method : "GET",
    headers: { "content-type": "application/json", ...(headers && typeof headers === "object" && !Array.isArray(headers) ? headers as Record<string, string> : {}) },
    body: body === undefined || method === "GET" ? undefined : JSON.stringify(body)
  }, 2, typeof timeout_ms === "number" ? timeout_ms : 10_000);
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* retain text */ }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  return { output: { status: response.status, body: parsed as never } };
}
