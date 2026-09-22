// Tests for encodeDisplayName / formatFromAddress (From-header RFC 5322 quoting).

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { encodeDisplayName, formatFromAddress, renderSignatureBlock, resolveTestRecipient, resolveReplyTo, NO_TENANT_INBOX_MESSAGE, OrgBrand } from '../orgBrand.ts';

// Minimal brand stub — only the two fields formatFromAddress reads matter.
function brandWith(sender_name: string, sender_email = 'sender@mail.enrops.com'): OrgBrand {
  return {
    org_id: 'x', org_name: 'x', sender_name, sender_email,
    reply_to: 'x@x.com', reply_to_source: 'branding', tenant_reply_to: 'x@x.com',
    alert_email: 'x@x.com', logo_url: null,
    primary_color: '#000', secondary_color: '#000', accent_color: '#000', page_bg_color: '#fff',
    email_signature: null, email_signature_image_url: null, email_signature_image_mode: null,
    mailing_address: null, sender_source: 'platform_shared',
    // Added when OrgBrand gained a per-tenant email font. The stub wasn't
    // updated, which broke type-checking for the WHOLE _shared suite - and it
    // went unnoticed because the tests are normally run without --check.
    font_family: 'Poppins, sans-serif',
    // Distinct from alert_email on purpose. alert_email cascades to the
    // platform; this one is tenant-only and nullable, and anything carrying
    // tenant data must route by it. Keeping different values here means a
    // future test that confuses the two fails loudly instead of passing on a
    // coincidence.
    tenant_alert_email: 'tenant@example.com',
  };
}

// --- encodeDisplayName: the common case is untouched (backward compat) ---

Deno.test('plain name is returned unchanged (no quoting)', () => {
  assertEquals(encodeDisplayName('Journey to STEAM'), 'Journey to STEAM');
});

Deno.test('apostrophes, ampersands and periods do NOT trigger quoting', () => {
  assertEquals(encodeDisplayName("St. Mary's Robotics & Chess"), "St. Mary's Robotics & Chess");
  assertEquals(encodeDisplayName('Co. Ltd.'), 'Co. Ltd.');
});

// --- encodeDisplayName: specials force a quoted-string ---

Deno.test('comma triggers quoting', () => {
  assertEquals(encodeDisplayName('Smith, Jones LLC'), '"Smith, Jones LLC"');
});

Deno.test('angle brackets trigger quoting', () => {
  assertEquals(encodeDisplayName('Cool <Camps>'), '"Cool <Camps>"');
});

Deno.test('embedded double-quote is backslash-escaped inside quotes', () => {
  assertEquals(encodeDisplayName('The "Best" Camp'), '"The \\"Best\\" Camp"');
});

Deno.test('embedded backslash is backslash-escaped', () => {
  assertEquals(encodeDisplayName('A\\B'), '"A\\\\B"');
  // Both backslash and quote together, order preserved.
  assertEquals(encodeDisplayName('A"\\B'), '"A\\"\\\\B"');
});

Deno.test('colon, semicolon, at-sign, parens and brackets each trigger quoting', () => {
  assertEquals(encodeDisplayName('a:b'), '"a:b"');
  assertEquals(encodeDisplayName('a;b'), '"a;b"');
  assertEquals(encodeDisplayName('a@b'), '"a@b"');
  assertEquals(encodeDisplayName('a(b)'), '"a(b)"');
  assertEquals(encodeDisplayName('a[b]'), '"a[b]"');
});

// --- encodeDisplayName: header-injection guard (newlines / control chars) ---

Deno.test('newlines are collapsed to a space (header-injection guard)', () => {
  // A CRLF injection attempt cannot survive into the header: the newline is
  // collapsed to a space, and the residual ':'/'@' then force the whole thing
  // into a quoted-string, so it can never be read as extra header fields.
  assertEquals(encodeDisplayName('Acme\r\nBcc: evil@x.com'), '"Acme Bcc: evil@x.com"');
  // A collapsed newline with no other specials stays a bare (unquoted) name.
  assertEquals(encodeDisplayName('Line1\nLine2'), 'Line1 Line2');
});

Deno.test('tabs and other control chars are collapsed to a single space', () => {
  assertEquals(encodeDisplayName('Acme\t\tCamps'), 'Acme Camps');
});

Deno.test('leading/trailing whitespace is trimmed', () => {
  assertEquals(encodeDisplayName('  Acme  '), 'Acme');
});

Deno.test('empty / whitespace-only / control-only name yields empty string', () => {
  assertEquals(encodeDisplayName(''), '');
  assertEquals(encodeDisplayName('   '), '');
  assertEquals(encodeDisplayName('\r\n'), '');
});

// --- formatFromAddress: end-to-end From line ---

Deno.test('formatFromAddress: plain name unchanged (byte-for-byte compat)', () => {
  assertEquals(
    formatFromAddress(brandWith('Journey to STEAM')),
    'Journey to STEAM <sender@mail.enrops.com>',
  );
});

Deno.test('formatFromAddress: name with comma is quoted', () => {
  assertEquals(
    formatFromAddress(brandWith('Smith, Jones LLC')),
    '"Smith, Jones LLC" <sender@mail.enrops.com>',
  );
});

Deno.test('formatFromAddress: newline in name cannot break the header', () => {
  assertEquals(
    formatFromAddress(brandWith('Acme\r\nBcc: evil@x.com')),
    '"Acme Bcc: evil@x.com" <sender@mail.enrops.com>',
  );
});

Deno.test('formatFromAddress: empty name falls back to bare address', () => {
  assertEquals(formatFromAddress(brandWith('')), 'sender@mail.enrops.com');
});

// --- resolveTestRecipient: a test send never escapes the tenant ---
//
// The regression these pin: resolveTestRecipient used to end at
// `brand.alert_email`, which cascades tenant -> Enrops -> a hardcoded Enrops
// address and is therefore NEVER null. An operator whose org had no address of
// its own clicked "Send test" and mailed their instructor roster to Enrops,
// while the admin UI told them it had gone to their own inbox.

Deno.test('resolveTestRecipient: an explicit operator-supplied address wins', () => {
  const brand = brandWith('Acme');
  assertEquals(resolveTestRecipient(brand, 'admin@acme.com'), 'admin@acme.com');
});

Deno.test('resolveTestRecipient: a junk explicit value falls through to the tenant inbox', () => {
  const brand = brandWith('Acme');
  assertEquals(resolveTestRecipient(brand, 'not-an-email'), 'tenant@example.com');
  assertEquals(resolveTestRecipient(brand, '   '), 'tenant@example.com');
  assertEquals(resolveTestRecipient(brand, null), 'tenant@example.com');
  assertEquals(resolveTestRecipient(brand, undefined), 'tenant@example.com');
});

Deno.test('resolveTestRecipient: no tenant inbox yields null, NOT the platform address', () => {
  // The whole point. alert_email is deliberately left populated here, exactly
  // as it is in production, so a regression that reinstates the cascade returns
  // 'x@x.com' and fails this test instead of quietly shipping.
  const brand = { ...brandWith('Acme'), tenant_alert_email: null };
  assertEquals(brand.alert_email, 'x@x.com');
  assertEquals(resolveTestRecipient(brand), null);
  assertEquals(resolveTestRecipient(brand, null), null);
  assertEquals(resolveTestRecipient(brand, 'still-not-an-email'), null);
});

Deno.test('NO_TENANT_INBOX_MESSAGE points at a control that exists, and attributes it to a role that can use it', () => {
  // This string is the ONLY instruction an operator gets when a test send is
  // refused, and it has been wrong twice. It is only true while
  // /admin/email-sender actually writes organizations.alert_email; if that field
  // is ever removed, this test is the tripwire.
  //
  // It must name the destination in the words that appear on screen: the
  // Settings section heading and the page's own h1 are both "Email sender".
  assertEquals(NO_TENANT_INBOX_MESSAGE.includes('Settings'), true);
  assertEquals(NO_TENANT_INBOX_MESSAGE.includes('Email sender'), true);

  // Must NOT tell the reader to do it themselves. The offer surfaces that raise
  // this refusal carry no role gate, so staff reach it, and staff cannot open
  // Settings. Naming the role keeps the sentence true for every reader.
  assertEquals(NO_TENANT_INBOX_MESSAGE.includes('owner or admin'), true);

  // The dead-end wording this replaced must not creep back.
  assertEquals(NO_TENANT_INBOX_MESSAGE.toLowerCase().includes('contact enrops support'), false);
});

Deno.test('resolveTestRecipient: an explicit address still works with no tenant inbox', () => {
  // Refusing must not block the normal path: every admin surface passes the
  // logged-in operator's own address, so a missing org address does not stop
  // an operator testing against themselves.
  const brand = { ...brandWith('Acme'), tenant_alert_email: null };
  assertEquals(resolveTestRecipient(brand, 'admin@acme.com'), 'admin@acme.com');
});

// --- resolveReplyTo: who does a family's reply reach, and who chose it? -----
// 2026-08-19: one Ukulele Project parent's reply reached the platform owner
// instead of his provider, and that org had no org_branding.email_reply_to. It
// DID have organizations.email, which this resolver returns for that shape, so
// the routing was right and that one email is still unexplained. The reportable
// defect was that nothing distinguished an address the operator chose from one
// picked for them. These pin all three states.

const PLATFORM = 'platform-fallback@example.com';

Deno.test('resolveReplyTo: the tenant branding address wins', () => {
  const r = resolveReplyTo({
    tenantBrandingReplyTo: 'hi@provider.com',
    tenantOrgEmail: 'admin@provider.com',
    enropsOrgEmail: 'hello@enrops.example',
    hardcodedFallback: PLATFORM,
  });
  assertEquals(r.reply_to, 'hi@provider.com');
  assertEquals(r.reply_to_source, 'branding');
  assertEquals(r.tenant_reply_to, 'hi@provider.com');
});

Deno.test("resolveReplyTo: the org email answers as 'org_email', NOT as configured", () => {
  // The Ukulele Project's shape: org_branding row present, email_reply_to NULL,
  // organizations.email set. Replies DO reach the provider, so this is not the
  // platform case — but the operator never chose this address for families and it
  // is not what the reply-to field on their settings screen shows them. An earlier
  // version collapsed this into 'tenant', which meant the warning built for this
  // incident could never fire for the org that caused it, while SenderSetupNotice
  // was separately calling the same org unconfigured. If this ever reads
  // 'branding' or 'platform' again, those two surfaces are lying to each other.
  const r = resolveReplyTo({
    tenantBrandingReplyTo: null,
    tenantOrgEmail: 'admin@theukuleleproject.example',
    enropsOrgEmail: 'hello@enrops.example',
    hardcodedFallback: PLATFORM,
  });
  assertEquals(r.reply_to, 'admin@theukuleleproject.example');
  assertEquals(r.reply_to_source, 'org_email');
  assertEquals(r.tenant_reply_to, 'admin@theukuleleproject.example');
});

Deno.test('resolveReplyTo: a blank hardcodedFallback cannot produce an empty reply_to', () => {
  // The docblock promises reply_to is ALWAYS non-empty and every consumer does
  // `reply_to: brand.reply_to` on that promise. `??` only rejects null/undefined,
  // so '' used to pass straight through and Resend would get an empty Reply-To.
  const r = resolveReplyTo({ hardcodedFallback: '' });
  assertEquals(r.reply_to.length > 0, true);
  assertEquals(r.platform_reply_to.length > 0, true);
  assertEquals(r.reply_to_source, 'platform');
});

Deno.test('resolveReplyTo: no tenant address at all is reported as PLATFORM, not hidden', () => {
  const r = resolveReplyTo({
    tenantBrandingReplyTo: null,
    tenantOrgEmail: null,
    enropsOrgEmail: 'hello@enrops.example',
    hardcodedFallback: PLATFORM,
  });
  assertEquals(r.reply_to, 'hello@enrops.example');
  assertEquals(r.reply_to_source, 'platform');
  // The distinguishing signal: null here is what lets a caller or a screen say
  // "this provider has no address" instead of printing a working-looking one.
  assertEquals(r.tenant_reply_to, null);
});

Deno.test('resolveReplyTo: the hardcoded fallback is the last resort, and still resolves', () => {
  // A family must never receive an email with no reply path, even when both the
  // tenant and the platform org rows are empty.
  const r = resolveReplyTo({ hardcodedFallback: PLATFORM });
  assertEquals(r.reply_to, PLATFORM);
  assertEquals(r.reply_to_source, 'platform');
  assertEquals(r.tenant_reply_to, null);
});

Deno.test('resolveReplyTo: whitespace is not an address', () => {
  // '   ' is falsy-adjacent but not falsy - the bug class this guards is a
  // column "set" to blanks reading as configured.
  const r = resolveReplyTo({
    tenantBrandingReplyTo: '   ',
    tenantOrgEmail: '\t\n',
    enropsOrgEmail: 'hello@enrops.example',
    hardcodedFallback: PLATFORM,
  });
  assertEquals(r.reply_to_source, 'platform');
  assertEquals(r.tenant_reply_to, null);
});

Deno.test('resolveReplyTo: addresses are trimmed', () => {
  const r = resolveReplyTo({ tenantBrandingReplyTo: '  hi@provider.com  ', hardcodedFallback: PLATFORM });
  assertEquals(r.reply_to, 'hi@provider.com');
});

Deno.test('resolveReplyTo: alert_email is NOT a reply-to source', () => {
  // Deliberate: alert_email is an INBOUND operator address. reply_to is printed
  // in family email, so folding one into the other would publish an inbox the
  // operator chose for alerts. If this test starts failing, that decision is
  // being reversed - make it on purpose, not by autocomplete.
  const r = resolveReplyTo({
    tenantBrandingReplyTo: null,
    tenantOrgEmail: null,
    // Deliberately not a parameter this function accepts. Kept as a comment so
    // the omission is visible in the test file, not just absent from it.
    enropsOrgEmail: 'hello@enrops.example',
    hardcodedFallback: PLATFORM,
  });
  assertEquals(r.reply_to_source, 'platform');
});

// --- renderSignatureBlock: the contact line that survives a forward ---------
//
// 2026-09-22: a school forwarded a roster email internally, the colleague
// replied to the only address visible to her (the platform's send-only FROM
// address, which has no inbox), and the message reached nobody. Reply-To
// protects a direct reply and does not survive a forward; a visible address in
// the body does. These pin the two things that make it safe.

function brandForSignature(over: Partial<OrgBrand> = {}): OrgBrand {
  return { ...brandWith('Any Org'), ...over };
}

Deno.test('signature: the operator OWN address is shown, so a forwarded copy has a way back', () => {
  const html = renderSignatureBlock(brandForSignature({
    tenant_reply_to: 'admin@theukuleleproject.com',
    email_signature: 'Strumming our way to a brighter future,',
  }));
  assertEquals(html.includes('mailto:admin@theukuleleproject.com'), true);
  assertEquals(html.includes('Questions? Email'), true);
});

Deno.test('signature: NEVER prints the platform address on a tenant email', () => {
  // reply_to always resolves to something; when the operator has set nothing,
  // that something is OURS. Printing it would tell another business's families
  // to write to Enrops. tenant_reply_to is null in exactly that case.
  const html = renderSignatureBlock(brandForSignature({
    tenant_reply_to: null,
    reply_to: 'jessica@enrops.com',
    reply_to_source: 'platform',
    email_signature: 'Warmly,',
  }));
  assertEquals(html.includes('jessica@enrops.com'), false);
  assertEquals(html.includes('Questions? Email'), false);
  // ...and the operator's own signature still renders.
  assertEquals(html.includes('Warmly,'), true);
});

Deno.test('signature: renders for an org with NO signature at all', () => {
  // 7 of 9 tenants had an empty signature, so gating the contact line behind an
  // existing signature would have helped almost nobody.
  const html = renderSignatureBlock(brandForSignature({
    tenant_reply_to: 'leslie@yogaplaygrounds.com',
    email_signature: null,
    email_signature_image_url: null,
    email_signature_image_mode: 'none',
  }));
  assertEquals(html.includes('mailto:leslie@yogaplaygrounds.com'), true);
});

Deno.test('signature: an org with no signature AND no own address still gets nothing', () => {
  const html = renderSignatureBlock(brandForSignature({
    tenant_reply_to: null,
    email_signature: null,
    email_signature_image_url: null,
    email_signature_image_mode: 'none',
  }));
  assertEquals(html, '');
});

Deno.test('signature: an address already in the operator signature is not repeated', () => {
  const html = renderSignatureBlock(brandForSignature({
    tenant_reply_to: 'info@mrsrichelle.com',
    email_signature: 'Mrs. Richelle<div>info@mrsrichelle.com</div>',
  }));
  assertEquals(html.split('info@mrsrichelle.com').length - 1, 1, 'shown once, not twice');
  assertEquals(html.includes('Questions? Email'), false);
});

Deno.test('signature: the address is escaped, so it cannot break out of the markup', () => {
  const html = renderSignatureBlock(brandForSignature({
    tenant_reply_to: 'a"><script>alert(1)</script>@x.com',
    email_signature: null,
  }));
  assertEquals(html.includes('<script>'), false);
  assertEquals(html.includes('&lt;script&gt;'), true);
});

Deno.test('signature: an org with no signature still gets its sign-off, not just an address', () => {
  // Eight senders wrote `${signatureHtml || '— {org}'}`, so the sign-off used to
  // appear exactly when this returned ''. The contact line made it non-empty and
  // silently removed that sign-off from the orgs that never set a signature.
  const html = renderSignatureBlock(brandForSignature({
    org_name: 'Yoga Playgrounds',
    tenant_reply_to: 'leslie@yogaplaygrounds.com',
    email_signature: null,
    email_signature_image_url: null,
    email_signature_image_mode: 'none',
  }));
  assertEquals(html.includes('Yoga Playgrounds'), true, 'the school must still see who it is from');
  assertEquals(html.includes('leslie@yogaplaygrounds.com'), true);
});

Deno.test('signature: an org WITH a signature is unchanged apart from the contact line', () => {
  // Their own sign-off is the one that shows; we must not add a second.
  const html = renderSignatureBlock(brandForSignature({
    org_name: 'The Ukulele Project',
    tenant_reply_to: 'admin@theukuleleproject.com',
    email_signature: 'Strumming our way to a brighter future,<div>The Ukulele Project Team</div>',
  }));
  assertEquals(html.includes('&mdash; The Ukulele Project'), false, 'no duplicate sign-off');
  assertEquals(html.includes('Strumming our way'), true);
  assertEquals(html.includes('admin@theukuleleproject.com'), true);
});
