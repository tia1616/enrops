// Instructors tab for /admin/contacts. Lists everyone in the admin's org
// with the full picture: display name (preferred_name fallback to legal
// first_name), legal name, email, phone, contractor tier, onboarding
// status, date of birth (with age + minor flag), shirt size, site
// preferences, availability, CPR cert (expiry + link), emergency contacts.
//
// Each row is collapsed to a one-liner; click to expand and see everything.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';

const PLUM = '#691D39';
const GOLD = '#CFB12F';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const OK = '#3a7c3a';
const RED = '#b53737';
const AMBER = '#b67e00';

const STATUS_COLOR = {
  complete: OK,
  in_progress: PLUM,
  pending_background_check: AMBER,
  pending_stripe: AMBER,
  payouts_disabled: RED,
  declined: RED,
  abandoned: MUTED,
  invited: MUTED,
  not_invited: MUTED,
};

const DAY_INITIALS = [
  ['monday', 'M'],
  ['tuesday', 'T'],
  ['wednesday', 'W'],
  ['thursday', 'Th'],
  ['friday', 'F'],
  ['saturday', 'Sa'],
  ['sunday', 'Su'],
];

function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age;
}

function fmtDate(d) {
  if (!d) return null;
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function InstructorsTab({ org }) {
  const [rows, setRows] = useState(null); // null = loading
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { data: instructors, error: instErr } = await supabase
          .from('instructors')
          .select(
            `id, first_name, last_name, preferred_name, email, phone, is_active,
             contractor_tier, date_of_birth, shirt_size, photo_url,
             site_preferences, availability,
             first_aid_cpr_url, first_aid_cpr_expires_at`
          )
          .eq('organization_id', org.id)
          .order('last_name', { ascending: true, nullsFirst: false });
        if (instErr) throw instErr;
        if (cancelled) return;

        const ids = (instructors ?? []).map((i) => i.id);
        let statusMap = {};
        let contactsByInstructor = {};

        if (ids.length > 0) {
          const [{ data: statusRows }, { data: contactRows }] = await Promise.all([
            supabase
              .from('contractor_onboarding_status')
              .select(
                'instructor_id, overall_status, current_step, checkr_status, stripe_payouts_enabled, background_check_source'
              )
              .in('instructor_id', ids),
            supabase
              .from('contractor_emergency_contacts')
              .select('instructor_id, contact_name, relationship, phone, is_primary')
              .in('instructor_id', ids)
              .order('is_primary', { ascending: false }),
          ]);
          for (const r of statusRows ?? []) statusMap[r.instructor_id] = r;
          for (const c of contactRows ?? []) {
            (contactsByInstructor[c.instructor_id] ??= []).push(c);
          }
        }

        if (!cancelled) {
          setRows(
            (instructors ?? []).map((i) => ({
              ...i,
              status: statusMap[i.id] ?? null,
              emergency_contacts: contactsByInstructor[i.id] ?? [],
            }))
          );
        }
      } catch (err) {
        console.error('[admin/contacts/instructors] load failed', err);
        if (!cancelled) setError(err.message ?? 'Failed to load instructors.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org?.id]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showInactive && !r.is_active) return false;
      if (!q) return true;
      const blob = [
        r.first_name,
        r.last_name,
        r.preferred_name,
        r.email,
        r.phone,
        r.contractor_tier,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return blob.includes(q);
    });
  }, [rows, search, showInactive]);

  function toggleExpand(id) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (error) {
    return (
      <div style={{ background: `${RED}1A`, color: RED, padding: 12, borderRadius: 6, fontSize: 13 }}>
        {error}
      </div>
    );
  }
  if (rows === null) {
    return <div style={{ color: MUTED, fontSize: 13 }}>Loading instructors…</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, email, phone"
          style={{
            flex: '1 1 220px',
            padding: '8px 12px',
            border: `1px solid ${RULE}`,
            borderRadius: 6,
            fontSize: 13,
            fontFamily: 'inherit',
            background: '#fff',
            color: INK,
          }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: MUTED, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
        <Link
          to="/admin/contractors/background-check-upload"
          style={{
            padding: '7px 12px',
            background: '#fff',
            color: PLUM,
            border: `1px solid ${PLUM}`,
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            textDecoration: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Upload prior BG check →
        </Link>
      </div>

      <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
        {filtered.length} instructor{filtered.length === 1 ? '' : 's'}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.length === 0 && (
          <div style={{ color: MUTED, fontSize: 13, padding: 14, background: '#fff', border: `1px solid ${RULE}`, borderRadius: 8 }}>
            No instructors match that search.
          </div>
        )}
        {filtered.map((r) => (
          <InstructorRow
            key={r.id}
            row={r}
            expanded={expanded.has(r.id)}
            onToggle={() => toggleExpand(r.id)}
          />
        ))}
      </div>
    </div>
  );
}

function InstructorRow({ row, expanded, onToggle }) {
  const displayName =
    row.preferred_name?.trim() ||
    `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() ||
    row.email;
  const legalName = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
  const hasPreferred = Boolean(row.preferred_name?.trim());
  const status = row.status?.overall_status ?? 'not_invited';
  const statusColor = STATUS_COLOR[status] ?? MUTED;
  const age = ageFromDob(row.date_of_birth);
  const isMinor = age !== null && age < 18;

  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${RULE}`,
        borderLeft: `3px solid ${statusColor}`,
        borderRadius: 8,
        padding: '10px 14px',
        opacity: row.is_active ? 1 : 0.55,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex',
          width: '100%',
          gap: 12,
          alignItems: 'center',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        <PhotoThumb url={row.photo_url} name={displayName} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: INK, lineHeight: 1.3 }}>
            {displayName}
            {hasPreferred && legalName && (
              <span style={{ color: MUTED, marginLeft: 6, fontSize: 12, fontWeight: 400 }}>
                ({legalName})
              </span>
            )}
            {isMinor && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 10,
                  fontWeight: 700,
                  color: '#fff',
                  background: GOLD,
                  padding: '1px 6px',
                  borderRadius: 4,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                Minor
              </span>
            )}
          </div>
          <div style={{ color: MUTED, fontSize: 12, marginTop: 2 }}>
            {row.email}
            {row.phone && <> · {row.phone}</>}
            {row.contractor_tier && <> · {row.contractor_tier}</>}
            {!row.is_active && <> · inactive</>}
          </div>
        </div>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: statusColor,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            whiteSpace: 'nowrap',
          }}
        >
          {status.replace(/_/g, ' ')}
        </span>
        <span style={{ color: MUTED, fontSize: 12 }}>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && <InstructorDetail row={row} age={age} />}
    </div>
  );
}

function InstructorDetail({ row, age }) {
  const sitePrefs = row.site_preferences?.districts ?? [];
  const dayDefaults = row.availability?.day_defaults ?? {};
  const activeDays = DAY_INITIALS.filter(([k]) => dayDefaults[k]).map(([, label]) => label);
  const cprExpired =
    row.first_aid_cpr_expires_at &&
    new Date(`${row.first_aid_cpr_expires_at}T00:00:00`) < new Date(new Date().toDateString());
  const checkr = row.status?.checkr_status;
  const bgSource = row.status?.background_check_source;

  return (
    <div
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTop: `1px solid ${RULE}`,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 14,
        fontSize: 13,
      }}
    >
      <DetailItem label="Date of birth">
        {row.date_of_birth ? (
          <>
            {fmtDate(row.date_of_birth)}
            {age !== null && (
              <span style={{ color: MUTED, marginLeft: 6 }}>(age {age})</span>
            )}
          </>
        ) : (
          <Em>not set</Em>
        )}
      </DetailItem>
      <DetailItem label="Shirt size">
        {row.shirt_size ?? <Em>not set</Em>}
      </DetailItem>
      <DetailItem label="Background check">
        {checkr ? (
          <>
            {checkr}
            {bgSource === 'admin_uploaded' && (
              <span style={{ color: MUTED, marginLeft: 6 }}>(admin uploaded)</span>
            )}
          </>
        ) : (
          <Em>not started</Em>
        )}
      </DetailItem>
      <DetailItem label="Stripe payouts">
        {row.status?.stripe_payouts_enabled ? 'enabled' : <Em>not enabled</Em>}
      </DetailItem>
      <DetailItem label="Districts">
        {sitePrefs.length > 0 ? sitePrefs.join(', ') : <Em>none selected</Em>}
      </DetailItem>
      <DetailItem label="Days available">
        {activeDays.length > 0 ? activeDays.join(', ') : <Em>none selected</Em>}
      </DetailItem>
      <DetailItem label="First Aid / CPR">
        {row.first_aid_cpr_url ? (
          <>
            on file
            {row.first_aid_cpr_expires_at && (
              <span style={{ color: cprExpired ? RED : MUTED, marginLeft: 6 }}>
                · expires {fmtDate(row.first_aid_cpr_expires_at)}
                {cprExpired && ' (expired)'}
              </span>
            )}
          </>
        ) : (
          <Em>not uploaded</Em>
        )}
      </DetailItem>
      <DetailItem label="Onboarding step">
        {row.status?.current_step ? `Step ${row.status.current_step} of 8` : <Em>not started</Em>}
      </DetailItem>

      {row.emergency_contacts.length > 0 && (
        <div style={{ gridColumn: '1 / -1', borderTop: `1px solid ${RULE}`, paddingTop: 10 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: MUTED,
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              marginBottom: 6,
            }}
          >
            Emergency contacts
          </div>
          {row.emergency_contacts.map((c, i) => (
            <div key={i} style={{ fontSize: 13, color: INK, marginBottom: 4 }}>
              {c.is_primary && (
                <span
                  style={{
                    fontSize: 9,
                    color: PLUM,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    marginRight: 6,
                  }}
                >
                  Primary
                </span>
              )}
              <strong>{c.contact_name}</strong> ({c.relationship}) · {c.phone}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PhotoThumb({ url, name }) {
  const [signedUrl, setSignedUrl] = useState(null);
  const initials = (name ?? '?')
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  useEffect(() => {
    let cancelled = false;
    if (!url) {
      setSignedUrl(null);
      return;
    }
    supabase.storage
      .from('contractor-documents')
      .createSignedUrl(url, 60 * 60)
      .then(({ data }) => {
        if (!cancelled) setSignedUrl(data?.signedUrl ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (signedUrl) {
    return (
      <img
        src={signedUrl}
        alt=""
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          objectFit: 'cover',
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: '50%',
        background: '#EAEADD',
        color: PLUM,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 13,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}

function DetailItem({ label, children }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: MUTED,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div style={{ color: INK }}>{children}</div>
    </div>
  );
}

function Em({ children }) {
  return <span style={{ color: MUTED, fontStyle: 'italic' }}>{children}</span>;
}
