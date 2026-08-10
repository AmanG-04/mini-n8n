CREATE TABLE public.notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id uuid NOT NULL REFERENCES public.workflow_steps(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('webhook', 'slack')),
  payload jsonb NOT NULL,
  delivered_at timestamptz,
  delivery_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_outbox_pending_idx ON public.notification_outbox(delivered_at) WHERE delivered_at IS NULL;
