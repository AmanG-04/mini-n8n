export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type StepType =
  | "llm_call"
  | "http_request"
  | "db_write"
  | "notify"
  | "conditional_branch"
  | "approval_gate";

export interface WorkflowStep {
  id: string;
  workflow_id: string;
  position: number;
  type: StepType;
  name: string;
  config: Record<string, Json>;
}

export interface StepRun {
  id: string;
  workflow_run_id: string;
  workflow_step_id: string;
  position: number;
  type: StepType;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "skipped";
  output: Json | null;
  approved_by: string | null;
}

export interface WorkflowRun {
  id: string;
  org_id: string;
  workflow_id: string;
  input: Record<string, Json>;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
}

export interface StepContext {
  run: WorkflowRun;
  step: WorkflowStep;
  stepRun: StepRun;
  input: Record<string, Json>;
  previousOutput: Json | null;
}

export interface StepResult {
  output: Json;
}
