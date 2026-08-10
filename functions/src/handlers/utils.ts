import type { Json } from "../types.js";

export function readPath(value: Json | undefined, path: string | undefined): Json | undefined {
  if (!path) return value;
  return path.split(".").filter(Boolean).reduce<Json | undefined>((current, key) => {
    if (current && typeof current === "object" && !Array.isArray(current)) return current[key];
    return undefined;
  }, value);
}

export function asRecord(value: Json | null): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export async function fetchWithRetry(url: string, init: RequestInit, attempts = 2, timeoutMs = 10_000): Promise<Response> {
  let failure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok || (response.status >= 400 && response.status < 500)) return response;
      failure = new Error(`HTTP ${response.status}`);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
  }
  throw failure instanceof Error ? failure : new Error("External request failed");
}
