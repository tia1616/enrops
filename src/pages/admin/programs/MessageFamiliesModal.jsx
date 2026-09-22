// Message the families of ONE class.
//
// The gap Jessica named: "there is no way to email just the families in one
// class - and it cost a real send today" (27 Aug, when the Art Rutkin FA26 class
// moved a week and nine confirmed families needed one sentence).
//
// PREVIEW FIRST, ALWAYS. The recipient list is fetched before a word is typed
// and re-fetched whenever the audience changes, because the standing rule is to
// count and inspect recipients before any send. Sawyer does the same thing -
// pick Booked and/or Waitlisted, then read the list - and it is the only way an
// operator can catch "14 when the class has 12" before families do.
//
// NO DEFAULT COPY. Subject and body start EMPTY with examples in the
// placeholders, deliberately: family-facing wording is Jessica's to approve, and
// a pre-filled sentence is one an operator can send without ever reading it.
// Sawyer auto-composes "A message from X about Y"; that can be added here once
// the wording is approved rather than invented in a modal.
//
// The families it CANNOT reach are shown, not hidden. A class whose roster came
// from a school that runs its own registration has placeholder addresses, and on
// prod one class has 13 of them - "13 recipients" with zero deliverable is the
// exact silent failure this panel exists to make visible.
//
// ── 2026-09-21: formatting, a test, a copy, and a record ────────────────────
//
// Jeff: "Since there's no way to test or add a CC to Message families, I've just
// been hitting send and giving a slight prayer... all the copied bold text shows
// up regular with **before and after**."
//
// He was right three times over, and the numbers are from prod, not from the
// report: of his 33 sends in eight days, 17 carried `**bold**` and 15 carried
// `[words](url)`, so 230 of 405 emails went out with the markers visible - one
// of them giving 29 families the portal sign-in link as `[enrops.com/...](...)`.
//
// The cause was not that we failed to understand his notation. `bodyEditorUtils`
// has understood exactly `**bold**`, `_italic_` and `[words](url)` since June,
// and every other body editor in the product is built on it. THIS was the one
// send surface that never got wired to it - a raw textarea whose contents went
// straight into a plain-text email. So the fix is adoption, not invention:
// the shared RichBodyEditor, and an HTML half on the send.
//
// The other two are the same complaint in different clothes - he could not see
// what he was about to send, and could not see what he had sent. Hence "Send a
// test to", "email me a copy", and the Sent tab, which reads the audit rows this
// panel has been writing since day one and that nothing on this screen showed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import RichBodyEditor from "../../../components/RichBodyEditor.jsx";
import { sanitizeRichHtml, stripHtml } from "../marketing-v2/bodyEditorUtils.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const RED = "#b53737";
const AMBER = "#a16207";
const OK_GREEN = "#3a7c3a";

// How long a fetched recipient list stays good for. Long enough that ticking a
// dozen classes costs a dozen queries and not seventy-eight; short enough that
// a count an operator reads is one they can still act on. Without an expiry the
// list froze at first fetch, so drafting, taking a phone call and sending
// twenty minutes later counted a roster that had since changed.
const PREVIEW_CACHE_MS = 60_000;

// Every placeholder the edge function fills, said in plain words and grouped the
// way an operator thinks about them. Not a jargon list: the palette shows
// "The parent's first name", never "{parent_first_name} interpolation".
//
// The keys are inserted as {{double braces}}, which is the spelling every other
// editor in the product uses. The edge function still honours the single-brace
// form this panel used to teach, so the 64 sends already written that way, and
// anyone who learned it here, keep working.
const FIELDS = [
  {
    group: "The family",
    tokens: [
      { key: "parent_first_name", label: "Parent's first name", tip: "The parent's first name" },
      { key: "student_first_name", label: "Their child", tip: "Their child - or all their children in this class" },
    ],
  },
  {
    group: "The class",
    tokens: [
      { key: "program_name", label: "Class name", tip: "The name of this class" },
      { key: "program_day", label: "Day it runs", tip: "The weekday this class meets" },
      { key: "program_location", label: "School or site", tip: "Where this class meets" },
    ],
  },
  {
    group: "You",
    tokens: [
      { key: "org_name", label: "Your business name", tip: "Your organisation's name" },
    ],
  },
];

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/**
 * @param programs the classes this message goes to, as [{ id, curriculum }].
 *
 * A LIST, chosen before the composer opens, because that is where operators
 * expect to choose it. The first version put a class picker INSIDE this panel;
 * Jessica: "wouldn't it be cleaner to have one 'message families' button at the
 * top of rosters, and then the provider just clicks one or multiple? seems like
 * that would be standard crm behavior?" It is - Jackrabbit ticks classes on the
 * class list and then presses one Send a Message - and a picker buried in a
 * per-class modal was the third shape nobody uses.
 *
 * So the selection lives on the roster list and this panel just composes. One
 * composer, reached from the two natural places: tick several classes and press
 * the button above the list, or press the button on a single class's row.
 */
export default function MessageFamiliesModal({ programs, orgId, onClose, onSent }) {
  // The class the panel is titled after and whose name fills a merge field in
  // the test send. With several, it is simply the first.
  const program = programs?.[0];
  const [tab, setTab] = useState("write");          // write | sent
  const [subject, setSubject] = useState("");
  // HTML is the canonical form, the same as every other body editor. The
  // operator never sees it; RichBodyEditor shows them words and a toolbar.
  const [bodyHtml, setBodyHtml] = useState("");
  const [includeWaitlist, setIncludeWaitlist] = useState(false);
  // THE THIRD GROUP, and it exists because of a dead end Jessica spotted: a
  // refund sets the registration to cancelled, which takes the family off the
  // roster - so after refunding, there was no way left to email them at all. One
  // cancelled class on prod has 2 refunded families and returned ZERO reachable
  // people. Sawyer solves it the same way, with a separate "canceled" tab you
  // can still message from.
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [preview, setPreview] = useState(null);       // null = loading
  const [previewError, setPreviewError] = useState("");
  const [phase, setPhase] = useState("compose");       // compose | sending | done
  const [error, setError] = useState("");
  const [duplicate, setDuplicate] = useState(null);    // the 409 payload
  const [result, setResult] = useState(null);

  // ONE ADDRESS, TWO USES - the test goes to it, and the copy goes to it. Two
  // separate address fields in one panel is two chances to typo the same fact.
  const [myEmail, setMyEmail] = useState("");
  const [copyToMe, setCopyToMe] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);  // { ok, message }

  // The body as words, used ONLY to decide whether anything has been written.
  // An "empty" RichBodyEditor still holds markup, so a trim() on the HTML would
  // call an empty message written and let a blank email go to a class.
  const bodyIsEmpty = useMemo(() => !stripHtml(bodyHtml || "").trim(), [bodyHtml]);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) setMyEmail(data?.session?.user?.email ?? "");
    });
    return () => { alive = false; };
  }, []);

  // ONE MESSAGE, SEVERAL CLASSES.
  //
  // Jeff sent "Help Us Bring More Friends" to TWELVE classes in one sitting,
  // 175 emails, by pasting it twelve times - 23 of his 33 sends in eight days
  // were the same message re-entered class by class.
  //
  // It is orchestrated HERE rather than in the edge function, deliberately. One
  // call per class keeps every existing reader correct: each class still gets
  // its own audit row with its own honest counts, its own Sent tab entry, and
  // its own {{program_name}} / {{program_day}} resolved to the class the family
  // is actually in. A function that took a list of classes would have had to
  // invent an answer to "which class is this family's" for the 13% of J2S
  // families in more than one, and would have made every count ambiguous.
  const [progress, setProgress] = useState(null);       // { done, total, name }

  // WHAT THIS COMPOSE SESSION HAS ALREADY DONE, so a retry RESUMES instead of
  // restarting.
  //
  // These are refs, not state, because the send loop reads them mid-flight and
  // a re-render must not hand it a stale copy. They survive across calls to
  // send() deliberately: the whole point is that pressing "Send it again
  // anyway" after a warning on class 3 does not re-send classes 1 and 2.
  const sentClassIds = useRef(new Set());
  // Households already addressed anywhere in this batch - the dedupe, carried
  // across a resume for the same reason.
  const emailedHouseholds = useRef(new Set());
  // The class a duplicate warning was raised FOR. Confirming clears the guard
  // for that class only.
  const duplicateForRef = useRef(null);
  // Per-class outcomes, accumulated across resumes so the final panel reports
  // the whole batch.
  const sentResults = useRef([]);
  // Preview responses by (class, audience). Keyed rather than cleared, so a
  // stale entry is unreachable by construction.
  const previewCache = useRef(new Map());
  // WHICH MESSAGE the batch state above belongs to.
  //
  // Without this the resume was tied to the PANEL, not to the message. After a
  // batch stopped partway, an operator who corrected the wording and pressed
  // Send again had classes 1 and 2 skipped - they HAD been sent, but they had
  // been sent the OLD message - and the households in them stayed excluded from
  // every later class too, while the result panel reported a clean batch. A
  // resume is only a resume while it is the same message.
  const batchMessageKey = useRef(null);

  // The classes to send to, in the order the operator picked them. Order
  // matters: a family in two of them is emailed by the FIRST and excluded from
  // the rest, so it decides which class their copy is about.
  //
  // KEYED ON THE IDS, NOT THE ARRAY. Memoising on the `programs` reference made
  // identity depend on who rendered last: ProgramsCalendar passes an inline
  // `programs={[program]}`, so every parent re-render minted a new array,
  // invalidated this, and re-ran the preview effect - which starts by setting
  // the list to null. The recipient list an operator was reading flashed back
  // to "Working out who would receive this..." at random, on the one panel
  // whose whole job is counting recipients before a send. A string of ids
  // changes when the SELECTION changes and not before.
  const classIdKey = (programs ?? []).map((p) => p?.id).filter(Boolean).join(",");
  const selectedClassIds = useMemo(
    () => (classIdKey ? classIdKey.split(",") : []),
    [classIdKey],
  );
  // Deliberately NOT memoised: it is called inside the send loop and sits in no
  // dependency array, so a stable identity would buy nothing and re-introduce
  // the array-reference dependency this just removed.
  const labelFor = (pid) =>
    (programs ?? []).find((p) => p?.id === pid)?.curriculum || "this class";

  const call = useCallback(async (payload) => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error("Your sign-in expired. Refresh and try again.");
    const resp = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/notify-program-families`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          // Defaults to the class this was opened from; a caller sending to
          // several passes its own program_id per call.
          program_id: program?.id,
          organization_id: orgId,
          include_waitlist: includeWaitlist,
          include_cancelled: includeCancelled,
          ...payload,
        }),
      },
    );
    return { status: resp.status, json: await resp.json().catch(() => ({})) };
    // includeCancelled is a dependency for the same reason includeWaitlist is:
    // `call` is what the preview effect watches, so leaving it out would show a
    // count that no longer matches the boxes as they sit.
  }, [program?.id, orgId, includeWaitlist, includeCancelled]);

  // Re-previewed whenever the audience changes, so the count on screen always
  // belongs to the toggle as it currently sits. A stale count is the thing that
  // makes an operator trust a number that is no longer true.
  useEffect(() => {
    let alive = true;
    setPreview(null);
    setPreviewError("");
    (async () => {
      try {
        // One preview per selected class, then merged. Sequential rather than
        // parallel: twelve simultaneous requests is a burst against a function
        // that runs a SECURITY DEFINER query per call, and the operator is
        // looking at a list, not racing a clock.
        const perClass = [];
        for (const pid of selectedClassIds) {
          // CACHED PER (CLASS, AUDIENCE), so ticking a twelfth class fetches
          // ONE preview and not twelve. Without this the effect replayed the
          // whole list on every tick - 1+2+...+12 = 78 calls to a function that
          // runs a SECURITY DEFINER query each time, with superseded runs still
          // in flight. The audience is part of the key rather than something to
          // remember to invalidate, so a stale entry cannot be served.
          const cacheKey = `${pid}|${includeWaitlist}|${includeCancelled}`;
          const hit = previewCache.current.get(cacheKey);
          if (hit && Date.now() - hit.at < PREVIEW_CACHE_MS) {
            perClass.push({ programId: pid, json: hit.json });
            continue;
          }

          const { status, json } = await call({ mode: "preview", program_id: pid });
          if (!alive) return;
          if (status !== 200) {
            setPreviewError(json?.error === "forbidden"
              ? "You don't have permission to message this class's families."
              : "Couldn't work out who would receive this. Refresh and try again.");
            setPreview({ recipients: [], unreachable: [], recipient_count: 0, unreachable_count: 0 });
            return;
          }
          previewCache.current.set(cacheKey, { json, at: Date.now() });
          perClass.push({ programId: pid, json });
        }
        if (!alive) return;
        // MERGED, NOT CONCATENATED. A family in two of the selected classes is
        // ONE recipient - 67 of 500 J2S families are in more than one class, up
        // to four, so concatenating would tell 13% of them the same thing
        // repeatedly. Which class each family is counted under is decided at
        // send time by the order below; here they are simply one row.
        const byAddress = new Map();
        // DEDUPED THE SAME WAY THE RECIPIENTS ARE. This was a flat push, so a
        // family with a placeholder address in three of the selected classes
        // was counted three times and their child named three times - "3
        // families have no email address on file" for one family. The panel
        // exists to make a silent gap visible; inflating it sends an operator
        // chasing a school for addresses that are one address.
        const byUnreachable = new Map();
        for (const { programId, json } of perClass) {
          for (const r of json.recipients ?? []) {
            const key = `${r.email}|${r.parent_id ?? ""}`;
            if (!byAddress.has(key)) byAddress.set(key, { ...r, programIds: [] });
            byAddress.get(key).programIds.push(programId);
          }
          for (const u of json.unreachable ?? []) {
            byUnreachable.set(`${u.email}|${u.parent_id ?? ""}`, u);
          }
        }
        const unreachable = [...byUnreachable.values()];
        const recipients = [...byAddress.values()];
        setPreview({
          program: perClass[0]?.json?.program,
          recipients,
          unreachable,
          recipient_count: recipients.length,
          unreachable_count: unreachable.length,
          per_class: perClass.map((p) => ({ programId: p.programId, count: p.json.recipient_count })),
        });
      } catch (e) {
        if (alive) {
          setPreviewError(e.message ?? "Couldn't load the recipient list.");
          setPreview({ recipients: [], unreachable: [], recipient_count: 0, unreachable_count: 0 });
        }
      }
    })();
    return () => { alive = false; };
    // selectedClassIds joins `call` as a dependency for the same reason the
    // audience toggles did: it changes WHO the list is, so a stale list would
    // be a count that no longer belongs to the classes as they sit ticked.
  }, [call, selectedClassIds]);

  // A TEST IS NOT A SEND, and the difference is enforced on the server: it
  // writes no audit row, does not arm the duplicate guard, and goes to exactly
  // one address that must already belong to this org.
  async function sendTest() {
    if (testing) return;
    setTestResult(null);
    if (!subject.trim() || bodyIsEmpty) {
      setTestResult({ ok: false, message: "Write a subject and a message first." });
      return;
    }
    if (!myEmail.trim()) {
      setTestResult({ ok: false, message: "Add an address to send the test to." });
      return;
    }
    setTesting(true);
    try {
      const { status, json } = await call({
        mode: "test",
        // Sent on a test too, so the sample family whose name fills the merge
        // fields is one who is actually going to receive it.
        exclude_parent_ids: [...excluded],
        subject: subject.trim(),
        body_html: bodyHtml,
        test_email: myEmail.trim(),
      });
      if (status !== 200 || json?.status !== "sent") {
        setTestResult({
          ok: false,
          message: json?.message || json?.failure_reason || "The test didn't go. Nothing was sent to families.",
        });
      } else {
        setTestResult({ ok: true, message: `Test sent to ${json.to}. Check how it looks before sending to families.` });
      }
    } catch (e) {
      setTestResult({ ok: false, message: e.message ?? "The test didn't go." });
    } finally {
      setTesting(false);
    }
  }

  async function send({ confirmFor = null } = {}) {
    if (phase === "sending") return;
    setError("");
    setDuplicate(null);
    if (!subject.trim() || bodyIsEmpty) {
      setError("Add a subject and a message before sending.");
      return;
    }
    // Two different empties, two different sentences. "Nobody has an address" is
    // a data problem the operator cannot fix from here; "you unticked everyone"
    // is a thing they just did and can undo.
    if ((preview?.recipient_count ?? 0) === 0) {
      setError(selectedClassIds.length > 1
        ? "Nobody in these classes has an email address we can send to."
        : "Nobody in this class has an email address we can send to.");
      return;
    }
    if (count === 0) {
      setError("Every family is unticked, so there is nobody to send to.");
      return;
    }
    // A DIFFERENT MESSAGE IS A DIFFERENT BATCH. Edit the subject or the body
    // after a batch stopped partway and everything starts again: the classes
    // already sent received the OLD wording, so skipping them would silently
    // deny them the correction the operator just wrote. Only an unchanged
    // message resumes.
    const messageKey = [subject.trim(), bodyHtml].join("\n--\n");
    if (batchMessageKey.current !== messageKey) {
      batchMessageKey.current = messageKey;
      sentClassIds.current = new Set();
      emailedHouseholds.current = new Set();
      sentResults.current = [];
      duplicateForRef.current = null;
    }

    setPhase("sending");
    // ALREADY EMAILED IN THIS BATCH, carried forward from class to class AND
    // across a resume. This is the whole dedupe, and it reuses the exclusion
    // the picker already sends rather than inventing a second mechanism. A
    // family in Monday and Tuesday is emailed by Monday, then excluded from
    // Tuesday - so they hear it once, and the class named in their email is one
    // they are really in. The alternative, one email per class, would have told
    // 67 J2S families the same thing two to four times.
    const alreadyEmailed = emailedHouseholds.current;
    // Accumulated across resumes too, so the panel at the end reports the whole
    // batch rather than only the classes that ran after the last warning.
    const perClass = sentResults.current;
    try {
      for (let i = 0; i < selectedClassIds.length; i++) {
        const pid = selectedClassIds[i];
        const label = labelFor(pid);

        // A RESUME SKIPS WHAT ALREADY WENT. Without this, a duplicate warning
        // raised on class 3 of 12 - which happens whenever THAT class had the
        // same subject minutes ago - left classes 1 and 2 sent, and pressing
        // "Send it again anyway" restarted at class 1 and emailed both of them
        // a second time. The control that exists to prevent a double send was
        // causing one.
        if (sentClassIds.current.has(pid)) continue;

        setProgress({ done: i, total: selectedClassIds.length, name: label });

        const { status, json } = await call({
          mode: "send",
          program_id: pid,
          // Sent as the households LEFT OUT rather than the ones selected, so
          // the default - an empty array - means everybody. A caller that
          // forgets the field emails the whole class, which is the pre-existing
          // behaviour; sending the inverse would mean a dropped field silently
          // emails nobody.
          exclude_parent_ids: [...new Set([...excluded, ...alreadyEmailed])],
          subject: subject.trim(),
          body_html: bodyHtml,
          // The operator's copy rides the first class ACTUALLY SENT, not
          // index 0 - on a resume, index 0 has already gone and would send a
          // second copy. One message, one copy.
          copy_to: sentClassIds.current.size === 0 && copyToMe && myEmail.trim()
            ? myEmail.trim() : undefined,
          // THIS CLASS ONLY. Passing the operator's confirmation to every class
          // in the batch spent one decision about one class on eleven others,
          // disabling their guards silently. The warning names a class; the
          // confirmation answers for that class.
          confirm_duplicate: confirmFor === pid,
        });

        if (status === 409 && json?.error === "duplicate_send") {
          // Reachable on ANY class, not just the first: the guard is per class,
          // so class 3 trips it whenever class 3 had this subject minutes ago.
          // Everything before it has already been sent, which is why the retry
          // resumes rather than restarts, and why the operator is told where it
          // stopped instead of being left to assume nothing happened.
          duplicateForRef.current = pid;
          setDuplicate({ ...json, class_label: label, already_sent: sentClassIds.current.size });
          setPhase("compose");
          setProgress(null);
          return;
        }
        if (status !== 200) {
          // NOT "nothing was sent" - we do not know that, and with several
          // classes we know the opposite for the ones already done. The server
          // emails the families BEFORE several of the things that can fail
          // afterwards, so asserting a clean failure is the sentence that makes
          // an operator press Send again and mail people twice.
          setError((json?.message || json?.error
            || "Something went wrong before this finished.")
            + (perClass.length
              ? ` ${perClass.length} of ${selectedClassIds.length} classes had already been sent. Check the Sent tab before trying again.`
              : " Check the Sent tab before trying again - some families may already have it."));
          setPhase("compose");
          setProgress(null);
          return;
        }

        // EVERY household this class ATTEMPTED is carried forward, not only the
        // ones that succeeded.
        //
        // The first version of this carried only `status === 'sent'`, reasoning
        // that a family whose send failed should stay eligible for the next
        // class. Watching it on staging showed why that is wrong: a family in
        // two classes appeared TWICE in "these did not go", because the failure
        // in class one made them eligible again in class two. Two consequences,
        // both bad - the operator reads one family as two problems, and if that
        // first send had in fact reached the inbox while reporting a failure,
        // the family gets the message twice, which is the exact thing this
        // batch exists to prevent.
        //
        // The operator's intent is "this family hears this once". Being
        // addressed is what satisfies it; whether the attempt bounced is a
        // delivery problem to report, not a reason to quietly re-aim the same
        // message at them under a different class.
        for (const r of json.results ?? []) {
          if (r.parent_id) alreadyEmailed.add(r.parent_id);
        }
        // Recorded BEFORE the next class runs, so a failure or a warning later
        // in the batch can never cause this one to be sent again.
        sentClassIds.current.add(pid);
        perClass.push({ programId: pid, label, ...json });
      }

      setProgress(null);
      // Aggregated, and the per-class rows are kept so the panel can name the
      // ones that failed rather than reporting one number for twelve sends.
      setResult({
        mode: "send",
        classes: perClass,
        // no_recipients SURVIVES AGGREGATION. Collapsing it into "failed" lost
        // the one sentence that explains an empty send - "nobody had an email
        // address" - and replaced it with "Sent to 0 families, 0 failed", which
        // is true and tells the operator nothing. Reachable when a roster
        // empties between the preview and the send.
        status: perClass.every((p) => p.status === "no_recipients") ? "no_recipients"
          : perClass.every((p) => p.status === "sent") ? "sent"
            : perClass.every((p) => p.status === "failed" || p.status === "no_recipients") ? "failed" : "partial",
        sent: perClass.reduce((n, p) => n + (p.sent ?? 0), 0),
        // Households actually REACHED, which is not the same as households
        // addressed now that a failed attempt also counts as addressed.
        households_sent: new Set(
          perClass.flatMap((p) => (p.results ?? []).filter((r) => r.status === "sent").map((r) => r.parent_id)).filter(Boolean),
        ).size,
        failed: perClass.reduce((n, p) => n + (p.failed ?? 0), 0),
        unreachable_count: perClass.reduce((n, p) => n + (p.unreachable_count ?? 0), 0),
        copy: perClass[0]?.copy ?? null,
        audit_recorded: perClass.every((p) => p.audit_recorded !== false),
        // Tagged with the class, because across several classes the SAME
        // address can appear twice - a family whose send failed stays eligible
        // for the next class, by design - and "these did not go" listing one
        // address twice with no class beside it is a list an operator cannot
        // act on. It also stops two rows colliding on the same React key.
        results: perClass.flatMap((p) => (p.results ?? []).map((r) => ({ ...r, class_label: p.label }))),
      });
      setPhase("done");
      // The batch ran. The caller's selection has been spent, and it is the
      // caller's to clear - reported here rather than on close, because closing
      // after cancelling must NOT discard a selection that was never used.
      onSent?.();
    } catch (e) {
      setProgress(null);
      setError((e.message ?? "The connection dropped before this finished.")
        + (perClass.length
          ? ` ${perClass.length} of ${selectedClassIds.length} classes had already been sent. Check the Sent tab before trying again.`
          : " Check the Sent tab before trying again - some families may already have it."));
      setPhase("compose");
    }
  }

  // HOUSEHOLDS, built from the preview's rows. Every row carries the parent_id
  // of the registration it came from, and a second guardian carries the SAME
  // one, so grouping on it turns "10 inboxes" back into "6 families" - which is
  // what the label above has always claimed to be counting and never was.
  const households = useMemo(() => {
    const byFamily = new Map();
    for (const r of preview?.recipients ?? []) {
      const key = r.parent_id || r.email;
      if (!byFamily.has(key)) {
        byFamily.set(key, { key, name: r.name, children: r.children, audiences: r.audiences ?? [], emails: [], classIds: [] });
      }
      const h = byFamily.get(key);
      h.emails.push(r.email);
      // Which of the selected classes this family sits in. Shown when it is
      // more than one, so an operator can see WHY they appear once in a list
      // that covers several classes rather than wondering what was dropped.
      for (const pid of r.programIds ?? []) if (!h.classIds.includes(pid)) h.classIds.push(pid);
      // The account holder's name wins; a guardian-only household keeps theirs.
      if (r.kinds?.includes("parent") && r.name) h.name = r.name;
      for (const a of r.audiences ?? []) if (!h.audiences.includes(a)) h.audiences.push(a);
    }
    return [...byFamily.values()];
  }, [preview]);

  // Excluded households, by key. Starts empty: the default is everybody, which
  // is what an operator opening this panel means.
  const [excluded, setExcluded] = useState(() => new Set());
  const toggleHousehold = (key) => setExcluded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // The audience toggles re-fetch a different list, and a household excluded
  // under the old one may not exist under the new one. Clearing is the honest
  // reset: a stale exclusion silently dropping a family from a list they were
  // never shown on is exactly the kind of quiet omission this panel exists to
  // prevent.
  useEffect(() => { setExcluded(new Set()); }, [includeWaitlist, includeCancelled]);

  // CAN WE TELL HOUSEHOLDS APART AT ALL? `parent_id` arrives only from a server
  // that has this release. Against an older one every row falls back to keying
  // on its own address, so the list silently becomes one row per INBOX - and
  // unticking Rosemary would leave Jim receiving it, which is the exact defect
  // this control exists to prevent. Offer no control rather than one that lies:
  // the picker is hidden until the function that honours it is deployed.
  const canPick = (preview?.recipients ?? []).every((r) => !!r.parent_id);

  const selected = households.filter((h) => !excluded.has(h.key));
  const count = selected.length;
  const inboxCount = selected.reduce((n, h) => n + h.emails.length, 0);
  const unreachable = preview?.unreachable ?? [];
  const sending = phase === "sending";

  return (
    // textAlign RESET, and it is not cosmetic paranoia. This panel is opened
    // from the Class rosters row, whose action column is `textAlign: "right"`,
    // and a fixed-position child still INHERITS text alignment from its DOM
    // parent - so every label, the placeholder list and the footer note came out
    // right-aligned. A modal must not depend on where it happens to be mounted.
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 24, zIndex: 60, overflowY: "auto", textAlign: "left" }}>
      <div style={{ background: "#fff", borderRadius: 12, maxWidth: 640, width: "100%", padding: 20, boxShadow: "0 12px 40px rgba(0,0,0,0.2)", textAlign: "left" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: PURPLE }}>Message families</div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
              {program?.curriculum || "This class"}
              {preview?.program?.summary ? ` · ${preview.program.summary}` : ""}
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={sending} aria-label="Close"
            style={{ background: "transparent", border: "none", color: MUTED, fontSize: 18, cursor: sending ? "not-allowed" : "pointer" }}>
            ✕
          </button>
        </div>

        {/* ONE PANEL, TWO QUESTIONS: what am I about to send, and what have I
            already sent. Kept in this modal rather than on a screen of its own
            so there is ONE place a class's messages live, reachable identically
            from Rosters and from the calendar. */}
        {phase !== "done" && (
          <div style={{ display: "flex", gap: 4, marginTop: 12, borderBottom: `1px solid ${RULE}` }}>
            {[["write", "Write a message"], ["sent", "Sent"]].map(([key, label]) => (
              <button key={key} type="button" onClick={() => setTab(key)} disabled={sending}
                style={{
                  background: "transparent", border: "none", borderBottom: `2px solid ${tab === key ? BRIGHT : "transparent"}`,
                  color: tab === key ? PURPLE : MUTED, fontWeight: tab === key ? 700 : 500,
                  fontSize: 13, fontFamily: "inherit", padding: "6px 10px", marginBottom: -1,
                  cursor: sending ? "not-allowed" : "pointer",
                }}>
                {label}
              </button>
            ))}
          </div>
        )}

        {phase === "done" ? (
          // THE RESULT WHERE THEY CLICKED. Counts first, then every failure by
          // name - a tally with no names is a result an operator cannot act on.
          <div style={{ marginTop: 14 }}>
            <div style={{ background: result?.failed ? "#fdf6e3" : "#eef7ee", border: `1px solid ${result?.failed ? "#ecdca6" : "#cfe6cf"}`, borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: result?.failed ? AMBER : OK_GREEN }}>
                {result?.status === "no_recipients"
                  ? "Nothing was sent - nobody in this class had an email address."
                  : (() => {
                    // Families, then the number of emails behind them when the
                    // two differ. `sent` counts EMAILS; calling that number
                    // "families" is what the preview label did for months.
                    // Older responses carry no household count, so fall back to
                    // the email count rather than printing "undefined".
                    const fam = result?.households_sent ?? result?.sent;
                    return `Sent to ${fam} ${fam === 1 ? "family" : "families"}`
                      + (result?.sent !== fam ? ` (${result.sent} emails)` : "")
                      + (result?.failed ? `, ${result.failed} failed` : "") + ".";
                  })()}
              </div>
              {!!result?.unreachable_count && (
                <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                  {result.unreachable_count} {result.unreachable_count === 1 ? "family has" : "families have"} no email address on file, so they were not included.
                </div>
              )}
              {/* The copy is reported separately, and says NOTHING about the
                  families. It read "The families were emailed, but your copy
                  did not go" until a staging run produced that sentence under a
                  heading that said 0 sent, 1 failed - the copy branch asserting
                  an outcome it does not know. The line above owns that fact. */}
              {result?.copy && (
                <div style={{ fontSize: 12, color: result.copy.status === "sent" ? MUTED : AMBER, marginTop: 6 }}>
                  {result.copy.status === "sent"
                    ? `A copy was sent to you at ${result.copy.to}.`
                    : `Your copy to ${result.copy.to} did not go.`}
                </div>
              )}
              {result?.audit_recorded === false && (
                <div style={{ fontSize: 12, color: AMBER, marginTop: 6 }}>
                  The emails went out, but recording them in the log failed. Don't send again - check the log later.
                </div>
              )}
            </div>
            {(result?.results ?? []).filter((r) => r.status === "failed").length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: RED, marginBottom: 4 }}>These did not go:</div>
                {(result.results).filter((r) => r.status === "failed").map((r) => (
                  // overflowWrap, because an email address is one unbroken word
                  // and a long one runs out of a 375px phone. Seen on staging.
                  <div key={`${r.class_label ?? ""}|${r.email}`} style={{ fontSize: 12, color: INK, overflowWrap: "anywhere" }}>
                    {r.name || r.email} <span style={{ color: MUTED }}>({r.email})</span>
                    {selectedClassIds.length > 1 && r.class_label && (
                      <span style={{ color: MUTED }}> · {r.class_label}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <button type="button" onClick={onClose} style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
                Done
              </button>
            </div>
          </div>
        ) : tab === "sent" ? (
          <SentMessages programId={program?.id} orgId={orgId} />
        ) : (
          <>
            {/* WHO, before what. */}
            <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, marginTop: 14 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: INK }}>
                <input type="checkbox" checked={includeWaitlist} disabled={sending}
                  onChange={(e) => setIncludeWaitlist(e.target.checked)} />
                Also include families on the waiting list
              </label>
              {/* Worded as "left or been refunded" rather than "cancelled",
                  because the operator is thinking about the family, not the
                  registration's status value. Off by default: most messages are
                  for the people currently in the class. */}
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: INK, marginTop: 6 }}>
                <input type="checkbox" checked={includeCancelled} disabled={sending}
                  onChange={(e) => setIncludeCancelled(e.target.checked)} />
                Also include families who have left or been refunded
              </label>

              {/* WHICH CLASSES, named rather than counted. The selection was
                  made on the roster list before this opened, so the panel's job
                  is to show it back - an operator who ticked twelve rows needs
                  to see the twelve, not the number twelve. */}
              {selectedClassIds.length > 1 && (
                <div style={{ marginTop: 8, borderTop: `1px solid ${RULE}`, paddingTop: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: INK }}>
                    Going to {selectedClassIds.length} classes
                  </div>
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>
                    {(programs ?? []).map((p) => p?.curriculum).filter(Boolean).join(" · ")}
                  </div>
                  {/* Said plainly, because it is the question an operator asks
                      the moment they tick a second class. */}
                  <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>
                    A family in more than one of these gets this once, not once per class.
                  </div>
                </div>
              )}

              <div style={{ marginTop: 10, fontSize: 13, color: INK }}>
                {preview === null ? (
                  <span style={{ color: MUTED }}>Working out who would receive this…</span>
                ) : previewError ? (
                  <span style={{ color: RED }}>{previewError}</span>
                ) : (
                  <>
                    <strong>{count} {count === 1 ? "family" : "families"} will receive this</strong>
                    {/* The second number, and it only appears when it differs.
                        A household with two guardians is ONE family and TWO
                        emails; printing only the bigger number is what made this
                        label say 10 for 6 at Jackson. */}
                    {inboxCount !== count && (
                      <span style={{ color: MUTED }}> ({inboxCount} email addresses)</span>
                    )}
                    {excluded.size > 0 && (
                      <span style={{ color: AMBER }}> · {excluded.size} left out</span>
                    )}
                  </>
                )}
              </div>

              {!!households.length && (
                <div style={{ marginTop: 8, maxHeight: 160, overflowY: "auto", border: `1px solid ${RULE}`, borderRadius: 6 }}>
                  {/* ONE ROW PER FAMILY, and the checkbox drops the HOUSEHOLD.
                      A row used to be an inbox, so unticking "Rosemary" would
                      have left Jim receiving it - the same household told
                      anyway, which is the exclude-by-address bug wearing a new
                      control. Both their addresses sit under one tick. */}
                  {households.map((r) => (
                    <label key={r.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "5px 8px", fontSize: 12, borderBottom: `1px solid ${RULE}`, cursor: sending ? "not-allowed" : "pointer", opacity: excluded.has(r.key) ? 0.45 : 1 }}>
                      <span style={{ color: INK, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 7 }}>
                        {canPick && (
                          <input type="checkbox" checked={!excluded.has(r.key)} disabled={sending}
                            onChange={() => toggleHousehold(r.key)} />
                        )}
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                          {r.name || r.emails[0]}
                          <span style={{ color: MUTED }}> · {r.children}</span>
                          {r.emails.length > 1 && (
                            <span style={{ color: MUTED }}> · {r.emails.length} addresses</span>
                          )}
                          {r.classIds?.length > 1 && (
                            <span style={{ color: MUTED }}> · in {r.classIds.length} of these classes</span>
                          )}
                        </span>
                      </span>
                      {/* FOUR STATES, FOUR LABELS. A family can be in more than
                          one group at once - one child enrolled, another waiting
                          or refunded - and a single-word badge for that reads as
                          the wrong fact about them. Seen live: Jessica Vorster
                          has Priya enrolled and J dog waiting on the same class. */}
                      {(r.audiences?.includes("waitlist") || r.audiences?.includes("cancelled")) && (
                        <span style={{ color: AMBER, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                          {r.audiences?.includes("enrolled")
                            ? "ENROLLED + OTHER"
                            : r.audiences?.includes("waitlist") && r.audiences?.includes("cancelled")
                              ? "WAITING + LEFT"
                              : r.audiences?.includes("waitlist") ? "WAITING LIST" : "LEFT / REFUNDED"}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              )}

              {/* The half a send would hide. Named, so the operator can chase the
                  school that runs its own registration for real addresses. */}
              {unreachable.length > 0 && (
                <div style={{ marginTop: 10, background: "#fdf6e3", border: "1px solid #ecdca6", borderRadius: 6, padding: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: AMBER }}>
                    {unreachable.length} {unreachable.length === 1 ? "family has" : "families have"} no email address on file and will not be included
                  </div>
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                    {unreachable.map((r) => r.children).join(", ")}
                  </div>
                  <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
                    These usually come from a school that runs its own registration. Ask them for parent emails to reach these families.
                  </div>
                </div>
              )}
            </div>

            {/* WHAT. */}
            <label style={{ display: "block", marginTop: 14 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: INK }}>Subject</span>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={sending}
                placeholder="e.g. A change to next week's class"
                style={{ width: "100%", marginTop: 4, padding: "7px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: INK, boxSizing: "border-box" }} />
            </label>

            <div style={{ marginTop: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: INK, display: "block", marginBottom: 4 }}>Message</span>
              {/* THE FIX. Select your words and press B, or press Link and fill
                  in a box - the same control Mailchimp, HubSpot and every other
                  comms tool gives you, and the same one the rest of Enrops
                  already uses. Nothing here shows an operator a markup marker. */}
              <RichBodyEditor
                value={bodyHtml}
                onChange={setBodyHtml}
                rows={7}
                fields={FIELDS}
                showPreview={false}
                // Plain words, no token spelling. An operator who wants the
                // parent's name in there presses Personalize with fields; an
                // example written in braces teaches the notation this editor
                // exists to hide.
                placeholder={"e.g. Next week class will start at 3pm instead of 2:30."}
              />
            </div>

            {/* SEE IT BEFORE THEY DO. Jeff's words: "I've just been hitting send
                and giving a slight prayer." */}
            <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, marginTop: 12, background: "#fcfbf7" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: INK }}>Check it first</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 6 }}>
                <label style={{ flex: "1 1 220px", fontSize: 11, color: MUTED }}>
                  Send a test to
                  <input value={myEmail} onChange={(e) => setMyEmail(e.target.value)} disabled={sending || testing}
                    placeholder="you@yourbusiness.com"
                    style={{ width: "100%", marginTop: 3, padding: "7px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: INK, boxSizing: "border-box" }} />
                </label>
                <button type="button" onClick={sendTest} disabled={sending || testing}
                  style={{ padding: "8px 14px", background: "#fff", color: PURPLE, border: `1px solid ${BRIGHT}`, borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: (sending || testing) ? "not-allowed" : "pointer" }}>
                  {testing ? "Sending test…" : "Send test"}
                </button>
              </div>
              <div style={{ fontSize: 11, color: MUTED, marginTop: 5 }}>
                A test goes to one person on your team and reaches no families. It is not recorded as a send.
              </div>
              {testResult && (
                <div style={{ fontSize: 12, marginTop: 7, color: testResult.ok ? OK_GREEN : RED }}>
                  {testResult.message}
                </div>
              )}
              {/* Disabled with no address rather than silently sending no copy.
                  Ticked-but-blank used to drop `copy_to` on the floor: the
                  families were emailed, no copy was sent, and the result panel
                  said nothing either way because there was no copy to report. */}
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: myEmail.trim() ? INK : MUTED, marginTop: 9 }}>
                <input type="checkbox" checked={copyToMe && !!myEmail.trim()} disabled={sending || !myEmail.trim()}
                  onChange={(e) => setCopyToMe(e.target.checked)} />
                Email me a copy when this goes
                {!myEmail.trim() && <span style={{ fontSize: 11 }}>(add an address above first)</span>}
              </label>
            </div>

            {/* One email per family, said out loud - it is the question an
                operator asks before sending to a class. */}
            <div style={{ fontSize: 11, color: MUTED, marginTop: 10 }}>
              Each family gets their own email. Nobody sees anyone else's address, and a family
              with two children in this class gets one email naming both.
            </div>

            {duplicate && (
              <div style={{ marginTop: 12, background: "#fdf6e3", border: "1px solid #ecdca6", borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: AMBER }}>This looks like a repeat</div>
                <div style={{ fontSize: 12, color: INK, marginTop: 4 }}>
                  {selectedClassIds.length > 1 && duplicate.class_label
                    ? <><b>{duplicate.class_label}:</b> {duplicate.message}</>
                    : duplicate.message}
                </div>
                {/* WHERE IT STOPPED, said out loud. Over several classes the
                    earlier ones have already gone out, and an operator who
                    cannot see that will read "repeat" as "nothing happened". */}
                {duplicate.already_sent > 0 && (
                  <div style={{ fontSize: 12, color: INK, marginTop: 6 }}>
                    {duplicate.already_sent} {duplicate.already_sent === 1 ? "class has" : "classes have"} already
                    been sent. Continuing picks up from this one - they will not be sent again.
                  </div>
                )}
                <button type="button" onClick={() => send({ confirmFor: duplicateForRef.current })}
                  style={{ marginTop: 8, padding: "6px 12px", background: AMBER, color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
                  Send it again anyway
                </button>
              </div>
            )}

            {error && (
              <div style={{ marginTop: 12, background: `${RED}1A`, color: RED, padding: 8, borderRadius: 6, fontSize: 12 }}>{error}</div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button type="button" onClick={onClose} disabled={sending}
                style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: sending ? "not-allowed" : "pointer" }}>
                Cancel
              </button>
              {/* Disabled WHILE SENDING as well as when there is nothing to send:
                  a send is one request per family, so it takes seconds with
                  nothing visibly happening, and a second click would email the
                  whole class twice. The edge function guards this too. */}
              <button type="button" onClick={() => send()} disabled={sending || count === 0 || preview === null}
                style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: (sending || count === 0) ? "not-allowed" : "pointer", opacity: (sending || count === 0 || preview === null) ? 0.5 : 1 }}>
                {/* The progress names the CLASS, not a percentage. A send to
                    twelve classes is minutes of one sequential POST per family
                    with nothing else moving on screen, and "sending…" for that
                    long is what makes somebody reach for the button again. */}
                {sending
                  ? (progress && progress.total > 1
                    ? `Sending ${progress.done + 1} of ${progress.total}: ${progress.name}…`
                    : `Sending to ${count}…`)
                  : `Send to ${count} ${count === 1 ? "family" : "families"}`
                    + (selectedClassIds.length > 1 ? ` across ${selectedClassIds.length} classes` : "")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// What this class has already been sent, read from the rows this panel has been
// writing since it was built - and which, until today, only appeared on ONE
// contact's timeline over in Comms. An operator who sent from here had no way to
// see it from here.
//
// Every row states its own outcome, including the families that were never
// attempted, because "sent to 29" with no failures listed is the number that
// makes an operator stop looking.
function SentMessages({ programId, orgId }) {
  const [rows, setRows] = useState(null);   // null = loading
  const [loadError, setLoadError] = useState("");
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from("program_family_messages")
        .select("id, sent_at, subject, body_text, body_html, status, recipient_count, sent_count, failed_count, include_waitlist, include_cancelled, recipients")
        .eq("program_id", programId)
        .eq("organization_id", orgId)
        .order("sent_at", { ascending: false })
        .limit(25);
      if (!alive) return;
      if (error) {
        setLoadError("Couldn't load what has been sent to this class.");
        setRows([]);
        return;
      }
      setRows(data ?? []);
    })();
    return () => { alive = false; };
  }, [programId, orgId]);

  if (rows === null) {
    return <div style={{ fontSize: 13, color: MUTED, padding: "20px 2px" }}>Loading…</div>;
  }
  if (loadError) {
    return <div style={{ fontSize: 13, color: RED, padding: "20px 2px" }}>{loadError}</div>;
  }
  if (!rows.length) {
    return (
      <div style={{ fontSize: 13, color: MUTED, padding: "24px 2px" }}>
        Nothing has been sent to this class's families yet. Anything you send from here will be listed, with who received it.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      {rows.map((m) => {
        const open = openId === m.id;
        const failed = (m.recipients ?? []).filter((r) => r.status === "failed");
        const notAttempted = (m.recipients ?? []).filter((r) => r.status === "not_attempted");
        return (
          <div key={m.id} style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <button type="button" onClick={() => setOpenId(open ? null : m.id)}
              style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>{m.subject}</div>
              <div style={{ fontSize: 11.5, color: MUTED, marginTop: 3 }}>
                {fmtWhen(m.sent_at)}
                {" · "}
                {m.status === "no_recipients"
                  ? "nobody could be reached"
                  : `${m.sent_count} of ${m.recipient_count} ${m.recipient_count === 1 ? "family" : "families"}`}
                {m.failed_count ? ` · ${m.failed_count} failed` : ""}
                {m.include_waitlist ? " · incl. waiting list" : ""}
                {m.include_cancelled ? " · incl. left/refunded" : ""}
              </div>
            </button>

            {open && (
              <div style={{ marginTop: 10, borderTop: `1px solid ${RULE}`, paddingTop: 10 }}>
                {/* The message as it was written. `body_html` is only ever
                    produced by our own editor, which sanitises link targets;
                    older rows have none and fall back to the plain half. */}
                {/* SANITIZED AT RENDER, not trusted because the editor cleaned
                    it on the way in. The edge function stores body_html as it
                    receives it, so anyone able to call that function - every
                    admin and staff member of this org - can put arbitrary
                    markup in this column without going near the editor. This
                    div is the only thing standing between that and an admin's
                    own session, so it does the check itself. */}
                {m.body_html
                  ? <div style={{ fontSize: 12.5, color: INK, lineHeight: 1.5 }} dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(m.body_html) }} />
                  : <div style={{ fontSize: 12.5, color: INK, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{m.body_text}</div>}

                {failed.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: RED }}>Did not arrive:</div>
                    {failed.map((r) => (
                      <div key={r.email} style={{ fontSize: 11.5, color: INK, overflowWrap: "anywhere" }}>
                        {r.name || r.email} <span style={{ color: MUTED }}>({r.email})</span>
                      </div>
                    ))}
                  </div>
                )}
                {notAttempted.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: AMBER }}>Not included - no email address on file:</div>
                    {notAttempted.map((r) => (
                      <div key={r.email || r.name} style={{ fontSize: 11.5, color: MUTED }}>{r.name || r.email}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
