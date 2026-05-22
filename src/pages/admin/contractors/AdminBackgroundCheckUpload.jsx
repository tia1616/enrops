// Admin UI to mark an existing instructor as background-check-cleared using
// a prior-year report PDF, bypassing Checkr. Feature A of the 2026-05-22
// chunk 3 scope additions.
//
// Flow:
//  1. Pick an instructor from the admin's org.
//  2. Upload a PDF to contractor-documents/{instructor_id}/bg_check_uploaded_
//     {ts}.pdf (admin's JWT — bucket RLS must allow org admins to write into
//     any instructor's path; if it doesn't, the upload will fail and we'll
//     need a separate signed-upload-url path).
//  3. Pick the date of the original check.
//  4. POST to admin-upload-background-check; the edge function sets
//     checkr_status='clear', updates the bg-check audit columns, marks
//     steps_completed.checkr_submitted, and runs the gate check.
//
// Uses inline styles to match existing admin pages (AdminOverview pattern).

import { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';

const PLUM = '#691D39';
const GOLD = '#CFB12F';
const CHALK = '#EAEADD';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';
const OK = '#3a7c3a';
const RED = '#b53737';

export default function AdminBackgroundCheckUpload() {
  const { org } = useOutletContext() ?? {};
  const orgId = org?.id;

  const [instructors, setInstructors] = useState([]);
  const [loadingInstructors, setLoadingInstructors] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [statusByInstructor, setStatusByInstructor] = useState({}); // { id: status row }
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [completedOn, setCompletedOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { type: 'ok' | 'err', message }

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      setLoadingInstructors(true);
      const { data: rows } = await supabase
        .from('instructors')
        .select('id, first_name, last_name, email, is_active')
        .eq('organization_id', orgId)
        .eq('is_active', true)
        .order('last_name', { ascending: true });
      if (cancelled) return;
      setInstructors(rows ?? []);
      setLoadingInstructors(false);

      // Pre-load onboarding status so we can show "already cleared" badges.
      const ids = (rows ?? []).map((r) => r.id);
      if (ids.length > 0) {
        const { data: statusRows } = await supabase
          .from('contractor_onboarding_status')
          .select('instructor_id, checkr_status, overall_status, background_check_source')
          .in('instructor_id', ids);
        if (!cancelled) {
          const map = {};
          for (const r of statusRows ?? []) map[r.instructor_id] = r;
          setStatusByInstructor(map);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return instructors;
    return instructors.filter((i) => {
      const name = `${i.first_name ?? ''} ${i.last_name ?? ''} ${i.email ?? ''}`.toLowerCase();
      return name.includes(q);
    });
  }, [instructors, search]);

  const selected = instructors.find((i) => i.id === selectedId);
  const selectedStatus = selected ? statusByInstructor[selected.id] : null;
  const alreadyCleared = selectedStatus?.checkr_status === 'clear';

  function onFileChange(e) {
    const f = e.target.files?.[0];
    setFileError('');
    if (!f) {
      setFile(null);
      return;
    }
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      setFileError('File must be a PDF.');
      setFile(null);
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      setFileError('PDF must be 10MB or smaller.');
      setFile(null);
      return;
    }
    setFile(f);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    if (!selected || !file || !completedOn) return;

    setBusy(true);
    setResult(null);
    try {
      // 1. Upload PDF to storage. Path:
      //    contractor-documents/{instructor_id}/bg_check_uploaded_{ts}.pdf
      const path = `${selected.id}/bg_check_uploaded_${Date.now()}.pdf`;
      const { error: upErr } = await supabase.storage
        .from('contractor-documents')
        .upload(path, file, { contentType: 'application/pdf', upsert: false });
      if (upErr) {
        setResult({
          type: 'err',
          message: `Upload failed: ${upErr.message}. Check that the storage bucket allows admin writes.`,
        });
        setBusy(false);
        return;
      }

      // 2. Call the edge function.
      const { data, error: fnErr } = await supabase.functions.invoke(
        'admin-upload-background-check',
        {
          body: {
            instructor_id: selected.id,
            file_url: path,
            completed_on: completedOn,
          },
        }
      );
      if (fnErr) {
        setResult({
          type: 'err',
          message: fnErr.message ?? "Couldn't save the background check.",
        });
        setBusy(false);
        return;
      }
      if (data?.error) {
        setResult({ type: 'err', message: data.error });
        setBusy(false);
        return;
      }

      // 3. Refresh local status + clear the form.
      const { data: fresh } = await supabase
        .from('contractor_onboarding_status')
        .select('instructor_id, checkr_status, overall_status, background_check_source')
        .eq('instructor_id', selected.id)
        .single();
      if (fresh) {
        setStatusByInstructor((s) => ({ ...s, [fresh.instructor_id]: fresh }));
      }

      setResult({
        type: 'ok',
        message: `Cleared ${selected.first_name} ${selected.last_name}. Onboarding status: ${data?.gate?.overall_status ?? 'updated'}.`,
      });
      setFile(null);
      setCompletedOn('');
      setBusy(false);
    } catch (err) {
      console.error('[admin-bg-upload] failed', err);
      setResult({ type: 'err', message: 'Something went wrong. Please try again.' });
      setBusy(false);
    }
  }

  return (
    <div>
      <header style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.3 }}>
          Background check — admin upload
        </h1>
        <p style={{ color: MUTED, marginTop: 6, fontSize: 14, lineHeight: 1.5 }}>
          Mark an instructor as background-check-cleared using a prior-year report PDF.
          Bypasses Checkr — use this for contractors who already have a valid check on file.
        </p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) 1fr', gap: 20, alignItems: 'start' }}>
        {/* Instructor picker */}
        <div style={card()}>
          <SectionLabel>Pick an instructor</SectionLabel>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email"
            style={input()}
          />
          <div
            style={{
              marginTop: 10,
              maxHeight: 360,
              overflowY: 'auto',
              border: `1px solid ${RULE}`,
              borderRadius: 6,
            }}
          >
            {loadingInstructors && (
              <div style={{ padding: 12, color: MUTED, fontSize: 13 }}>Loading…</div>
            )}
            {!loadingInstructors && filtered.length === 0 && (
              <div style={{ padding: 12, color: MUTED, fontSize: 13 }}>No instructors found.</div>
            )}
            {filtered.map((i) => {
              const st = statusByInstructor[i.id];
              const isSel = i.id === selectedId;
              return (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => setSelectedId(i.id)}
                  style={{
                    display: 'flex',
                    width: '100%',
                    textAlign: 'left',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 12px',
                    background: isSel ? `${PLUM}14` : 'transparent',
                    border: 'none',
                    borderBottom: `1px solid ${RULE}`,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <span style={{ fontSize: 13, color: INK }}>
                    {(i.first_name ?? '')} {(i.last_name ?? '')}
                    <span style={{ color: MUTED, marginLeft: 6, fontSize: 12 }}>{i.email}</span>
                  </span>
                  {st?.checkr_status === 'clear' && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: OK, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      Cleared
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Upload form */}
        <div style={card()}>
          <SectionLabel>Upload prior background check</SectionLabel>
          {!selected ? (
            <p style={{ color: MUTED, fontSize: 13 }}>Pick an instructor on the left to get started.</p>
          ) : (
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 14, padding: 10, background: CHALK, borderRadius: 6, fontSize: 13 }}>
                <div style={{ color: INK, fontWeight: 600 }}>
                  {selected.first_name} {selected.last_name}
                </div>
                <div style={{ color: MUTED, marginTop: 2 }}>{selected.email}</div>
                {alreadyCleared && (
                  <div style={{ marginTop: 6, color: OK, fontSize: 12 }}>
                    Already cleared (source: {selectedStatus?.background_check_source ?? 'unknown'}). Uploading again will overwrite.
                  </div>
                )}
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={fieldLabel()}>Report PDF</label>
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={onFileChange}
                  style={{ marginTop: 6, fontSize: 13 }}
                />
                {file && (
                  <div style={{ color: MUTED, fontSize: 12, marginTop: 4 }}>
                    {file.name} · {(file.size / 1024).toFixed(0)} KB
                  </div>
                )}
                {fileError && <FieldError>{fileError}</FieldError>}
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={fieldLabel()}>Date of original check</label>
                <input
                  type="date"
                  value={completedOn}
                  onChange={(e) => setCompletedOn(e.target.value)}
                  style={{ ...input(), width: 180, marginTop: 6 }}
                />
              </div>

              {result && (
                <div
                  style={{
                    marginBottom: 14,
                    padding: 10,
                    background: result.type === 'ok' ? `${OK}1A` : `${RED}1A`,
                    color: result.type === 'ok' ? OK : RED,
                    borderRadius: 6,
                    fontSize: 13,
                  }}
                >
                  {result.message}
                </div>
              )}

              <button
                type="submit"
                disabled={busy || !file || !completedOn}
                style={{
                  padding: '9px 16px',
                  background: PLUM,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  cursor: busy ? 'wait' : 'pointer',
                  opacity: busy || !file || !completedOn ? 0.5 : 1,
                }}
              >
                {busy ? 'Saving…' : 'Mark as cleared'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: MUTED,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function FieldError({ children }) {
  return <div style={{ color: RED, fontSize: 12, marginTop: 4 }}>{children}</div>;
}

function card() {
  return {
    background: '#fff',
    border: `1px solid ${RULE}`,
    borderRadius: 8,
    padding: 18,
  };
}

function input() {
  return {
    width: '100%',
    padding: '8px 12px',
    border: `1px solid ${RULE}`,
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'inherit',
    color: INK,
    background: '#fff',
    boxSizing: 'border-box',
  };
}

function fieldLabel() {
  return {
    fontSize: 11,
    fontWeight: 700,
    color: MUTED,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  };
}
