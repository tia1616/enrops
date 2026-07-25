-- 20260725f — a waiver LIBRARY instead of one bundled document.
--
-- Arielle's checklist asks for "default waiver library (liability, photo
-- release, medical)". What exists is a single 6,000-character "Waiver and
-- Agreement" that genuinely covers all three, but as one take-it-or-leave-it
-- document. A family cannot decline the photo release without refusing to
-- enroll, and a provider who doesn't photograph children cannot switch it off.
-- Jessica: "photo release should be its own. i'm not sure everyone requires it
-- like we do."
--
-- So the platform templates become four documents named for what they are:
--
--   Participation & liability   required
--   Medical & emergency care    required
--   Photo & media release       OPTIONAL  <- the point of the exercise
--   Program fit                 required
--
-- SECOND BUG FIXED HERE, and it is the worse one. The templates carry EIGHT
-- unfilled placeholders, not the single age one already fixed in 20260725e:
--   [your cancellation window] x2, [your administrative fee],
--   [your late pickup fee], [your grace period],
--   [your contact email], [your phone], [your website]
-- Confirmed present on every seeded organisation in BOTH environments. The
-- refund ones are the serious ones: families have been signing a refund policy
-- reading "A full refund will be granted if cancellation is made more than
-- [your cancellation window] from the Program's scheduled start date."
--
-- These are NOT filled in with invented numbers. Inventing a cancellation
-- window or an administrative fee would bind a provider to terms they never
-- agreed to, in a document their families sign. Instead the refund section
-- defers to the provider's own policy, and the late-pickup fee clause is
-- dropped: it is an operational charge specific to after-school childcare, not
-- something to default a dance studio into.
--
-- The text is otherwise REARRANGED, not rewritten. Each clause keeps its
-- original wording and moves to the document it belongs in.
--
-- ORDERING: this migration must land AFTER the frontend that substitutes {{org}}
-- at render (commit ac7db79). The templates keep {{org}} rather than the baked
-- business name, so an older frontend would show families a literal "{{org}}".
--
-- Existing signatures are never touched: waiver_signatures.waiver_text_snapshot
-- holds exactly what each family agreed to, independent of these rows.
--
-- J2S IS NOT TOUCHED. Its waivers are its own filled-in legal text with 91
-- signatures against them; only the platform template org and organisations
-- seeded from it are rewritten.

do $$
declare
  v_platform uuid;
begin
  select id into v_platform from public.organizations where slug = 'enrops';
  if v_platform is null then
    raise exception 'platform template org (slug=enrops) not found';
  end if;

  -- Retire the bundle. Archived rather than deleted so any signature that
  -- references it keeps a valid parent row.
  update public.waivers
  set active = false, updated_at = now()
  where organization_id = v_platform and name = 'Waiver and Agreement';

  -- Program fit: same document, contact blanks removed. Renamed to say what it
  -- is rather than what kind of thing it is.
  update public.waivers
  set name = 'Program fit',
      content = $doc$Is our program the right fit for your child? What you need to know before signing up.

At {{org}}, we are committed to creating an inclusive environment where all children feel welcome and supported. Our programs are designed for children who thrive in group settings and can participate with minimal individualized assistance. While we strive to support a wide range of needs, we are not able to provide one-on-one supervision or substantial individual support. To ensure the safety and well-being of all participants, if we find that your child's needs exceed what we can reasonably accommodate in our program, we may require that a guardian or a designated adult attend the program to provide additional support.

If you have any questions about whether our program is a good fit for your child, please contact {{org}} before you register. We're happy to talk it through.$doc$,
      required = true,
      active = true,
      updated_at = now()
  where organization_id = v_platform and name in ('Program Fit Acknowledgment', 'Program fit');

  -- The three new documents. Inserted only if absent, so re-running is safe.
  if not exists (select 1 from public.waivers where organization_id = v_platform and name = 'Participation & liability') then
    insert into public.waivers (organization_id, name, content, required, active)
    values (v_platform, 'Participation & liability', $doc$
{{org}} is dedicated to providing a safe and enjoyable learning environment for all participants in our programs. To ensure a positive experience, we kindly request that enrolled children adhere to basic behavioral guidelines. Our instructors establish clear boundaries and expectations for appropriate conduct, and we expect all students to follow these guidelines. Should any discipline issues arise, we appreciate your cooperation in addressing them promptly. It is our primary goal to offer exciting and fun enrichment experiences for children, and actions will be taken only if a child's behavior disrupts this positive learning environment. If necessary, {{org}} may request the removal of a child from the program, and any potential refund will be at the sole discretion of {{org}}.

Expectations for parents:

Parents of children enrolled in {{org}} programs are expected to support their child's learning experience by ensuring that only children with a genuine interest in our programs and the maturity to handle the environment and activities participate. A designated guardian must pick up children promptly at the dismissal of the program. Parents are welcome to observe classes and participate where appropriate. Supporting the learning process beyond the program's conclusion is also encouraged.

Safety and risk acknowledgment:

Participating in our program activities involves inherent risks. While {{org}} takes every precaution to ensure the safety of participants and staff, it's important to understand that certain equipment and materials can be dangerous if used improperly or without instructor supervision, potentially resulting in severe injury or death.

Cancellations and refunds:

Refunds and cancellations are handled according to {{org}}'s own cancellation policy. Please contact {{org}} directly if you have any question about a refund before you register.

Absences:

a. Refunds will not be issued for student absences, whether planned or unplanned.
b. The program fee is paid as a whole and not on a per-session basis. Consequently, individual session absences will not warrant a refund.

Inclement weather:

If a class is canceled due to inclement weather and cannot be rescheduled or extended, that class will not be refunded. If additional weather-related cancellations occur, {{org}} will make every reasonable effort to reschedule, extend, or adjust programming so that students receive the full experience. If the hosting school or facility is closed due to weather, the program will also be canceled for that day. {{org}} will notify families of weather-related closures as soon as possible.

Right to refuse service:

{{org}} reserves the right to refuse service to any participant for reasons including but not limited to inappropriate behavior, violation of program rules, or any other conduct deemed detrimental to the overall experience of the participants.

Acknowledgment and agreement:

I, the undersigned, hereby acknowledge and agree to the following:

1. I am the parent or legal guardian of the below-named child.
2. I understand that failure to comply with the policies outlined by my child's instructor may lead to the revocation of my child's enrollment and forfeiture of any funds.
3. I certify that the below-named child meets the minimum age for the program they are registering for.
4. I understand that {{org}} is not responsible for my child before or after the stated program times.
5. I release and indemnify {{org}}, its principals, officers, employees, agents, and representatives from any claims related to injury or loss resulting from participation in the program.
6. I agree that {{org}} assumes no responsibility for injuries or losses beyond their control.

With my full knowledge and consent, I expressly give my child permission to attend this {{org}} program.

By signing below, I confirm that I have read, understood, and accepted the terms outlined in this agreement, including the risks associated with participation in the {{org}} program.$doc$, true, true);
  end if;

  if not exists (select 1 from public.waivers where organization_id = v_platform and name = 'Medical & emergency care') then
    insert into public.waivers (organization_id, name, content, required, active)
    values (v_platform, 'Medical & emergency care', $doc$
This covers your child's health, and what {{org}} should do if your child needs medical attention while they are with us.

1. I certify that my child is physically able to participate in all {{org}} activities.
2. In the event that I cannot be contacted, I authorize {{org}} and its representatives to provide necessary medical attention to my child.
3. I confirm that I have told {{org}} about any allergies, medical conditions, or medication my child needs while attending, and that I will let {{org}} know if anything changes.

By signing below, I confirm that what I have told {{org}} about my child's health is accurate to the best of my knowledge.$doc$, true, true);
  end if;

  -- OPTIONAL by design. required = false is the whole reason this is a separate
  -- document: a family can decline it and still enroll, and a provider who
  -- doesn't photograph children can archive it in one click.
  if not exists (select 1 from public.waivers where organization_id = v_platform and name = 'Photo & media release') then
    insert into public.waivers (organization_id, name, content, required, active)
    values (v_platform, 'Photo & media release', $doc$
{{org}} sometimes takes photographs or video during programs - a class in progress, a finished project, a group at the end of a session - and may use them to show families and the wider community what happens in their programs.

This one is optional. Your child takes part in everything exactly the same way whether you agree to it or not.

I consent to the use of any media, including film and electronic photography or video, taken of my child during the program for {{org}}'s publicity purposes.$doc$, false, true);
  end if;
end $$;

-- Seeding copies the template verbatim, tokens and all.
--
-- It used to replace {{org}} with the business name as it copied, which is what
-- froze the name into every organisation's waivers at signup. Now the token
-- survives into the copy and the name is substituted when the text is read, so
-- renaming a business flows through to future signatures automatically.
--
-- `required` is copied from the template, which is what carries the photo
-- release through as optional.
create or replace function public.seed_default_waivers(p_org_id uuid)
returns integer
language plpgsql
security definer
-- pg_temp is named explicitly: without it Postgres searches the temp schema
-- FIRST for unqualified relation names, so a temp table called `organizations`
-- could redirect the slug='enrops' lookup below and seed one org's waivers from
-- another's. The sibling functions in this release already do this; this one
-- inherited the gap from its predecessor.
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_platform uuid;
  v_count int := 0;
begin
  if not public.can_admin_org(p_org_id) then
    raise exception 'forbidden';
  end if;
  select id into v_platform from organizations where slug = 'enrops';
  if v_platform is null then return 0; end if;
  insert into public.waivers (organization_id, name, content, required, active)
  select p_org_id, w.name, w.content, w.required, true
  from public.waivers w
  where w.organization_id = v_platform and w.active = true;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.seed_default_waivers(uuid) from public;
revoke all on function public.seed_default_waivers(uuid) from anon;
grant execute on function public.seed_default_waivers(uuid) to authenticated;
grant execute on function public.seed_default_waivers(uuid) to service_role;

-- Bring existing self-serve organisations onto the new library.
--
-- Their current waivers carry the baked business name and the eight blanks, so
-- leaving them as they are would mean the bug is only fixed for providers who
-- sign up after today. The old bundle is ARCHIVED rather than deleted so
-- existing signatures keep a valid parent row and remain readable.
--
-- Scoped to instructor_pay_model = 'enrops_platform': J2S runs its own filled-in
-- legal text and must not be touched.
do $$
declare
  v_platform uuid;
  v_org record;
begin
  select id into v_platform from public.organizations where slug = 'enrops';

  for v_org in
    select id, name from public.organizations
    where instructor_pay_model = 'enrops_platform' and id <> v_platform
  loop
    -- Retire only what is RECOGNISABLY our unmodified stock template.
    --
    -- The unfilled "[your ...]" placeholders are the reliable tell: they exist
    -- only in text nobody has edited, because editing is precisely what fills
    -- them in. Every seeded copy in both environments carries them (verified by
    -- count before running).
    --
    -- An earlier version of this also archived anything missing the {{org}}
    -- token, which would have silently deactivated and replaced the waivers of
    -- any operator who had WRITTEN THEIR OWN — their text has no token either.
    -- Losing an operator's own legal wording to a backfill is not a trade worth
    -- making to tidy up a template, so the token clause is gone. An operator
    -- who customised their waiver simply keeps it.
    update public.waivers
    set active = false, updated_at = now()
    where organization_id = v_org.id
      and active = true
      and content like '%[your %';

    -- Copy the current library across, skipping any the org already has by name.
    insert into public.waivers (organization_id, name, content, required, active)
    select v_org.id, w.name, w.content, w.required, true
    from public.waivers w
    where w.organization_id = v_platform
      and w.active = true
      and not exists (
        select 1 from public.waivers x
        where x.organization_id = v_org.id and x.name = w.name and x.active = true
      );
  end loop;
end $$;

-- Proof, not assumption: no ACTIVE waiver anywhere may still carry a blank.
do $$
declare v_left int;
begin
  select count(*) into v_left from public.waivers where active = true and content like '%[your %';
  if v_left > 0 then
    raise exception 'blanks still present in % active waiver(s)', v_left;
  end if;
end $$;
