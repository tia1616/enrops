import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { getTenant } from '../../lib/tenants.js';

const tenant = getTenant('j2s');

export default function Dashboard() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [parent, setParent] = useState(null);
  const [enrollments, setEnrollments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/j2s/login', { replace: true });
      return;
    }
    if (user) fetchDashboardData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, authLoading]);

  async function fetchDashboardData() {
    try {
      setLoading(true);
      setError(null);

      // 1. Get parent row linked to this auth user
      const { data: parentData, error: parentError } = await supabase
        .from('parents')
        .select('id, first_name, last_name')
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

      // 2. Get registrations with student, program, and location info
      const { data: regData, error: regError } = await supabase
        .from('registrations')
        .select(
          `id, status,
           students(first_name, last_name),
           programs(
             curriculum, day_of_week, start_time, end_time, first_session_date,
             program_locations(name, arrival_instructions, dismissal_instructions)
           )`,
        )
        .eq('parent_id', parentData.id)
        .in('status', ['confirmed'])
        .order('registered_at', { ascending: true });

      if (regError) {
        console.error('Registration fetch error:', regError);
        setError('fetch_failed');
        setLoading(false);
        return;
      }

      setEnrollments(regData || []);
      setLoading(false);
    } catch (err) {
      console.error('Dashboard error:', err);
      setError('fetch_failed');
      setLoading(false);
    }
  }

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

  function formatTime(timeStr) {
    if (!timeStr) return '';
    if (timeStr.includes('AM') || timeStr.includes('PM')) return timeStr;
    const [h, m] = timeStr.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  // --- Auth still loading ---
  if (authLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="animate-pulse text-j2s-ink/50">Loading&hellip;</div>
      </div>
    );
  }

  // --- Data loading ---
  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-b-2 border-j2s-purple"></div>
          <p className="text-j2s-ink/50">Loading your enrollments&hellip;</p>
        </div>
      </div>
    );
  }

  // --- No parent row found ---
  if (error === 'no_parent') {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center">
        <h2 className="font-titan text-2xl text-j2s-purple">
          Hmm, we couldn't find your enrollments.
        </h2>
        <p className="mt-3 text-j2s-ink/70">
          This sometimes happens if your account is still being set up.
          Please email us and we'll sort it out right away.
        </p>
        <a
          href={`mailto:${tenant.supportEmail}`}
          className="mt-6 inline-block rounded-lg bg-j2s-purple px-6 py-3 font-bold text-white transition hover:bg-j2s-purple-dark"
        >
          Email {tenant.supportEmail}
        </a>
      </div>
    );
  }

  // --- Fetch error ---
  if (error === 'fetch_failed') {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center">
        <h2 className="font-titan text-2xl text-j2s-purple">
          Something went wrong
        </h2>
        <p className="mt-3 text-j2s-ink/70">
          We had trouble loading your enrollments. Please try refreshing,
          or email us if the problem continues.
        </p>
        <a
          href={`mailto:${tenant.supportEmail}`}
          className="mt-4 inline-block font-bold text-j2s-purple underline"
        >
          {tenant.supportEmail}
        </a>
      </div>
    );
  }

  // --- Happy path ---
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      {/* Header */}
      <h1 className="font-titan text-3xl text-j2s-ink">
        Hi {parent?.first_name || user?.email?.split('@')[0] || 'there'}!
      </h1>

      {/* Zero enrollments */}
      {enrollments.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-j2s-purple/10 bg-white p-8 text-center shadow-card">
          <p className="text-lg text-j2s-ink/70">
            You don't have any enrollments yet.
          </p>
          <Link
            to="/j2s"
            className="mt-5 inline-block rounded-lg bg-j2s-purple px-6 py-3 font-bold text-white transition hover:bg-j2s-purple-dark"
          >
            Browse fall programs &rarr;
          </Link>
        </div>
      ) : (
        <>
          <h2 className="mt-8 font-titan text-xl text-j2s-ink">
            Your enrollments
          </h2>

          <div className="mt-4 space-y-4">
            {enrollments.map((reg) => {
              const student = reg.students;
              const program = reg.programs;
              const location = program?.program_locations;
              const arrivalInfo = location?.arrival_instructions;
              const dismissalInfo = location?.dismissal_instructions;

              return (
                <div
                  key={reg.id}
                  className="rounded-2xl border border-j2s-purple/10 bg-white p-5 shadow-card"
                >
                  {/* Student name */}
                  <p className="text-lg font-bold text-j2s-ink">
                    {student?.first_name} {student?.last_name}
                  </p>

                  {/* Program name */}
                  <p className="mt-1 font-semibold text-j2s-purple">
                    {program?.curriculum}
                  </p>

                  {/* School */}
                  {location?.name && (
                    <p className="mt-1 text-sm text-j2s-ink/70">
                      at {location.name}
                    </p>
                  )}

                  {/* Day & time */}
                  {program?.day_of_week && (
                    <p className="mt-1 text-sm text-j2s-ink/70">
                      {program.day_of_week}s, {formatTime(program.start_time)}{program.end_time ? `–${formatTime(program.end_time)}` : ''}
                    </p>
                  )}

                  {/* First session date */}
                  {program?.first_session_date && (
                    <p className="mt-1 text-sm text-j2s-ink/70">
                      First session: {formatDate(program.first_session_date)}
                    </p>
                  )}

                  {/* Arrival */}
                  {arrivalInfo && (
                    <div className="mt-3 border-t border-j2s-purple/5 pt-3">
                      <p className="text-xs font-bold uppercase tracking-wider text-j2s-ink/50">
                        Arrival
                      </p>
                      <p className="mt-1 text-sm leading-relaxed text-j2s-ink/70">
                        {arrivalInfo}
                      </p>
                    </div>
                  )}

                  {/* Dismissal */}
                  {dismissalInfo && (
                    <div className={`mt-3 ${arrivalInfo ? '' : 'border-t border-j2s-purple/5 pt-3'}`}>
                      <p className="text-xs font-bold uppercase tracking-wider text-j2s-ink/50">
                        Dismissal
                      </p>
                      <p className="mt-1 text-sm leading-relaxed text-j2s-ink/70">
                        {dismissalInfo}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Footer support line */}
      <div className="mt-10 text-center">
        <p className="text-sm text-j2s-ink/50">
          Questions? Email{' '}
          <a
            href={`mailto:${tenant.supportEmail}`}
            className="font-semibold text-j2s-purple hover:underline"
          >
            {tenant.supportEmail}
          </a>
        </p>
      </div>
    </div>
  );
}
