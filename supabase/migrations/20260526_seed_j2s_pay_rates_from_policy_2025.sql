-- One-off seed for the J2S tenant from the "Policy-Instructor Pay & Time
-- Logging-2025" doc (effective 2025-02-17):
--
--   * Base hourly rate: $20/hr
--   * Half-day camp (morning/afternoon): 15 hrs/week => 3 hrs/day
--   * Full-day camp: 35 hrs/week => 7 hrs/day
--   * Weekly completion bonus: $100 (paid at week end)
--
-- Other tenants are NOT seeded by this migration. They configure their
-- own values when they onboard.

UPDATE organizations
SET pay_hourly_cents = 2000,
    pay_camp_morning_hours = 3.0,
    pay_camp_full_day_hours = 7.0,
    pay_camp_weekly_bonus_cents = 10000
WHERE id = '1adf10ad-d091-4aa0-82e3-af331468ea2b';
