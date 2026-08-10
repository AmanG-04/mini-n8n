import type { Pool, PoolClient } from "pg";
import { createHash, timingSafeEqual } from "node:crypto";
import { WorkflowExecutor } from "./executor.js";

type Role = "owner" | "editor" | "viewer";

export class ActionError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

async function eligibleWorkflow(client: PoolClient, workflowId: string, userId: string): Promise<{ id: string; org_id: string; role: Role } | null> {
  const result = await client.query<{ id: string; org_id: string; role: Role }>(
    `SELECT w.id, w.org_id, m.role FROM public.workflows w
     JOIN public.org_members m ON m.org_id = w.org_id
     WHERE w.id = $1 AND w.is_enabled AND m.user_id = $2`, [workflowId, userId]
  );
  return result.rows[0] ?? null;
}

export async function createRun(pool: Pool, workflowId: string, userId: string, triggerType: "manual" | "webhook", input: object = {}): Promise<{ run_id: string; status: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workflow = await eligibleWorkflow(client, workflowId, userId);
    if (!workflow || workflow.role === "viewer") throw new ActionError("Workflow not found or you do not have permission", 403);
    await client.query(`SELECT id FROM public.organizations WHERE id = $1 FOR UPDATE`, [workflow.org_id]);
    const quota = await client.query<{ quota_limit: number; calls_used: number }>(
      `SELECT o.quota_limit, COALESCE(SUM(u.billable_calls) FILTER (WHERE u.created_at >= o.quota_period_start), 0)::integer AS calls_used
       FROM public.organizations o LEFT JOIN public.usage_events u ON u.org_id = o.id WHERE o.id = $1 GROUP BY o.id`, [workflow.org_id]
    );
    const usage = quota.rows[0];
    if (!usage || usage.calls_used >= usage.quota_limit) throw new ActionError("Organization workflow quota is exhausted", 429);
    const run = await client.query<{ id: string; status: string }>(
      `INSERT INTO public.workflow_runs (workflow_id, org_id, trigger_type, status, input, initiated_by)
       VALUES ($1, $2, $3, 'queued', $4::jsonb, $5) RETURNING id, status`,
      [workflow.id, workflow.org_id, triggerType, JSON.stringify(input), userId]
    );
    await client.query(
      `INSERT INTO public.step_runs (workflow_run_id, workflow_step_id, position, type)
       SELECT $1, id, position, type FROM public.workflow_steps WHERE workflow_id = $2 ORDER BY position`,
      [run.rows[0].id, workflow.id]
    );
    await client.query("COMMIT");
    queueExecution(pool, run.rows[0].id);
    return { run_id: run.rows[0].id, status: run.rows[0].status };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function approveRunStep(pool: Pool, stepRunId: string, userId: string): Promise<{ run_id: string; status: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ run_id: string; role: Role }>(
      `SELECT sr.workflow_run_id AS run_id, m.role
       FROM public.step_runs sr
       JOIN public.workflow_runs wr ON wr.id = sr.workflow_run_id
       JOIN public.org_members m ON m.org_id = wr.org_id
       WHERE sr.id = $1 AND sr.type = 'approval_gate' AND sr.status = 'paused'
         AND wr.status = 'paused' AND m.user_id = $2 FOR UPDATE`, [stepRunId, userId]
    );
    const step = result.rows[0];
    if (!step || step.role === "viewer") throw new ActionError("Approval step not found or you do not have permission", 403);
    await client.query(
      `UPDATE public.step_runs SET approved_by = $2, approved_at = now(), status = 'pending' WHERE id = $1`, [stepRunId, userId]
    );
    await client.query(`UPDATE public.workflow_runs SET status = 'queued' WHERE id = $1`, [step.run_id]);
    await client.query("COMMIT");
    queueExecution(pool, step.run_id);
    return { run_id: step.run_id, status: "queued" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Authenticates an inbound webhook with its per-trigger secret, never an org id supplied by the caller. */
export async function createWebhookRun(pool: Pool, triggerId: string, secret: string, input: object = {}): Promise<{ run_id: string; status: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const trigger = await client.query<{ workflow_id: string; org_id: string; secret_hash: string | null }>(
      `SELECT wt.workflow_id, w.org_id, wt.secret_hash FROM public.workflow_triggers wt
       JOIN public.workflows w ON w.id = wt.workflow_id
       WHERE wt.id = $1 AND wt.type = 'webhook' AND wt.is_enabled AND w.is_enabled FOR UPDATE`, [triggerId]
    );
    const row = trigger.rows[0];
    const received = createHash("sha256").update(secret).digest("hex");
    if (!row?.secret_hash || !timingSafeEqual(Buffer.from(row.secret_hash), Buffer.from(received))) throw new ActionError("Invalid webhook credentials", 401);
    await client.query(`SELECT id FROM public.organizations WHERE id = $1 FOR UPDATE`, [row.org_id]);
    const quota = await client.query<{ quota_limit: number; calls_used: number }>(
      `SELECT o.quota_limit, COALESCE(SUM(u.billable_calls) FILTER (WHERE u.created_at >= o.quota_period_start), 0)::integer AS calls_used
       FROM public.organizations o LEFT JOIN public.usage_events u ON u.org_id = o.id WHERE o.id = $1 GROUP BY o.id`, [row.org_id]
    );
    if (!quota.rows[0] || quota.rows[0].calls_used >= quota.rows[0].quota_limit) throw new ActionError("Organization workflow quota is exhausted", 429);
    const run = await client.query<{ id: string; status: string }>(
      `INSERT INTO public.workflow_runs (workflow_id, org_id, trigger_type, status, input) VALUES ($1, $2, 'webhook', 'queued', $3::jsonb) RETURNING id, status`,
      [row.workflow_id, row.org_id, JSON.stringify(input)]
    );
    await client.query(`INSERT INTO public.step_runs (workflow_run_id, workflow_step_id, position, type) SELECT $1, id, position, type FROM public.workflow_steps WHERE workflow_id = $2 ORDER BY position`, [run.rows[0].id, row.workflow_id]);
    await client.query("COMMIT");
    queueExecution(pool, run.rows[0].id);
    return { run_id: run.rows[0].id, status: run.rows[0].status };
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { client.release(); }
}

function queueExecution(pool: Pool, runId: string): void {
  setTimeout(() => {
    void new WorkflowExecutor(pool).execute(runId).then(async (result) => {
      if (result.status === "completed") {
        await pool.query(`INSERT INTO public.usage_events (org_id, workflow_run_id) SELECT org_id, id FROM public.workflow_runs WHERE id = $1 ON CONFLICT (workflow_run_id) DO NOTHING`, [runId]);
      }
    }).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : "Executor crashed";
      await pool.query(`UPDATE public.workflow_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1 AND status <> 'completed'`, [runId, message]);
      console.error("Workflow execution failed", { runId, message });
    });
  }, 0);
}
