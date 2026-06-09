import React, { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { getTenant } from '../../lib/tenants.js';

/* ------------------------------------------------------------------ */
/*  Term helpers                                                       */
/* ------------------------------------------------------------------ */
const TERM_ORDER = ['SU26', 'FA26', 'WI27', 'SP27', 'SU27'];
const TERM_LABELS = {
  SU26: 'Summer 2026',
  FA26: 'Fall 2026',
  WI27: 'Winter 2027',
  SP27: 'Spring 2027',
  SU27: 'Summer 2027',
};

function nextAvailableTerm(enrolledTerms) {
  return TERM_ORDER.find((t) => !enrolledTerms.has(t) && TERM_LABELS[t]);
}

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                 */
/* ------------------------------------------------------------------ */
function formatDate(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTime(timeStr) {
  if (!timeStr) return '';
  if (timeStr.includes('AM') || timeStr.includes('PM')) return timeStr;
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}

/* ------------------------------------------------------------------ */
/*  Notification pref labels                                           */
/* ------------------------------------------------------------------ */
const PREF_OPTIONS = [
  {
    key: 'email_registration_updates',
    label: 'Registration confirmations and updates',
    description: 'Receipts, schedule changes, and enrollment details',
  },
  {
    key: 'email_session_recaps',
    label: 'Class recaps and session notes',
    description: 'What your child learned and questions to ask at home',
  },
  {
    key: 'email_reenrollment_prompts',
    label: 'New term enrollment reminders',
    description: 'Early access to register for the next session',
  },
];

const DEFAULT_PREFS = {
  email_registration_updates: true,
  email_session_recaps: true,
  email_reenrollment_prompts: true,
};

/* ------------------------------------------------------------------ */
/*  Chevron icon                                                       */
/* ------------------------------------------------------------------ */
function ChevronDown({ open, className = '' }) {
  return (
    <svg
      className={`h-5 w-5 transition-transform duration-200 ${open ? 'rotate-180' : ''} ${className}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */
export default function Dashboard() {
  const { org } = useOutletContext();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  // Fallback: if org doesn't carry supportEmail, use tenant config
  const tenant = getTenant(org?.slug || 'j2s');
  const supportEmail = tenant?.supportEmail || 'support@enrops.com';

  const [parent, setParent] = useState(null);
  const [afterschoolRegs, setAfterschoolRegs] = useState([]);
  const [campRegs, setCampRegs] = useState([]);
  const [nextTerm, setNextTerm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedCards, setExpandedCards] = useState(new Set());

  // Notification preferences
  const [prefs, setPrefs] = useState(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsSaved, setPrefsSaved] = useState(false);

  const toggleCard = useCallback((id) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /* ---- Redirect if not authenticated ---- */
  useEffect(() => {
    if (!authLoading && !user) {
      navigate(`/${org?.slug || 'j2s'}/login`, { replace: true });
      return;
    }
    if (user) fetchDashboardData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, authLoading]);

  /* ---- Main data fetch ---- */
  async function fetchDashboardData() {
    try {
      setLoading(true);
      setError(null);

      // 1. Parent row
      const { data: parentData, error: parentError } = await supabase
        .from('parents')
        .select('id, first_name, last_name, communication_preferences')
        .eq('auth_id', user.id)
        .maybeSingle();

      if (parentError) {
        console.error('Parent fetch error:', parentError);
        setError('fetch_failed');
        setLoading(false);
        return;
      }
      if (!parentData) {
        setError('no_parent');
        setLoading(false);
        return;
      }
      setParent(parentData);
      setPrefs({ ...DEFAULT_PREFS, ...(parentData.communication_preferences || {}) });

      // 2a. Afterschool registrations (program_id path)
      const { data: asRegs, error: asErr } = await supabase
        .from('registrations')
        .select(
          `id, status, registered_at, program_id,
           students(first_name, last_name),
           programs(
             id, curriculum, curriculum_id, day_of_week, start_time, end_time,
             first_session_date, term, session_count,
             program_locations(name, arrival_instructions, dismissal_instructions),
             curricula(
               id, name, skills_overall,
               curriculum_sessions(session_number, title, description, skills_practiced, parent_engagement_question)
             )
           )`
        )
        .eq('parent_id', parentData.id)
        .in('status', ['confirmed'])
        .not('program_id', 'is', null)
        .order('registered_at', { ascending: true });

      if (asErr) console.error('Afterschool fetch error:', asErr);
      setAfterschoolRegs(asRegs || []);

      // 2b. Camp registrations (camp_session_id path)
      const { data: cRegs, error: cErr } = await supabase
        .from('registrations')
        .select(
          `id, status, registered_at, camp_session_id,
           students(first_name, last_name),
           camp_sessions(
             id, curriculum_name, curriculum_id, location_name,
             starts_on, ends_on, start_time, end_time, session_type, week_num,
             curricula(
               id, name, skills_overall,
               curriculum_sessions(session_number, title, description, skills_practiced, parent_engagement_question)
             )
           )`
        )
        .eq('parent_id', parentData.id)
        .in('status', ['confirmed'])
        .not('camp_session_id', 'is', null)
        .order('registered_at', { ascending: true });

      if (cErr) console.error('Camp fetch error:', cErr);
      setCampRegs(cRegs || []);

      // 3. Detect next available term for re-enrollment CTA
      const enrolledTerms = new Set();
      (asRegs || []).forEach((r) => {
        if (r.programs?.term) enrolledTerms.add(r.programs.term);
      });
      // Camp sessions are SU26 by convention
      if ((cRegs || []).length > 0) enrolledTerms.add('SU26');

      const next = nextAvailableTerm(enrolledTerms);
      setNextTerm(next);

      setLoading(false);
    } catch (err) {
      console.error('Dashboard error:', err);
      setError('fetch_failed');
      setLoading(false);
    }
  }

  /* ---- Save notification prefs ---- */
  async function savePrefs(newPrefs) {
    setSavingPrefs(true);
    setPrefsSaved(false);
    const { error: upErr } = await supabase
      .from('parents')
      .update({ communication_preferences: newPrefs })
      .eq('id', parent.id);
    setSavingPrefs(false);
    if (!upErr) {
      setPrefs(newPrefs);
      setPrefsSaved(true);
      setTimeout(() => setPrefsSaved(false), 2000);
    }
  }

  function togglePref(key) {
    const updated = { ...prefs, [key]: !prefs[key] };
    savePrefs(updated);
  }

  /* ================================================================ */
  /*  Render states                                                    */
  /* ================================================================ */
  if (authLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="animate-pulse text-j2s-ink/50">Loading&hellip;</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-b-2 border-j2s-purple" />
          <p className="text-j2s-ink/50">Loading your enrollments&hellip;</p>
        </div>
      </div>
    );
  }

  if (error === 'no_parent') {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center">
        <h2 className="font-titan text-2xl text-j2s-purple">
          Hmm, we couldn't find your enrollments.
        </h2>
        <p className="mt-3 text-j2s-ink/70">
          This sometimes happens if your account is still being set up. Please
          email us and we'll sort it out right away.
        </p>
        <a
          href={`mailto:${supportEmail}`}
          className="mt-6 inline-block rounded-lg bg-j2s-purple px-6 py-3 font-bold text-white transition hover:bg-j2s-purple-dark"
        >
          Email {supportEmail}
        </a>
      </div>
    );
  }

  if (error === 'fetch_failed') {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center">
        <h2 className="font-titan text-2xl text-j2s-purple">Something went wrong</h2>
        <p className="mt-3 text-j2s-ink/70">
          We had trouble loading your enrollments. Please try refreshing, or
          email us if the problem continues.
        </p>
        <a
          href={`mailto:${supportEmail}`}
          className="mt-4 inline-block font-bold text-j2s-purple underline"
        >
          {supportEmail}
        </a>
      </div>
    );
  }

  const totalEnrollments = afterschoolRegs.length + campRegs.length;

  /* ================================================================ */
  /*  Happy path                                                       */
  /* ================================================================ */
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      {/* ---- Header ---- */}
      <h1 className="font-titan text-3xl text-j2s-ink">
        Hi {parent?.first_name || user?.email?.split('@')[0] || 'there'}!
      </h1>

      {/* ---- Zero enrollments ---- */}
      {totalEnrollments === 0 ? (
        <div className="mt-10 rounded-2xl border border-j2s-purple/10 bg-white p-8 text-center shadow-card">
          <p className="text-lg text-j2s-ink/70">
            You don't have any enrollments yet.
          </p>
          <Link
            to={`/${org.slug}`}
            className="mt-5 inline-block rounded-lg bg-j2s-purple px-6 py-3 font-bold text-white transition hover:bg-j2s-purple-dark"
          >
            Browse programs &rarr;
          </Link>
        </div>
      ) : (
        <>
          {/* ============================================================ */}
          {/*  CAMP ENROLLMENTS                                             */}
          {/* ============================================================ */}
          {campRegs.length > 0 && (
            <>
              <h2 className="mt-8 font-titan text-xl text-j2s-ink">
                Summer camps
              </h2>
              <div className="mt-4 space-y-4">
                {campRegs.map((reg) => (
                  <CampCard
                    key={reg.id}
                    reg={reg}
                    expanded={expandedCards.has(reg.id)}
                    onToggle={() => toggleCard(reg.id)}
                  />
                ))}
              </div>
            </>
          )}

          {/* ============================================================ */}
          {/*  AFTERSCHOOL ENROLLMENTS                                      */}
          {/* ============================================================ */}
          {afterschoolRegs.length > 0 && (
            <>
              <h2 className="mt-8 font-titan text-xl text-j2s-ink">
                After-school classes
              </h2>
              <div className="mt-4 space-y-4">
                {afterschoolRegs.map((reg) => (
                  <AfterschoolCard
                    key={reg.id}
                    reg={reg}
                    expanded={expandedCards.has(reg.id)}
                    onToggle={() => toggleCard(reg.id)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* ============================================================ */}
      {/*  REGISTER-FOR-NEXT-TERM CTA                                   */}
      {/* ============================================================ */}
      {nextTerm && (
        <div className="mt-10 rounded-2xl border border-j2s-green/20 bg-j2s-green/5 p-6 text-center">
          <h2 className="font-titan text-xl text-j2s-ink">
            {TERM_LABELS[nextTerm]} registration is open
          </h2>
          <p className="mt-2 text-sm text-j2s-ink/70">
            Secure your spot for the upcoming term.
          </p>
          <Link
            to={`/${org.slug}`}
            className="mt-4 inline-block rounded-lg bg-j2s-purple px-6 py-3 font-bold text-white transition hover:bg-j2s-purple-dark"
          >
            Browse {TERM_LABELS[nextTerm]} programs &rarr;
          </Link>
        </div>
      )}

      {/* ============================================================ */}
      {/*  NOTIFICATION PREFERENCES                                     */}
      {/* ============================================================ */}
      {prefs && (
        <div className="mt-10">
          <h2 className="font-titan text-xl text-j2s-ink">
            Email preferences
          </h2>
          <p className="mt-1 text-sm text-j2s-ink/50">
            Choose which emails you'd like to receive.
          </p>
          <div className="mt-4 space-y-3">
            {PREF_OPTIONS.map((opt) => (
              <label
                key={opt.key}
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-j2s-purple/10 bg-white p-4 transition hover:border-j2s-purple/20"
              >
                <div className="pt-0.5">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!prefs[opt.key]}
                    disabled={savingPrefs}
                    onClick={(e) => {
                      e.preventDefault();
                      togglePref(opt.key);
                    }}
                    className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-j2s-purple/40 ${
                      prefs[opt.key] ? 'bg-j2s-purple' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
                        prefs[opt.key] ? 'translate-x-[22px]' : 'translate-x-0.5'
                      } mt-0.5`}
                    />
                  </button>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-j2s-ink">
                    {opt.label}
                  </p>
                  <p className="mt-0.5 text-xs text-j2s-ink/50">
                    {opt.description}
                  </p>
                </div>
              </label>
            ))}
          </div>
          {prefsSaved && (
            <p className="mt-2 text-sm font-medium text-green-600">
              Saved!
            </p>
          )}
        </div>
      )}

      {/* ---- Footer ---- */}
      <div className="mt-10 text-center">
        <p className="text-sm text-j2s-ink/50">
          Questions? Email{' '}
          <a
            href={`mailto:${supportEmail}`}
            className="font-semibold text-j2s-purple hover:underline"
          >
            {supportEmail}
          </a>
        </p>
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  Afterschool enrollment card                                          */
/* ==================================================================== */
function AfterschoolCard({ reg, expanded, onToggle }) {
  const student = reg.students;
  const program = reg.programs;
  const location = program?.program_locations;
  const curriculum = program?.curricula;
  const sessions = curriculum?.curriculum_sessions
    ? [...curriculum.curriculum_sessions].sort((a, b) => a.session_number - b.session_number)
    : [];
  const hasSchedule = sessions.length > 0;

  return (
    <div className="rounded-2xl border border-j2s-purple/10 bg-white shadow-card overflow-hidden">
      {/* Card header — always visible */}
      <div className="p-5">
        <p className="text-lg font-bold text-j2s-ink">
          {student?.first_name} {student?.last_name}
        </p>
        <p className="mt-1 font-semibold text-j2s-purple">
          {program?.curriculum}
        </p>

        {location?.name && (
          <p className="mt-1 text-sm text-j2s-ink/70">at {location.name}</p>
        )}
        {program?.day_of_week && (
          <p className="mt-1 text-sm text-j2s-ink/70">
            {program.day_of_week}s, {formatTime(program.start_time)}
            {program.end_time ? `–${formatTime(program.end_time)}` : ''}
          </p>
        )}
        {program?.first_session_date && (
          <p className="mt-1 text-sm text-j2s-ink/70">
            First session: {formatDate(program.first_session_date)}
          </p>
        )}

        {/* Arrival / Dismissal */}
        {(location?.arrival_instructions || location?.dismissal_instructions) && (
          <div className="mt-3 border-t border-j2s-purple/5 pt-3 space-y-2">
            {location.arrival_instructions && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-j2s-ink/50">
                  Arrival
                </p>
                <p className="mt-0.5 text-sm leading-relaxed text-j2s-ink/70">
                  {location.arrival_instructions}
                </p>
              </div>
            )}
            {location.dismissal_instructions && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-j2s-ink/50">
                  Dismissal
                </p>
                <p className="mt-0.5 text-sm leading-relaxed text-j2s-ink/70">
                  {location.dismissal_instructions}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Skills overview fallback (when no session data) */}
        {!hasSchedule && curriculum?.skills_overall && (
          <div className="mt-3 border-t border-j2s-purple/5 pt-3">
            <p className="text-xs font-bold uppercase tracking-wider text-j2s-ink/50">
              Skills your child will practice
            </p>
            <p className="mt-1 text-sm text-j2s-ink/70">
              {curriculum.skills_overall}
            </p>
          </div>
        )}

        {/* Expand toggle for session schedule */}
        {hasSchedule && (
          <button
            type="button"
            onClick={onToggle}
            className="mt-3 flex w-full items-center justify-between border-t border-j2s-purple/5 pt-3 text-left text-sm font-semibold text-j2s-purple hover:text-j2s-purple-dark transition"
          >
            <span>
              {expanded ? 'Hide' : 'View'} week-by-week schedule ({sessions.length} sessions)
            </span>
            <ChevronDown open={expanded} className="text-j2s-purple" />
          </button>
        )}
      </div>

      {/* Expanded session schedule */}
      {expanded && hasSchedule && (
        <SessionSchedule sessions={sessions} labelPrefix="Week" />
      )}
    </div>
  );
}

/* ==================================================================== */
/*  Camp enrollment card                                                 */
/* ==================================================================== */
function CampCard({ reg, expanded, onToggle }) {
  const student = reg.students;
  const camp = reg.camp_sessions;
  const curriculum = camp?.curricula;
  const sessions = curriculum?.curriculum_sessions
    ? [...curriculum.curriculum_sessions].sort((a, b) => a.session_number - b.session_number)
    : [];
  const hasSchedule = sessions.length > 0;

  // Format camp date range
  const dateRange =
    camp?.starts_on && camp?.ends_on
      ? `${formatDateShort(camp.starts_on)}–${formatDateShort(camp.ends_on)}`
      : null;

  // Session type label
  const typeLabel =
    camp?.session_type === 'half_day_am'
      ? 'Morning'
      : camp?.session_type === 'half_day_pm'
        ? 'Afternoon'
        : camp?.session_type === 'full_day'
          ? 'Full day'
          : '';

  return (
    <div className="rounded-2xl border border-j2s-purple/10 bg-white shadow-card overflow-hidden">
      <div className="p-5">
        <p className="text-lg font-bold text-j2s-ink">
          {student?.first_name} {student?.last_name}
        </p>
        <p className="mt-1 font-semibold text-j2s-purple">
          {camp?.curriculum_name || curriculum?.name || 'Camp session'}
        </p>

        {camp?.location_name && (
          <p className="mt-1 text-sm text-j2s-ink/70">
            at {camp.location_name}
          </p>
        )}

        <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-j2s-ink/70">
          {dateRange && <span>{dateRange}</span>}
          {typeLabel && <span>{typeLabel}</span>}
          {camp?.start_time && (
            <span>
              {formatTime(camp.start_time)}
              {camp.end_time ? `–${formatTime(camp.end_time)}` : ''}
            </span>
          )}
        </div>

        {camp?.week_num && (
          <p className="mt-1 text-xs text-j2s-ink/50">
            Week {camp.week_num}
          </p>
        )}

        {/* Skills overview fallback */}
        {!hasSchedule && curriculum?.skills_overall && (
          <div className="mt-3 border-t border-j2s-purple/5 pt-3">
            <p className="text-xs font-bold uppercase tracking-wider text-j2s-ink/50">
              Skills your child will practice
            </p>
            <p className="mt-1 text-sm text-j2s-ink/70">
              {curriculum.skills_overall}
            </p>
          </div>
        )}

        {/* Expand toggle */}
        {hasSchedule && (
          <button
            type="button"
            onClick={onToggle}
            className="mt-3 flex w-full items-center justify-between border-t border-j2s-purple/5 pt-3 text-left text-sm font-semibold text-j2s-purple hover:text-j2s-purple-dark transition"
          >
            <span>
              {expanded ? 'Hide' : 'View'} day-by-day schedule ({sessions.length} days)
            </span>
            <ChevronDown open={expanded} className="text-j2s-purple" />
          </button>
        )}
      </div>

      {expanded && hasSchedule && (
        <SessionSchedule sessions={sessions} labelPrefix="Day" />
      )}
    </div>
  );
}

/* ==================================================================== */
/*  Shared session schedule (week-by-week or day-by-day)                 */
/* ==================================================================== */
function SessionSchedule({ sessions, labelPrefix }) {
  return (
    <div className="border-t border-j2s-purple/10 bg-j2s-purple/[0.02] px-5 py-4">
      <div className="space-y-4">
        {sessions.map((s) => (
          <div key={s.session_number} className="relative pl-7">
            {/* Timeline dot */}
            <div className="absolute left-0 top-1 h-4 w-4 rounded-full border-2 border-j2s-purple bg-white" />
            {s.session_number < sessions.length && (
              <div className="absolute left-[7px] top-5 bottom-0 w-0.5 bg-j2s-purple/15" />
            )}

            <p className="text-xs font-bold uppercase tracking-wider text-j2s-purple/70">
              {labelPrefix} {s.session_number}
            </p>
            <p className="mt-0.5 text-sm font-semibold text-j2s-ink">
              {s.title}
            </p>

            {s.skills_practiced && s.skills_practiced.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {s.skills_practiced
                  .filter(Boolean)
                  .map((skill, i) => (
                    <span
                      key={i}
                      className="inline-block rounded-full bg-j2s-purple/10 px-2.5 py-0.5 text-xs font-medium text-j2s-purple"
                    >
                      {skill}
                    </span>
                  ))}
              </div>
            )}

            {s.parent_engagement_question && (
              <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2">
                <p className="text-xs font-bold text-amber-700">
                  Ask your child
                </p>
                <p className="mt-0.5 text-sm text-amber-900">
                  {s.parent_engagement_question}
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
