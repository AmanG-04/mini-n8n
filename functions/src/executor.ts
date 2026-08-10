import type { Pool, PoolClient } from "pg";
import { executeStep } from "./handlers/index.js";
import type { Json, StepRun, WorkflowRun, WorkflowStep } from "./types.js";

type JoinedStep = WorkflowStep & { step_run_id: string; step_run_status: StepRun["status"]; step_run_output: Json | null; approved_by: string | null };

function toRun(row: Record<string, unknown>): WorkflowRun {
  return row as unknown as WorkflowRun;
}

export class WorkflowExecutor {
  constructor(private readonly pool: Pool) {}

  async execute(runId: string): Promise<{ status: WorkflowRun["status"] }> {
    const client = await this.pool.connect();
    try {
      const runResult = await client.query<WorkflowRun>(
        `UPDATE public.workflow_runs SET status = 'running', started_at = COALESCE(started_at, now()), error = NULL
         WHERE id = $1 AND status IN ('queued', 'paused', 'running') RETURNING *`, [runId]
      );
      const run = runResult.rows[0];
      if (!run) throw new Error("Run is not executable");
      const steps = await this.loadSteps(client, runId);
      let previousOutput: Json | null = null;
      for (const item of steps) {
        if (item.step_run_status === "completed" || item.step_run_status === "skipped") {
          previousOutput = item.step_run_output;
          continue;
        }
        if (item.type === "approval_gate") {
          if (!item.approved_by) {
            await client.query(`UPDATE public.step_runs SET status = 'paused', started_at = COALESCE(started_at, now()) WHERE id = $1`, [item.step_run_id]);
            await client.query(`UPDATE public.workflow_runs SET status = 'paused' WHERE id = $1`, [runId]);
            return { status: "paused" };
          }
          await client.query(`UPDATE public.step_runs SET status = 'completed', completed_at = now(), output = $2::jsonb WHERE id = $1`, [item.step_run_id, JSON.stringify({ approved_by: item.approved_by })]);
          previousOutput = { approved_by: item.approved_by };
          continue;
        }

        const stepRun = await this.markRunning(client, item.step_run_id, run.input, previousOutput);
        try {
          const result = await executeStep(client, { run, step: item, stepRun, input: run.input, previousOutput });
          await client.query(
            `UPDATE public.step_runs SET status = 'completed', output = $2::jsonb, completed_at = now(), error = NULL WHERE id = $1`,
            [item.step_run_id, JSON.stringify(result.output)]
          );
          previousOutput = result.output;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown step error";
          await client.query(`UPDATE public.step_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`, [item.step_run_id, message]);
          await client.query(`UPDATE public.workflow_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`, [runId, message]);
          return { status: "failed" };
        }
      }
      await client.query(`UPDATE public.workflow_runs SET status = 'completed', output = $2::jsonb, completed_at = now() WHERE id = $1`, [runId, JSON.stringify(previousOutput)]);
      return { status: "completed" };
    } finally {
      client.release();
    }
  }

  private async loadSteps(client: PoolClient, runId: string): Promise<JoinedStep[]> {
    const result = await client.query<JoinedStep>(
      `SELECT ws.*, sr.id AS step_run_id, sr.status AS step_run_status, sr.output AS step_run_output, sr.approved_by
       FROM public.step_runs sr JOIN public.workflow_steps ws ON ws.id = sr.workflow_step_id
       WHERE sr.workflow_run_id = $1 ORDER BY sr.position ASC`, [runId]
    );
    return result.rows;
  }

  private async markRunning(client: PoolClient, id: string, input: Record<string, Json>, previousOutput: Json | null): Promise<StepRun> {
    const result = await client.query<StepRun>(
      `UPDATE public.step_runs SET status = 'running', started_at = COALESCE(started_at, now()), attempt_count = attempt_count + 1,
       input = $2::jsonb WHERE id = $1 RETURNING *`,
      [id, JSON.stringify({ workflow_input: input, previous_output: previousOutput })]
    );
    return result.rows[0];
  }
}
