-- Make the invariant every waitlist reader already assumes into a fact the database
-- enforces: a row cannot be status='waitlist' AND cancelled at the same time.
--
-- WHY THIS AND NOT THE FIX THAT WAS ASKED FOR. The review found that waitlist_join's
-- idempotency SELECT tests `cancelled_at is null` while uniq_registrations_waitlist_student
-- is partial on `status = 'waitlist'` alone, and proposed widening the INDEX predicate to
-- match the SELECT. Two reviewers agreed, so this deviation needs its reasons stated.
--
-- FIRST, WHAT IS ACTUALLY TRUE TODAY. Checked before writing anything: zero rows on staging
-- and zero on prod are status='waitlist' with cancelled_at set, and there is no writer that
-- could make one. Every path that cancels - waitlist_remove (20260819h), invite consume
-- (20260819m), the expiry sweep (20260819r) and refund-registration - sets status and
-- cancelled_at in the SAME statement. Everything else in the repo only READS cancelled_at.
-- So the 23505-into-a-bare-500 the review describes is not reachable on either database
-- right now, and 20260819h's argument for moving the status is correct rather than sloppy.
--
-- SECOND, WHY WIDENING THE INDEX IS THE WEAKER FIX. It would make that one INSERT survive
-- the bad row, and leave every other reader still broken by it. Such a row would keep its
-- waitlist_position, so the queue renumbering counts it, ProgramRoster and WaitingList hide
-- it (they filter cancelled_at is null), and a family would sit at a number the operator
-- cannot see - which is precisely the trap 20260819h describes and avoids. Fixing the
-- INSERT alone treats the symptom that happens to have a stack trace.
--
-- So instead of teaching one more object to tolerate the state, this forbids the state.
-- The convention 20260819h relies on is currently enforced by nothing except everybody
-- remembering it; an admin fixing something by hand in SQL, or the next function to write
-- cancelled_at, is all it takes. Now the write fails immediately, at the statement that
-- got it wrong, instead of surfacing later as a family who cannot rejoin.
--
-- Validated rather than NOT VALID, because both databases are already clean - so the
-- constraint is proven against every existing row at the moment it is added.

alter table public.registrations
  add constraint registrations_waitlist_not_cancelled
  check (not (status = 'waitlist' and cancelled_at is not null));

comment on constraint registrations_waitlist_not_cancelled on public.registrations is
  'A waitlist row cannot also be cancelled. Leaving status=''waitlist'' while setting cancelled_at strands the row: uniq_registrations_waitlist_student and the waitlist_position renumbering both key on status alone and would keep counting it, while every operator surface filters cancelled_at is null and would hide it - so the family holds a place nobody can see and can never rejoin. Cancel by moving the status (see 20260819h), which every writer already does. This makes that convention enforced rather than remembered.';
