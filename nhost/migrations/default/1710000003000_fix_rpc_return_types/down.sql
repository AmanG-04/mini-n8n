DROP FUNCTION IF EXISTS public.record_workflow_usage(uuid);
DROP FUNCTION IF EXISTS public.approve_workflow_step(uuid, uuid);
DROP FUNCTION IF EXISTS public.start_webhook_workflow_run(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.start_workflow_run(uuid, uuid, text, jsonb);

CREATE FUNCTION public.start_workflow_run(
  p_workflow_id uuid, p_user_id uuid, p_trigger_type text, p_input jsonb DEFAULT '{}'::jsonb
) RETURNS SETOF public.workflow_action_result
LANGUAGE plpgsql AS $$
DECLARE v_org_id uuid; v_role public.org_role; v_limit integer; v_used integer; v_run_id uuid; v_status public.workflow_run_status;
BEGIN
  SELECT w.org_id, m.role INTO v_org_id, v_role FROM public.workflows w JOIN public.org_members m ON m.org_id = w.org_id WHERE w.id = p_workflow_id AND w.is_enabled AND m.user_id = p_user_id;
  IF v_org_id IS NULL OR v_role = 'viewer' THEN RAISE EXCEPTION 'WORKFLOW_FORBIDDEN'; END IF;
  PERFORM 1 FROM public.organizations WHERE id = v_org_id FOR UPDATE;
  SELECT o.quota_limit, COALESCE(SUM(u.billable_calls) FILTER (WHERE u.created_at >= o.quota_period_start), 0)::integer INTO v_limit, v_used FROM public.organizations o LEFT JOIN public.usage_events u ON u.org_id = o.id WHERE o.id = v_org_id GROUP BY o.id;
  IF v_used >= v_limit THEN RAISE EXCEPTION 'QUOTA_EXHAUSTED'; END IF;
  INSERT INTO public.workflow_runs (workflow_id, org_id, trigger_type, input, initiated_by) VALUES (p_workflow_id, v_org_id, p_trigger_type::public.workflow_trigger_type, p_input, p_user_id) RETURNING id, workflow_runs.status INTO v_run_id, v_status;
  INSERT INTO public.step_runs (workflow_run_id, workflow_step_id, position, type) SELECT v_run_id, id, position, type FROM public.workflow_steps WHERE workflow_id = p_workflow_id ORDER BY position;
  RETURN QUERY SELECT v_run_id, v_status;
END; $$;

CREATE FUNCTION public.start_webhook_workflow_run(
  p_trigger_id uuid, p_secret text, p_input jsonb DEFAULT '{}'::jsonb
) RETURNS SETOF public.workflow_action_result
LANGUAGE plpgsql AS $$
DECLARE v_workflow_id uuid; v_org_id uuid; v_limit integer; v_used integer; v_run_id uuid; v_status public.workflow_run_status;
BEGIN
  SELECT wt.workflow_id, w.org_id INTO v_workflow_id, v_org_id FROM public.workflow_triggers wt JOIN public.workflows w ON w.id = wt.workflow_id WHERE wt.id = p_trigger_id AND wt.type = 'webhook' AND wt.is_enabled AND w.is_enabled AND wt.secret_hash = encode(digest(p_secret, 'sha256'), 'hex');
  IF v_workflow_id IS NULL THEN RAISE EXCEPTION 'WEBHOOK_FORBIDDEN'; END IF;
  PERFORM 1 FROM public.organizations WHERE id = v_org_id FOR UPDATE;
  SELECT o.quota_limit, COALESCE(SUM(u.billable_calls) FILTER (WHERE u.created_at >= o.quota_period_start), 0)::integer INTO v_limit, v_used FROM public.organizations o LEFT JOIN public.usage_events u ON u.org_id = o.id WHERE o.id = v_org_id GROUP BY o.id;
  IF v_used >= v_limit THEN RAISE EXCEPTION 'QUOTA_EXHAUSTED'; END IF;
  INSERT INTO public.workflow_runs (workflow_id, org_id, trigger_type, input) VALUES (v_workflow_id, v_org_id, 'webhook', p_input) RETURNING id, workflow_runs.status INTO v_run_id, v_status;
  INSERT INTO public.step_runs (workflow_run_id, workflow_step_id, position, type) SELECT v_run_id, id, position, type FROM public.workflow_steps WHERE workflow_id = v_workflow_id ORDER BY position;
  RETURN QUERY SELECT v_run_id, v_status;
END; $$;

CREATE FUNCTION public.approve_workflow_step(p_step_run_id uuid, p_user_id uuid)
RETURNS SETOF public.workflow_action_result
LANGUAGE plpgsql AS $$
DECLARE v_role public.org_role; v_run_id uuid;
BEGIN
  SELECT m.role, sr.workflow_run_id INTO v_role, v_run_id FROM public.step_runs sr JOIN public.workflow_runs wr ON wr.id = sr.workflow_run_id JOIN public.org_members m ON m.org_id = wr.org_id WHERE sr.id = p_step_run_id AND sr.type = 'approval_gate' AND sr.status = 'paused' AND wr.status = 'paused' AND m.user_id = p_user_id FOR UPDATE OF sr, wr;
  IF v_run_id IS NULL OR v_role = 'viewer' THEN RAISE EXCEPTION 'APPROVAL_FORBIDDEN'; END IF;
  UPDATE public.step_runs SET approved_by = p_user_id, approved_at = now(), status = 'pending' WHERE id = p_step_run_id;
  UPDATE public.workflow_runs SET status = 'queued' WHERE id = v_run_id;
  RETURN QUERY SELECT v_run_id, 'queued'::public.workflow_run_status;
END; $$;

CREATE FUNCTION public.record_workflow_usage(p_run_id uuid)
RETURNS SETOF public.workflow_usage_result LANGUAGE sql AS $$
  INSERT INTO public.usage_events (org_id, workflow_run_id)
  SELECT org_id, id FROM public.workflow_runs WHERE id = p_run_id AND status = 'completed'
  ON CONFLICT (workflow_run_id) DO NOTHING RETURNING id AS usage_id;
$$;
