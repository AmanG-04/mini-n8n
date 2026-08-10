-- Run after creating two Nhost Auth users. Replace the UUIDs with auth.users IDs.
-- The service/admin role is intentionally required for setup only; normal clients never receive it.
INSERT INTO public.organizations (id, name, quota_limit) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Org A', 100),
  ('22222222-2222-4222-8222-222222222222', 'Org B', 100);
-- INSERT INTO public.org_members (org_id,user_id,role) VALUES
-- ('11111111-1111-4111-8111-111111111111','ORG_A_OWNER_AUTH_UUID','owner'),
-- ('22222222-2222-4222-8222-222222222222','ORG_B_USER_AUTH_UUID','editor');

-- Create a workflow as the Org A owner through the UI, then add:
-- 1. llm_call config: {"prompt":"Return true when this input is acceptable: {{input}}"}
-- 2. conditional_branch config: {"path":"text","equals":"yes","if_positions":[2],"else_positions":[]}
-- 3. http_request config: {"url":"https://httpbin.org/post","method":"POST"}
-- 4. approval_gate config: {}
