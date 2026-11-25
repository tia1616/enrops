// "Emails they get" (Jessica 2026-11-25): on the provider's page for a partner,
// every automatic email that partner's people receive, and exactly who. The
// rules live in partnerPortalLogic.emailsTheyGet; this only reads and shows.

import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { listPortalAccess } from "../../lib/partnerPortal.js";
import { emailsTheyGet } from "../../lib/partnerPortalLogic.js";

export default function EmailsTheyGet({ orgId, partnerId }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!orgId || !partnerId) return;
    let cancelled = false;
    setRows(null); setError("");
    (async () => {
      try {
        const [contacts, sites, logins, partner, roster] = await Promise.all([
          supabase.from("partner_contacts").select("contact_name, contact_email")
            .eq("organization_id", orgId).eq("partner_id", partnerId).then((r) => { if (r.error) throw r.error; return r.data ?? []; }),
          supabase.from("program_locations").select("contact_email")
            .eq("organization_id", orgId).eq("partner_id", partnerId).then((r) => { if (r.error) throw r.error; return r.data ?? []; }),
          listPortalAccess(orgId).then((all) => all.filter((g) => g.partner_id === partnerId)),
          supabase.from("partners").select("show_family_payments")
            .eq("organization_id", orgId).eq("id", partnerId).maybeSingle().then((r) => (r.error ? null : r.data)),
          // The roster email is one switch per business (Automations).
          supabase.from("automations").select("enabled, template:automation_templates!inner(key)")
            .eq("organization_id", orgId).eq("template.key", "partner_roster").maybeSingle()
            .then((r) => (r.error ? null : r.data ? !!r.data.enabled : false)),
        ]);
        if (cancelled) return;
        setRows(emailsTheyGet({
          contacts,
          siteEmails: [...new Set(sites.map((s) => (s.contact_email || "").trim()).filter(Boolean))],
          logins,
          rosterOn: roster,
          sharesPaid: !!partner?.show_family_payments,
        }));
      } catch (err) {
        if (!cancelled) setError(`Couldn't load who gets what: ${err?.message ?? "unknown error"}`);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, partnerId]);

  return (
    <section className="mt-5 rounded-2xl bg-white p-4 shadow-card">
      <h2 className="text-base font-bold text-j2s-ink">Emails they get</h2>
      <p className="mt-0.5 text-sm text-j2s-ink/60">Every automatic email enrops sends their people, and exactly who gets it.</p>
      {error && <p role="alert" className="error-text mt-2">{error}</p>}
      {rows === null && !error ? (
        <p className="mt-2 text-sm text-j2s-ink/60">Loading…</p>
      ) : rows && (
        <ul className="mt-3 divide-y divide-j2s-ink/10">
          {rows.map((r) => (
            <li key={r.key} className="py-2.5">
              <div className="text-sm font-semibold text-j2s-ink">{r.title}</div>
              <div className="text-xs text-j2s-ink/60">{r.when}</div>
              <div className="mt-0.5 text-sm text-j2s-ink/80">
                {r.to.length ? `To: ${r.to.join(", ")}` : null}
                {r.note && <span className={r.to.length ? "ml-1 text-j2s-ink/55" : "text-j2s-ink/55"}>{r.to.length ? `(${r.note})` : r.note}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
