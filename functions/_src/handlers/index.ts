import type { StepContext, StepResult } from "../types.js";
import { runConditionalBranch } from "./conditional.js";
import { runDbWrite } from "./db-write.js";
import { runHttpRequest } from "./http.js";
import { runLlmCall } from "./llm.js";
import { runNotify } from "./notify.js";

export async function executeStep(context: StepContext): Promise<StepResult> {
  switch (context.step.type) {
    case "llm_call": return runLlmCall(context);
    case "http_request": return runHttpRequest(context);
    case "db_write": return runDbWrite(context);
    case "notify": return runNotify(context);
    case "conditional_branch": return runConditionalBranch(context);
    case "approval_gate": throw new Error("approval_gate is handled by the executor");
  }
}
