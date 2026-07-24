import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { getTenant } from '../../lib/tenants.js';
import { getUserRoles } from '../../lib/useUserRoles.js';
import WaiverGate from './WaiverGate.jsx';
import PickupInfoGate from './PickupInfoGate.jsx';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */
const TABS = [
  { key: 'today', label: 'Today' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'classes', label: 'Classes' },
  { key: 'settings', label: 'Settings' },
];

const TERM_ORDER = ['SU26', 'FA26', 'WI27', 'SP27', 'SU27'];
const TERM_LABELS = {
  SU26: 'Summer 2026', FA26: 'Fall 2026', WI27: 'Winter 2027',
  SP27: 'Spring 2027', SU27: 'Summer 2027',
};
const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

const PREF_OPTIONS = [
  { key: 'email_registration_updates', label: 'Registration updates', desc: 'Confirmations, schedule changes, and enrollment details' },
  { key: 'email_session_recaps', label: 'Class recaps', desc: 'What your child learned and conversation starters' },
  { key: 'email_reenrollment_prompts', label: 'Enrollment reminders', desc: 'Early access to register for the next term' },
];
const DEFAULT_PREFS = { email_registration_updates: true, email_session_recaps: true, email_reenrollment_prompts: true };

/* ------------------------------------------------------------------ */
/*  Formatting                                                         */
/* ------------------------------------------------------------------ */
function fmtDate(d) {
  if (!d) return '';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
function fmtDateShort(d) {
  if (!d) return '';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '';
  if (t.includes('AM') || t.includes('PM')) return t;
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const days = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ------------------------------------------------------------------ */
/*  Session math                                                       */
/* ------------------------------------------------------------------ */
// The PROGRAM decides how many classes there are: the same curriculum can run
// 8 sessions at one school and 10 at another, and across terms. The authored
// session list is CONTENT that may run out - never the source of truth for the
// count. Deriving the total from sessions.length told families their class was
// "complete" as soon as the lesson plans ran out, weeks before it actually ended.
function getSessionInfo(program, sessions) {
  const total = program?.session_count || sessions?.length || 0;
  if (!program?.first_session_date || !total) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const first = new Date(program.first_session_date + 'T00:00:00');
  if (today < first) return { state: 'upcoming', nextDate: program.first_session_date, session: sessions?.[0] ?? null, totalSessions: total };

  const diffWeeks = Math.floor((today - first) / (1000 * 60 * 60 * 24 * 7));
  const sessionIdx = Math.min(diffWeeks, total - 1);
  if (diffWeeks >= total) return { state: 'complete' };

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const isClassDay = dayNames[today.getDay()].toLowerCase() === (program.day_of_week || '').toLowerCase();

  return {
    state: isClassDay ? 'today' : 'in-progress',
    // May be null past the end of the authored lesson plans - the class is
    // still running, we just have no content for that week.
    session: sessions?.[sessionIdx] ?? null,
    sessionNumber: sessionIdx + 1,
    totalSessions: total,
    nextSession: sessionIdx + 1 < total ? (sessions?.[sessionIdx + 1] ?? null) : null,
    nextSessionNumber: sessionIdx + 2,
  };
}

/* ------------------------------------------------------------------ */
/*  Icons                                                              */
/* ------------------------------------------------------------------ */
function IconToday({ className }) {
  return <svg className={className} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" /></svg>;
}
function IconSchedule({ className }) {
  return <svg className={className} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" /></svg>;
}
function IconClasses({ className }) {
  return <svg className={className} viewBox="0 0 20 20" fill="currentColor"><path d="M10.394 2.08a1 1 0 00-.788 0l-7 3a1 1 0 000 1.84L5.25 8.051a.999.999 0 01.356-.257l4-1.714a1 1 0 11.788 1.838l-3.14 1.346L10 11.12l6.606-2.83a1 1 0 000-1.84l-7-3zM3.31 9.397L5 10.12v4.102a8.969 8.969 0 00-1.05-.174 1 1 0 01-.89-.89 11.115 11.115 0 01.25-3.762zM9.3 16.573A9.026 9.026 0 007 14.935v-3.957l1.818.78a3 3 0 002.364 0l5.508-2.361a11.026 11.026 0 01.25 3.762 1 1 0 01-.89.89 8.968 8.968 0 00-5.35 2.524 1 1 0 01-1.4 0z" /></svg>;
}
function IconSettings({ className }) {
  return <svg className={className} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" /></svg>;
}
function ChevronDown({ open, className = '' }) {
  return <svg className={`h-5 w-5 transition-transform duration-200 ${open ? 'rotate-180' : ''} ${className}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>;
}
const TAB_ICONS = { today: IconToday, schedule: IconSchedule, classes: IconClasses, settings: IconSettings };

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */
const WEEKLY_DAY_ORDER = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

// Group recurring class_schedule rows by weekday, in week order.
function groupClassesByDay(classes) {
  const sorted = [...classes].sort((a, b) =>
    ((WEEKLY_DAY_ORDER[a.day_of_week] ?? 9) - (WEEKLY_DAY_ORDER[b.day_of_week] ?? 9)) ||
    (a.start_time || '').localeCompare(b.start_time || ''));
  const groups = [];
  for (const c of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.day === c.day_of_week) last.items.push(c);
    else groups.push({ day: c.day_of_week, items: [c] });
  }
  return groups;
}

export default function Dashboard() {
  const { org } = useOutletContext();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  // Fail CLOSED on an unresolved tenant. This used to be `org?.slug || 'j2s'`,
  // which would have shown another provider's support address and pushed the
  // family into the J2S portal. PublicLayout gates this Outlet on a resolved
  // org, so in practice slug is always present — the guard below is the
  // backstop, not a fallback tenant.
  const slug = org?.slug || null;
  const tenant = slug ? getTenant(slug) : null;
  const supportEmail = tenant?.supportEmail || 'support@enrops.com';

  const [parent, setParent] = useState(null);
  const [enrollments, setEnrollments] = useState([]);
  const [unsignedWaivers, setUnsignedWaivers] = useState([]); // required waivers still needing signature
  const [incompleteStudents, setIncompleteStudents] = useState([]); // after-school kids missing pickup/dismissal info
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('today');
  const [expandedCards, setExpandedCards] = useState(new Set());
  const [prefs, setPrefs] = useState(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsSaved, setPrefsSaved] = useState(false);
  const [weeklyClasses, setWeeklyClasses] = useState([]); // org's recurring class schedule (outside-registration tenants), safe public view

  const toggleCard = useCallback((id) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!slug) return; // unresolved tenant — rendered as an error below, never redirected into J2S
    if (!authLoading && !user) {
      navigate(`/${slug}/login`, { replace: true });
      return;
    }
    if (user) fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, authLoading]);

  async function fetchData() {
    try {
      setLoading(true);
      setError(null);

      // 1. Parent
      const { data: p, error: pErr } = await supabase
        .from('parents')
        .select('id, first_name, last_name, communication_preferences')
        .eq('auth_id', user.id)
        .maybeSingle();
      if (pErr) { setError('fetch_failed'); setLoading(false); return; }
      if (!p) {
        // No family record for this user. The header "My account" link and the
        // family login both funnel everyone to this dashboard, so an instructor
        // or org admin can land here by mistake. Route them to their real home
        // instead of dead-ending on "couldn't find your account".
        const roles = await getUserRoles(user.id);
        if (roles.isInstructor) { navigate(`/${slug}/instructor`, { replace: true }); return; }
        if (roles.isAdmin) { navigate('/admin', { replace: true }); return; }
        setError('no_account'); setLoading(false); return;
      }
      setParent(p);
      setPrefs({ ...DEFAULT_PREFS, ...(p.communication_preferences || {}) });

      // Org's recurring weekly classes (outside-registration tenants). Read from
      // the anon-safe view (no coach email/notes). Only renders when rows exist,
      // so registration tenants (J2S) are unaffected.
      const { data: wc } = await supabase
        .from('class_schedule_public')
        .select('id, title, day_of_week, start_time, end_time, location_text')
        .eq('organization_id', org.id);
      setWeeklyClasses(wc || []);

      // 2a. Afterschool registrations
      const { data: asRegs } = await supabase
        .from('registrations')
        .select(`id, status, registered_at, program_id,
          students(id, first_name, last_name, dismissal_method),
          programs(
            id, curriculum, curriculum_id, day_of_week, start_time, end_time,
            first_session_date, term, session_count,
            program_locations(name, arrival_instructions, dismissal_instructions),
            curricula(id, name, skills_overall,
              curriculum_sessions(session_number, title, description, skills_practiced, parent_engagement_question)
            )
          )`)
        .eq('parent_id', p.id)
        .in('status', ['confirmed'])
        .not('program_id', 'is', null)
        .order('registered_at', { ascending: true });

      // 2b. Camp registrations
      const { data: cRegs } = await supabase
        .from('registrations')
        .select(`id, status, registered_at, camp_session_id,
          students(first_name, last_name),
          camp_sessions(
            id, curriculum_name, curriculum_id, location_name,
            starts_on, ends_on, start_time, end_time, session_type, week_num,
            curricula(id, name, skills_overall,
              curriculum_sessions(session_number, title, description, skills_practiced, parent_engagement_question)
            )
          )`)
        .eq('parent_id', p.id)
        .in('status', ['confirmed'])
        .not('camp_session_id', 'is', null)
        .order('registered_at', { ascending: true });

      // 2c. Required-waiver gate — block the portal until the parent has signed
      // every required, active waiver for each of their registrations. A
      // signature is per-registration (matches create-registration).
      const regIds = [...(asRegs || []).map((r) => r.id), ...(cRegs || []).map((r) => r.id)];
      let needsWaivers = [];
      if (regIds.length > 0) {
        const [{ data: wv }, { data: sigs }] = await Promise.all([
          supabase.from('waivers')
            .select('id, name, content, version')
            .eq('organization_id', org.id).eq('active', true).eq('required', true),
          supabase.from('waiver_signatures')
            .select('waiver_id, registration_id').eq('parent_id', p.id),
        ]);
        const signed = new Set((sigs || []).map((s) => `${s.registration_id}:${s.waiver_id}`));
        needsWaivers = (wv || [])
          .map((w) => ({ ...w, missingRegIds: regIds.filter((rid) => !signed.has(`${rid}:${w.id}`)) }))
          .filter((w) => w.missingRegIds.length > 0);
      }
      setUnsignedWaivers(needsWaivers);

      // Backfill gate: after-school kids who registered before the pickup/dismissal
      // questions existed still need that info. Only gate when THIS org actually
      // asks the dismissal question (else there's nothing to collect and we'd lock
      // the parent out with an empty form). Summer camps are excluded (only asRegs).
      let asksDismissal = false;
      try {
        const { data: fields } = await supabase.rpc('get_active_registration_fields', { p_org_id: org.id });
        asksDismissal = (fields || []).some((f) => f.standard_key === 'dismissal_method' && f.is_active !== false);
      } catch { asksDismissal = false; }

      const incomplete = [];
      if (asksDismissal) {
        const seenStu = new Set();
        for (const r of asRegs || []) {
          const stu = r.students;
          if (stu?.id && stu.dismissal_method == null && !seenStu.has(stu.id)) {
            seenStu.add(stu.id);
            incomplete.push({ student_id: stu.id, name: `${stu.first_name ?? ""} ${stu.last_name ?? ""}`.trim() });
          }
        }
      }
      setIncompleteStudents(incomplete);

      // 3. Normalize + cap sessions at program.session_count
      const merged = [];
      const programIdsForDates = [];

      (asRegs || []).forEach((r) => {
        const pr = r.programs;
        const cur = pr?.curricula;
        const maxSessions = pr?.session_count || 999;
        const sessions = cur?.curriculum_sessions
          ? [...cur.curriculum_sessions]
              .sort((a, b) => a.session_number - b.session_number)
              .slice(0, maxSessions)
          : [];

        const entry = {
          id: r.id, type: 'afterschool',
          student: r.students,
          name: pr?.curriculum || 'Class',
          location: pr?.program_locations?.name,
          arrival: pr?.program_locations?.arrival_instructions,
          dismissal: pr?.program_locations?.dismissal_instructions,
          day: pr?.day_of_week,
          startTime: pr?.start_time, endTime: pr?.end_time,
          term: pr?.term, firstDate: pr?.first_session_date,
          programId: pr?.id,
          // NOT maxSessions: that carries the 999 slice sentinel when a program
          // has no session_count, which would render "999 sessions" to parents.
          sessionCount: pr?.session_count || sessions.length,
          sessions,
          sessionDates: [], // meeting dates only — filled by RPC below
          sessionSchedule: [], // full schedule incl. no-school days — filled below
          sessionInfo: getSessionInfo(pr, sessions),
          skillsOverall: cur?.skills_overall,
        };
        merged.push(entry);
        if (pr?.id) programIdsForDates.push({ enrollmentId: r.id, programId: pr.id });
      });

      (cRegs || []).forEach((r) => {
        const cs = r.camp_sessions;
        const cur = cs?.curricula;
        const sessions = cur?.curriculum_sessions
          ? [...cur.curriculum_sessions].sort((a, b) => a.session_number - b.session_number)
          : [];
        merged.push({
          id: r.id, type: 'camp',
          student: r.students,
          name: cs?.curriculum_name || cur?.name || 'Camp',
          location: cs?.location_name,
          day: null,
          startTime: cs?.start_time, endTime: cs?.end_time,
          term: 'SU26', firstDate: cs?.starts_on, lastDate: cs?.ends_on,
          sessionType: cs?.session_type, weekNum: cs?.week_num,
          programId: null,
          sessionCount: sessions.length,
          sessions, sessionDates: [],
          sessionInfo: null,
          skillsOverall: cur?.skills_overall,
        });
      });

      // 4. Fetch the full schedule via derive_program_session_schedule() —
      // meeting dates AND the skipped no-school days (with reasons). We keep a
      // meeting-dates-only array for the range summary + curriculum-session
      // pairing, and the full schedule for the interleaved timeline render.
      if (programIdsForDates.length > 0) {
        const dateResults = await Promise.all(
          programIdsForDates.map(({ programId }) =>
            supabase.rpc('derive_program_session_schedule', { p_program_id: programId })
          )
        );
        programIdsForDates.forEach(({ enrollmentId }, i) => {
          // The RPC returns rows keyed entry_date/kind/reason; normalize entry_date -> date.
          const schedule = (dateResults[i]?.data || []).map((x) => ({ date: x.entry_date, kind: x.kind, reason: x.reason }));
          const entry = merged.find((e) => e.id === enrollmentId);
          if (entry) {
            entry.sessionSchedule = schedule;
            entry.sessionDates = schedule
              .filter((x) => x?.kind === 'session')
              .map((x) => x.date);
          }
        });
      }

      // 5. Notification feed
      const { data: notifs } = await supabase
        .from('automation_run_recipients')
        .select('id, status, sent_at, automations(automation_templates(display_name))')
        .eq('parent_id', p.id)
        .order('sent_at', { ascending: false })
        .limit(10);

      setNotifications((notifs || []).map((n) => ({
        id: n.id,
        name: n.automations?.automation_templates?.display_name || 'Update',
        sentAt: n.sent_at,
        status: n.status,
      })));

      setEnrollments(merged);
      setLoading(false);
    } catch (err) {
      console.error('Dashboard error:', err);
      setError('fetch_failed');
      setLoading(false);
    }
  }

  async function savePrefs(updated) {
    setSavingPrefs(true);
    setPrefsSaved(false);
    const { error: e } = await supabase
      .from('parents').update({ communication_preferences: updated }).eq('id', parent.id);
    setSavingPrefs(false);
    if (!e) { setPrefs(updated); setPrefsSaved(true); setTimeout(() => setPrefsSaved(false), 2000); }
  }

  const enrolledTerms = useMemo(() => new Set(enrollments.map((e) => e.term).filter(Boolean)), [enrollments]);
  const nextTerm = useMemo(() => {
    if (enrolledTerms.size === 0) return null;
    const latestIdx = Math.max(...[...enrolledTerms].map((t) => TERM_ORDER.indexOf(t)).filter((i) => i >= 0));
    return TERM_ORDER[latestIdx + 1] || null;
  }, [enrolledTerms]);
  const todayClasses = useMemo(() => enrollments.filter((e) => e.sessionInfo?.state === 'today'), [enrollments]);

  /* ---- Render gates ---- */
  // Fail closed rather than fall back to a tenant. Reaching this means the
  // layout handed us no org, so we have no idea whose data this account belongs
  // to — showing the J2S portal would be a guess with someone's family data.
  if (!slug) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="font-titan text-2xl text-j2s-ink">We couldn&rsquo;t load your provider</h1>
        <p className="mt-3 text-j2s-ink/70">
          Please use the link your provider sent you, or contact them for the correct address.
        </p>
      </div>
    );
  }
  if (authLoading) {
    return <div className="flex min-h-[50vh] items-center justify-center"><div className="animate-pulse text-j2s-ink/50">Loading&hellip;</div></div>;
  }
  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-b-2 border-j2s-purple" />
          <p className="text-j2s-ink/50">Loading your dashboard&hellip;</p>
        </div>
      </div>
    );
  }
  if (error === 'no_account') {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center">
        <h2 className="font-titan text-2xl text-j2s-purple">Check your email to access your dashboard</h2>
        <p className="mt-3 text-j2s-ink/70">If you just registered, we sent a sign-in link to your inbox — click it to see your child&rsquo;s schedule and details. Still stuck? Email us and we&rsquo;ll sort it out right away.</p>
        <Link to={`/${slug}`} className="mt-6 inline-block rounded-lg bg-j2s-purple px-6 py-3 font-bold text-white transition hover:bg-j2s-purple-dark">Browse programs</Link>
        <p className="mt-4 text-sm text-j2s-ink/60"><a href={`mailto:${supportEmail}`} className="font-semibold text-j2s-purple hover:underline">Email {supportEmail}</a></p>
        <p className="mt-6 text-sm text-j2s-ink/60">
          Are you an instructor?{' '}
          <Link to={`/${slug}/instructor`} className="font-semibold text-j2s-purple hover:underline">Go to the instructor portal →</Link>
        </p>
      </div>
    );
  }
  if (error === 'fetch_failed') {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center">
        <h2 className="font-titan text-2xl text-j2s-purple">Something went wrong</h2>
        <p className="mt-3 text-j2s-ink/70">We had trouble loading your dashboard. Please try refreshing, or email us if the problem continues.</p>
        <a href={`mailto:${supportEmail}`} className="mt-4 inline-block font-bold text-j2s-purple underline">{supportEmail}</a>
      </div>
    );
  }

  // Blocking waiver gate — must sign required waivers before seeing details.
  if (unsignedWaivers.length > 0) {
    return <WaiverGate waivers={unsignedWaivers} parent={parent} orgId={org.id} onComplete={fetchData} />;
  }
  if (incompleteStudents.length > 0) {
    return <PickupInfoGate students={incompleteStudents} parent={parent} orgId={org.id} onComplete={fetchData} />;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pb-8 sm:px-6">
      <div className="pb-2 pt-6 sm:pt-10">
        <h1 className="font-titan text-2xl text-j2s-ink sm:text-3xl">
          Hi {parent?.first_name || 'there'}!
        </h1>
      </div>

      {nextTerm && enrollments.length > 0 && (
        <Link to={`/${org.slug}`} className="mb-4 block rounded-2xl bg-j2s-purple px-5 py-4 text-white shadow-lg transition hover:bg-j2s-purple-dark hover:shadow-xl">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-bold">{TERM_LABELS[nextTerm]} registration is open</p>
              <p className="mt-0.5 text-xs text-white/70">Secure your spot for the upcoming term</p>
            </div>
            <span className="shrink-0 rounded-full bg-white px-3.5 py-1.5 text-xs font-bold text-j2s-purple">Register →</span>
          </div>
        </Link>
      )}

      {/* Org's weekly class schedule — for outside-registration tenants whose
          families aren't enrolled through Enrops. Only renders when the org has a
          class_schedule; registration tenants (J2S) show nothing here. */}
      {weeklyClasses.length > 0 && (
        <div className="mb-6 rounded-2xl border border-j2s-purple/10 bg-white p-5 shadow-card sm:p-6">
          <h2 className="font-titan text-xl text-j2s-ink">This week&rsquo;s schedule</h2>
          <div className="mt-4 space-y-5">
            {groupClassesByDay(weeklyClasses).map((g) => (
              <div key={g.day}>
                <h3 className="text-xs font-bold uppercase tracking-widest text-j2s-purple">{g.day}</h3>
                <ul className="mt-2 divide-y divide-j2s-purple/10">
                  {g.items.map((c) => {
                    const time = [c.start_time, c.end_time].filter(Boolean).join(' – ');
                    return (
                      <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                        <span className="font-semibold text-j2s-ink">{c.title}</span>
                        <span className="text-sm text-j2s-ink/70">{time}{c.location_text ? `${time ? ' · ' : ''}${c.location_text}` : ''}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sticky top-0 z-10 -mx-4 bg-white/95 px-4 backdrop-blur sm:-mx-6 sm:px-6">
        <nav className="flex border-b border-j2s-purple/10">
          {TABS.map((t) => {
            const Icon = TAB_ICONS[t.key];
            const active = tab === t.key;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`flex flex-1 flex-col items-center gap-0.5 py-3 text-xs font-semibold transition sm:flex-row sm:justify-center sm:gap-1.5 sm:text-sm ${
                  active ? 'border-b-2 border-j2s-purple text-j2s-purple' : 'text-j2s-ink/40 hover:text-j2s-ink/70'
                }`}>
                <Icon className="h-5 w-5" />
                {t.label}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="mt-6">
        {tab === 'today' && <TodayTab todayClasses={todayClasses} enrollments={enrollments} notifications={notifications} slug={org.slug} />}
        {tab === 'schedule' && <ScheduleTab enrollments={enrollments} />}
        {tab === 'classes' && <ClassesTab enrollments={enrollments} expandedCards={expandedCards} toggleCard={toggleCard} slug={org.slug} />}
        {tab === 'settings' && <SettingsTab prefs={prefs} savingPrefs={savingPrefs} prefsSaved={prefsSaved} onToggle={(key) => savePrefs({ ...prefs, [key]: !prefs[key] })} supportEmail={supportEmail} />}
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  TODAY TAB                                                            */
/* ==================================================================== */
function TodayTab({ todayClasses, enrollments, notifications, slug }) {
  if (enrollments.length === 0) {
    return <EmptyState title="No enrollments yet" body="Once you register for a class, you'll see what your child is learning each day." cta="Browse programs" to={`/${slug}`} />;
  }

  return (
    <div className="space-y-6">
      {/* Notification feed — top of page */}
      {notifications.length > 0 && (
        <>
          <SectionLabel>From {org?.name || 'your provider'}</SectionLabel>
          <div className="space-y-2">
            {notifications.map((n) => (
              <div key={n.id} className="flex items-center gap-3 rounded-xl border-l-4 border-l-j2s-purple border border-j2s-purple/10 bg-j2s-purple/[0.03] px-4 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-j2s-purple/10">
                  <svg className="h-4 w-4 text-j2s-purple" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-j2s-ink">{n.name}</p>
                  <p className="text-xs text-j2s-ink/40">{timeAgo(n.sentAt)}</p>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {todayClasses.length > 0 ? (
        <>
          <SectionLabel>Today in class</SectionLabel>
          {todayClasses.map((e) => <TodayCard key={e.id} enrollment={e} />)}
        </>
      ) : (
        <div className="rounded-2xl border border-j2s-purple/10 bg-white p-6 text-center shadow-card">
          <p className="text-sm text-j2s-ink/50">No classes today</p>
        </div>
      )}
    </div>
  );
}

function TodayCard({ enrollment: e }) {
  const s = e.sessionInfo?.session;
  // `s` is null once the program outruns the authored lesson plans (a 10-week
  // term with 8 plans). The class IS still on today, so keep the card and drop
  // only the lesson-specific detail - bailing here left the "Today in class"
  // heading sitting above nothing.
  if (!e.sessionInfo) return null;
  return (
    <div className="rounded-2xl border border-j2s-purple/10 bg-white shadow-card overflow-hidden">
      <div className="h-1 bg-j2s-purple" />
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider text-j2s-purple/70">
              Session {e.sessionInfo.sessionNumber} of {e.sessionInfo.totalSessions}
            </p>
            <p className="mt-1 text-lg font-bold text-j2s-ink">{s?.title || e.name}</p>
          </div>
          <span className="shrink-0 rounded-full bg-j2s-green/10 px-2.5 py-1 text-xs font-bold text-j2s-green-dark">Today</span>
        </div>
        <p className="mt-1 text-sm text-j2s-ink/60">
          {e.student?.first_name} &middot; {e.name}{e.location ? ` at ${e.location}` : ''}
        </p>
        {s?.description && <p className="mt-3 text-sm leading-relaxed text-j2s-ink/70">{s.description}</p>}
        {s?.skills_practiced?.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-j2s-ink/40">Skills</p>
            <div className="flex flex-wrap gap-1.5">
              {s.skills_practiced.filter(Boolean).map((skill, i) => (
                <span key={i} className="rounded-full bg-j2s-purple/10 px-2.5 py-0.5 text-xs font-medium text-j2s-purple">{skill}</span>
              ))}
            </div>
          </div>
        )}
        {s?.parent_engagement_question && (
          <div className="mt-4 rounded-xl bg-amber-50 p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-amber-700">{'💬'} Ask your child tonight</p>
            <p className="mt-1.5 text-sm italic leading-relaxed text-amber-900">&ldquo;{s.parent_engagement_question}&rdquo;</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  SCHEDULE TAB — actual session dates from derive_program_session_dates */
/* ==================================================================== */
function ScheduleTab({ enrollments }) {
  const afterschool = enrollments.filter((e) => e.type === 'afterschool');
  const camps = enrollments.filter((e) => e.type === 'camp');

  if (afterschool.length === 0 && camps.length === 0) {
    return (
      <div className="rounded-2xl border border-j2s-purple/10 bg-white p-6 text-center shadow-card">
        <p className="text-j2s-ink/50">No classes scheduled yet.</p>
      </div>
    );
  }

  const todayStr = new Date().toISOString().split('T')[0];

  return (
    <div className="space-y-8">
      {afterschool.map((e) => (
        <div key={e.id}>
          <SectionLabel>
            {e.student?.first_name} &middot; {e.name}
          </SectionLabel>
          <p className="mt-0.5 text-xs text-j2s-ink/60">
            {e.day}s {fmtTime(e.startTime)}{e.endTime ? `–${fmtTime(e.endTime)}` : ''}
            {e.location ? ` at ${e.location}` : ''}
          </p>

          {(e.sessionSchedule?.length > 0 || e.sessionDates.length > 0) ? (
            <div className="mt-3 space-y-1">
              {(() => {
                // Prefer the full schedule (with no-school rows); fall back to
                // meeting-dates-only if the schedule RPC didn't populate.
                const rows = e.sessionSchedule?.length > 0
                  ? e.sessionSchedule
                  : e.sessionDates.map((date) => ({ date, kind: 'session', reason: null }));
                const totalSessions = e.sessionDates.length;
                let sessionIdx = -1; // running index into curriculum sessions
                return rows.map((row) => {
                  const date = row.date;
                  if (row.kind === 'no_school') {
                    const isPast = date < todayStr;
                    return (
                      <div
                        key={`ns-${date}`}
                        className={`flex items-center gap-3 rounded-lg px-3 py-2 ${isPast ? 'opacity-40' : ''}`}
                      >
                        <div className="w-5 shrink-0 text-center">
                          <div className="mx-auto h-2.5 w-2.5 rounded-full border-2 border-j2s-ink/15" />
                        </div>
                        <p className="w-28 shrink-0 text-sm text-j2s-ink/40 line-through">
                          {fmtDateShort(date)}
                        </p>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm italic text-j2s-ink/50 truncate">
                            No school · {row.reason || 'No class'}
                          </p>
                        </div>
                      </div>
                    );
                  }
                  sessionIdx += 1;
                  const idx = sessionIdx;
                  const isPast = date < todayStr;
                  const isToday = date === todayStr;
                  const session = e.sessions[idx];
                  return (
                    <div
                      key={`s-${date}`}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2 ${
                        isToday ? 'bg-j2s-purple/10 ring-1 ring-j2s-purple/20' : isPast ? 'opacity-40' : 'bg-white'
                      }`}
                    >
                      {/* Check or dot */}
                      <div className="w-5 shrink-0 text-center">
                        {isPast ? (
                          <svg className="mx-auto h-4 w-4 text-j2s-green" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        ) : isToday ? (
                          <div className="mx-auto h-3 w-3 rounded-full bg-j2s-purple" />
                        ) : (
                          <div className="mx-auto h-2.5 w-2.5 rounded-full border-2 border-j2s-purple/30" />
                        )}
                      </div>

                      {/* Date */}
                      <p className={`w-28 shrink-0 text-sm ${isToday ? 'font-bold text-j2s-purple' : 'text-j2s-ink/80'}`}>
                        {fmtDateShort(date)}
                      </p>

                      {/* Session title */}
                      <div className="min-w-0 flex-1">
                        {session ? (
                          <p className={`text-sm truncate ${isToday ? 'font-semibold text-j2s-ink' : 'text-j2s-ink/80'}`}>
                            {session.title}
                          </p>
                        ) : (
                          <p className="text-sm text-j2s-ink/50">Session {idx + 1}</p>
                        )}
                      </div>

                      {/* Session number badge */}
                      <span className="shrink-0 text-xs text-j2s-ink/50">{idx + 1}/{totalSessions}</span>
                    </div>
                  );
                });
              })()}
            </div>
          ) : (
            <p className="mt-3 text-sm text-j2s-ink/60">
              {e.firstDate ? `Starts ${fmtDate(e.firstDate)} · ${e.sessionCount} sessions` : `${e.sessionCount} sessions`}
            </p>
          )}
        </div>
      ))}

      {camps.length > 0 && (
        <>
          <SectionLabel>Camp sessions</SectionLabel>
          {camps.map((e) => (
            <div key={e.id} className="rounded-2xl border border-j2s-purple/10 bg-white p-4 shadow-card">
              <p className="text-sm font-semibold text-j2s-ink">{e.name}</p>
              <p className="mt-0.5 text-xs text-j2s-ink/50">
                {e.student?.first_name}{e.location ? ` · ${e.location}` : ''}
                {e.firstDate && e.lastDate ? ` · ${fmtDateShort(e.firstDate)}–${fmtDateShort(e.lastDate)}` : ''}
                {e.startTime ? ` · ${fmtTime(e.startTime)}–${fmtTime(e.endTime)}` : ''}
              </p>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ==================================================================== */
/*  CLASSES TAB                                                         */
/* ==================================================================== */
function ClassesTab({ enrollments, expandedCards, toggleCard, slug }) {
  if (enrollments.length === 0) {
    return <EmptyState title="No enrollments yet" body="Browse programs to get started." cta="Browse programs" to={`/${slug}`} />;
  }

  const byStudent = {};
  enrollments.forEach((e) => {
    const key = e.student ? `${e.student.first_name} ${e.student.last_name}` : 'Unknown';
    if (!byStudent[key]) byStudent[key] = [];
    byStudent[key].push(e);
  });

  return (
    <div className="space-y-6">
      {Object.entries(byStudent).map(([name, classes]) => (
        <div key={name}>
          <SectionLabel>{name}</SectionLabel>
          <div className="mt-2 space-y-3">
            {classes.map((e) => (
              <ClassCard key={e.id} enrollment={e} expanded={expandedCards.has(e.id)} onToggle={() => toggleCard(e.id)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ClassCard({ enrollment: e, expanded, onToggle }) {
  const isCamp = e.type === 'camp';
  const hasSchedule = e.sessions.length > 0;
  const count = e.sessionCount;
  const scheduleLabel = isCamp
    ? `day-by-day schedule (${count} days)`
    : `week-by-week schedule (${count} sessions)`;

  return (
    <div className="rounded-2xl border border-j2s-purple/10 bg-white shadow-card overflow-hidden">
      <div className="p-4">
        <p className="font-semibold text-j2s-purple">{e.name}</p>
        <div className="mt-1 space-y-0.5 text-sm text-j2s-ink/60">
          {e.location && <p>at {e.location}</p>}
          {e.day && <p>{e.day}s, {fmtTime(e.startTime)}{e.endTime ? `–${fmtTime(e.endTime)}` : ''}</p>}
          {!e.day && e.startTime && <p>{fmtTime(e.startTime)}{e.endTime ? `–${fmtTime(e.endTime)}` : ''}</p>}
          {/* Date range from actual session dates */}
          {e.sessionDates?.length > 0 && (
            <p>{fmtDateShort(e.sessionDates[0])}–{fmtDateShort(e.sessionDates[e.sessionDates.length - 1])}</p>
          )}
          {e.sessionDates?.length === 0 && e.firstDate && !isCamp && <p>Starts {fmtDate(e.firstDate)}</p>}
          {isCamp && e.firstDate && e.lastDate && <p>{fmtDateShort(e.firstDate)}–{fmtDateShort(e.lastDate)}</p>}
          {e.term && <p className="text-xs text-j2s-ink/40">{TERM_LABELS[e.term] || e.term}</p>}
        </div>

        {(e.arrival || e.dismissal) && (
          <div className="mt-3 border-t border-j2s-purple/5 pt-3 space-y-2">
            {e.arrival && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-j2s-ink/40">Arrival</p>
                <p className="mt-0.5 text-sm text-j2s-ink/60">{e.arrival}</p>
              </div>
            )}
            {e.dismissal && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-j2s-ink/40">Dismissal</p>
                <p className="mt-0.5 text-sm text-j2s-ink/60">{e.dismissal}</p>
              </div>
            )}
          </div>
        )}

        {!hasSchedule && e.skillsOverall && (
          <div className="mt-3 border-t border-j2s-purple/5 pt-3">
            <p className="text-xs font-bold uppercase tracking-wider text-j2s-ink/40">Skills</p>
            <p className="mt-1 text-sm text-j2s-ink/60">{e.skillsOverall}</p>
          </div>
        )}

        {hasSchedule && (
          <button type="button" onClick={onToggle}
            className="mt-3 flex w-full items-center justify-between border-t border-j2s-purple/5 pt-3 text-left text-sm font-semibold text-j2s-purple hover:text-j2s-purple-dark transition">
            <span>{expanded ? 'Hide' : 'View'} {scheduleLabel}</span>
            <ChevronDown open={expanded} className="text-j2s-purple" />
          </button>
        )}
      </div>
      {expanded && hasSchedule && <SessionTimeline sessions={e.sessions} isCamp={isCamp} />}
    </div>
  );
}

/* ==================================================================== */
/*  SETTINGS TAB                                                        */
/* ==================================================================== */
function SettingsTab({ prefs, savingPrefs, prefsSaved, onToggle, supportEmail }) {
  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Email preferences</SectionLabel>
        <p className="mt-1 text-sm text-j2s-ink/40">Choose which emails you'd like to receive.</p>
        <div className="mt-4 space-y-3">
          {PREF_OPTIONS.map((opt) => (
            <label key={opt.key} className="flex cursor-pointer items-start gap-3 rounded-xl border border-j2s-purple/10 bg-white p-4 transition hover:border-j2s-purple/20">
              <button type="button" role="switch" aria-checked={!!prefs?.[opt.key]} disabled={savingPrefs}
                onClick={(ev) => { ev.preventDefault(); onToggle(opt.key); }}
                className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-j2s-purple/40 ${prefs?.[opt.key] ? 'bg-j2s-purple' : 'bg-gray-300'}`}>
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform duration-200 mt-0.5 ${prefs?.[opt.key] ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
              </button>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-j2s-ink">{opt.label}</p>
                <p className="mt-0.5 text-xs text-j2s-ink/40">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>
        {prefsSaved && <p className="mt-2 text-sm font-medium text-green-600">Saved!</p>}
      </div>
      <div className="rounded-2xl border border-j2s-purple/10 bg-white p-5 text-center shadow-card">
        <p className="text-sm text-j2s-ink/50">
          Questions? Email{' '}
          <a href={`mailto:${supportEmail}`} className="font-semibold text-j2s-purple hover:underline">{supportEmail}</a>
        </p>
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  Shared                                                               */
/* ==================================================================== */
function SectionLabel({ children, className = '' }) {
  return <p className={`text-xs font-bold uppercase tracking-wider text-j2s-ink/40 ${className}`}>{children}</p>;
}

function EmptyState({ title, body, cta, to }) {
  return (
    <div className="rounded-2xl border border-j2s-purple/10 bg-white p-8 text-center shadow-card">
      <p className="text-lg font-bold text-j2s-ink/70">{title}</p>
      <p className="mt-2 text-sm text-j2s-ink/50">{body}</p>
      {cta && to && <Link to={to} className="mt-5 inline-block rounded-lg bg-j2s-purple px-6 py-3 text-sm font-bold text-white transition hover:bg-j2s-purple-dark">{cta}</Link>}
    </div>
  );
}

function SessionTimeline({ sessions, isCamp }) {
  const prefix = isCamp ? 'Day' : 'Week';
  return (
    <div className="border-t border-j2s-purple/10 bg-j2s-purple/[0.02] px-5 py-4">
      <div className="space-y-4">
        {sessions.map((s, idx) => (
          <div key={s.session_number} className="relative pl-7">
            <div className="absolute left-0 top-1 h-4 w-4 rounded-full border-2 border-j2s-purple bg-white" />
            {idx < sessions.length - 1 && <div className="absolute left-[7px] top-5 bottom-0 w-0.5 bg-j2s-purple/15" />}
            <p className="text-xs font-bold uppercase tracking-wider text-j2s-purple/70">{prefix} {s.session_number}</p>
            <p className="mt-0.5 text-sm font-semibold text-j2s-ink">{s.title}</p>
            {s.skills_practiced?.length > 0 && (
              <div className="mt-1.5">
                <p className="mb-1 text-xs font-bold uppercase tracking-wider text-j2s-purple/50">Skills</p>
                <div className="flex flex-wrap gap-1.5">
                  {s.skills_practiced.filter(Boolean).map((skill, i) => (
                    <span key={i} className="rounded-full bg-j2s-purple/10 px-2.5 py-0.5 text-xs font-medium text-j2s-purple">{skill}</span>
                  ))}
                </div>
              </div>
            )}
            {s.parent_engagement_question && (
              <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2">
                <p className="text-xs font-bold text-amber-700">{'💬'} Ask your child</p>
                <p className="mt-0.5 text-sm italic text-amber-900">&ldquo;{s.parent_engagement_question}&rdquo;</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
