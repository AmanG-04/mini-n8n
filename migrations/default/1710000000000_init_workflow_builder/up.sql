CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE public.org_role AS ENUM ('owner', 'editor', 'viewer');
CREATE TYPE public.workflow_run_status AS ENUM ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled');
CREATE TYPE public.step_run_status AS ENUM ('pending', 'running', 'paused', 'completed', 'failed', 'skipped');
CREATE TYPE public.workflow_step_type AS ENUM ('llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate');
CREATE TYPE public.workflow_trigger_type AS ENUM ('manual', 'webhook', 'scheduled', 'database_event');

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  quota_limit integer NOT NULL DEFAULT 250 CHECK (quota_limit >= 0),
  quota_period_start timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.org_members (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.org_role NOT NULL DEFAULT 'viewer',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user_id_idx ON public.org_members(user_id);

CREATE TABLE public.workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '',
  is_enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  updated_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflows_org_id_idx ON public.workflows(org_id);

CREATE TABLE public.workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  type public.workflow_step_type NOT NULL,
  name text NOT NULL DEFAULT '',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, position)
);
CREATE INDEX workflow_steps_workflow_id_idx ON public.workflow_steps(workflow_id, position);

CREATE TABLE public.workflow_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  type public.workflow_trigger_type NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, type)
);
CREATE INDEX workflow_triggers_workflow_id_idx ON public.workflow_triggers(workflow_id);

CREATE TABLE public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  trigger_type public.workflow_trigger_type NOT NULL,
  status public.workflow_run_status NOT NULL DEFAULT 'queued',
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  error text,
  initiated_by uuid REFERENCES auth.users(id),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status <> 'completed') OR completed_at IS NOT NULL)
);
CREATE INDEX workflow_runs_workflow_id_created_at_idx ON public.workflow_runs(workflow_id, created_at DESC);
CREATE INDEX workflow_runs_org_id_created_at_idx ON public.workflow_runs(org_id, created_at DESC);

CREATE TABLE public.step_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id uuid NOT NULL REFERENCES public.workflow_steps(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position >= 0),
  type public.workflow_step_type NOT NULL,
  status public.step_run_status NOT NULL DEFAULT 'pending',
  input jsonb,
  output jsonb,
  error text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, workflow_step_id),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);
CREATE INDEX step_runs_run_id_position_idx ON public.step_runs(workflow_run_id, position);

CREATE TABLE public.workflow_data_writes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id uuid NOT NULL REFERENCES public.workflow_steps(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_data_writes_org_id_idx ON public.workflow_data_writes(org_id);

CREATE TABLE public.usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid UNIQUE NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  billable_calls integer NOT NULL DEFAULT 1 CHECK (billable_calls > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_org_month_idx ON public.usage_events(org_id, created_at);

CREATE VIEW public.organization_usage_monthly AS
SELECT
  o.id AS org_id,
  o.quota_limit,
  COALESCE(SUM(u.billable_calls) FILTER (WHERE u.created_at >= o.quota_period_start), 0)::integer AS calls_used,
  GREATEST(o.quota_limit - COALESCE(SUM(u.billable_calls) FILTER (WHERE u.created_at >= o.quota_period_start), 0)::integer, 0) AS calls_remaining
FROM public.organizations o
LEFT JOIN public.usage_events u ON u.org_id = o.id
GROUP BY o.id, o.quota_limit;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER organizations_set_updated_at BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER workflows_set_updated_at BEFORE UPDATE ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER workflow_steps_set_updated_at BEFORE UPDATE ON public.workflow_steps FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER workflow_triggers_set_updated_at BEFORE UPDATE ON public.workflow_triggers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
