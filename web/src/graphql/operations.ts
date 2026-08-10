import { gql } from "@apollo/client";

export const STEP_RUNS_SUBSCRIPTION = gql`
  subscription StepRuns($workflowRunId: uuid!) {
    step_runs(where: { workflow_run_id: { _eq: $workflowRunId } }, order_by: { position: asc }) {
      id position type status input output error attempt_count approved_by approved_at started_at completed_at
    }
  }
`;

export const TRIGGER_WORKFLOW_RUN = gql`
  mutation TriggerWorkflowRun($workflowId: uuid!) {
    triggerWorkflowRun(workflow_id: $workflowId) { run_id status }
  }
`;

export const APPROVE_STEP = gql`
  mutation ApproveStep($stepRunId: uuid!) {
    approveStep(step_run_id: $stepRunId) { run_id status }
  }
`;
