"use client";
import { useEffect, useMemo, useState } from "react";
import { graphQL, ORGANIZATIONS, WORKFLOWS, STEP_RUNS } from "../lib/graphql";

type Org = { id: string; name: string; members: { user_id: string; role: "owner" | "editor" | "viewer" }[] };
type Workflow = { id: string; name: string; description: string; steps: Step[]; triggers: { id: string; type: string; is_enabled: boolean }[]; runs: { id: string; status: string }[] };
type Step = { id: string; position: number; type: string; name: string; config: Record<string, unknown> };
const mutation = (name: string, body: string) => `mutation ${name} ${body}`;
const configExamples: Record<string, string> = {
  llm_call: JSON.stringify({ prompt: "Classify this input: {{input}}", model: "llama-3.3-70b-versatile", temperature: 0.2 }),
  http_request: JSON.stringify({ url: "https://httpbin.org/post", method: "POST", body: { input: "{{input}}" }, timeout_ms: 10000 }),
  conditional_branch: JSON.stringify({ path: "text", equals: "yes" }),
  approval_gate: "{}",
  db_write: JSON.stringify({ label: "save workflow output" }),
  notify: JSON.stringify({ channel: "webhook", message: "Workflow completed" })
};

export default function Home() {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [token, setToken] = useState("");
  const [userId, setUserId] = useState(""); const [orgs, setOrgs] = useState<Org[]>([]); const [orgId, setOrgId] = useState(""); const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selected, setSelected] = useState<Workflow | null>(null); const [runId, setRunId] = useState(""); const [stepRuns, setStepRuns] = useState<Step[]>([]); const [message, setMessage] = useState(""); const [usage, setUsage] = useState({ quota_limit: 0, calls_used: 0, calls_remaining: 0 });
  const role = useMemo(() => orgs.find((x) => x.id === orgId)?.members.find((m) => m.user_id === userId)?.role, [orgs, orgId, userId]);
  const editable = role === "owner" || role === "editor";
  async function login(e: React.FormEvent) { e.preventDefault(); try { const r = await fetch((process.env.NEXT_PUBLIC_NHOST_AUTH_URL ?? "http://localhost:1337/v1/auth") + "/signin/email-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }); const b = await r.json(); if (!r.ok) throw new Error(b.message ?? "Sign in failed"); setToken(b.session.accessToken); setUserId(b.session.user.id); } catch (x) { setMessage(x instanceof Error ? x.message : "Sign in failed"); } }
  async function loadOrgs() { const d = await graphQL<{ organizations: Org[] }>(ORGANIZATIONS, {}, token); setOrgs(d.organizations); setOrgId((v) => v || d.organizations[0]?.id || ""); }
  async function loadWorkflows() { if (!orgId) return; const d = await graphQL<{ workflows: Workflow[]; organization_usage_monthly: typeof usage[] }>(WORKFLOWS, { org: orgId }, token); setWorkflows(d.workflows); setSelected((old) => d.workflows.find((w) => w.id === old?.id) ?? d.workflows[0] ?? null); if (d.organization_usage_monthly[0]) setUsage(d.organization_usage_monthly[0]); }
  useEffect(() => { if (token) void loadOrgs(); }, [token]); useEffect(() => { if (token && orgId) void loadWorkflows(); }, [token, orgId]);
  useEffect(() => { if (!runId || !token) return; const ws = new WebSocket((process.env.NEXT_PUBLIC_NHOST_GRAPHQL_WS_URL ?? "ws://localhost:1337/v1/graphql").replace("http", "ws"), "graphql-transport-ws"); ws.onopen = () => { ws.send(JSON.stringify({ type: "connection_init", payload: { headers: { authorization: `Bearer ${token}` } } })); ws.send(JSON.stringify({ id: "steps", type: "subscribe", payload: { query: STEP_RUNS, variables: { id: runId } } })); }; ws.onmessage = (event) => { const data = JSON.parse(event.data); if (data.payload?.data) { setStepRuns(data.payload.data.step_runs); if (["completed", "failed"].includes(data.payload.data.workflow_runs_by_pk?.status)) void loadWorkflows(); } }; return () => ws.close(); }, [runId, token]);
  async function run() { if (!selected) return; const d = await graphQL<{ triggerWorkflowRun: { run_id: string } }>(mutation("Run", `($id:uuid!){triggerWorkflowRun(workflow_id:$id){run_id status}}`), { id: selected.id }, token); setRunId(d.triggerWorkflowRun.run_id); setMessage("Run started — live statuses below."); }
  async function approve(id: string) { await graphQL(mutation("Approve", `($id:uuid!){approveStep(step_run_id:$id){run_id status}}`), { id }, token); setMessage("Approval accepted; execution resumed."); }
  async function createWorkflow() { const name = window.prompt("Workflow name"); if (!name || !orgId) return; const d = await graphQL<{ insert_workflows_one: Workflow }>(mutation("NewWorkflow", `($org:uuid!,$name:String!){insert_workflows_one(object:{org_id:$org,name:$name,description:""}){id name description steps{ id position type name config } triggers{id type is_enabled}}}`), { org: orgId, name }, token); setSelected(d.insert_workflows_one); await loadWorkflows(); }
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
  async function editStep(step: Step) { const raw = window.prompt(`Config JSON for ${step.type}. Example: ${configExamples[step.type] ?? "{}"}`, JSON.stringify(step.config)); if (raw === null) return; try { const config = JSON.parse(raw); await graphQL(mutation("EditStep", `($id:uuid!,$config:jsonb!){update_workflow_steps_by_pk(pk_columns:{id:$id},_set:{config:$config}){id}}`), { id: step.id, config }, token); await loadWorkflows(); setMessage(`${step.type} config saved.`); } catch { setMessage("Config must be valid JSON."); } }
  async function deleteStep(step: Step) { if (!selected || !window.confirm(`Delete the ${step.type} step?`)) return; try { await graphQL(mutation("DeleteStep", `($id:uuid!){delete_workflow_steps_by_pk(id:$id){id}}`), { id: step.id }, token); await loadWorkflows(); setMessage("Step deleted."); } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to delete step. A step used by a run cannot be deleted."); } }
  async function moveStep(index: number, direction: -1 | 1) { if (!selected) return; const other = selected.steps[index + direction]; const current = selected.steps[index]; if (!other) return; const update = `mutation Move($id:uuid!,$position:Int!){update_workflow_steps_by_pk(pk_columns:{id:$id},_set:{position:$position}){id}}`; await graphQL(update, { id: current.id, position: 1000000 }, token); await graphQL(update, { id: other.id, position: current.position }, token); await graphQL(update, { id: current.id, position: other.position }, token); await loadWorkflows(); }
  async function addTrigger(type: "manual" | "webhook") {
    if (!selected) return;
    if (selected.triggers.some((trigger) => trigger.type === type)) { setMessage(`${type} trigger already exists.`); return; }
    if (type === "webhook" && role !== "owner") { setMessage("Only owners can add webhook triggers."); return; }
    try {
      await graphQL(mutation("AddTrigger", `($workflow:uuid!,$type:workflow_trigger_type!){insert_workflow_triggers_one(object:{workflow_id:$workflow,type:$type,is_enabled:true,config:{}}){id}}`), { workflow: selected.id, type }, token);
      await loadWorkflows();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to add trigger.");
    }
  }
  if (!token) return <main className="auth"><h1>FlowForge</h1><p>Organization-safe AI workflow execution.</p><form onSubmit={login}><input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} /><input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} /><button>Sign in</button></form><small>{message}</small></main>;
  return <main><header><h1>FlowForge</h1><select value={orgId} onChange={(e) => setOrgId(e.target.value)}>{orgs.map((o) => <option value={o.id} key={o.id}>{o.name}</option>)}</select><span className="badge">{role ?? "no role"}</span><span>Usage {usage.calls_used}/{usage.quota_limit}</span></header><section className="grid"><aside><div className="row"><h2>Workflows</h2>{editable && <button onClick={createWorkflow}>New</button>}</div>{workflows.map((w) => <button className={selected?.id === w.id ? "selected" : ""} onClick={() => setSelected(w)} key={w.id}>{w.name}<small>{w.runs[0]?.status ?? "not run"}</small></button>)}</aside><article>{selected ? <><div className="row"><div><h2>{selected.name}</h2><p>{selected.description || "No description"}</p></div>{editable && <button onClick={run}>Run</button>}</div><h3>Ordered steps</h3>{selected.steps.map((s, index) => <div className="step" key={s.id}><b>{s.position + 1}. {s.type}</b><span>{s.name}</span>{editable && <><button onClick={() => moveStep(index, -1)}>↑</button><button onClick={() => moveStep(index, 1)}>↓</button><button onClick={() => editStep(s)}>Config</button><button onClick={() => deleteStep(s)}>Delete</button></>}</div>)}{editable && <div className="row">{["llm_call","http_request","conditional_branch","approval_gate","db_write","notify"].map((t) => <button key={t} onClick={() => addStep(t)}>+ {t}</button>)}</div>}<h3>Triggers</h3>{selected.triggers.map((t) => <div className="step" key={t.id}><b>{t.type}</b><span>{t.is_enabled ? "enabled" : "disabled"}</span></div>)}{editable && <div className="row">{!selected.triggers.some((trigger) => trigger.type === "manual") && <button onClick={() => addTrigger("manual")}>+ manual trigger</button>}{role === "owner" && !selected.triggers.some((trigger) => trigger.type === "webhook") && <button onClick={() => addTrigger("webhook")}>+ webhook trigger</button>}</div>}<h3>Live execution {runId && `(${runId.slice(0, 8)})`}</h3>{stepRuns.map((s: Step & { status?: string; error?: string; approved_by?: string }) => <div className="step" key={s.id}><b>{s.position + 1}. {s.type}</b><span className={'status ' + (s.status ?? "")}>{s.status}</span>{s.status === "paused" && editable && <button onClick={() => approve(s.id)}>Approve</button>}{s.error && <small>{s.error}</small>}</div>)}</> : <p>Create or select a workflow.</p>}</article></section><footer>{message}</footer></main>;
}
