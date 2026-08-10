export const HASURA_URL = process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL ?? "http://localhost:1337/v1/graphql";

export async function graphQL<T>(query: string, variables: Record<string, unknown>, token: string): Promise<T> {
  const response = await fetch(HASURA_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }) });
  const body = await response.json();
  if (!response.ok || body.errors) throw new Error(body.errors?.[0]?.message ?? "GraphQL request failed");
  return body.data as T;
}

export const WORKFLOWS = `query Workflows($org: uuid!) { workflows(where:{org_id:{_eq:$org}}, order_by:{updated_at:desc}) { id name description is_enabled steps(order_by:{position:asc}) { id position type name config } triggers { id type is_enabled config } runs(limit:1,order_by:{created_at:desc}) { id status created_at } } organization_usage_monthly(where:{org_id:{_eq:$org}}) { quota_limit calls_used calls_remaining } }`;
export const ORGANIZATIONS = `query Organizations { organizations { id name members { user_id role } } }`;
export const STEP_RUNS = `subscription StepRuns($id: uuid!) { step_runs(where:{workflow_run_id:{_eq:$id}},order_by:{position:asc}) { id position type status output error approved_by } workflow_runs_by_pk(id:$id) { id status error } }`;
export const STEP_RUNS_QUERY = `query StepRuns($id: uuid!) { step_runs(where:{workflow_run_id:{_eq:$id}},order_by:{position:asc}) { id position type status output error approved_by } workflow_runs_by_pk(id:$id) { id status error } }`;
