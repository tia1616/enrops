import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { supabase } from '../lib/supabase.js';

/**
 * Multi-tenant policy page. Route: /:orgSlug/:policyType
 * Resolves org + policy from DB. Works for any provider without code changes.
 *
 * orgSlug comes from URL (e.g. 'j2s' → resolves Journey to STEAM org row)
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
  const orgSlug = orgSlugProp || params.orgSlug;
  const [policy, setPolicy] = useState(null);
  const [orgName, setOrgName] = useState('');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setNotFound(false);

      // Resolve org by slug
      const { data: org } = await supabase
        .from('public_org_directory')
        .select('id, name')
        .eq('slug', orgSlug)
        .maybeSingle();

      if (!org) {
        if (!cancelled) {
          setNotFound(true);
          setLoading(false);
        }
        return;
      }

      // Fetch the matching policy
      const { data: pol } = await supabase
        .from('org_policies')
        .select('content_markdown, effective_date, last_updated')
        .eq('organization_id', org.id)
        .eq('policy_type', policyType)
        .maybeSingle();

      if (cancelled) return;
      setOrgName(org.name);
      setPolicy(pol);
      setNotFound(!pol);
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

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h1 className="font-titan text-3xl text-j2s-ink">Policy not found</h1>
        <p className="mt-4 text-j2s-ink/70">
          We couldn&apos;t find a {title.toLowerCase()} for this provider.
        </p>
        <Link to="/j2s" className="mt-6 inline-block text-j2s-purple hover:underline">
          Return home
        </Link>
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
