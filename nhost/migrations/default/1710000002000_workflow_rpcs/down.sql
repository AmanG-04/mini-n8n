DROP FUNCTION IF EXISTS public.record_workflow_usage(uuid);
DROP FUNCTION IF EXISTS public.approve_workflow_step(uuid, uuid);
DROP FUNCTION IF EXISTS public.start_webhook_workflow_run(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.start_workflow_run(uuid, uuid, text, jsonb);
