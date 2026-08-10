import { describe, expect, it } from "vitest";
import { runConditionalBranch } from "../src/handlers/conditional.js";

describe("conditional_branch", () => {
  it("uses the previous LLM output rather than a hard-coded branch", async () => {
    const result = await runConditionalBranch({
      run: { id: "r", org_id: "o", workflow_id: "w", input: {}, status: "running" },
      step: { id: "s", workflow_id: "w", position: 0, type: "conditional_branch", name: "", config: { path: "approved", equals: true } },
      stepRun: { id: "sr", workflow_run_id: "r", workflow_step_id: "s", position: 0, type: "conditional_branch", status: "running", output: null, approved_by: null },
      input: {}, previousOutput: { approved: true }
    });
    expect(result.output).toMatchObject({ branch: "if", matched: true });
  });
});
