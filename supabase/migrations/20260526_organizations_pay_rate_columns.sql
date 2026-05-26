-- Pay-rate config per organization. Each tenant configures their own
-- model; nothing here is J2S-specific.
--
-- session_delivery_confirmations.pay_amount_cents is computed at write
-- time (in the confirm-session-taught edge function) as:
--   pay_hourly_cents * hours_for_session_type
--
-- where hours_for_session_type is pay_camp_morning_hours for
-- session_type='morning' or 'afternoon', and pay_camp_full_day_hours
-- for session_type='full_day'.
--
-- pay_camp_weekly_bonus_cents is added as pay_adjustment_cents on the
-- last weekday confirmation of a camp when all preceding weekdays are
-- also confirmed for the same instructor. Reason: "Week completion bonus".
--
-- Tenants without these values set: confirm-session-taught skips pay
-- computation (pay_amount_cents stays null, admin sets manually). This
-- keeps things safe before a tenant has configured their pay model.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS pay_hourly_cents INTEGER CHECK (pay_hourly_cents IS NULL OR pay_hourly_cents >= 0),
  ADD COLUMN IF NOT EXISTS pay_camp_morning_hours NUMERIC(4,2) CHECK (pay_camp_morning_hours IS NULL OR pay_camp_morning_hours > 0),
  ADD COLUMN IF NOT EXISTS pay_camp_full_day_hours NUMERIC(4,2) CHECK (pay_camp_full_day_hours IS NULL OR pay_camp_full_day_hours > 0),
  ADD COLUMN IF NOT EXISTS pay_camp_weekly_bonus_cents INTEGER CHECK (pay_camp_weekly_bonus_cents IS NULL OR pay_camp_weekly_bonus_cents >= 0);

COMMENT ON COLUMN organizations.pay_hourly_cents IS 'Base hourly rate for instructor pay, in cents. e.g. 2000 = $20/hr.';
COMMENT ON COLUMN organizations.pay_camp_morning_hours IS 'Hours logged per morning/afternoon (half-day) camp session.';
COMMENT ON COLUMN organizations.pay_camp_full_day_hours IS 'Hours logged per full-day camp session.';
COMMENT ON COLUMN organizations.pay_camp_weekly_bonus_cents IS 'One-time bonus paid when all weekdays of a camp are confirmed taught.';
