-- Rewrite the starter cancellation policy as PLAIN TEXT (Jessica, 2026-07-28).
--
-- THE PROBLEM. Telling an operator "plain writing is fine" and then handing
-- them a document full of `##` and `**` is a contradiction they have to resolve
-- themselves. The editor is a bare textarea, so the syntax is not hidden behind
-- a toolbar — it is just there, in their own policy, unexplained now that the
-- Markdown lesson has been removed.
--
-- And it is inconsistent with everything else they edit. Checked, not assumed:
-- all four seeded WAIVERS are plain text, no `##`, no `**`. Only the policies
-- carry Markdown, and the other policy types (privacy, terms, dpa, cookies,
-- acceptable-use, data-retention, subprocessors) are PLATFORM documents that no
-- operator edits. `cancellation` is the only one seeded into a tenant, so it is
-- the only editable operator document written in a syntax nothing else uses.
--
-- Bold and headings are dropped rather than replaced. A colon does the same job
-- ("Before the first session: full refund"), reads correctly as plain text, and
-- renders identically whether or not anything parses Markdown. Nothing is lost
-- that an operator would miss, and the public page still supplies its own title
-- so the document does not need an internal heading.
--
-- WHOSE TEXT GETS REWRITTEN. Only rows still flagged seeded_by_platform — text
-- WE wrote. An operator who has already replaced the wording is untouched: that
-- flag is cleared the moment they save, and overwriting somebody's own refund
-- policy would be far worse than leaving Markdown in ours.

DO $mig$
DECLARE
  v_platform uuid;
  v_plain    text;
  v_tenants  int;
BEGIN
  SELECT id INTO v_platform FROM public.organizations WHERE slug = 'enrops';
  IF v_platform IS NULL THEN
    RAISE EXCEPTION 'no enrops platform org - the template lives there, refusing to guess';
  END IF;

  v_plain :=
'If you need to cancel, contact {{org}} as early as you can. The sooner we know, the more likely we can offer the spot to another family.

Before the first session: full refund.

Once the program has started: we refund the sessions your child has not yet attended.

After the program has finished: no refund.

If {{org}} cancels a class, you receive a full refund regardless of timing.

Questions about a refund? Reply to your confirmation email and it comes straight to us.';

  -- 1. The template every future tenant is provisioned from.
  --
  -- The IS DISTINCT FROM guard makes a re-run a true no-op. Without it the
  -- UPDATE rewrites identical text and still stamps last_updated = now(), and
  -- that date is rendered to FAMILIES on the public policy page ("Last updated
  -- July 28, 2026"). Re-applying during a recovery or an environment rebuild
  -- would tell every family the refund policy was revised on a day nothing
  -- about it changed.
  UPDATE public.org_policies
     SET content_markdown = v_plain, last_updated = now()
   WHERE organization_id = v_platform AND policy_type = 'cancellation'
     AND content_markdown IS DISTINCT FROM v_plain;

  -- 2. Existing tenants still carrying OUR wording. seeded_by_platform is the
  --    whole reason this is safe to do in bulk - it records authorship at the
  --    moment we wrote the text, so it cannot mistake an operator's own policy
  --    for ours the way a live text comparison would.
  -- Same guard as above, per tenant: only rows whose text actually changes get
  -- a new last_updated.
  UPDATE public.org_policies p
     SET content_markdown = replace(v_plain, '{{org}}',
           coalesce(nullif(btrim(o.name), ''), 'our program')),
         last_updated = now()
    FROM public.organizations o
   WHERE p.organization_id = o.id
     AND p.policy_type = 'cancellation'
     AND p.seeded_by_platform = true
     AND p.organization_id <> v_platform
     AND p.content_markdown IS DISTINCT FROM replace(v_plain, '{{org}}',
           coalesce(nullif(btrim(o.name), ''), 'our program'));
  GET DIAGNOSTICS v_tenants = ROW_COUNT;

  RAISE NOTICE 'plain-text cancellation: template + % tenant copies', v_tenants;
END $mig$;