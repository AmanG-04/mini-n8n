import type { StepContext, StepResult } from "../types.js";
import { asRecord, fetchWithRetry } from "./utils.js";

export async function runLlmCall(context: StepContext): Promise<StepResult> {
  const config = context.step.config;
  const promptTemplate = typeof config.prompt === "string" ? config.prompt : "Summarize the supplied workflow input.";
  const prompt = promptTemplate
    .replaceAll("{{input}}", JSON.stringify(context.input))
    .replaceAll("{{previous}}", JSON.stringify(context.previousOutput));
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    return { output: { provider: "stub", text: `Stubbed LLM response: ${prompt}`, approved: true } };
  }

  const response = await fetchWithRetry("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: typeof config.model === "string" ? config.model : "llama-3.3-70b-versatile",
      temperature: typeof config.temperature === "number" ? config.temperature : 0.2,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const body = asRecord(await response.json() as never);
  if (!response.ok) throw new Error(`Groq returned ${response.status}: ${JSON.stringify(body)}`);
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = asRecord(choices[0] ?? null);
  const message = asRecord(first.message ?? null);
  return { output: { provider: "groq", text: typeof message.content === "string" ? message.content : "", raw: body } };
}
