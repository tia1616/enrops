// AssignSubModal — admin asks somebody to cover a single day of a camp or
// after-school class. Calls create-assignment-substitution, which writes an
// offer row PER PERSON and emails each of them an Ennie-voiced offer.
//
// A class-day can hold an offer per person: several people can be asked and the
// first to accept gets it. So every state below is asked about the PERSON
// selected, never about the date — "is there a row for this date?" stopped
// having one answer when the one-row-per-day rule came off (20260923e).
//
// Resent state: re-opening the modal for somebody who already holds a live,
// emailed offer shows "Resend to X". The transition keys off
// assignment_substitutions.email_sent_at — the only column the edge fn ever
// writes on the offer-send path. Per the feedback_ui_state_artifacts rule.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { offerButtonLabel, offerSentMessage } from '../../lib/subOfferButton.js';

// Mirrors MAX_CANDIDATES in create-assignment-substitution. The cap exists so a
// single click cannot fan out into a crowd; refusing here means the operator
// finds out while they are still choosing, not after the round has started.
const MAX_CANDIDATES = 12;

const PURPLE = '#1C004F';
const BRIGHT = '#5847C9';   // indigo - primary actions (Figma)
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const CREAM = '#FBFBFB';
const CORAL = '#b53737';
const OK_GREEN = '#3a7c3a';

function fmtDate(d) {
  if (!d) return '';
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function shortName(i) {
  if (!i) return '—';
  return i.preferred_name || `${i.first_name ?? ''} ${i.last_name ?? ''}`.trim() || 'Unknown';
}

const STATUS_LABEL = {
  pending: 'Offered, waiting',
  confirmed: 'Accepted',
  declined: 'Declined',
  taught: 'Taught',
  missed: 'Missed',
  cancelled: 'Cancelled',
};

// The columns every read of this table in this file needs. One spelling: three
// near-identical select strings drifted apart once already, and a column
// missing from one of them does not error, it just makes that refresh disagree
// with the others about the same day.
const SUB_ROW_COLUMNS =
  'id, date, sub_instructor_id, sub_tier, status, decline_reason, email_sent_at, declined_at, cover_still_needed';

// What happened to one offer, in the operator's words. A row closed out because
// SOMEBODY ELSE accepted first is not a refusal — that person very likely said
// yes and simply lost the race — and calling it "Declined" on the screen where
// you choose who to ask next quietly penalises your quickest people.
function offerLabel(s) {
  if (s.status === 'declined' && s.decline_reason === 'covered_by_other') {
    return { text: 'Someone else covered it', tone: 'neutral' };
  }
  // A pending row whose offer email never left is NOT "Offered, waiting" -
  // nobody has heard from us at all. The sentence below the list already omits
  // these people, and two contradictory statements about the same person, six
  // lines apart, on the screen where an operator decides whether to ask anybody
  // else, is worse than either one alone.
  if (s.status === 'pending' && !s.email_sent_at) {
    return { text: 'Not sent - nobody was asked', tone: 'bad' };
  }
  if (s.status === 'cancelled') {
    return {
      text: s.cover_still_needed === false ? 'Cancelled, no sub needed' : 'Cover released',
      tone: 'neutral',
    };
  }
  const text = STATUS_LABEL[s.status] ?? s.status;
  if (s.status === 'declined') return { text, tone: 'bad' };
  if (s.status === 'confirmed' || s.status === 'taught') return { text, tone: 'good' };
  return { text, tone: 'neutral' };
}

// Why an instructor is already working that date (RPC working_reason).
// These now fire only on a real TIME OVERLAP, not on "has anything that day"
// (20260818b), so the wording says "at that time" -- saying "that day" would be
// stating something untrue about a 12:15 class against a 3:25 slot.
const WORKING_LABEL = {
  teaching: 'already teaching an after-school class at that time',
  camp: 'already at a camp at that time',
  subbing: 'already subbing at that time',
};

// Three display groups, best first:
//   SUGGEST - availability matches this day & time and they're free (the picks)
//   OTHER   - free, but not an exact match (no survey / wrong time / wrong day)
//   OUT     - marked this day off, or booked at a time that OVERLAPS this class
//             (not merely booked somewhere else that day -- see 20260818b)
const SUGGEST = 0, OTHER = 1, OUT = 2;
const GROUP_META = {
  [SUGGEST]: { label: 'Available — matches this day & time', color: '#3a7c3a' },
  [OTHER]:   { label: 'Other instructors',                        color: '#6b6b6b' },
  [OUT]:     { label: 'Marked off or already working',            color: '#b53737' },
};

// Map one instructor's availability signal to a group + a fine sort rank +
// the note to show under their name. av is undefined until the date loads.
function classify(av) {
  if (!av) return { group: OTHER, rank: 1, note: null };            // no signal yet
  if (av.is_working) {
    return { group: OUT, rank: 6, note: WORKING_LABEL[av.working_reason] ?? 'already working that day' };
  }
  if (av.is_date_off) {
    return { group: OUT, rank: 5, note: 'marked this day off' };
  }
  const base = (() => {
    switch (av.day_time_match) {
      case 'match': return { group: SUGGEST, rank: 0, note: null };
      case 'time':  return { group: OTHER, rank: 2, note: 'not available at this class time' };
      case 'day':   return { group: OTHER, rank: 3, note: 'usually off that day' };
      default:      return { group: OTHER, rank: 1, note: 'no availability on file' };   // 'none'
    }
  })();
  // tight_gap: they have another booking that day which does NOT overlap this
  // class, but leaves a tight turnaround to get between the two. They stay exactly
  // where they ranked -- pickable, and in SUGGEST if they matched -- because this
  // is a note about the drive, not a reason they can't do it. Only a real time
  // OVERLAP sets is_working and moves someone out (20260818b).
  //
  // No specific duration in this copy on purpose: the threshold lives in the RPC
  // (and the board's TRAVEL_GAP_WARN_MIN), and stating "an hour" here would be a
  // third copy to keep in sync. The RPC decides; this just surfaces its verdict.
  if (av.tight_gap) {
    const drive = 'tight turnaround from another class that day';
    return { ...base, note: base.note ? `${base.note} · ${drive}` : drive };
  }
  return base;
}

export default function AssignSubModal({
  parentAssignment,           // { id, instructor_id, role }
  parentType,                 // 'camp' | 'program'
  sessionInfo,                // { curriculum_name, location_name, starts_on, ends_on, week_num } for camp; or { curriculum, school_name, first_session_date } for program
  defaultDate,                // YYYY-MM-DD; pre-fills the date input when admin clicked a specific day-tile
  availableDates,             // optional string[] of valid class dates — renders a date picker (afterschool, which has no day-tiles)
  organizationId,
  instructors,                // full instructor list for the org
  onClose,
  onSubmitted,                // (substitutionId) => void — a send landed
  onChanged,                  // () => void — the day changed but the modal stays open (a release)
}) {
  const [date, setDate] = useState(defaultDate ?? '');
  // SEVERAL PEOPLE, NOT ONE. A class-day can hold an offer per person and the
  // first to accept takes it, so the picker is a set. Order is preserved only
  // for display; the database decides the winner, not the order we ask in.
  const [selectedIds, setSelectedIds] = useState([]);
  const toggleSelected = (id) => setSelectedIds((prev) => (
    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
  ));
  const [subTier, setSubTier] = useState(parentAssignment?.role ?? 'lead');
  const [notes, setNotes] = useState('');
  const [existingSubs, setExistingSubs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [okMsg, setOkMsg] = useState('');
  // Releasing a cover is a separate action from sending one, and it is armed
  // in two steps: it emails somebody that a day they agreed to teach is off.
  const [releasing, setReleasing] = useState(false);
  const [releaseArmed, setReleaseArmed] = useState(false);
  // Availability signals for the chosen date, keyed by instructor id. Only
  // flagged instructors appear here; anyone absent is free that day. Loaded
  // from the sub_availability_on_date RPC whenever the date changes.
  const [availability, setAvailability] = useState({});
  const [availLoading, setAvailLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);   // "show everyone" override

  const minDate = parentType === 'camp' ? sessionInfo?.starts_on : sessionInfo?.first_session_date;
  const maxDate = parentType === 'camp' ? sessionInfo?.ends_on   : null;

  // Eligible subs = everyone in the org except the parent's regular instructor.
  const eligible = useMemo(() => {
    return (instructors ?? [])
      .filter((i) => i.id !== parentAssignment?.instructor_id)
      .sort((a, b) => shortName(a).localeCompare(shortName(b)));
  }, [instructors, parentAssignment?.instructor_id]);

  // Rank by availability match: exact day+time matches first, then other free
  // instructors, then marked-off / already-working; alpha within each rank.
  // Availability is empty until a date is chosen, so this is a plain alpha list
  // up front (everyone lands in OTHER with no note).
  const ranked = useMemo(() => {
    return eligible
      .map((i) => {
        const av = availability[i.id];
        const c = classify(av);
        return { instr: i, av, ...c, outOfArea: !!av?.out_of_area };
      })
      .sort((a, b) => a.rank - b.rank || shortName(a.instr).localeCompare(shortName(b.instr)));
  }, [eligible, availability]);

  const grouped = useMemo(() => {
    const g = { [SUGGEST]: [], [OTHER]: [], [OUT]: [] };
    ranked.forEach((r) => g[r.group].push(r));
    return g;
  }, [ranked]);

  // Load existing subs for this parent assignment so we can show the day
  // list + flip the submit-button label to "Resend" when applicable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!parentAssignment?.id) { setLoading(false); return; }
      const { data, error } = await supabase
        .from('assignment_substitutions')
        .select(SUB_ROW_COLUMNS)
        .eq('parent_assignment_id', parentAssignment.id)
        .eq('parent_assignment_type', parentType)
        .order('date', { ascending: true });
      if (cancelled) return;
      if (error) { setErr(error.message); setLoading(false); return; }
      setExistingSubs(data ?? []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [parentAssignment?.id, parentType]);

  // Load availability signals for the chosen date. Ranks free instructors up
  // and flags conflicts; never hard-hides (sub pools are small). Re-runs on
  // every date change so a swap to a different day re-checks.
  useEffect(() => {
    let cancelled = false;
    if (!date || !organizationId || !parentAssignment?.id) {
      setAvailability({}); setShowAll(false); setAvailLoading(false); return;
    }
    (async () => {
      setAvailLoading(true);
      const { data, error } = await supabase.rpc('sub_availability_on_date', {
        p_org: organizationId,
        p_date: date,
        p_parent_type: parentType,
        p_parent_assignment_id: parentAssignment.id,
      });
      if (cancelled) return;
      if (error) {
        // Availability is an assist, not a gate: on failure fall back to the
        // flat list rather than blocking the assignment.
        setAvailability({});
        setAvailLoading(false);
        return;
      }
      const map = {};
      for (const row of data ?? []) {
        map[row.instructor_id] = {
          is_working: row.is_working,
          working_reason: row.working_reason,
          is_date_off: row.is_date_off,
          day_time_match: row.day_time_match,
          out_of_area: row.out_of_area,
          tight_gap: row.tight_gap,
        };
      }
      setAvailability(map);
      setShowAll(false);   // collapse non-matches again for the new date
      setAvailLoading(false);
    })();
    return () => { cancelled = true; };
  }, [date, organizationId, parentType, parentAssignment?.id]);

  // A class-day can hold an offer PER PERSON now, so "is there a row for this
  // date?" is no longer a question with one answer. Everything below asks about
  // the person actually selected.
  //
  // This used to take the first row for the date, which was safe only while the
  // database allowed one. It drove a "Swap to X" button that described the old
  // behaviour — the send REPLACED the row — and that is no longer what happens:
  // asking somebody else now ADDS an offer beside the first. An operator
  // pressing a button labelled Swap would have believed they moved the day,
  // while the person they were replacing still held a live offer and could
  // still accept it.
  const offersThisDate = existingSubs.filter((s) => s.date === date);
  // One PERSON can hold two rows for one day: a decline they gave earlier, and a
  // live offer from being asked again. The pending one is the one every label
  // here is about, so pick it explicitly rather than taking whichever the query
  // happened to return first — the same first-row mistake this block replaced,
  // one level down.
  //
  // A RESEND is a one-person idea. With several people ticked the click is a
  // round, not a repeat of one message, so it only applies when exactly one is
  // selected — otherwise the button would say "Resend to Ann" about a click
  // that also first-asks Bo and Cy.
  // How many of the SELECTED people already hold a live, emailed offer for this
  // day. A count, not a yes/no: "is this a resend?" only had an answer when
  // exactly one person was ticked, so ticking Ann (emailed yesterday) alongside
  // Bo and Cy read as a first ask and sent Ann a second identical email with
  // nothing on screen admitting it.
  const selectedResends = offersThisDate.filter(
    (s) => s.status === 'pending' && s.email_sent_at && selectedIds.includes(s.sub_instructor_id),
  );
  // Other people already holding a LIVE offer on this day. A settled day is not
  // counted here: the send refuses outright once somebody has accepted.
  //
  // email_sent_at is part of the test, not decoration. The row is written
  // BEFORE its email goes, so a failed send can leave one behind, and the
  // sentence this drives says the person "is already holding this day and
  // hasn't answered" — which is false for somebody who was never contacted. An
  // operator who reads that stops looking for anybody else, and the class goes
  // uncovered on the strength of an email that never left.
  const othersPending = offersThisDate.filter(
    (s) => s.status === 'pending' && s.email_sent_at && !selectedIds.includes(s.sub_instructor_id),
  );
  // The row that actually has the day, so it can be released. `taught` is
  // deliberately not releasable here — that class happened and its pay line is
  // real; unwinding it is a payroll correction, and the function refuses it.
  const coveringRow = offersThisDate.find((s) => s.status === 'confirmed') ?? null;
  const taughtRow = offersThisDate.find((s) => s.status === 'taught') ?? null;
  const dayIsCovered = !!coveringRow || !!taughtRow;

  // An armed release must not outlive the thing it was armed for. Changing the
  // date re-points coveringRow at a DIFFERENT day's sub, and a "Yes, release
  // it" button still sitting there would email somebody the operator never
  // looked at that a class they agreed to teach is off.
  //
  // Declared HERE, below coveringRow, not up with the other effects: the
  // dependency array is evaluated during render, so reading coveringRow before
  // its `const` would throw on every single render rather than fail loudly once.
  useEffect(() => { setReleaseArmed(false); }, [date, coveringRow?.id]);

  // A SELECTION IS ABOUT A DAY. Tick three people for Oct 12, change the date
  // to Oct 19, and those ticks would still be sitting there — so one click
  // would email three people about a day nobody chose them for, and the
  // availability ranking they were picked from was for the old date too. Same
  // shape as the armed release above: state that asserts something about a
  // specific day must not outlive that day.
  //
  // The messages go with it. "Offer sent to 3 people" is a statement about the
  // day it was sent for; leaving it sitting above an empty picker for a
  // different date tells the operator that date is handled.
  useEffect(() => { setSelectedIds([]); setOkMsg(''); setErr(''); }, [date]);

  // The words are in src/lib/subOfferButton.js so each branch can be asserted
  // against the state that selects it. Five of them, and "Resend" said to
  // somebody nobody has emailed is the same class of defect as a count that
  // indicts rows its condition does not prove.
  const submitLabel = offerButtonLabel({
    selectedIds,
    nameOf: (id) => shortName(eligible.find((i) => i.id === id)),
    resendCount: selectedResends.length,
    othersPending: othersPending.length,
    sending: busy,
    noDate: !date,
  });
  const tooMany = selectedIds.length > MAX_CANDIDATES;

  // Take the day back from whoever has it, or withdraw an offer nobody has
  // answered yet.
  //
  // This is the action the picker has been telling operators to perform since
  // multi-offer shipped ("cancel their cover first") while no surface in the
  // product could do it. Dropping the old one-row-per-day upsert removed the
  // only way to replace a confirmed sub, and nothing took its place: a sub who
  // accepted and then fell ill froze the class-day, with the board still
  // drawing a tick and the submit button greyed out.
  async function releaseCover(row, stillNeedsCover) {
    if (!row) return;
    setErr(''); setOkMsg(''); setReleasing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cancel-sub-cover`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ substitution_id: row.id, still_needs_cover: stillNeedsCover }),
        },
      );
      const data = await resp.json();
      if (!resp.ok) {
        setErr(data.detail || data.message || data.error || 'Could not release this cover.');
      } else {
        const who = shortName((instructors ?? []).find((i) => i.id === row.sub_instructor_id));
        // Say what actually happened, not what was attempted. The release
        // succeeds even when the email does not, and an operator told "Dana has
        // been told" who then closes the dialog is how Dana turns up to a class
        // that was given away.
        const told = data.notified_sub
          ? `${who} has been emailed.`
          : `We could NOT email ${who} — tell them yourself.`;
        if (!data.was_confirmed) {
          setOkMsg(`The offer to ${who} has been withdrawn. ${data.notified_sub ? 'They have been told.' : 'We could not email them, so let them know.'}`);
        } else if (stillNeedsCover) {
          setOkMsg(`${told} The day is open again — you can ask someone else now.`);
        } else {
          setOkMsg(`${told} The day is marked as not needing a sub, so it won't show as uncovered.`);
        }
      }
      // Refresh either way. On failure the list is what tells the operator what
      // the day ACTUALLY holds, which is exactly what a 409 is complaining about.
      const { data: refreshed, error: refreshErr } = await supabase
        .from('assignment_substitutions')
        .select(SUB_ROW_COLUMNS)
        .eq('parent_assignment_id', parentAssignment.id)
        .eq('parent_assignment_type', parentType)
        .order('date', { ascending: true });
      if (!refreshErr && refreshed) setExistingSubs(refreshed);
      // Tell the board, WITHOUT closing this modal: the next thing an operator
      // does after releasing a cover is ask somebody else, and the after-school
      // board's onSubmitted closes the dialog.
      onChanged?.();
      setReleaseArmed(false);
    } catch (e) {
      setErr(e.message || 'Could not release this cover.');
    } finally {
      setReleasing(false);
    }
  }

  async function submit() {
    setErr(''); setOkMsg(''); setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-assignment-substitution`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            parent_assignment_id: parentAssignment.id,
            parent_assignment_type: parentType,
            date,
            // The plural shape. The function still accepts a single
            // sub_instructor_id for compatibility, but sending one id when the
            // operator ticked three would quietly ask only the first.
            sub_instructor_ids: selectedIds,
            sub_tier: subTier,
            notes: notes.trim() || undefined,
          }),
        },
      );
      const data = await resp.json();
      if (!resp.ok) {
        // `message` sits between detail and error: `error` is a machine code
        // (e.g. 'no_tenant_inbox') and putting a code on screen tells the
        // operator nothing. Prefer any human sentence the function supplies.
        //
        // A send can stop PARTWAY — some people asked, then a failure. Saying
        // only "it failed" would invite pressing the button again, which emails
        // everybody who already got it a second time. The function reports who
        // it reached; show that, and refresh the list so those offers are
        // visible rather than hidden behind an error.
        const already = Array.isArray(data.asked) ? data.asked.length : 0;
        const base = data.detail || data.message || data.error || 'Could not send the offer.';
        setErr(already > 0
          ? `${base} ${already === 1 ? '1 person was' : `${already} people were`} already asked before this failed — don't send again without checking who.`
          : base);
        const { data: afterFail, error: afterFailErr } = await supabase
          .from('assignment_substitutions')
          .select(SUB_ROW_COLUMNS)
          .eq('parent_assignment_id', parentAssignment.id)
          .eq('parent_assignment_type', parentType)
          .order('date', { ascending: true });
        // Keep what we already had if the refresh itself fails — very likely,
        // since whatever broke the send may still be broken. Blanking the list
        // here would hide the offers this message just told them to check.
        if (!afterFailErr && afterFail) setExistingSubs(afterFail);
        setBusy(false);
        return;
      }
      // From what the function REPORTS it reached, not from what was ticked: a
      // round can stop partway, and the number the operator reads has to be the
      // number of people who really got an email.
      setOkMsg(offerSentMessage(data.asked));
      if (Array.isArray(data.terms_not_applied) && data.terms_not_applied.length > 0) {
        // "Settled", not "accepted". The function raises this whenever the row
        // was no longer pending — which is accepted, declined OR released — so
        // saying "accepted" would tell the operator the day is covered when the
        // person may have just turned it down, and they would stop looking.
        setErr(`${data.terms_not_applied.join(', ')} answered while this was sending, so the role you picked was not applied to their day — open the day again to see where it stands.`);
      }
      setSelectedIds([]);
      onSubmitted?.(data.substitution_id);
      // Re-load the existing list so the day appears with email_sent_at set.
      const { data: refreshed } = await supabase
        .from('assignment_substitutions')
        .select(SUB_ROW_COLUMNS)
        .eq('parent_assignment_id', parentAssignment.id)
        .eq('parent_assignment_type', parentType)
        .order('date', { ascending: true });
      setExistingSubs(refreshed ?? []);
      setBusy(false);
    } catch (e) {
      setErr(e.message || 'Could not send the offer.');
      setBusy(false);
    }
  }

  const sessionTitle = parentType === 'camp'
    ? `${sessionInfo?.curriculum_name ?? 'Camp'} · ${sessionInfo?.location_name ?? ''}${sessionInfo?.week_num ? ` · Week ${sessionInfo.week_num}` : ''}`
    : `${sessionInfo?.curriculum ?? 'Program'} · ${sessionInfo?.school_name ?? ''}`;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 12, width: '100%', maxWidth: 520, maxHeight: '90vh',
        overflow: 'auto', boxShadow: '0 18px 40px rgba(0,0,0,0.25)',
      }}>
        <div style={{ padding: '18px 20px 12px', borderBottom: `1px solid ${RULE}` }}>
          <div style={{ fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 }}>
            Assign a sub
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: INK }}>{sessionTitle}</div>
        </div>

        <div style={{ padding: '14px 20px' }}>
          {loading ? (
            <div style={{ fontSize: 14, color: MUTED, padding: '12px 0' }}>Loading existing subs…</div>
          ) : existingSubs.length > 0 && (
            <div style={{ marginBottom: 16, padding: 12, background: CREAM, border: `1px solid ${RULE}`, borderRadius: 6 }}>
              {/* "Already covered" was never quite true — a declined row has
                  always appeared in this list — and it is now plainly wrong,
                  because a day can show several people who were asked and have
                  not answered. It says what it is instead. */}
              <div style={{ fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
                Subs asked for this class
              </div>
              {existingSubs.map((s) => {
                const subInst = (instructors ?? []).find((i) => i.id === s.sub_instructor_id);
                return (
                  <div key={s.id} style={{ fontSize: 13, color: INK, padding: '4px 0', display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span>
                      <strong>{fmtDate(s.date)}</strong> — {shortName(subInst)} · {s.sub_tier} · <span style={{ color: offerLabel(s).tone === 'bad' ? CORAL : offerLabel(s).tone === 'good' ? OK_GREEN : MUTED }}>{offerLabel(s).text}</span>
                    </span>
                    {/* Taking back an offer nobody has answered. Without this
                        the only way to undo asking the wrong person was to wait
                        for them to answer, while they held a working Accept
                        button — and the endpoint's whole withdraw path sat
                        unreachable, which is the same defect this build set out
                        to fix, inverted. Not armed in two steps like a release:
                        nobody has agreed to anything yet. */}
                    {s.status === 'pending' && (
                      <button
                        type="button"
                        onClick={() => releaseCover(s, true)}
                        disabled={busy || releasing}
                        style={{
                          background: 'none', border: 'none', padding: 0,
                          color: MUTED, fontSize: 12, textDecoration: 'underline',
                          cursor: (busy || releasing) ? 'default' : 'pointer',
                        }}
                      >
                        {releasing ? 'Withdrawing…' : 'Withdraw'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <Field label="Date">
            {availableDates ? (
              availableDates.length > 0 ? (
                <select value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle}>
                  <option value="">— Pick a class date —</option>
                  {availableDates.map((d) => (
                    <option key={d} value={d}>{fmtDate(d)}</option>
                  ))}
                </select>
              ) : (
                <div style={{ ...inputStyle, background: CREAM, color: MUTED, display: "flex", alignItems: "center" }}>
                  No class dates found for this term.
                </div>
              )
            ) : (
              <div style={{ ...inputStyle, background: CREAM, color: INK, display: "flex", alignItems: "center" }}>
                {date ? fmtDate(date) : <span style={{ color: MUTED }}>Open the modal from a day tile to set the date.</span>}
              </div>
            )}
          </Field>

          <Field label={selectedIds.length > 1
            ? `Sub instructors — ${selectedIds.length} picked`
            : 'Sub instructors — pick one or several'}>
            {!date ? (
              <div style={{ fontSize: 12, color: MUTED }}>
                Pick a date above to see who's available that day.
              </div>
            ) : (
            <>
            {availLoading && (
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Checking availability…</div>
            )}
            <div style={{ border: `1px solid ${RULE}`, borderRadius: 6, overflow: 'hidden' }}>
              {ranked.length === 0 ? (
                <div style={{ padding: 12, fontSize: 13, color: MUTED }}>No other instructors in this org.</div>
              ) : (() => {
                const suggested = grouped[SUGGEST];
                const hidden = [...grouped[OTHER], ...grouped[OUT]];
                const selectedHidden = hidden.some((r) => selectedIds.includes(r.instr.id));
                const noMatches = !!date && !availLoading && suggested.length === 0;
                const expanded = showAll || selectedHidden || noMatches;
                const renderRow = (row) => (
                  <SubRow
                    key={row.instr.id}
                    row={row}
                    selected={selectedIds.includes(row.instr.id)}
                    onSelect={() => toggleSelected(row.instr.id)}
                  />
                );
                return (
                  <>
                    {date && suggested.length > 0 && (
                      <GroupHeader meta={GROUP_META[SUGGEST]} count={suggested.length} first />
                    )}
                    {suggested.map(renderRow)}

                    {noMatches && (
                      <div style={{ padding: '8px 10px', fontSize: 12, color: MUTED, background: CREAM, borderTop: `1px solid ${RULE}` }}>
                        No one matches this day &amp; time — showing everyone.
                      </div>
                    )}

                    {date && hidden.length > 0 && !expanded && (
                      <button type="button" onClick={() => setShowAll(true)} style={toggleRowStyle}>
                        Show everyone ({hidden.length})
                      </button>
                    )}

                    {expanded && [OTHER, OUT].map((group) => {
                      const rows = grouped[group];
                      if (rows.length === 0) return null;
                      return (
                        <div key={group}>
                          {date && <GroupHeader meta={GROUP_META[group]} count={rows.length} />}
                          {rows.map(renderRow)}
                        </div>
                      );
                    })}

                    {date && hidden.length > 0 && showAll && !selectedHidden && !noMatches && (
                      <button type="button" onClick={() => setShowAll(false)} style={toggleRowStyle}>
                        Show fewer
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
            </>
            )}
          </Field>

          <Field label="Role for this day">
            <select value={subTier} onChange={(e) => setSubTier(e.target.value)} style={inputStyle}>
              <option value="lead">Lead</option>
              <option value="developing">Developing</option>
            </select>
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              {selectedIds.length > 1
                ? 'This is the role for the DAY, so whoever accepts covers it at this rate. Defaults to the regular instructor\'s role.'
                : 'Defaults to the regular instructor\'s role. Adjust if the sub is filling a different slot.'}
            </div>
          </Field>

          <Field label="Notes (optional)">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="e.g. parking is tight today; check in at the front office first"
              style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
            />
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              Included in the offer email and visible on the day in their portal.
            </div>
          </Field>

          {err && (
            <div style={{ marginTop: 10, padding: 10, background: '#fdecec', border: `1px solid ${CORAL}`, borderRadius: 6, color: CORAL, fontSize: 13 }}>
              {err}
            </div>
          )}
          {okMsg && (
            <div style={{ marginTop: 10, padding: 10, background: '#ecf6ec', border: `1px solid ${OK_GREEN}`, borderRadius: 6, color: OK_GREEN, fontSize: 13 }}>
              {okMsg}
            </div>
          )}
          {/* Say what pressing the button will actually do. Asking somebody now
              ADDS an offer rather than replacing one, so an operator must be able
              to see who else is already holding this day before they decide —
              otherwise the only way to find out is when two people both say yes
              and one of them has to be told no. */}
          {/* Its OWN line, not the head of the chain below. As a branch of that
              ternary it hid the two things underneath it — the sentence saying
              somebody has already accepted the day, and the "Release this
              cover" button that is the only way to free it. An operator who
              ticked thirteen names on a covered day was told about the
              thirteen and lost the control that would have helped. A cap is
              also not mutually exclusive with a covered day: both can be true,
              so both are said. */}
          {tooMany && (
            <div style={{ marginTop: 10, fontSize: 12, color: CORAL }}>
              That's {selectedIds.length} people. Ask at most {MAX_CANDIDATES} at once — untick a few.
            </div>
          )}
          {taughtRow ? (
            <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
              {shortName((instructors ?? []).find((i) => i.id === taughtRow.sub_instructor_id))} already
              taught this day, so it can't be reassigned here. Change it in payroll if that's wrong.
            </div>
          ) : coveringRow ? (
            /* The sentence that used to sit here told the operator to "cancel
               their cover first" — an action that existed nowhere in the
               product. Now it IS the action. Armed in two steps because
               confirming it emails somebody that a day they agreed to teach is
               off, and that is not an undo. */
            <div style={{ marginTop: 10, fontSize: 12, color: CORAL }}>
              <div style={{ marginBottom: 6 }}>
                {shortName((instructors ?? []).find((i) => i.id === coveringRow.sub_instructor_id))} has
                accepted this day. Release it to ask somebody else.
              </div>
              {releaseArmed ? (
                /* The two outcomes are genuinely different days, and only the
                   operator knows which one this is. "Still need a sub" keeps
                   the day on the coverage alarm; "no sub needed" settles it.
                   Without the choice, releasing a cover because the regular is
                   teaching after all would pin the day as uncovered with no way
                   to clear it — and an alarm nobody can clear gets ignored. */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ color: INK }}>
                    They'll be emailed that they're no longer needed. What happens to the day?
                  </span>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => releaseCover(coveringRow, true)}
                      disabled={releasing}
                      style={{ ...btnSecondary, borderColor: CORAL, color: CORAL, opacity: releasing ? 0.5 : 1 }}
                    >
                      {releasing ? 'Releasing…' : 'Release — I still need a sub'}
                    </button>
                    <button
                      type="button"
                      onClick={() => releaseCover(coveringRow, false)}
                      disabled={releasing}
                      style={{ ...btnSecondary, opacity: releasing ? 0.5 : 1 }}
                    >
                      {releasing ? 'Releasing…' : 'Release — no sub needed now'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setReleaseArmed(false)}
                      disabled={releasing}
                      style={btnSecondary}
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setReleaseArmed(true)}
                  disabled={busy || releasing}
                  style={{ ...btnSecondary, borderColor: CORAL, color: CORAL }}
                >
                  Release this cover
                </button>
              )}
            </div>
          ) : othersPending.length > 0 && selectedIds.length > 0 ? (
            <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
              {othersPending.length === 1
                ? `${shortName((instructors ?? []).find((i) => i.id === othersPending[0].sub_instructor_id))} is already holding this day and hasn't answered. Whoever accepts first gets it.`
                : `${othersPending.length} people are already holding this day and haven't answered. Whoever accepts first gets it.`}
            </div>
          ) : null}
          {/* Said about the people who ARE ticked, and therefore about to be
              emailed again. The line above deliberately covers only people NOT
              selected, so it went silent at the exact moment the operator
              ticked the person it was warning about — and the click that
              followed sent a second identical offer to somebody the screen had
              just stopped mentioning. */}
          {selectedResends.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: '#9a6a00' }}>
              {selectedResends.length === 1
                ? `${shortName((instructors ?? []).find((i) => i.id === selectedResends[0].sub_instructor_id))} has already been emailed about this day. Sending again gives them a second copy.`
                : `${selectedResends.length} of the people you've ticked have already been emailed about this day. Sending again gives them a second copy.`}
            </div>
          )}
        </div>

        <div style={{ padding: '12px 20px', borderTop: `1px solid ${RULE}`, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} disabled={busy} style={btnSecondary}>Close</button>
          <button
            type="button"
            onClick={submit}
            // dayIsCovered is in here as well as in the message above: the server
            // refuses a covered day with a 409, and a button that invites a click
            // it will refuse is a button that teaches operators to ignore the
            // sentence next to it.
            disabled={busy || !date || selectedIds.length === 0 || tooMany || dayIsCovered}
            style={{ ...btnPrimary, opacity: (busy || !date || selectedIds.length === 0 || tooMany || dayIsCovered) ? 0.5 : 1 }}
          >
            {/* No ternary here. This used to read `busy ? 'Sending…' :
                submitLabel`, which shadowed the module's own sending branch —
                so the module that claims to own this copy had a state that
                could never render, and a test asserting it proved nothing
                about the screen. The label decides; the button prints it. */}
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 4, fontWeight: 600 }}>{label}</div>
      {children}
    </div>
  );
}

function GroupHeader({ meta, count, first }) {
  return (
    <div style={{
      padding: '6px 10px', background: CREAM,
      borderTop: first ? 'none' : `1px solid ${RULE}`,
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4,
      color: meta.color,
    }}>
      {meta.label} ({count})
    </div>
  );
}

// One clickable candidate row: radio dot + name + the availability note.
function SubRow({ row, selected, onSelect }) {
  const { instr, note, outOfArea, group } = row;
  const noteColor = group === OUT ? CORAL : MUTED;
  // Somebody with no email cannot be asked, and the function validates the
  // whole batch BEFORE contacting anyone — so one unpickable person in a tick
  // of five sends ZERO emails and returns a 400 that, past one missing address,
  // does not even name who. Fail-safe, but the operator finds out after
  // pressing send. Stopping the tick is the same answer given earlier.
  const pickable = !!instr.email;
  const choose = () => { if (pickable) onSelect(); };
  return (
    /* A CHECKBOX, not a radio. Several people can be asked about one class-day
       and the first to accept takes it, so picking Bo must not silently unpick
       Ann — which is exactly what a radio would do, with no way for the
       operator to tell that it had. The square shape is the affordance that
       says "you may choose more than one" before anybody clicks. */
    <div
      role="checkbox"
      aria-checked={selected}
      aria-disabled={!pickable}
      // Focusable and Space/Enter operable. A role="checkbox" that answers only
      // to a mouse is a checkbox in name: an admin working this board by
      // keyboard could reach the date, the role select and the send button, and
      // could not tick a single instructor between them.
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); choose(); }
      }}
      onClick={choose}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
        cursor: pickable ? 'pointer' : 'not-allowed',
        opacity: pickable ? 1 : 0.55,
        borderTop: `1px solid ${RULE}`,
        background: selected ? '#f2f0ff' : '#fff',
      }}
    >
      <span style={{
        width: 14, height: 14, borderRadius: 3, flexShrink: 0,
        border: `2px solid ${selected ? BRIGHT : RULE}`,
        background: selected ? BRIGHT : '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: 1,
      }}>
        {selected ? '✓' : ''}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, color: INK, fontWeight: selected ? 700 : 500 }}>
          {shortName(instr)}
        </div>
        {note ? (
          <div style={{ fontSize: 11, color: noteColor }}>
            {note}{outOfArea ? ' · outside their districts' : ''}
          </div>
        ) : outOfArea ? (
          <div style={{ fontSize: 11, color: '#9a6a00' }}>outside their districts</div>
        ) : instr.email ? (
          <div style={{ fontSize: 11, color: MUTED }}>{instr.email}</div>
        ) : null}
        {/* Said on the row itself, whatever other note it carries. Without an
            address this person cannot be asked at all, and the function
            validates the whole batch before contacting anybody — so ticking
            them silently costs everybody else on the round their email too. */}
        {!pickable && (
          <div style={{ fontSize: 11, color: CORAL }}>no email on file — can't be asked</div>
        )}
      </div>
    </div>
  );
}

const toggleRowStyle = {
  width: '100%',
  textAlign: 'left',
  padding: '8px 10px',
  background: '#fff',
  border: 'none',
  borderTop: `1px solid ${RULE}`,
  color: BRIGHT,
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
};

const inputStyle = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 14,
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  background: '#fff',
  color: INK,
  boxSizing: 'border-box',
};

const btnPrimary = {
  background: BRIGHT,
  color: '#fff',
  border: `1px solid ${BRIGHT}`,
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 6,
  cursor: 'pointer',
};

const btnSecondary = {
  background: 'transparent',
  color: MUTED,
  border: `1px solid ${RULE}`,
  padding: '8px 14px',
  fontSize: 13,
  borderRadius: 6,
  cursor: 'pointer',
};
