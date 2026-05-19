-- Without this grant, authenticated users hit 403 from PostgREST even though
-- the org_read_recipients RLS policy would allow them. RLS only runs after
-- the SELECT grant gate. The table's `service_role` grants kept marketing-send
-- working; chunk 06's UI is the first authenticated-role consumer.
GRANT SELECT ON marketing_recipients TO authenticated;
