-- 20260821f_seed_contractor_status_documents.sql
--
-- Give every existing active provider a ready-made first version of the
-- `contractor_status` ("Independent contractor status") document.
--
-- WHY THIS EXISTS, AND WHY IT SHIPS WITH THE FRONTEND RATHER THAN AFTER IT.
-- 20260821e restores the key and the frontend turns Screen3ORS into that
-- document. The document DEFAULTS ON (absent means ON, no exceptions), and no
-- provider has ever written one - so on the day the frontend lands, every
-- provider's instructors would reach Screen 3, find nothing published, and read
-- "<provider> has not published this note yet" with a disabled Continue. Today
-- that screen is hardcoded platform text every instructor passes without
-- thinking. Turning a working screen into a wall is not an acceptable
-- transition, so the seed is part of the same pass, not a follow-up.
--
-- COUNTED LIVE BEFORE WRITING THIS (2026-08-22):
--   PROD    : 7 active orgs, ZERO with a contractor_status document, ZERO with
--             the config key. j2s has 27 instructors, the-ukulele-project has 1,
--             the other five have none. So this is additive everywhere and only
--             two orgs can even feel it today.
--   STAGING : tenant-two-test (Cascade) already has a v1 from QA and is skipped
--             by the guard below - which is also the idempotency test.
--
-- WHAT THE TEXT IS. Our existing Screen 3 wording, which is what every
-- instructor already reads today, with two changes that make it publish-ready:
--   1. `[your business name]` is replaced with the provider's own name, so no
--      instructor is shown a bracketed prompt.
--   2. The optional "[Add anything else specific to how you engage
--      contractors...]" prompt is DROPPED entirely rather than seeded. A
--      bracketed instruction is fine in a starter draft the provider is about to
--      edit; it is not fine in a published document an instructor reads. This is
--      the whole reason the seed is not simply the starter string.
-- Net effect for an instructor: the words on Screen 3 do not change.
--
-- A POINT-IN-TIME SNAPSHOT, NOT A MIRROR. This prose is deliberately a copy of
-- INSTRUCTOR_DOCUMENTS['contractor_status'].starter as it stood on 2026-08-22.
-- It is NOT kept in sync and must not be: the starter seeds NEW providers going
-- forward, this seeded the ones that already existed, and from the moment it runs
-- each row belongs to its provider and they will edit it. Do not add a drift
-- guard between the two - there is nothing to keep aligned.
--
-- version 'v1' is correct rather than cosmetic: nextVersionFor() reads the
-- highest existing integer, so a provider's first edit publishes v2 and the
-- screen says "Version 2". No collision with the UNIQUE(organization_id,
-- document_key, document_version) constraint, because the guard below skips any
-- org that already holds ANY version of this key.
--
-- IDEMPOTENT AND RE-RUNNABLE. The NOT EXISTS is on (org, document_key) with no
-- version filter, so running this twice inserts nothing the second time, and an
-- org that has since written their own v1 (or v3) is never overwritten. Re-run
-- it freely.
--
-- DELIBERATELY DOES NOT TOUCH instructor_document_config. Absent already means
-- ON, so writing `true` would add a config key for every org to say what the
-- default already says - and it would be the one write here that changes a
-- provider's stored intent rather than giving them content. If a provider wants
-- the screen gone they switch it off in Settings and gateCheck drops the step;
-- that path is verified on staging in both directions.
--
-- ORGS WITH NO NAME ARE SKIPPED, not seeded with a gap where the name goes.
-- "Your engagement with  is as an independent contractor" is worse than the
-- honest "not published yet" message. No active org on either database is in
-- that state today; the guard is there so it stays true.

insert into legal_documents
  (organization_id, document_key, document_version, title, body_text, effective_from)
select
  o.id,
  'contractor_status',
  'v1',
  'Independent contractor status',
  replace(
    $seed$Working as an independent contractor

Your engagement with [your business name] is as an independent contractor, not as an employee. That means:

- You are responsible for your own taxes. Nothing is withheld from what we pay you.
- You use your own transportation and carry your own car insurance.
- You may work with other clients alongside this engagement.

Where the detail lives
Your contractor agreement sets out the specific criteria for independent-business status. Please read it before you sign.$seed$,
    '[your business name]',
    trim(o.name)
  ),
  current_date
from organizations o
where o.status = 'active'
  and coalesce(trim(o.name), '') <> ''
  and not exists (
    select 1
    from legal_documents ld
    where ld.organization_id = o.id
      and ld.document_key = 'contractor_status'
  );
