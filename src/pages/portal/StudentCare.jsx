// /:slug/dashboard/child/:studentId — a parent editing one child's care details
// AFTER checkout: how they leave, who may collect them, who must not, the second
// guardian, and the homeroom teacher.
//
// WHY THIS SCREEN EXISTS. Until now exactly one surface could write these facts:
// PickupInfoGate, which fires only when `dismissal_method` is null or the answer
// is aftercare-with-no-provider. A family who answered "released to an authorized
// adult" at checkout and then actually started going to aftercare had NO route in
// the app at all - and no operator surface wrote student_contacts either. So when
// a parent rang to say "actually she goes to aftercare", there was no box anybody
// could type it into and the only fix was editing the database by hand. That is
// the live safety gap this closes.
//
// THE GATE IS NOW THIS SCREEN'S FORCED TWIN, not a separate implementation: both
// validate with careProblem() and save with careRpcArgs() from lib/studentCare.js,
// so the rule about what counts as complete cannot drift between the version a
// family is forced through and the version they choose to open.
//
// Deliberately its own route rather than a modal on the dashboard: the "please
// update your info in your parent portal" email needs somewhere to link a family
// straight to, per child.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { needsAftercareProvider } from '../../lib/dismissal.js';
import { parseRegFields } from './register-steps/RegExtraFields.jsx';
import { PickupDismissalSection, GuardianSecondarySection } from './register-steps/RegExtraFields.jsx';
import {
  CARE_CONTACT_COLUMNS, careProblem, careRpcArgs, careSaveMessage,
  homeroomPatch, lockedDoNotRelease,
} from '../../lib/studentCare.js';

export default function StudentCare() {
  const { org } = useOutletContext() ?? {};
  const { slug, studentId } = useParams();
  const navigate = useNavigate();

  const [std, setStd] = useState({});
  const [student, setStudent] = useState(null);
  const [data, setData] = useState(null);
  // The homeroom value as LOADED, kept separately so the save can send the field
  // only when it actually changed rather than writing the whole row back.
  const [loadedHomeroom, setLoadedHomeroom] = useState('');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!org?.id || !studentId) return;
      setLoading(true);
      setNotFound(false);
      setLoadError('');
      try {
        const [fieldsRes, stuRes, contactsRes] = await Promise.all([
          supabase.rpc('get_active_registration_fields', { p_org_id: org.id }),
          // RLS does the authorization: parents_see_own_students is
          // `parent_id = current_parent_id()`, so another family's child comes
          // back as NO ROW rather than as data. The org filter is belt and
          // braces for a student row shared across... nothing, today - but it
          // costs nothing and states the tenancy this screen assumes.
          supabase
            .from('students')
            .select('id, first_name, last_name, homeroom_teacher, dismissal_method, aftercare_provider')
            .eq('id', studentId)
            .eq('organization_id', org.id)
            .maybeSingle(),
          // EVERY column the RPC re-inserts. The save replaces all three roles
          // from this payload, so a column missing here is a column the next
          // save writes NULL over - see CARE_CONTACT_COLUMNS.
          supabase
            .from('student_contacts')
            .select(CARE_CONTACT_COLUMNS)
            .eq('student_id', studentId)
            .order('sort_order'),
        ]);
        if (cancelled) return;

        // A FAILED CONTACTS READ MUST NOT LOOK LIKE "THIS CHILD HAS NOBODY".
        // Saving on top of a failed read would send an empty do-not-release list
        // and the RPC would DELETE the rows we simply failed to fetch. Refuse to
        // render the editor at all rather than offer a Save that destroys data.
        if (contactsRes.error) throw contactsRes.error;
        if (stuRes.error) throw stuRes.error;

        const stu = stuRes.data;
        if (!stu) { setNotFound(true); setLoading(false); return; }

        const rows = contactsRes.data || [];
        setStd(parseRegFields(fieldsRes.data || []).std);
        setStudent(stu);
        setLoadedHomeroom(stu.homeroom_teacher ?? '');
        setData({
          dismissal_method: stu.dismissal_method || '',
          aftercare_provider: stu.aftercare_provider || '',
          homeroom_teacher: stu.homeroom_teacher ?? '',
          pickup: rows.filter((c) => c.role === 'authorized_pickup'),
          // Marked locked on the way in, so the section renders them as facts and
          // the save carries them through untouched.
          doNotRelease: lockedDoNotRelease(rows),
          guardian2: rows.find((c) => c.role === 'guardian') || {},
        });
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setLoadError(careSaveMessage(e));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id, studentId]);

  function update(patch) {
    setSaved(false);
    setData((d) => ({ ...d, ...patch }));
  }

  const problem = loading ? 'loading' : careProblem(std, data);
  const blocked = problem !== null;
  // 'loading' is a sentinel, never a sentence shown to a parent - it would read
  // as an instruction. The button is disabled either way; only the explanation
  // differs, and in that state there is nothing to explain yet.
  const blockerSentence = blocked && problem !== 'loading' ? problem : '';

  async function save() {
    if (blocked || saving || !data) return;
    setSaving(true);
    setError('');
    try {
      // Custody first, homeroom second, and NOT in one unit on purpose. Jessica,
      // 2026-08-28: homeroom is a plain student attribute with no trigger and no
      // snapshot, so it is not worth a third overload of the custody RPC. The
      // invariants are independent, so if the second write fails the child's
      // custody record is still correct and only the homeroom is stale - the
      // safe direction, and the reason the order is this way round.
      const { error: rpcErr } = await supabase.rpc(
        'replace_student_pickup_dnr_guardian',
        careRpcArgs({ studentId, organizationId: org.id, data }),
      );
      if (rpcErr) throw rpcErr;

      const patch = homeroomPatch(loadedHomeroom, data.homeroom_teacher);
      if (patch) {
        const { error: hrErr } = await supabase
          .from('students')
          .update(patch)
          .eq('id', studentId)
          .eq('organization_id', org.id);
        if (hrErr) throw hrErr;
        setLoadedHomeroom(data.homeroom_teacher ?? '');
      }

      // Re-baseline rather than re-fetch: what a parent just added is now saved,
      // so it becomes locked. Without this, adding a second name in the same
      // sitting would send the first one as an ADDITION again - harmless in the
      // database (the row is replaced either way) but the screen would keep
      // offering Remove on a name that is now on file, which is the promise this
      // screen makes to a custody record.
      setData((d) => ({ ...d, doNotRelease: lockedDoNotRelease((d.doNotRelease || []).map((c) => ({ ...c, role: 'do_not_release' }))) }));
      setSaved(true);
    } catch (e) {
      setError(careSaveMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const backTo = `/${slug}/dashboard`;

  if (loading) {
    return <div className="mx-auto max-w-2xl px-4 py-8 text-j2s-ink/70">Loading&hellip;</div>;
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <h1 className="font-titan text-2xl text-j2s-ink">We couldn&rsquo;t find that child</h1>
        <p className="mt-2 text-j2s-ink/70">
          They may be registered under a different account. Head back to your dashboard and pick a
          child from there.
        </p>
        <Link to={backTo} className="mt-6 inline-block font-semibold text-j2s-purple hover:underline">
          &larr; Back to my dashboard
        </Link>
      </div>
    );
  }

  // A read that FAILED is not a child with no details. Offering the form here
  // would let a parent save an empty do-not-release list over a real one.
  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <h1 className="font-titan text-2xl text-j2s-ink">We couldn&rsquo;t load these details</h1>
        <p className="mt-2 text-j2s-ink/70">{loadError}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 rounded-xl bg-j2s-purple px-5 py-2.5 font-semibold text-white hover:bg-j2s-purple/90"
        >
          Try again
        </button>
        <div className="mt-4">
          <Link to={backTo} className="font-semibold text-j2s-purple hover:underline">
            &larr; Back to my dashboard
          </Link>
        </div>
      </div>
    );
  }

  const childName = `${student?.first_name ?? ''} ${student?.last_name ?? ''}`.trim() || 'your child';

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <Link to={backTo} className="text-sm font-semibold text-j2s-purple hover:underline">
        &larr; Back to my dashboard
      </Link>

      <h1 className="mt-4 font-titan text-2xl text-j2s-ink sm:text-3xl">
        Pickup &amp; dismissal for {student?.first_name || 'your child'}
      </h1>
      <p className="mt-2 text-j2s-ink/70">
        Change these any time. We use them to release {student?.first_name || 'your child'} safely at
        the end of class, so please keep them current.
      </p>

      <div className="mt-8 rounded-2xl border-2 border-j2s-purple/10 bg-white p-6">
        <h2 className="font-titan text-xl text-j2s-ink">{childName}</h2>

        <PickupDismissalSection
          std={std}
          instanceKey={studentId}
          lockSavedDoNotRelease
          dismissalMethod={data.dismissal_method}
          // Same clear-on-change rule as the registration form and the gate: a
          // provider name must never outlive the answer it describes, or a roster
          // shows a destination for a child who now walks home.
          onDismissalChange={(v) => update(
            needsAftercareProvider(v)
              ? { dismissal_method: v }
              : { dismissal_method: v, aftercare_provider: '' },
          )}
          aftercareProvider={data.aftercare_provider}
          onAftercareProviderChange={(v) => update({ aftercare_provider: v })}
          pickup={data.pickup}
          onPickupChange={(v) => update({ pickup: v })}
          doNotRelease={data.doNotRelease}
          onDoNotReleaseChange={(v) => update({ doNotRelease: v })}
        />

        {std.guardian_secondary && (
          <GuardianSecondarySection
            config={std.guardian_secondary}
            value={data.guardian2}
            onChange={(v) => update({ guardian2: v })}
          />
        )}

        {/* Only when the provider asks it. This screen must never offer a field
            the operator has switched off - the same rule the registration form
            follows, read from the same std map. */}
        {std.homeroom_teacher && (
          <div className="mt-8" data-reg-field="student_homeroom">
            <label className="label-field" htmlFor={`student-homeroom-${studentId}`}>
              {std.homeroom_teacher.label || 'Homeroom teacher'}
              {std.homeroom_teacher.required ? ' *' : ' (optional)'}
            </label>
            <p className="help-text">Who collects {student?.first_name || 'your child'} from class, and where from.</p>
            <input
              id={`student-homeroom-${studentId}`}
              className="input-field mt-2"
              value={data.homeroom_teacher}
              onChange={(e) => update({ homeroom_teacher: e.target.value })}
              placeholder="e.g. Ms. Smith"
            />
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="mt-4 rounded-lg border-2 border-j2s-orange-dark/30 bg-j2s-orange-dark/5 px-4 py-3 text-sm text-j2s-orange-dark">
          {error}
        </div>
      )}

      {/* WHY SAVE IS GREY, next to the button rather than up beside the field.
          Same shape as the gate: the button is disabled and the reason sits in
          the same glance, because a disabled control with no explanation is the
          silent-wall pattern this codebase keeps having to undo. */}
      {blockerSentence && !saving && (
        <div role="alert" className="mt-4 rounded-lg border-2 border-j2s-purple/15 bg-j2s-purple-soft/40 px-4 py-3 text-sm text-j2s-ink/80">
          <span className="font-semibold text-j2s-ink">Still needed:</span> {blockerSentence}
        </div>
      )}

      <div className="mt-6 flex items-center gap-4">
        <button
          type="button"
          onClick={save}
          disabled={blocked || saving}
          className="rounded-xl bg-j2s-purple px-6 py-3 font-semibold text-white hover:bg-j2s-purple/90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {/* Feedback where the parent is looking, and it survives long enough to
            read. It clears on the next edit (update() resets it) rather than on a
            timer, so it can never claim "saved" about what is now on screen. */}
        {/* text-j2s-purple, NOT text-j2s-green: there is no `green` key under
            `j2s` in tailwind.config.js, so Tailwind emits no rule for it and the
            text falls back to whatever it inherits. Dashboard.jsx:711 and :815
            already do this and their "Today" badge and tick are silently
            unstyled - copying the class would have made a confirmation the
            parent might not see. */}
        {saved && !saving && (
          <span role="status" className="text-sm font-semibold text-j2s-purple">Saved &#10003;</span>
        )}
        <button
          type="button"
          onClick={() => navigate(backTo)}
          className="text-sm font-semibold text-j2s-ink/60 hover:text-j2s-ink"
        >
          Done
        </button>
      </div>
    </div>
  );
}
