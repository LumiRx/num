-- NUM 0003 — make analytics views run with the querying user's privileges
-- Resolves Supabase linter 0010 (security_definer_view). Views created in 0002
-- default to SECURITY DEFINER; security_invoker makes them honour the caller's
-- RLS, so the dashboard role only ever sees rows it's entitled to.
alter view v_cost_per_user_daily set (security_invoker = on);
alter view v_language_mix       set (security_invoker = on);
