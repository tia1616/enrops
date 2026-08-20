// familyRecipients — turn a program's registrations into ONE entry per parent
// that names EVERY child that parent has in the class.
//
// WHY THIS EXISTS. On 2026-08-14 a curriculum change went out for the Catlin
// Gabel Wednesday class. Yu Zhou has two children in it, Ryan and Evan. She got
// one email, about Ryan. Evan was never mentioned, and nothing anywhere recorded
// that he had been left out — the audit row said one recipient, one send, zero
// failures, which was true and completely misleading.
//
// The cause was a dedupe that stopped at the first row per parent:
//
//     if (seen.has(p.id)) continue;
//     ... student_first_name: r.student?.first_name
//
// One email per family is RIGHT — two notes about one class change would read as
// two changes. The defect is that the email is per-CHILD (it says "{student_
// first_name}'s Wednesday class") while the recipient list is per-PARENT, so the
// first child read won and the rest became invisible. Collapsing rows is fine;
// throwing away what they said is not.
//
// THIS SIDE IS THE PREVIEW, and it had its own byte-for-byte copy of the bug —
// so the admin read a preview naming one child and then sent an email naming one
// child, and the two agreeing made the defect look like correct behaviour.
//
// TWIN. This logic exists twice — here for the modal's preview, and in
// supabase/functions/_shared/familyRecipients.ts for the edge function that
// actually sends. Vite and Deno cannot import across each other's bundle roots
// (see docs/parent-facing-surface-checklist.md §4), so the house answer is a twin
// plus a parity test: _shared/tests/familyRecipientsTwinParity.test.ts fails when
// they drift. If you change one, change the other.

// program_note_recipients returns FLAT rows; groupFamilyRecipients takes the
// nested registration shape both callers used to select directly. Mapping lives
// here, beside the grouping, so the preview and the send cannot map it two ways.
export function rowsToRegistrationShape(rows) {
  return ((rows ?? [])).map((r) => ({
    parent: {
      id: r?.parent_id,
      first_name: r?.parent_first_name,
      last_name: r?.parent_last_name,
      email: r?.parent_email,
    },
    student: { id: r?.student_id, first_name: r?.student_first_name },
  }));
}

export function joinChildNames(names) {
  const list = (names ?? []).filter((n) => typeof n === 'string' && n.trim());
  if (list.length === 0) return 'your child';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

export function groupFamilyRecipients(regs) {
  const byParent = new Map();
  for (const r of (regs ?? [])) {
    const p = r?.parent;
    const s = r?.student;
    if (!p?.id || !p.email) continue;
    let entry = byParent.get(p.id);
    if (!entry) {
      entry = {
        parent_id: p.id,
        parent_first_name: String(p.first_name ?? '').trim() || 'there',
        name: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || '(no name)',
        email: String(p.email).trim().toLowerCase(),
        children: [],
        seen: new Set(),
      };
      byParent.set(p.id, entry);
    }
    // Keyed on the STUDENT ID, not the name. Two siblings can share a first name
    // and a family can hold two registrations for one child; deduping by name
    // would silently drop a real second child, which is the exact failure this
    // module was written to end.
    const sid = s?.id ? String(s.id) : '';
    if (sid && entry.seen.has(sid)) continue;
    if (sid) entry.seen.add(sid);
    const child = String(s?.first_name ?? '').trim();
    if (child) entry.children.push(child);
  }
  // SORTED, because neither caller's query has an ORDER BY. Postgres may return
  // a parent's two registrations in either order, so without this the same family
  // could be greeted "Ryan and Evan" in one send and "Evan and Ryan" in the next,
  // and the behaviour test below would have been passing on the order its own
  // fixture happened to be written in. Sorting HERE rather than adding ORDER BY to
  // two queries means a third caller cannot forget it. Plain .sort() and not
  // localeCompare: this runs in Deno and in a browser, and the twins must agree.
  // FAMILIES SORTED TOO, for the same reason the children are: the source query
  // has no ORDER BY. The operator's preview renders "previewing as <first family>",
  // so an unordered list meant reopening the same modal could preview as a
  // different family each time, and the audit row's recipient order wandered with
  // it. By email because it is the one field every recipient has and it is unique.
  return Array.from(byParent.values()).sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0)).map((e) => ({
    parent_id: e.parent_id,
    parent_first_name: e.parent_first_name,
    name: e.name,
    email: e.email,
    children: [...e.children].sort(),
    student_first_name: joinChildNames([...e.children].sort()),
  }));
}
