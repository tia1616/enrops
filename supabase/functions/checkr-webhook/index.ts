// checkr-webhook — receives Checkr account-level webhooks.
//
// Auth: verify_jwt: false. Checkr does not send a JWT. Authenticate via
// HMAC-SHA256 signature on the X-Checkr-Signature header, signed with our
// CHECKR_API_KEY (Checkr's account-level webhooks use the secret API key as
// the signing secret — they do not provide a per-webhook signing secret).
//
// Events we care about:
//   report.completed (with status clear / consider / suspended) — flips
//     checkr_status, runs gate check, optionally emails admin for review.
//   report.created — diagnostic only, no DB write needed.
//   invitation.completed — diagnostic.
//
// Idempotency: contractor_onboarding_status.checkr_last_webhook_event_id holds
// the most recent processed event id. If the incoming event matches, return
// 200 without re-processing. CRITICAL: the event id is written AFTER all
// downstream work succeeds — if processing crashes mid-flight, the retry
// from Checkr will replay the same event.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';
import { runGateCheck } from '../_shared/gateCheck.ts';

// Per-environment site origin. Staging Supabase sets PUBLIC_SITE_URL to the staging
// site so the onboarding link points at staging, not prod. Defaults to prod.
const PUBLIC_SITE_URL = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '');

interface CheckrEvent {
  id?: string;
  type?: string;
  data?: {
    object?: {
      id?: string;
      candidate_id?: string;
      status?: string;
      [k: string]: unknown;
    };
  };
  [k: string]: unknown;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // Read raw body before JSON.parse — HMAC verifies the bytes Checkr sent,
    // not whatever the JSON serializer would produce.
    const rawBody = await req.text();

    const signature = req.headers.get('X-Checkr-Signature');
    if (!signature) return json({ error: 'missing_signature' }, 401);

    const apiKey = Deno.env.get('CHECKR_API_KEY');
    if (!apiKey) {
      console.error('CHECKR_API_KEY not set');
      return json({ error: 'webhook_not_configured' }, 500);
    }

    const validSig = await verifyHmac(apiKey, rawBody, signature);
    if (!validSig) {
      console.warn('Checkr webhook signature mismatch');
      return json({ error: 'invalid_signature' }, 401);
    }

    let event: CheckrEvent;
    try {
      event = JSON.parse(rawBody) as CheckrEvent;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const eventId = event.id;
    const eventType = event.type;
    if (!eventId || !eventType) {
      return json({ error: 'invalid_event_shape' }, 400);
    }

    // Pull candidate id from the event. For report.* events, the report
    // object has a candidate_id field. For invitation.* events, it's also
    // present on the invitation object.
    const obj = event.data?.object;
    const candidateId = obj?.candidate_id ?? (obj && obj.id && eventType.startsWith('candidate.') ? obj.id : null);
    if (!candidateId) {
      console.warn('Checkr webhook missing candidate_id', { eventId, eventType });
      // Acknowledge to prevent retries; nothing we can do without a candidate id.
      return json({ ok: true, no_op: 'missing_candidate_id' });
    }

    const supabase = adminClient();

    // Find the onboarding row by candidate id.
    const { data: onboardingRow, error: onbErr } = await supabase
      .from('contractor_onboarding_status')
      .select(
        'id, instructor_id, organization_id, checkr_status, checkr_last_webhook_event_id, overall_status',
      )
      .eq('checkr_candidate_id', candidateId)
      .maybeSingle();

    if (onbErr) {
      console.error('onboarding lookup failed:', onbErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!onboardingRow) {
      // Orphan webhook — Checkr has the candidate but we don't.
      // Acknowledge so Checkr stops retrying. Log for human review.
      console.warn('Checkr webhook orphan candidate', { candidateId, eventId, eventType });
      return json({ ok: true, no_op: 'unknown_candidate' });
    }

    // Idempotency check.
    if (onboardingRow.checkr_last_webhook_event_id === eventId) {
      return json({ ok: true, no_op: 'already_processed' });
    }

    // Process the event.
    if (eventType === 'report.completed') {
      const status = obj?.status as string | undefined;
      const nowIso = new Date().toISOString();

      if (status === 'clear') {
        const { error: updErr } = await supabase
          .from('contractor_onboarding_status')
          .update({
            checkr_status: 'clear',
            checkr_completed_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', onboardingRow.id);
        if (updErr) {
          console.error('clear status update failed:', updErr);
          return json({ error: 'update_failed' }, 500);
        }

        // Gate check — may flip overall_status to 'complete' if everything else is ready.
        await runGateCheck(supabase, onboardingRow.instructor_id);

        // Email the contractor that their check is done.
        await sendCheckrCompleteContractorEmail(supabase, onboardingRow.instructor_id, onboardingRow.organization_id);
      } else if (status === 'consider' || status === 'suspended') {
        const { error: updErr } = await supabase
          .from('contractor_onboarding_status')
          .update({
            checkr_status: status,
            updated_at: nowIso,
          })
          .eq('id', onboardingRow.id);
        if (updErr) {
          console.error('consider/suspended status update failed:', updErr);
          return json({ error: 'update_failed' }, 500);
        }

        // Email admin to review in Checkr dashboard. Don't auto-clear.
        await sendCheckrReviewAdminEmail(
          supabase,
          onboardingRow.instructor_id,
          onboardingRow.organization_id,
          status,
        );
      } else {
        // Unknown status — log and keep moving.
        console.warn('Checkr report.completed with unknown status', { status, eventId });
      }
    }
    // report.created / invitation.completed / other types: no DB write needed.

    // Stamp the event id AFTER processing succeeds. If anything above threw,
    // we'd already have returned; if any update returned an error, we'd have
    // 500'd. Either way, the retry will replay this event cleanly.
    const { error: stampErr } = await supabase
      .from('contractor_onboarding_status')
      .update({ checkr_last_webhook_event_id: eventId })
      .eq('id', onboardingRow.id);
    if (stampErr) {
      console.error('idempotency stamp failed:', stampErr);
      // Don't fail the response — we've already done the work. Worst case
      // is a retry comes in and runs the work again, which is fine for the
      // status updates (idempotent) but would double-email. Acceptable v1.
    }

    return json({ ok: true });
  } catch (err) {
    console.error('checkr-webhook fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// HMAC verification — Checkr signs the raw body with the API key.
// ────────────────────────────────────────────────────────────────────────────

async function verifyHmac(secret: string, body: string, signatureHex: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const computed = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const computedHex = Array.from(new Uint8Array(computed))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison
  return constantTimeEq(computedHex, signatureHex);
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Emails
// ────────────────────────────────────────────────────────────────────────────

async function sendCheckrCompleteContractorEmail(
  supabase: ReturnType<typeof adminClient>,
  instructorId: string,
  orgId: string,
): Promise<void> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) return;

  const { data: instructor } = await supabase
    .from('instructors')
    .select('first_name, email')
    .eq('id', instructorId)
    .maybeSingle();
  const { data: org } = await supabase
    .from('organizations')
    .select('name, default_sender_name, default_sender_email, slug')
    .eq('id', orgId)
    .maybeSingle();

  if (!instructor?.email || !org?.default_sender_email) return;

  const text = [
    `Hi ${instructor.first_name ?? 'there'},`,
    ``,
    `Good news — your background check came back clear. You're one step closer to being fully onboarded with ${org.name ?? 'us'}.`,
    ``,
    `Log back in to continue: ${PUBLIC_SITE_URL}/${org.slug}/onboarding`,
  ].join('\n');

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `${org.default_sender_name ?? org.name ?? 'enrops'} <${org.default_sender_email}>`,
        to: instructor.email,
        subject: `Your background check is complete`,
        text,
        tags: [{ name: 'type', value: 'checkr_complete' }],
      }),
    });
  } catch (err) {
    console.error('checkr complete email failed:', err);
  }
}

async function sendCheckrReviewAdminEmail(
  supabase: ReturnType<typeof adminClient>,
  instructorId: string,
  orgId: string,
  checkrStatus: string,
): Promise<void> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) return;

  const { data: instructor } = await supabase
    .from('instructors')
    .select('first_name, last_name, email')
    .eq('id', instructorId)
    .maybeSingle();
  const { data: org } = await supabase
    .from('organizations')
    .select('alert_email, name, default_sender_name, default_sender_email')
    .eq('id', orgId)
    .maybeSingle();

  if (!org?.alert_email || !org.default_sender_email) {
    console.warn('cannot send checkr review alert — org missing config', { orgId });
    return;
  }

  const instructorName =
    `${instructor?.first_name ?? ''} ${instructor?.last_name ?? ''}`.trim() ||
    instructor?.email ||
    instructorId;

  const text = [
    `${instructorName}'s background check requires review.`,
    ``,
    `Checkr status: ${checkrStatus}`,
    `Contractor email: ${instructor?.email ?? '(not available)'}`,
    ``,
    `Log in to Checkr's dashboard to review the report. Do NOT clear the contractor in enrops manually — adjudicate in Checkr and the next webhook will sync.`,
  ].join('\n');

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `${org.default_sender_name ?? org.name ?? 'enrops'} <${org.default_sender_email}>`,
        to: org.alert_email,
        subject: `Background check needs review: ${instructorName}`,
        text,
        tags: [{ name: 'type', value: 'checkr_review' }],
      }),
    });
  } catch (err) {
    console.error('checkr review admin email failed:', err);
  }
}
