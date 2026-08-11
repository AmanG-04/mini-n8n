"use client";

import { useEffect, useMemo, useState } from "react";
import { graphQL, ORGANIZATIONS, STEP_RUNS, STEP_RUNS_QUERY, WORKFLOWS } from "../lib/graphql";

type Org = { id: string; name: string; members: { user_id: string; role: "owner" | "editor" | "viewer" }[] };
type WorkflowRun = {
  id: string;
  trigger_type: string;
  status: string;
  error: string | null;
  initiated_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};
type Workflow = {
  id: string;
  name: string;
  description: string;
  steps: Step[];
  triggers: { id: string; type: string; is_enabled: boolean }[];
  runs: WorkflowRun[];
};
type Step = { id: string; position: number; type: string; name: string; config: Record<string, unknown> };
type StepRun = {
  id: string;
  position: number;
  type: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  attempt_count: number;
  approved_by: string | null;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
};

const mutation = (name: string, body: string) => `mutation ${name} ${body}`;
const configExamples: Record<string, string> = {
  llm_call: JSON.stringify({ prompt: "Reply with exactly the lowercase word yes and nothing else. Input: {{input}}", temperature: 0.2 }),
  http_request: JSON.stringify({ url: "https://httpbin.org/post", method: "POST", body: { input: "{{input}}" }, timeout_ms: 10000 }),
  conditional_branch: JSON.stringify({ path: "text", equals: "yes", if_positions: [2], else_positions: [] }),
  approval_gate: "{}",
  db_write: JSON.stringify({ label: "save workflow output" }),
  notify: JSON.stringify({ channel: "webhook", message: "Workflow completed" })
};

export default function Home() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [userId, setUserId] = useState("");
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgId, setOrgId] = useState("");
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [runId, setRunId] = useState("");
  const [workflowIdToTest, setWorkflowIdToTest] = useState("");
  const [stepRuns, setStepRuns] = useState<StepRun[]>([]);
  const [message, setMessage] = useState("");
  const [usage, setUsage] = useState({ quota_limit: 0, calls_used: 0, calls_remaining: 0 });
  const role = useMemo(() => orgs.find((x) => x.id === orgId)?.members.find((m) => m.user_id === userId)?.role, [orgs, orgId, userId]);
  const editable = role === "owner" || role === "editor";

  async function login(e: React.FormEvent) {
    e.preventDefault();
    try {
      const response = await fetch((process.env.NEXT_PUBLIC_NHOST_AUTH_URL ?? "http://localhost:1337/v1/auth") + "/signin/email-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Sign in failed");
      setToken(body.session.accessToken);
      setUserId(body.session.user.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign in failed");
    }
  }

  async function loadOrgs() {
    const data = await graphQL<{ organizations: Org[] }>(ORGANIZATIONS, {}, token);
    setOrgs(data.organizations);
    setOrgId((value) => value || data.organizations[0]?.id || "");
  }

  async function loadWorkflows() {
    if (!orgId) return;
    const data = await graphQL<{ workflows: Workflow[]; organization_usage_monthly: typeof usage[] }>(WORKFLOWS, { org: orgId }, token);
    setWorkflows(data.workflows);
    setSelected((old) => data.workflows.find((workflow) => workflow.id === old?.id) ?? data.workflows[0] ?? null);
    if (data.organization_usage_monthly[0]) setUsage(data.organization_usage_monthly[0]);
  }

  useEffect(() => { if (token) void loadOrgs(); }, [token]);
  useEffect(() => { if (token && orgId) void loadWorkflows(); }, [token, orgId]);

  async function loadStepRuns(id: string) {
    try {
      const data = await graphQL<{ step_runs: StepRun[]; workflow_runs_by_pk: { status: string } | null }>(STEP_RUNS_QUERY, { id }, token);
      setStepRuns(data.step_runs);
      if (["completed", "failed"].includes(data.workflow_runs_by_pk?.status ?? "")) void loadWorkflows();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load execution status.");
    }
  }

  useEffect(() => {
    if (!runId || !token) return;
    void loadStepRuns(runId);
    const refresh = window.setInterval(() => void loadStepRuns(runId), 1000);
    const ws = new WebSocket((process.env.NEXT_PUBLIC_NHOST_GRAPHQL_WS_URL ?? "ws://localhost:1337/v1/graphql").replace("http", "ws"), "graphql-transport-ws");
    ws.onopen = () => ws.send(JSON.stringify({ type: "connection_init", payload: { headers: { authorization: `Bearer ${token}` } } }));
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "connection_ack") {
        ws.send(JSON.stringify({ id: "steps", type: "subscribe", payload: { query: STEP_RUNS, variables: { id: runId } } }));
      } else if (data.type === "error") {
        setMessage("Live subscription error; automatic status refresh is active.");
      } else if (data.payload?.data) {
        setStepRuns(data.payload.data.step_runs);
        if (["completed", "failed"].includes(data.payload.data.workflow_runs_by_pk?.status)) void loadWorkflows();
      }
    };
    ws.onerror = () => setMessage("Live subscription unavailable; automatic status refresh is active.");
    return () => { window.clearInterval(refresh); ws.close(); };
  }, [runId, token]);

  async function run() {
    if (!selected) return;
    const data = await graphQL<{ triggerWorkflowRun: { run_id: string } }>(mutation("Run", `($id:uuid!){triggerWorkflowRun(workflow_id:$id){run_id status}}`), { id: selected.id }, token);
    setRunId(data.triggerWorkflowRun.run_id);
    setMessage("Run started - live statuses below.");
  }

  async function runWorkflowById() {
    const workflowId = workflowIdToTest.trim();
    if (!workflowId) { setMessage("Paste a workflow UUID first."); return; }
    try {
      const data = await graphQL<{ triggerWorkflowRun: { run_id: string } }>(mutation("RunById", `($id:uuid!){triggerWorkflowRun(workflow_id:$id){run_id status}}`), { id: workflowId }, token);
      setRunId(data.triggerWorkflowRun.run_id);
      setStepRuns([]);
      setMessage("Workflow ID was authorized and the run started.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Workflow run was not allowed.");
    }
  }

  async function approve(id: string) {
    await graphQL(mutation("Approve", `($id:uuid!){approveStep(step_run_id:$id){run_id status}}`), { id }, token);
    setMessage("Approval accepted; execution resumed.");
  }

  async function createWorkflow() {
    const name = window.prompt("Workflow name");
    if (!name || !orgId) return;
    const data = await graphQL<{ insert_workflows_one: Workflow }>(mutation("NewWorkflow", `($org:uuid!,$name:String!){insert_workflows_one(object:{org_id:$org,name:$name,description:""}){id name description steps{ id position type name config } triggers{id type is_enabled}}}`), { org: orgId, name }, token);
    setSelected(data.insert_workflows_one);
    await loadWorkflows();
  }

  async function addStep(type: string) {
    if (!selected) return;
    try {
      await graphQL(mutation("AddStep", `($workflow:uuid!,$position:Int!,$type:workflow_step_type!,$name:String!){insert_workflow_steps_one(object:{workflow_id:$workflow,position:$position,type:$type,name:$name,config:{}}){id}}`), { workflow: selected.id, position: selected.steps.length, type, name: type }, token);
      await loadWorkflows();
      setMessage(`${type} step added.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to add this step.");
    }
  }

  async function editStep(step: Step) {
    const raw = window.prompt(`Config JSON for ${step.type}. Example: ${configExamples[step.type] ?? "{}"}`, JSON.stringify(step.config));
    if (raw === null) return;
    try {
      const config = JSON.parse(raw);
      await graphQL(mutation("EditStep", `($id:uuid!,$config:jsonb!){update_workflow_steps_by_pk(pk_columns:{id:$id},_set:{config:$config}){id}}`), { id: step.id, config }, token);
      await loadWorkflows();
      setMessage(`${step.type} config saved.`);
    } catch {
      setMessage("Config must be valid JSON.");
    }
  }

  async function deleteStep(step: Step) {
    if (!selected || !window.confirm(`Delete the ${step.type} step?`)) return;
    try {
      await graphQL(mutation("DeleteStep", `($id:uuid!){delete_workflow_steps_by_pk(id:$id){id}}`), { id: step.id }, token);
      await loadWorkflows();
      setMessage("Step deleted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete step. A step used by a run cannot be deleted.");
    }
  }

  async function moveStep(index: number, direction: -1 | 1) {
    if (!selected) return;
    const other = selected.steps[index + direction];
    const current = selected.steps[index];
    if (!other) return;
    const update = `mutation Move($id:uuid!,$position:Int!){update_workflow_steps_by_pk(pk_columns:{id:$id},_set:{position:$position}){id}}`;
    await graphQL(update, { id: current.id, position: 1000000 }, token);
    await graphQL(update, { id: other.id, position: current.position }, token);
    await graphQL(update, { id: current.id, position: other.position }, token);
    await loadWorkflows();
  }

  async function addTrigger(type: "manual" | "webhook") {
    if (!selected) return;
    if (type === "webhook" && role !== "owner") { setMessage("Only owners can add webhook triggers."); return; }
    if (type === "manual" && selected.triggers.some((trigger) => trigger.type === type)) { setMessage(`${type} trigger already exists.`); return; }
    try {
      if (type === "webhook") {
        const result = await graphQL<{ createWebhookTrigger: { trigger_id: string; secret: string } }>(mutation("CreateWebhook", `($workflow:uuid!){createWebhookTrigger(workflow_id:$workflow){trigger_id secret}}`), { workflow: selected.id }, token);
        window.alert(`Copy this webhook secret now. It will not be shown again:\n\n${result.createWebhookTrigger.secret}\n\nTrigger ID: ${result.createWebhookTrigger.trigger_id}`);
        await loadWorkflows();
        return;
      }
      await graphQL(mutation("AddTrigger", `($workflow:uuid!,$type:workflow_trigger_type!){insert_workflow_triggers_one(object:{workflow_id:$workflow,type:$type,is_enabled:true,config:{}}){id}}`), { workflow: selected.id, type }, token);
      await loadWorkflows();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to add trigger.");
    }
  }

  function formatExecutionValue(value: unknown): string {
    if (value === null || value === undefined) return "-";
    if (typeof value === "string") return value;
    try { return JSON.stringify(value, null, 2) ?? "-"; } catch { return String(value); }
  }

  function formatExecutionTime(value: string | null): string { return value ? new Date(value).toLocaleString() : "-"; }

  if (!token) return <main className="auth"><h1>FlowForge</h1><p>Organization-safe AI workflow execution.</p><form onSubmit={login}><input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} /><input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} /><button>Sign in</button></form><small>{message}</small></main>;

  return <main><header><h1>FlowForge</h1><select value={orgId} onChange={(e) => setOrgId(e.target.value)}>{orgs.map((o) => <option value={o.id} key={o.id}>{o.name}</option>)}</select><span className="badge">{role ?? "no role"}</span><span>Usage {usage.calls_used}/{usage.quota_limit}</span></header><section className="grid"><aside><div className="row"><h2>Workflows</h2>{editable && <button onClick={createWorkflow}>New</button>}</div>{workflows.map((w) => <button className={selected?.id === w.id ? "selected" : ""} onClick={() => setSelected(w)} key={w.id}>{w.name}<small>{w.runs[0]?.status ?? "not run"}</small></button>)}</aside><article>{selected ? <><div className="row"><div><h2>{selected.name}</h2><p>{selected.description || "No description"}</p></div>{editable && <button onClick={run}>Run</button>}</div><h3>Ordered steps</h3>{selected.steps.map((s, index) => <div className="step" key={s.id}><b>{s.position + 1}. {s.type}</b><span>{s.name}</span>{editable && <><button onClick={() => moveStep(index, -1)}>Up</button><button onClick={() => moveStep(index, 1)}>Down</button><button onClick={() => editStep(s)}>Config</button><button onClick={() => deleteStep(s)}>Delete</button></>}</div>)}{editable && <div className="row">{["llm_call", "http_request", "conditional_branch", "approval_gate", "db_write", "notify"].map((t) => <button key={t} onClick={() => addStep(t)}>+ {t}</button>)}</div>}<h3>Triggers</h3>{selected.triggers.map((t) => <div className="step" key={t.id}><b>{t.type}</b><span>{t.is_enabled ? "enabled" : "disabled"}</span></div>)}{editable && <div className="row">{!selected.triggers.some((trigger) => trigger.type === "manual") && <button onClick={() => addTrigger("manual")}>+ manual trigger</button>}{role === "owner" && <button onClick={() => addTrigger("webhook")}>{selected.triggers.some((trigger) => trigger.type === "webhook") ? "Regenerate webhook secret" : "+ webhook trigger"}</button>}</div>}<section className="security-test"><h3>Authorization test</h3><p>Paste a workflow UUID from another organization. The server should reject it if this user is not a member.</p><p className="workflow-id">Current workflow ID: <code>{selected.id}</code></p><div className="row"><input value={workflowIdToTest} onChange={(e) => setWorkflowIdToTest(e.target.value)} placeholder="Workflow UUID to test" /><button onClick={runWorkflowById}>Run by ID</button></div></section><h3>Run history ({selected.runs.length})</h3>{selected.runs.length ? <div className="run-history">{selected.runs.map((runRecord) => <details className="run-history-item" key={runRecord.id}><summary><span className={'status ' + runRecord.status}>{runRecord.status}</span><b>{runRecord.trigger_type}</b><span>{formatExecutionTime(runRecord.created_at)}</span></summary><dl className="run-history-meta"><div><dt>Run ID</dt><dd>{runRecord.id}</dd></div><div><dt>Started</dt><dd>{formatExecutionTime(runRecord.started_at)}</dd></div><div><dt>Completed</dt><dd>{formatExecutionTime(runRecord.completed_at)}</dd></div><div><dt>Initiated by</dt><dd>{runRecord.initiated_by ?? "System/webhook"}</dd></div>{runRecord.error && <div className="execution-value"><dt>Error</dt><dd className="step-error">{runRecord.error}</dd></div>}</dl><button onClick={() => { setRunId(runRecord.id); setStepRuns([]); }}>View step details</button></details>)}</div> : <p className="muted">No runs yet.</p>}<h3>Live execution {runId && `(${runId.slice(0, 8)})`}</h3>{stepRuns.map((s) => <div className="step execution-step" key={s.id}><div className="execution-summary"><b>{s.position + 1}. {s.type}</b><span className={'status ' + (s.status ?? "")}>{s.status}</span><span className="attempt-count">attempts: {s.attempt_count}</span>{s.status === "paused" && editable && <button onClick={() => approve(s.id)}>Approve</button>}</div>{s.error && <small className="step-error">{s.error}</small>}<details className="execution-details"><summary>Execution details</summary><dl className="execution-meta"><div><dt>Status</dt><dd>{s.status}</dd></div><div><dt>Attempts</dt><dd>{s.attempt_count}</dd></div><div><dt>Started</dt><dd>{formatExecutionTime(s.started_at)}</dd></div><div><dt>Completed</dt><dd>{formatExecutionTime(s.completed_at)}</dd></div>{s.type === "approval_gate" && <><div><dt>Approved by</dt><dd>{s.approved_by ?? "Pending approval"}</dd></div><div><dt>Approved at</dt><dd>{formatExecutionTime(s.approved_at)}</dd></div></>}<div className="execution-value"><dt>Input</dt><dd><pre>{formatExecutionValue(s.input)}</pre></dd></div><div className="execution-value"><dt>Output</dt><dd><pre>{formatExecutionValue(s.output)}</pre></dd></div></dl></details></div>)}</> : <p>Create or select a workflow.</p>}</article></section><footer>{message}</footer></main>;
}
