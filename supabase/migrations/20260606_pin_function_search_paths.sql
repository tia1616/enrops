-- 2026-06-06 — Defense-in-depth: pin search_path on four functions the advisor
-- flagged with a mutable search_path. All are SECURITY INVOKER, take no args, and
-- currently resolve unqualified names against the default search_path (which
-- includes public), so pinning to `public` is behavior-preserving. Guarded so it
-- is a no-op if a function is absent in a given environment.
do $$
begin
  if to_regprocedure('public.set_automations_updated_at()') is not null then
    execute 'alter function public.set_automations_updated_at() set search_path = public'; end if;
  if to_regprocedure('public.program_locations_partner_same_org()') is not null then
    execute 'alter function public.program_locations_partner_same_org() set search_path = public'; end if;
  if to_regprocedure('public.check_camp_assignment_conflict()') is not null then
    execute 'alter function public.check_camp_assignment_conflict() set search_path = public'; end if;
  if to_regprocedure('public.compute_distance_bonus()') is not null then
    execute 'alter function public.compute_distance_bonus() set search_path = public'; end if;
end $$;
