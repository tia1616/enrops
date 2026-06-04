select format(
  'create policy %I on storage.objects for %s to %s %s%s;',
  policyname, cmd, array_to_string(roles, ', '),
  case when qual is not null then 'using ('||qual||')' else '' end,
  case when with_check is not null then ' with check ('||with_check||')' else '' end
)
from pg_policies
where schemaname='storage' and tablename='objects'
order by policyname;
