-- Correct a function comment that 20260819f made false, in the same pass it was made false.
--
-- waitlist_join's stored comment ends with "Waitlist rows do NOT hold a seat:
-- registration_holds_seat() returns false for status=waitlist." That was true when
-- 20260819d shipped and stopped being true four commits later, when 20260819f taught the
-- rule that an unexpired invite holds the place. The comment lives in the DATABASE
-- catalog, not just in a file, so anyone reading \df+ or the Supabase UI is told the
-- opposite of what the seat rule now does - and the code most likely to read it is
-- chunk 2's invite flow, the one thing that must get this right.
--
-- Comment-only. No behaviour changes here.

comment on function public.waitlist_join(uuid, uuid, uuid, uuid) is
  'Atomically place a child on an afterschool program''s waitlist and return their position. Takes a per-program advisory lock so concurrent joins cannot collide on a position. Re-validates same-org / open / not-partner-run / actually-full rather than trusting the caller, and is idempotent for a child already on the list. A row created here holds NO seat: it carries no invite, and registration_holds_seat() only counts a waitlist row while waitlist_invite_expires_at is in the future (see 20260819f). SECURITY DEFINER, service_role only - called by the public join endpoint.';
