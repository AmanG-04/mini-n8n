import type { StepContext, StepResult } from "../types.js";
import { readPath } from "./utils.js";

export async function runConditionalBranch(context: StepContext): Promise<StepResult> {
  const config = context.step.config;
  const actual = readPath(context.previousOutput, typeof config.path === "string" ? config.path : undefined);
  const expected = config.equals;
  const matches = expected === undefined ? Boolean(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  return { output: { branch: matches ? "if" : "else", matched: matches, actual: actual ?? null, expected: expected ?? null } };
}
