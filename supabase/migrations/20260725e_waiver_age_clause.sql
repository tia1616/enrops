-- 20260725e — take the unfilled blank out of a legal document.
--
-- Clause 5 of the platform waiver template reads, verbatim, to every parent:
--
--   "I certify that the below-named child is age [your minimum age] or older
--    before the commencement of the {{org}} program."
--
-- "[your minimum age]" is an instruction to whoever set the template up. It was
-- never filled in, and it copied into every organisation seeded from the
-- template, so families have been signing an agreement with a visible blank in
-- it. Confirmed on the template and on every seeded org in both environments.
--
-- The fix is to state the thing that is actually true and needs no number:
-- programs carry their own age range, so the child's eligibility is per-program,
-- not per-organisation. A single org-level number would be wrong the moment an
-- operator runs one class for 4-year-olds and another for teens.
--
-- SAFE TO RUN BEFORE THE FRONTEND: this only rewrites stored text and depends on
-- no code change. Already-signed agreements are untouched -
-- waiver_signatures.waiver_text_snapshot keeps the exact words each family
-- agreed to, which is what makes editing a live waiver safe at all.
--
-- The pattern stops at the first full stop ([^.]*) so it cannot run past the end
-- of the sentence, and it matches whether the organisation name is still the
-- {{org}} token (the template) or was baked in at seed time (every other org).

update public.waivers
set content = regexp_replace(
      content,
      'is age \[your minimum age\] or older before the commencement of [^.]*\.',
      'meets the minimum age for the program they are registering for.'
    ),
    updated_at = now()
where content like '%[your minimum age]%';

-- Proof, not assumption: no active waiver may still contain the placeholder.
do $$
declare v_left int;
begin
  select count(*) into v_left from public.waivers where content like '%[your minimum age]%';
  if v_left > 0 then
    raise exception 'waiver age placeholder still present in % row(s)', v_left;
  end if;
end $$;
