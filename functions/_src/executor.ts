import { hasura } from "./hasura.js";
import { executeStep } from "./handlers/index.js";
import type { Json, StepRun, WorkflowRun, WorkflowStep } from "./types.js";

type JoinedStep = WorkflowStep & { step_run_id: string; step_run_status: StepRun["status"]; step_run_output: Json | null; approved_by: string | null };

function positionList(value: Json | undefined): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item >= 0) : [];
}

export class WorkflowExecutor {
  async execute(runId: string): Promise<{ status: WorkflowRun["status"] }> {
    const loaded = await hasura<{ workflow_runs_by_pk: WorkflowRun | null }>(
      `query Run($id: uuid!) { workflow_runs_by_pk(id: $id) { id org_id workflow_id input status } }`, { id: runId }
    );
    const run = loaded.workflow_runs_by_pk;
    if (!run || !["queued", "paused", "running"].includes(run.status)) throw new Error("Run is not executable");
    await this.updateRun(runId, { status: "running", started_at: new Date().toISOString(), error: null });
    const steps = await this.loadSteps(runId);
    let previousOutput: Json | null = null;
    const skippedPositions = new Set<number>();
    for (const item of steps) {
      if (item.step_run_status === "completed") { previousOutput = item.step_run_output; continue; }
      if (item.step_run_status === "skipped") continue;
      if (skippedPositions.has(item.position)) {
        await this.updateStep(item.step_run_id, { status: "skipped", output: { reason: "conditional_branch" }, completed_at: new Date().toISOString() });
        continue;
      }
      if (item.type === "approval_gate") {
        if (!item.approved_by) {
          await this.updateStep(item.step_run_id, { status: "paused", started_at: new Date().toISOString() });
          await this.updateRun(runId, { status: "paused" });
          return { status: "paused" };
        }
        const output = { approved_by: item.approved_by };
        await this.updateStep(item.step_run_id, { status: "completed", completed_at: new Date().toISOString(), output });
        previousOutput = output;
        continue;
      }
      const stepRun = await this.markRunning(item.step_run_id, run.input, previousOutput);
      try {
        const result = await executeStep({ run, step: item, stepRun, input: run.input, previousOutput });
        await this.updateStep(item.step_run_id, { status: "completed", output: result.output, completed_at: new Date().toISOString(), error: null });
        previousOutput = result.output;
        if (item.type === "conditional_branch" && result.output && typeof result.output === "object" && !Array.isArray(result.output)) {
          const matched = result.output.matched === true;
          const skip = matched ? positionList(item.config.else_positions) : positionList(item.config.if_positions);
          for (const position of skip) if (position > item.position) skippedPositions.add(position);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown step error";
        await this.updateStep(item.step_run_id, { status: "failed", error: message, completed_at: new Date().toISOString() });
        await this.updateRun(runId, { status: "failed", error: message, completed_at: new Date().toISOString() });
        return { status: "failed" };
      }
    }
    await this.updateRun(runId, { status: "completed", output: previousOutput, completed_at: new Date().toISOString() });
    return { status: "completed" };
  }

  private async loadSteps(runId: string): Promise<JoinedStep[]> {
    const data = await hasura<{ step_runs: { id: string; status: StepRun["status"]; output: Json | null; approved_by: string | null; workflow_step: WorkflowStep }[] }>(
      `query Steps($id: uuid!) { step_runs(where: { workflow_run_id: { _eq: $id } }, order_by: { position: asc }) { id status output approved_by workflow_step { id workflow_id position type name config } } }`, { id: runId }
    );
    return data.step_runs.map((row) => ({ ...row.workflow_step, step_run_id: row.id, step_run_status: row.status, step_run_output: row.output, approved_by: row.approved_by }));
  }

  private async markRunning(id: string, input: Record<string, Json>, previousOutput: Json | null): Promise<StepRun> {
    const data = await hasura<{ update_step_runs_by_pk: StepRun }>(
      `mutation Start($id: uuid!, $input: jsonb!, $started: timestamptz!) { update_step_runs_by_pk(pk_columns: { id: $id }, _set: { status: running, started_at: $started, input: $input }, _inc: { attempt_count: 1 }) { id workflow_run_id workflow_step_id position type status output approved_by } }`,
      { id, input: { workflow_input: input, previous_output: previousOutput }, started: new Date().toISOString() }
    );
    return data.update_step_runs_by_pk;
  }

  private async updateStep(id: string, changes: Record<string, unknown>): Promise<void> {
    await hasura(`mutation Step($id: uuid!, $set: step_runs_set_input!) { update_step_runs_by_pk(pk_columns: { id: $id }, _set: $set) { id } }`, { id, set: changes });
  }

  private async updateRun(id: string, changes: Record<string, unknown>): Promise<void> {
    await hasura(`mutation Run($id: uuid!, $set: workflow_runs_set_input!) { update_workflow_runs_by_pk(pk_columns: { id: $id }, _set: $set) { id } }`, { id, set: changes });
  }
}
