// stripe-webhook v17 — PATCH 10 (2026-05-01)
// v17: Bug A fix — per-child installment attribution.
//      Reads schedule from checkout_schedules table (keyed by session_id) and
//      inserts N×3 installment rows (one per registration × charge), allowing
//      proper per-child cancellation/refund handling. Falls back to old behavior
//      if schedule_source != 'checkout_schedules' (legacy session compatibility).
// v16: Confirmation email now includes end_time, arrival/dismissal instructions.
//      Fixed support email to info@journeytosteam.com. Email-safe table layout.
// v15: Auto-create parent auth account after payment + send magic-link email.
//      Multi-tenant operator alert emails.
// v14: Fixed payment_method_id storage bug.
// v13: Installments support.
// v12: Fixed confirmation email copy.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || 'Journey to STEAM <hello@updates.journeytosteam.com>';
const PLATFORM_ALERT_DEFAULT = 'alerts@enrops.com';

interface PerLineEntry {
  installment_number: number;
  registration_id: string;
  amount_cents: number;
  due_date: string;
}

serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('Missing signature', { status: 400 });

  const rawBody = await req.text();
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', (err as Error).message);
    return new Response(`Invalid signature: ${(err as Error).message}`, { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const meta = session.metadata || {};
      const regIds = (meta.registration_ids || '').split(',').filter(Boolean);
      const parentEmail = session.customer_email || meta.parent_email;
      const parentName = meta.parent_name || '';
      const useInstallments = meta.use_installments === 'true';

      if (!regIds.length) {
        console.warn('Webhook: no registration_ids in metadata');
        return new Response('ok', { status: 200 });
      }

      // Look up org alert_email for error notifications
      const { data: regForOrg } = await admin.from('registrations').select('organization_id').eq('id', regIds[0]).single();
      const orgId = regForOrg?.organization_id;
      let alertEmail = PLATFORM_ALERT_DEFAULT;
      if (orgId) {
        const { data: orgData } = await admin.from('organizations').select('alert_email').eq('id', orgId).single();
        alertEmail = orgData?.alert_email || PLATFORM_ALERT_DEFAULT;
      }

      await admin.from('registrations').update({
        status: 'confirmed', payment_status: 'paid',
        stripe_payment_intent_id: session.payment_intent as string,
      }).in('id', regIds);

      if (useInstallments) {
        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent as string);

          const customerId = (session.customer as string) || (paymentIntent.customer as string);
          const paymentMethodId = paymentIntent.payment_method as string;

          if (!customerId || !paymentMethodId) {
            console.error('Installments: missing customer or payment_method', { customer: customerId, payment_method: paymentMethodId });
            await sendOperatorAlert({
              to: alertEmail,
              subject: 'Installments queueing failed — manual review needed',
              body: `Session ${session.id} completed with use_installments=true but could not queue installments 2 and 3. customer_id=${customerId} payment_method_id=${paymentMethodId}. Registration IDs: ${regIds.join(', ')}. Charge 1 succeeded; please manually create installment rows or contact parent.`,
            });
          } else {
            // v17: Determine schedule source
            const useNewSchedule = meta.schedule_source === 'checkout_schedules';

            if (useNewSchedule) {
              // === v17 PATH: Read N×3 schedule from checkout_schedules table ===
              const { data: scheduleRow, error: schedErr } = await admin
                .from('checkout_schedules')
                .select('*')
                .eq('stripe_session_id', session.id)
                .single();

              if (schedErr || !scheduleRow) {
                console.error('checkout_schedules lookup failed:', schedErr);
                await sendOperatorAlert({
                  to: alertEmail,
                  subject: 'Schedule lookup failed — manual review needed',
                  body: `Session ${session.id}: webhook fired but checkout_schedules row missing or unreadable. Charge 1 succeeded but installments 2 and 3 could not be queued. Error: ${schedErr?.message || 'no row'}.`,
                });
              } else {
                const perLine = (scheduleRow.schedule?.per_line || []) as PerLineEntry[];

                // Insert ONE row per per_line entry. Charge 1 entries → status='paid'
                // (just charged via Stripe Checkout). Charges 2 and 3 → status='pending'.
                const installmentRows = perLine.map((entry) => {
                  const isPaid = entry.installment_number === 1;
                  return {
                    registration_id: entry.registration_id,
                    installment_number: entry.installment_number,
                    amount_cents: entry.amount_cents,
                    due_date: entry.due_date,
                    status: isPaid ? 'paid' : 'pending',
                    stripe_customer_id: customerId,
                    stripe_payment_method_id: paymentMethodId,
                    organization_id: orgId,
                    // For paid (charge 1) rows, link to the actual paymentIntent.
                    // Multiple rows share one PI because charge 1 is one Stripe charge
                    // split across N children in our DB.
                    stripe_payment_intent_id: isPaid ? (session.payment_intent as string) : null,
                    paid_at: isPaid ? new Date().toISOString() : null,
                  };
                });

                const { error: insertError } = await admin.from('installments').insert(installmentRows);

                if (insertError) {
                  console.error('Failed to insert N×3 installment rows:', insertError);
                  await sendOperatorAlert({
                    to: alertEmail,
                    subject: 'N×3 installment row insert failed — manual review needed',
                    body: `Session ${session.id}: ${installmentRows.length} installment rows could not be inserted. Error: ${insertError.message}. Charge 1 succeeded. Customer ${customerId}, payment method ${paymentMethodId}. Registration IDs: ${regIds.join(', ')}.`,
                  });
                } else {
                  console.log(`v17: Inserted ${installmentRows.length} installment rows for session ${session.id} (${perLine.length} per_line entries)`);
                  // Mark schedule as consumed
                  await admin
                    .from('checkout_schedules')
                    .update({ consumed_at: new Date().toISOString() })
                    .eq('stripe_session_id', session.id);
                }
              }
            } else {
              // === LEGACY PATH (pre-v17 sessions): hardcoded 2-row insert ===
              // Kept for backwards compat with sessions created before v17 deploy.
              const inst2RegId = meta.installment_2_registration_id || regIds[0];
              const inst3RegId = meta.installment_3_registration_id || regIds[0];

              const installmentRows = [
                { registration_id: inst2RegId, installment_number: 2, amount_cents: parseInt(meta.installment_2_amount_cents, 10), due_date: meta.installment_2_due_date, status: 'pending', stripe_customer_id: customerId, stripe_payment_method_id: paymentMethodId, organization_id: orgId },
                { registration_id: inst3RegId, installment_number: 3, amount_cents: parseInt(meta.installment_3_amount_cents, 10), due_date: meta.installment_3_due_date, status: 'pending', stripe_customer_id: customerId, stripe_payment_method_id: paymentMethodId, organization_id: orgId },
              ];

              const { error: insertError } = await admin.from('installments').insert(installmentRows);

              if (insertError) {
                console.error('Failed to insert installment rows (legacy path):', insertError);
                await sendOperatorAlert({
                  to: alertEmail,
                  subject: 'Installment row insert failed (legacy) — manual review needed',
                  body: `Session ${session.id}: legacy 2-row installment insert failed. Error: ${insertError.message}. Charge 1 succeeded.`,
                });
              } else {
                console.log(`Legacy installments queued: 2 pending rows for session ${session.id}`);
                await admin.from('installments').insert({
                  registration_id: regIds[0], installment_number: 1,
                  amount_cents: session.amount_total || 0,
                  due_date: new Date().toISOString().slice(0, 10),
                  status: 'paid', stripe_customer_id: customerId, stripe_payment_method_id: paymentMethodId,
                  stripe_payment_intent_id: session.payment_intent as string,
                  paid_at: new Date().toISOString(), organization_id: orgId,
                });
              }
            }
          }
        } catch (instErr) {
          console.error('Installments processing error:', instErr);
          await sendOperatorAlert({
            to: alertEmail,
            subject: 'Installments error — manual review needed',
            body: `Session ${session.id} encountered an error while processing installments: ${(instErr as Error).message}. Charge 1 likely succeeded. Registration IDs: ${regIds.join(', ')}.`,
          });
        }
      }

      // Confirmation email (unchanged from v16)
      const { data: regs } = await admin.from('registrations').select(
        `id, amount_cents, programs(curriculum, day_of_week, start_time, end_time, first_session_date, term, program_locations(name, address, arrival_instructions)), students(first_name, last_name)`,
      ).in('id', regIds);

      let orgSlug = 'j2s';
      if (orgId) {
        const { data: orgSlugData } = await admin.from('organizations').select('slug').eq('id', orgId).single();
        if (orgSlugData?.slug) orgSlug = orgSlugData.slug;
      }

      if (parentEmail && regs?.length) {
        // For installments, derive aggregated charge breakdown for the email
        let installmentInfo = null;
        if (useInstallments) {
          const useNewSchedule = meta.schedule_source === 'checkout_schedules';
          if (useNewSchedule) {
            const { data: scheduleRow } = await admin
              .from('checkout_schedules')
              .select('schedule')
              .eq('stripe_session_id', session.id)
              .single();
            const aggregated = scheduleRow?.schedule?.aggregated || [];
            const c2 = aggregated.find((a: any) => a.installment_number === 2);
            const c3 = aggregated.find((a: any) => a.installment_number === 3);
            installmentInfo = {
              paidToday: session.amount_total || 0,
              installment2Amount: c2?.amount_cents || 0,
              installment2Date: c2?.due_date || '',
              installment3Amount: c3?.amount_cents || 0,
              installment3Date: c3?.due_date || '',
            };
          } else {
            installmentInfo = {
              paidToday: session.amount_total || 0,
              installment2Amount: parseInt(meta.installment_2_amount_cents || '0', 10),
              installment2Date: meta.installment_2_due_date || '',
              installment3Amount: parseInt(meta.installment_3_amount_cents || '0', 10),
              installment3Date: meta.installment_3_due_date || '',
            };
          }
        }

        await sendConfirmationEmail({
          to: parentEmail, parentName, registrations: regs,
          totalCents: session.amount_total || 0, sessionId: session.id, useInstallments,
          installmentInfo,
        });
      }

      // Auto-create parent account
      if (parentEmail) {
        try {
          await autoCreateParentAccount(admin, parentEmail, parentName, orgSlug, alertEmail);
        } catch (accountErr) {
          console.error('Auto-create parent account failed:', accountErr);
        }
      }
    }

    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('stripe-webhook processing error:', err);
    return new Response(`Error: ${(err as Error).message}`, { status: 500 });
  }
});

async function autoCreateParentAccount(
  admin: ReturnType<typeof createClient>,
  email: string,
  name: string,
  orgSlug: string,
  alertEmail: string,
) {
  const { data: existingUsers } = await admin.auth.admin.listUsers();
  const alreadyExists = existingUsers?.users?.some(
    (u) => u.email?.toLowerCase() === email.toLowerCase(),
  );

  if (alreadyExists) {
    console.log(`Auth user already exists for ${email}, sending dashboard link email`);
    await sendAccountReadyEmail(admin, email, name, orgSlug, false);
    return;
  }

  const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: name },
  });

  if (createErr) {
    if (createErr.message?.includes('already been registered')) {
      console.log(`Auth user already registered for ${email} (race condition), sending dashboard link`);
      await sendAccountReadyEmail(admin, email, name, orgSlug, false);
      return;
    }
    console.error(`Failed to create auth user for ${email}:`, createErr);
    await sendOperatorAlert({
      to: alertEmail,
      subject: `Auto-create account failed for ${email}`,
      body: `Could not create auth user for ${email} after successful payment. Error: ${createErr.message}. The parent can still create an account manually at enrops.com/${orgSlug}/login.`,
    });
    return;
  }

  console.log(`Auth user created for ${email}: ${newUser?.user?.id}`);
  await sendAccountReadyEmail(admin, email, name, orgSlug, true);
}

async function sendAccountReadyEmail(admin: ReturnType<typeof createClient>, email: string, name: string, orgSlug: string, isNew: boolean) {
  const firstName = name ? name.split(' ')[0] : 'there';
  const dashboardUrl = `https://enrops.com/${orgSlug}/dashboard`;
  const loginUrl = `https://enrops.com/${orgSlug}/login`;

  let signInUrl = loginUrl;
  try {
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: dashboardUrl },
    });
    if (linkData?.properties?.action_link) {
      signInUrl = linkData.properties.action_link;
      console.log(`Magic link generated for ${email}`);
    } else {
      console.warn('generateLink returned no action_link:', linkErr?.message);
    }
  } catch (err) {
    console.warn('generateLink failed, falling back to login URL:', (err as Error).message);
  }

  const subject = isNew
    ? `Your parent account is ready — Journey to STEAM`
    : `See your child's program details — Journey to STEAM`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Your Account</title></head><body style="margin:0;padding:0;background:#f5f3ff;font-family:'Nunito Sans',Arial,sans-serif;"><div style="max-width:600px;margin:0 auto;background:#fff;"><div style="background:linear-gradient(135deg,#674EE8,#4430AC);padding:40px 30px;text-align:center;"><div style="color:#F8A638;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Journey to STEAM</div><h1 style="color:#fff;margin:12px 0 0;font-family:'Titan One',Georgia,serif;font-size:28px;">${isNew ? 'Your account is ready!' : 'View your programs'}</h1></div><div style="padding:32px 30px;"><p style="margin:0 0 16px;font-size:16px;color:#1A1530;">Hi ${firstName},</p><p style="margin:0 0 24px;font-size:16px;color:#1A1530;line-height:1.6;">${isNew ? 'We created a parent account for you automatically when you registered. Tap the button below to see your child\'s program schedule and arrival details.' : 'Tap the button below to view your children\'s program details and schedules.'}</p><div style="text-align:center;margin:32px 0;"><a href="${signInUrl}" style="display:inline-block;background:#674EE8;color:#fff;text-decoration:none;padding:16px 40px;border-radius:8px;font-size:16px;font-weight:700;">View my dashboard</a></div><p style="margin:0 0 8px;font-size:14px;color:#6b6880;">This link expires in 24 hours. After that, you can always sign in at <a href="${loginUrl}" style="color:#674EE8;">enrops.com/${orgSlug}/login</a> using the magic link option.</p><p style="margin:24px 0 0;font-size:14px;color:#6b6880;">Questions? Reach us at <a href="mailto:info@journeytosteam.com" style="color:#674EE8;">info@journeytosteam.com</a></p></div><div style="background:#1A1530;padding:20px 30px;text-align:center;color:#fff;opacity:0.6;font-size:12px;">Journey to STEAM &middot; Powered by Enrops &middot; ${new Date().getFullYear()}</div></div></body></html>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: FROM_EMAIL, to: email, subject, html,
        tags: [{ name: 'type', value: isNew ? 'account_created' : 'account_reminder' }],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Account email send failed:', resp.status, errText);
    } else {
      console.log(`Account ${isNew ? 'created' : 'reminder'} email sent to ${email}`);
    }
  } catch (err) {
    console.error('Account email error:', err);
  }
}

async function sendOperatorAlert({ to, subject, body }: { to: string; subject: string; body: string }) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: FROM_EMAIL, to,
        subject: `[Enrops Alert] ${subject}`, text: body,
        tags: [{ name: 'type', value: 'operator_alert' }],
      }),
    });
  } catch (err) {
    console.error('Operator alert send failed:', err);
  }
}

async function sendConfirmationEmail({
  to, parentName, registrations, totalCents, sessionId, useInstallments, installmentInfo,
}: {
  to: string; parentName: string; registrations: any[]; totalCents: number; sessionId: string; useInstallments: boolean;
  installmentInfo: { paidToday: number; installment2Amount: number; installment2Date: string; installment3Amount: number; installment3Date: string; } | null;
}) {
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const fmtDate = (iso: string) => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const greeting = parentName ? `Hi ${parentName.split(' ')[0]}` : 'Hi there';

  const hasAnyArrival = registrations.some((r) => r.programs?.program_locations?.arrival_instructions);

  const regRows = registrations.map((r) => {
    const p = r.programs;
    const s = r.students;
    const loc = p?.program_locations;
    const locationName = loc?.name || '';
    const programName = p?.curriculum || 'Program';
    const timeDisplay = p?.start_time
      ? (p?.end_time ? `${p.start_time}&ndash;${p.end_time}` : p.start_time)
      : '';
    const firstDate = p?.first_session_date ? fmtDate(p.first_session_date) : 'Date TBD';

    const arrivalRow = loc?.arrival_instructions
      ? `<tr><td colspan="2" style="padding:0 16px 16px;"><table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tr><td style="padding:10px 12px;background:#F9F8FE;border-radius:8px;border-left:3px solid #674EE8;font-family:'Nunito Sans',sans-serif;"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#674EE8;margin-bottom:4px;">Arrival &amp; Dismissal</div><div style="font-size:13px;color:#1A1530;line-height:1.6;">${loc.arrival_instructions}</div></td></tr></table></td></tr>`
      : '';

    const hasArrival = !!loc?.arrival_instructions;

    return `<tr>
        <td style="padding:16px 16px ${hasArrival ? '8px' : '16px'};border-bottom:${hasArrival ? 'none' : '1px solid #EDE9FE'};font-family:'Nunito Sans',sans-serif;">
          <div style="font-size:16px;font-weight:700;color:#1A1530;">${programName}</div>
          <div style="font-size:14px;color:#6b6880;margin-top:4px;">${s?.first_name || ''} ${s?.last_name || ''} &middot; ${locationName}</div>
          <div style="font-size:14px;color:#6b6880;margin-top:4px;">${p?.day_of_week || ''}s &middot; ${timeDisplay}</div>
          <div style="font-size:13px;color:#674EE8;margin-top:8px;font-weight:600;">First session: ${firstDate}</div>
        </td>
        <td style="padding:16px;text-align:right;vertical-align:top;border-bottom:${hasArrival ? 'none' : '1px solid #EDE9FE'};font-family:'Nunito Sans',sans-serif;font-weight:700;color:#1A1530;">
          ${fmt(r.amount_cents)}
        </td>
      </tr>${hasArrival ? `${arrivalRow}<tr><td colspan="2" style="border-bottom:1px solid #EDE9FE;"></td></tr>` : ''}`;
  }).join('');

  const totalsBlock = useInstallments && installmentInfo
    ? `<tr><td colspan="2" style="padding:20px 16px;background:#F5F3FF;"><div style="font-family:'Nunito Sans',sans-serif;font-size:15px;font-weight:700;color:#4430AC;margin-bottom:12px;">Your payment plan</div><table cellpadding="0" cellspacing="0" style="width:100%;font-family:'Nunito Sans',sans-serif;font-size:14px;color:#1A1530;"><tr><td style="padding:6px 0;">Today (paid)</td><td style="padding:6px 0;text-align:right;font-weight:700;">${fmt(installmentInfo.paidToday)}</td></tr><tr><td style="padding:6px 0;">Installment 2 &middot; ${fmtDate(installmentInfo.installment2Date)}</td><td style="padding:6px 0;text-align:right;">${fmt(installmentInfo.installment2Amount)}</td></tr><tr><td style="padding:6px 0;">Installment 3 &middot; ${fmtDate(installmentInfo.installment3Date)}</td><td style="padding:6px 0;text-align:right;">${fmt(installmentInfo.installment3Amount)}</td></tr><tr><td style="padding:8px 0 0;border-top:1px solid #DDD8FA;font-weight:700;">Total</td><td style="padding:8px 0 0;border-top:1px solid #DDD8FA;text-align:right;font-weight:700;">${fmt(installmentInfo.paidToday + installmentInfo.installment2Amount + installmentInfo.installment3Amount)}</td></tr></table><div style="font-family:'Nunito Sans',sans-serif;font-size:12px;color:#6b6880;margin-top:10px;">Your card on file will be charged automatically on each date. We'll email you before each charge.</div></td></tr>`
    : `<tr><td style="padding:20px 16px;font-family:'Nunito Sans',sans-serif;font-size:18px;font-weight:700;color:#1A1530;">Total paid</td><td style="padding:20px 16px;text-align:right;font-family:'Titan One',Georgia,serif;font-size:24px;color:#F8A638;">${fmt(totalCents)}</td></tr>`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Registration Confirmation</title></head>
<body style="margin:0;padding:0;background:#f5f3ff;font-family:'Nunito Sans',Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#fff;">
    <div style="background:linear-gradient(135deg,#674EE8,#4430AC);padding:40px 30px;text-align:center;">
      <div style="color:#F8A638;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Journey to STEAM</div>
      <h1 style="color:#fff;margin:12px 0 0;font-family:'Titan One',Georgia,serif;font-size:32px;">You're registered!</h1>
    </div>
    <div style="padding:32px 30px;">
      <p style="margin:0 0 16px;font-size:16px;color:#1A1530;">${greeting},</p>
      <p style="margin:0 0 24px;font-size:16px;color:#1A1530;line-height:1.6;">
        Thanks for signing up! Here's everything you need to know for your child's program.
      </p>
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        ${regRows}
        ${totalsBlock}
      </table>
      <div style="background:#EDE9FE;border-radius:12px;padding:20px;margin-bottom:24px;">
        <div style="font-weight:700;color:#4430AC;margin-bottom:8px;">What happens next?</div>
        <ul style="margin:0;padding-left:20px;color:#1A1530;font-size:14px;line-height:1.8;">
          <li>We'll send a reminder email before the first session</li>
          ${hasAnyArrival ? '<li>Arrival and dismissal details are listed above for each program</li>' : '<li>We\'ll share arrival and dismissal details before the first session</li>'}
          <li>Check your inbox for a separate email with access to your parent dashboard</li>
        </ul>
      </div>
      <p style="margin:0 0 8px;font-size:14px;color:#6b6880;">Questions? Reach us at <a href="mailto:info@journeytosteam.com" style="color:#674EE8;">info@journeytosteam.com</a></p>
      <p style="margin:24px 0 0;font-size:14px;color:#1A1530;font-style:italic;">Future-ready skills, right after school.</p>
    </div>
    <div style="background:#1A1530;padding:20px 30px;text-align:center;color:#fff;opacity:0.6;font-size:12px;">
      Journey to STEAM &middot; Powered by Enrops &middot; ${new Date().getFullYear()}
    </div>
  </div>
</body>
</html>`;

  const resendResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: FROM_EMAIL, to,
      subject: useInstallments ? `You're registered! Your payment plan is set — Journey to STEAM` : `You're registered! — Journey to STEAM`,
      html,
      tags: [
        { name: 'type', value: useInstallments ? 'registration_confirmation_installments' : 'registration_confirmation' },
        { name: 'session', value: sessionId },
      ],
    }),
  });

  if (!resendResp.ok) {
    const body = await resendResp.text();
    console.error('Resend send failed:', resendResp.status, body);
  }
}
