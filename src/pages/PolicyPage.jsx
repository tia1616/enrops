import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { supabase } from '../lib/supabase.js';

/**
 * Multi-tenant policy page.
 *
 * Two ways in:
 *   1. Provider routes — `/:slug/privacy`, `/:slug/terms`. The org comes from the
 *      URL slug, so /the-ukulele-project/privacy renders THAT provider's policy.
 *   2. Platform routes — `/privacy`, `/terms`, `/dpa`, ... These pass
 *      orgSlug="enrops" explicitly because there is no slug in the URL. These are
 *      Enrops' own docs and apply to every user of every provider.
 *
 * The prop deliberately wins over the URL param, but it is ONLY ever set on the
 * platform routes. It used to be hardcoded to "j2s" on the provider routes too,
 * which made /{any-slug}/privacy serve Journey to STEAM LLC's actual privacy
 * policy under another provider's brand.
 *
 * policyType is one of POLICY_TITLES keys below.
 */

const POLICY_TITLES = {
  privacy: 'Privacy Policy',
  terms: 'Terms of Service',
  'acceptable-use': 'Acceptable Use Policy',
  cookies: 'Cookie & Tracking Technologies Disclosure',
  'data-retention': 'Data Retention & Deletion Policy',
  subprocessors: 'Subprocessor Disclosure',
  dpa: 'Data Processing Agreement',
};
export default function PolicyPage({ policyType, orgSlug: orgSlugProp }) {
  const params = useParams();
  // The route param in App.jsx is `:slug` (not `:orgSlug`). `params.orgSlug` was
  // always undefined, which is why the hardcoded prop was masking the bug.
  const orgSlug = orgSlugProp || params.slug;
  const isPlatformDoc = orgSlug === 'enrops';
  const [policy, setPolicy] = useState(null);
  const [orgName, setOrgName] = useState('');
  const [loading, setLoading] = useState(true);
  // 'org' = the slug doesn't resolve to a provider at all.
  // 'policy' = the provider is real but hasn't published this document.
  const [missing, setMissing] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setMissing(null);

      // Resolve org by slug
      const { data: org } = await supabase
        .from('public_org_directory')
        .select('id, name')
        .eq('slug', orgSlug)
        .maybeSingle();

      if (!org) {
        if (!cancelled) {
          setMissing('org');
          setLoading(false);
        }
        return;
      }

      // Fetch the matching policy. published = false is a hidden draft, so it
      // reads to families exactly like "not published yet" — never show it.
      const { data: pol } = await supabase
        .from('org_policies')
        .select('content_markdown, effective_date, last_updated')
        .eq('organization_id', org.id)
        .eq('policy_type', policyType)
        .eq('published', true)
        .maybeSingle();

      if (cancelled) return;
      setOrgName(org.name);
      setPolicy(pol);
      setMissing(pol ? null : 'policy');
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [orgSlug, policyType]);

  const title = POLICY_TITLES[policyType] || 'Policy';

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <p className="text-j2s-ink/50">Loading&hellip;</p>
      </div>
    );
  }

  if (missing) {
    // Two genuinely different situations, so say which one it is rather than a
    // generic 404. Never fall back to another org's document — a policy is a
    // legal statement about who handles your child's data.
    // When the SLUG itself didn't resolve, `/${orgSlug}` is another dead end
    // (PublicLayout would render its own "couldn't find that page"). Only offer
    // the provider's home when we know the provider is real.
    const providerHome =
      missing === 'policy' && orgSlug && !isPlatformDoc ? `/${orgSlug}` : '/';
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        {missing === 'org' ? (
          <>
            <h1 className="font-titan text-3xl text-j2s-ink">We couldn&rsquo;t find that page</h1>
            <p className="mt-4 text-j2s-ink/70">
              The link you followed may be old, or the provider&rsquo;s address may have changed.
            </p>
          </>
        ) : (
          <>
            <h1 className="font-titan text-3xl text-j2s-ink">No {title.toLowerCase()} published yet</h1>
            <p className="mt-4 text-j2s-ink/70">
              {orgName || 'This provider'} hasn&rsquo;t published a {title.toLowerCase()} yet.
              Enrops, the platform that runs their registration, publishes its own
              policies covering how your account and payment information are handled.
            </p>
            <p className="mt-4 text-sm text-j2s-ink/60">
              For questions about how {orgName || 'this provider'} handles your family&rsquo;s
              information, contact them directly.
            </p>
          </>
        )}
        <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {!isPlatformDoc && (
            <Link to={`/${policyType === 'terms' ? 'terms' : 'privacy'}`} className="text-j2s-purple hover:underline">
              Read the Enrops {policyType === 'terms' ? 'Terms of Service' : 'Privacy Policy'}
            </Link>
          )}
          <Link to={providerHome} className="text-j2s-purple hover:underline">
            Return home
          </Link>
        </div>
      </div>
    );
  }

  const effectiveDate = policy.effective_date
    ? new Date(policy.effective_date + 'T00:00:00').toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null;
  const lastUpdated = policy.last_updated
    ? new Date(policy.last_updated).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="mb-2 text-xs uppercase tracking-wider text-j2s-ink/50">{orgName}</div>
      <h1 className="font-titan text-3xl text-j2s-ink sm:text-4xl">{title}</h1>
      {(effectiveDate || lastUpdated) && (
        <p className="mt-2 text-xs text-j2s-ink/50">
          {effectiveDate && <>Effective {effectiveDate}</>}
          {effectiveDate && lastUpdated && <> &middot; </>}
          {lastUpdated && <>Last updated {lastUpdated}</>}
        </p>
      )}

      <div className="policy-prose mt-8 text-j2s-ink/90">
        <ReactMarkdown
          components={{
            // The DB content sometimes starts with a `#` title — hide it
            // here since we already render the title above.
            h1: () => null,
            h2: ({ node, ...props }) => (
              <h2 className="mt-8 font-titan text-xl text-j2s-ink" {...props} />
            ),
            h3: ({ node, ...props }) => (
              <h3 className="mt-6 text-sm font-bold uppercase tracking-wide text-j2s-ink/80" {...props} />
            ),
            p: ({ node, ...props }) => (
              <p className="mt-3 leading-relaxed" {...props} />
            ),
            ul: ({ node, ...props }) => (
              <ul className="mt-3 list-disc space-y-2 pl-6" {...props} />
            ),
            ol: ({ node, ...props }) => (
              <ol className="mt-3 list-decimal space-y-2 pl-6" {...props} />
            ),
            li: ({ node, ...props }) => <li className="leading-relaxed" {...props} />,
            strong: ({ node, ...props }) => (
              <strong className="font-bold text-j2s-ink" {...props} />
            ),
            em: ({ node, ...props }) => (
              <em className="italic" {...props} />
            ),
            a: ({ node, ...props }) => (
              <a className="text-j2s-purple hover:underline" {...props} />
            ),
            hr: () => <hr className="mt-8 border-j2s-ink/10" />,
          }}
        >
          {policy.content_markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}
