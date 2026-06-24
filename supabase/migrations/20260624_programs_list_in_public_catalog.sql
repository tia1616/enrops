-- Opt-in: list a partner-run program on the public catalog with a link-out.
--
-- Only meaningful when runs_own_registration = true. Default false, so partner-run
-- programs stay hidden from the public catalog unless the operator explicitly opts
-- to list them (and has set external_registration_url). Additive + default-false,
-- so nothing changes for existing programs. No RLS change.

ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS list_in_public_catalog boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.programs.list_in_public_catalog IS
  'Only meaningful when runs_own_registration = true. When true (and external_registration_url is set), the partner-run program is shown in the public catalog with a register-on-the-partner-site link-out instead of being hidden.';
