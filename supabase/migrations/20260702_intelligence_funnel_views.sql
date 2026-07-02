-- Intelligence metrics layer: rollup views over the append-only event log.
--
-- WHY views (not raw-event queries): dashboards and the future Ennie readout must
-- never hand-roll funnel math against raw events — that's how two surfaces drift
-- into two different "conversion rates". These views are the single source of the
-- funnel definition. New signals still need no migration (open action_type vocab);
-- only a *new rollup* touches this file.
--
-- SEALED (Intelligence Rule 5): these views live in the sealed `intelligence`
-- schema and are granted to NO client role. anon/authenticated cannot reach them.
-- Per-operator readout is a later, SECURITY DEFINER RPC that filters to the caller's
-- own org and aggregates — an operator never sees another operator's rows.
--
-- HONEST CONVERSION: 'initiated' capture began 2026-06-05; many 'payment_completed'
-- rows were backfilled from earlier registrations that never emitted 'initiated'.
-- So conversion is measured ONLY over registrations that were actually initiated in
-- the instrumented window (initiated_and_paid / initiated) — it can never exceed 100%
-- and is only meaningful for the instrumented period.

-- Registration-grained base: one row per registration_id, collapsing its event history
-- into terminal facts. This is what makes conversion accurate (did THIS reg that was
-- initiated ever reach paid?) rather than dividing two unrelated all-time counts.
create or replace view intelligence.registration_funnel as
select
  registration_id,
  max(organization_id::text)::uuid                                         as organization_id,
  bool_or(action_type = 'initiated')                                       as was_initiated,
  bool_or(action_type = 'payment_completed')                               as was_paid,
  bool_or(action_type = 'payment_failed')                                  as had_payment_failure,
  bool_or(action_type = 'checkout_failed')                                 as had_checkout_failure,
  bool_or(action_type = 'cancelled')                                       as was_cancelled,
  bool_or(action_type = 'refunded')                                        as was_refunded,
  min(occurred_at) filter (where action_type = 'initiated')                as initiated_at,
  min(occurred_at) filter (where action_type = 'payment_completed')        as paid_at
from intelligence.enrollment_events
where registration_id is not null
group by registration_id;

comment on view intelligence.registration_funnel is
  'One row per registration_id: its funnel outcome (initiated/paid/failed/cancelled/refunded) + timestamps. Base for all funnel rollups.';

-- Per-operator funnel rollup. "What is working / what converts" for one org.
create or replace view intelligence.enrollment_funnel_by_org as
select
  organization_id,
  count(*) filter (where was_initiated)                                    as initiated,
  count(*) filter (where was_paid)                                         as paid,
  count(*) filter (where was_initiated and was_paid)                       as initiated_and_paid,
  count(*) filter (where had_payment_failure and not was_paid)             as failed_unrecovered,
  count(*) filter (where had_checkout_failure and not was_paid)            as checkout_failed_unrecovered,
  count(*) filter (where was_initiated and not was_paid
                        and not had_payment_failure)                       as open_or_abandoned,
  count(*) filter (where was_cancelled)                                    as cancelled,
  count(*) filter (where was_refunded)                                     as refunded,
  round(
    100.0 * count(*) filter (where was_initiated and was_paid)
          / nullif(count(*) filter (where was_initiated), 0)
  , 1)                                                                     as conversion_pct
from intelligence.registration_funnel
group by organization_id;

comment on view intelligence.enrollment_funnel_by_org is
  'Per-org funnel rollup. conversion_pct is initiated_and_paid / initiated (<=100%, instrumented window only).';

-- Abandonment: initiated a checkout, never paid, no recorded payment failure, and
-- enough time has passed that it is not just in-flight. This is the "not working / why"
-- signal — derived, because you cannot know at the moment of initiation that it will
-- be abandoned; abandonment is the ABSENCE of a follow-up event, so it is a query, not
-- an event we log.
create or replace view intelligence.abandoned_registrations as
select organization_id, registration_id, initiated_at
from intelligence.registration_funnel
where was_initiated
  and not was_paid
  and not had_payment_failure
  and initiated_at < now() - interval '24 hours';

comment on view intelligence.abandoned_registrations is
  'Registrations initiated >24h ago with no payment and no payment failure recorded — the abandonment (drop-off) signal, derived from event absence.';

-- Coverage / drift: every action_type actually in the log, with volume and window.
-- A typo (payment_complete vs payment_completed) shows up here as a low-count stray
-- action_type — the DB has no enum on purpose, so this view is how drift stays visible.
create or replace view intelligence.action_volume as
select
  action_type,
  count(*)                     as events,
  count(distinct organization_id) as orgs,
  min(occurred_at)             as first_seen,
  max(occurred_at)             as last_seen
from intelligence.enrollment_events
group by action_type
order by events desc;

comment on view intelligence.action_volume is
  'Every action_type in the log with volume + first/last seen. Stray low-count types = typos/drift (the enum lives in code, not the DB).';

-- Keep the seal: no client role may read these. Readout reaches operators only via a
-- future SECURITY DEFINER RPC that scopes to the caller org and aggregates.
revoke all on intelligence.registration_funnel      from anon, authenticated;
revoke all on intelligence.enrollment_funnel_by_org from anon, authenticated;
revoke all on intelligence.abandoned_registrations  from anon, authenticated;
revoke all on intelligence.action_volume            from anon, authenticated;
