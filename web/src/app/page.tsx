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
const stepTypes = ["llm_call", "http_request", "conditional_branch", "approval_gate", "db_write", "notify"] as const;
const configExamples: Record<string, string> = {
  llm_call: JSON.stringify({ prompt: "Choose exactly one lowercase word: yes or no. Reply yes if the input message says yes; otherwise reply no. Do not add punctuation or explanation. Input: {{input}}", temperature: 0 }),
  // Postman Echo is used for the demo because it reliably echoes the request
  // body and is available over HTTPS without credentials.
  http_request: JSON.stringify({ url: "https://postman-echo.com/post", method: "POST", body: { input: "{{input}}" }, timeout_ms: 10000 }),
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
  const [memberUserId, setMemberUserId] = useState("");
  const [memberRole, setMemberRole] = useState<"owner" | "editor" | "viewer">("viewer");
  const [stepTypeToAdd, setStepTypeToAdd] = useState<(typeof stepTypes)[number]>("llm_call");
  const [startingRun, setStartingRun] = useState(false);
  const [stepRuns, setStepRuns] = useState<StepRun[]>([]);
  const [message, setMessage] = useState("");
  const [usage, setUsage] = useState({ quota_limit: 0, calls_used: 0, calls_remaining: 0 });
  const role = useMemo(() => orgs.find((x) => x.id === orgId)?.members.find((m) => m.user_id === userId)?.role, [orgs, orgId, userId]);
  const currentOrg = useMemo(() => orgs.find((x) => x.id === orgId), [orgs, orgId]);
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

  async function refreshOrganizations() {
    const data = await graphQL<{ organizations: Org[] }>(ORGANIZATIONS, {}, token);
    setOrgs(data.organizations);
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
    if (!selected || startingRun) return;
    setStartingRun(true);
    setMessage("Starting workflow… please wait for the first step status.");
    try {
      const data = await graphQL<{ triggerWorkflowRun: { run_id: string } }>(mutation("Run", `($id:uuid!){triggerWorkflowRun(workflow_id:$id){run_id status}}`), { id: selected.id }, token);
      setRunId(data.triggerWorkflowRun.run_id);
      setMessage("Run started - live statuses below.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to start workflow.");
    } finally {
      setStartingRun(false);
    }
  }

  async function runWorkflowById() {
    if (startingRun) return;
    const workflowId = workflowIdToTest.trim();
    if (!workflowId) { setMessage("Paste a workflow UUID first."); return; }
    setStartingRun(true);
    setMessage("Starting workflow by ID… please wait.");
    try {
      const data = await graphQL<{ triggerWorkflowRun: { run_id: string } }>(mutation("RunById", `($id:uuid!){triggerWorkflowRun(workflow_id:$id){run_id status}}`), { id: workflowId }, token);
      setRunId(data.triggerWorkflowRun.run_id);
      setStepRuns([]);
      setMessage("Workflow ID was authorized and the run started.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Workflow run was not allowed.");
    } finally {
      setStartingRun(false);
    }
  }

  async function approve(id: string) {
    try {
      setMessage("Approval submitted; resuming workflow…");
      const data = await graphQL<{ approveStep: { run_id: string; status: string } }>(mutation("Approve", `($id:uuid!){approveStep(step_run_id:$id){run_id status}}`), { id }, token);
      setRunId(data.approveStep.run_id);
      await loadStepRuns(data.approveStep.run_id);
      setMessage("Approval accepted; execution resumed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to approve this step.");
    }
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

  async function addSelectedStep() {
    await addStep(stepTypeToAdd);
  }

  async function handleStepAction(step: Step, index: number, action: string) {
    if (action === "config") await editStep(step);
    if (action === "delete") await deleteStep(step);
    if (action === "up") await moveStep(index, -1);
    if (action === "down") await moveStep(index, 1);
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

  async function saveMember(userId: string, roleToSave: "owner" | "editor" | "viewer") {
    if (!orgId || role !== "owner") return;
    try {
      await graphQL(mutation("SaveMember", `($org:uuid!,$user:uuid!,$role:org_role!){insert_org_members_one(object:{org_id:$org,user_id:$user,role:$role},on_conflict:{constraint:org_members_pkey,update_columns:[role]}){org_id user_id role}}`), { org: orgId, user: userId, role: roleToSave }, token);
      await refreshOrganizations();
      setMessage("Organization member saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save member. Check the user UUID and your owner role.");
    }
  }

  async function addMember() {
    const userId = memberUserId.trim();
    if (!userId) { setMessage("Enter an auth user UUID first."); return; }
    await saveMember(userId, memberRole);
    setMemberUserId("");
  }

  async function removeMember(memberId: string) {
    if (!orgId || role !== "owner" || memberId === userId) return;
    if (!window.confirm("Remove this user from the organization?")) return;
    try {
      await graphQL(mutation("RemoveMember", `($org:uuid!,$user:uuid!){delete_org_members_by_pk(org_id:$org,user_id:$user){org_id user_id}}`), { org: orgId, user: memberId }, token);
      await refreshOrganizations();
      setMessage("Organization member removed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to remove member.");
    }
  }

  function formatExecutionValue(value: unknown): string {
    if (value === null || value === undefined) return "-";
    if (typeof value === "string") return value;
    try { return JSON.stringify(value, null, 2) ?? "-"; } catch { return String(value); }
  }

  function formatExecutionTime(value: string | null): string {
    return value
      ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)) + " IST"
      : "-";
  }

  if (!token) return <main className="auth"><h1>FlowForge</h1><p>Organization-safe AI workflow execution.</p><form onSubmit={login}><input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} /><input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} /><button>Sign in</button></form><small>{message}</small></main>;

  return <main>
    <header>
      <h1>FlowForge</h1>
      <select aria-label="Organization" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
        {orgs.map((o) => <option value={o.id} key={o.id}>{o.name}</option>)}
      </select>
      <span className="badge">{role ?? "no role"}</span>
      <span>Usage {usage.calls_used}/{usage.quota_limit}</span>
    </header>
    <section className="grid">
      <aside>
        <div className="row"><h2>Workflows</h2>{editable && <button onClick={createWorkflow}>New</button>}</div>
        {workflows.map((w) => <button className={selected?.id === w.id ? "selected" : ""} onClick={() => setSelected(w)} key={w.id}>
          <span>{w.name}</span><small>{w.runs[0]?.status ?? "not run"}</small>
        </button>)}
      </aside>
      <article>
        {selected ? <>
          <div className="row workflow-heading">
            <div><h2>{selected.name}</h2><p>{selected.description || "No description"}</p></div>
            {editable && <button className="primary-action" onClick={run} disabled={startingRun}>{startingRun ? "Starting…" : "Run workflow"}</button>}
          </div>

          <section className="workflow-section">
            <div className="section-heading"><div><h3>Workflow steps</h3><p className="muted">Runs sequentially from top to bottom.</p></div></div>
            {selected.steps.length ? selected.steps.map((s, index) => <div className="step workflow-step" key={s.id}>
              <span className="step-number">{s.position + 1}</span><div className="step-label"><b>{s.type}</b><span>{s.name}</span></div>
              {editable && <select className="step-actions" aria-label={`Actions for step ${s.position + 1}`} defaultValue="" onChange={(e) => void handleStepAction(s, index, e.target.value)}>
                <option value="" disabled>Actions</option><option value="config">Edit config</option><option value="up" disabled={index === 0}>Move up</option><option value="down" disabled={index === selected.steps.length - 1}>Move down</option><option value="delete">Delete step</option>
              </select>}
            </div>) : <p className="muted empty-state">No steps yet. Add one below.</p>}
            {editable && <div className="add-step-controls"><select aria-label="Step type" value={stepTypeToAdd} onChange={(e) => setStepTypeToAdd(e.target.value as (typeof stepTypes)[number])}>{stepTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select><button onClick={addSelectedStep}>Add step</button></div>}
          </section>

          <section className="live-panel workflow-section">
            <div className="section-heading"><div><h3>Live execution</h3><p className="muted">Select a run to inspect each step as it updates.</p></div>
              <select aria-label="Execution run" value={runId} onChange={(e) => { setRunId(e.target.value); setStepRuns([]); }}>
                <option value="">Select run</option>
                {runId && !selected.runs.some((r) => r.id === runId) && <option value={runId}>Current run ({runId.slice(0, 8)})</option>}
                {selected.runs.map((runRecord) => <option value={runRecord.id} key={runRecord.id}>{runRecord.status} · {formatExecutionTime(runRecord.created_at)}</option>)}
              </select>
            </div>
            {stepRuns.length ? <div className="execution-list">{stepRuns.map((s) => <div className="step execution-step" key={s.id}>
              <div className="execution-summary"><span className="step-number">{s.position + 1}</span><b>{s.type}</b><span className={'status ' + (s.status ?? "")}>{s.status}</span><span className="attempt-count">{s.attempt_count} attempt{s.attempt_count === 1 ? "" : "s"}</span>{s.status === "paused" && editable && <button onClick={() => approve(s.id)}>Approve</button>}</div>
              {s.error && <small className="step-error">{s.error}</small>}
              <details className="execution-details"><summary>Step details</summary><dl className="execution-meta"><div><dt>Status</dt><dd>{s.status}</dd></div><div><dt>Attempts</dt><dd>{s.attempt_count}</dd></div><div><dt>Started</dt><dd>{formatExecutionTime(s.started_at)}</dd></div><div><dt>Completed</dt><dd>{formatExecutionTime(s.completed_at)}</dd></div>{s.type === "approval_gate" && <><div><dt>Approved by</dt><dd>{s.approved_by ?? "Pending approval"}</dd></div><div><dt>Approved at</dt><dd>{formatExecutionTime(s.approved_at)}</dd></div></>}<div className="execution-value"><dt>Input</dt><dd><pre>{formatExecutionValue(s.input)}</pre></dd></div><div className="execution-value"><dt>Output</dt><dd><pre>{formatExecutionValue(s.output)}</pre></dd></div></dl></details>
            </div>)}</div> : <p className="muted empty-state">Run the workflow or choose a run above to see step status.</p>}
          </section>

          <section className="workflow-section">
            <div className="section-heading"><div><h3>Triggers</h3><p className="muted">Start this workflow manually or through its webhook.</p></div></div>
            {selected.triggers.map((t) => <div className="step trigger-row" key={t.id}><b>{t.type}</b><span className={'status ' + (t.is_enabled ? "completed" : "")}>{t.is_enabled ? "enabled" : "disabled"}</span></div>)}
            {editable && <div className="add-step-controls"><select aria-label="Trigger type" defaultValue=""><option value="" disabled>Add trigger...</option>{!selected.triggers.some((trigger) => trigger.type === "manual") && <option value="manual">Manual trigger</option>}{role === "owner" && <option value="webhook">Webhook trigger</option>}</select><button onClick={(e) => { const select = e.currentTarget.previousElementSibling as HTMLSelectElement | null; if (select?.value) { void addTrigger(select.value as "manual" | "webhook"); select.value = ""; } }}>Add trigger</button></div>}
          </section>

          {role === "owner" && <details className="secondary-panel"><summary>Organization members</summary><p>Manage membership by Auth user UUID. Email addresses stay server-side.</p><div className="row member-form"><input value={memberUserId} onChange={(e) => setMemberUserId(e.target.value)} placeholder="Auth user UUID" /><select value={memberRole} onChange={(e) => setMemberRole(e.target.value as "owner" | "editor" | "viewer")}><option value="owner">owner</option><option value="editor">editor</option><option value="viewer">viewer</option></select><button onClick={addMember}>Add/update member</button></div><div className="member-list">{currentOrg?.members.map((member) => <div className="member-row" key={member.user_id}><code>{member.user_id}</code><select value={member.role} onChange={(e) => void saveMember(member.user_id, e.target.value as "owner" | "editor" | "viewer")}><option value="owner">owner</option><option value="editor">editor</option><option value="viewer">viewer</option></select><button disabled={member.user_id === userId} onClick={() => void removeMember(member.user_id)}>Remove</button></div>)}</div></details>}

          <details className="secondary-panel security-test"><summary>Authorization test</summary><p>Paste a workflow UUID from another organization. The server should reject it if this user is not a member.</p><p className="workflow-id">Current workflow ID: <code>{selected.id}</code></p><div className="row"><input value={workflowIdToTest} onChange={(e) => setWorkflowIdToTest(e.target.value)} placeholder="Workflow UUID to test" /><button onClick={runWorkflowById} disabled={startingRun}>{startingRun ? "Starting…" : "Run by ID"}</button></div></details>

          <details className="secondary-panel history-panel"><summary>Run history <span className="muted">({selected.runs.length} runs)</span></summary>
            {selected.runs.length ? <div className="run-history">{selected.runs.map((runRecord) => <details className="run-history-item" key={runRecord.id}><summary><span className={'status ' + runRecord.status}>{runRecord.status}</span><b>{runRecord.trigger_type}</b><span>{formatExecutionTime(runRecord.created_at)}</span></summary><dl className="run-history-meta"><div><dt>Run ID</dt><dd>{runRecord.id}</dd></div><div><dt>Started</dt><dd>{formatExecutionTime(runRecord.started_at)}</dd></div><div><dt>Completed</dt><dd>{formatExecutionTime(runRecord.completed_at)}</dd></div><div><dt>Initiated by</dt><dd>{runRecord.initiated_by ?? "System/webhook"}</dd></div>{runRecord.error && <div className="execution-value"><dt>Error</dt><dd className="step-error">{runRecord.error}</dd></div>}</dl><button onClick={() => { setRunId(runRecord.id); setStepRuns([]); }}>View step details</button></details>)}</div> : <p className="muted">No runs yet.</p>}
          </details>
        </> : <p>Create or select a workflow.</p>}
      </article>
    </section>
    <footer>{message}</footer>
  </main>;
}
