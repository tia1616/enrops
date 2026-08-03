-- 20260802b_alert_email_check_no_function_dependency.sql
--
-- Code-review finding on 20260802a.
--
-- 20260802a re-pointed organizations_alert_email_format at
-- public.is_plausible_email() so the rule lived in one place. That was right
-- about the drift and wrong about the cost: pg_dump emits CHECK constraints
-- INLINE in CREATE TABLE, so a logical restore into an empty database can run
--
--     CREATE TABLE public.organizations (... CHECK (... public.is_plausible_email(...)))
--
-- before the function exists, and fail on the table that everything else
-- references. That only bites during disaster recovery, which is exactly when
-- it is least affordable, and 20260801d had no such coupling.
--
-- So: the CONSTRAINT goes back to an inline regex (no dependency, restores
-- standalone), and the FUNCTION stays for the triggers, where a plain function
-- call carries no dump-ordering risk.
--
-- That leaves the pattern written twice, which is the thing 20260802a was
-- trying to avoid. It is not left on trust: the assertion at the bottom feeds a
-- table of addresses through BOTH the live constraint and the function and
-- fails the migration if they ever disagree. That is a real cross-check, not a
-- function compared against itself -- the constraint is exercised by actually
-- attempting writes.

-- ---------------------------------------------------------------------------
-- Constraint: inline predicate, byte-identical to the function's body.
-- ---------------------------------------------------------------------------
alter table public.organizations
  drop constraint if exists organizations_alert_email_format;

alter table public.organizations
  add constraint organizations_alert_email_format
  check (
    alert_email is null
    or alert_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  );

comment on function public.is_plausible_email(text) is
  'Single definition of the address-format rule for the alert_email seeding triggers (20260731f / 20260802a). The organizations_alert_email_format CHECK deliberately inlines the SAME pattern rather than calling this, so the table has no function dependency to trip a pg_dump restore (20260802b). 20260802b asserts the two agree; keep them in step. Mirrored in the UI by PLAUSIBLE_EMAIL in src/pages/admin/EmailSenderSettings.jsx.';

-- ---------------------------------------------------------------------------
-- Prove the constraint and the function still agree, by exercising BOTH on the
-- same inputs. The constraint is tested the only way that is honest: by trying
-- a real write and seeing whether it is refused.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org      uuid;
  v_case     record;
  v_fn       boolean;
  v_accepted boolean;
begin
  insert into public.organizations (name, slug, email, venue_model, timezone)
  values ('CONSTRAINT PARITY PROBE', 'constraint-parity-probe', null, 'own_venue', 'America/Los_Angeles')
  returning id into v_org;

  for v_case in
    select * from (values
      ('owner@example.com'),          -- ordinary
      ('a.b+tag@sub.example.co.uk'),  -- plus-addressing, multi-label domain
      ('no-at-sign.example.com'),     -- missing @
      ('missing-tld@example'),        -- no dot in the domain
      ('two@@example.com'),           -- doubled @
      ('has space@example.com'),      -- embedded ASCII space
      ('trailing@example.com.'),      -- trailing dot
      ('Name <real@example.com>'),    -- pasted display-name form
      ('@example.com'),               -- empty local part
      ('owner@.com')                  -- empty domain label
    ) as t(addr)
  loop
    v_fn := public.is_plausible_email(v_case.addr);

    begin
      update public.organizations set alert_email = v_case.addr where id = v_org;
      v_accepted := true;
    exception when check_violation then
      v_accepted := false;
    end;

    if v_fn is distinct from v_accepted then
      raise exception
        'DRIFT: is_plausible_email(%) = %, but the CHECK constraint %. The inline pattern and the function body have diverged.',
        v_case.addr, v_fn, case when v_accepted then 'accepted it' else 'rejected it' end;
    end if;
  end loop;

  delete from public.organizations where id = v_org;
end $$;
