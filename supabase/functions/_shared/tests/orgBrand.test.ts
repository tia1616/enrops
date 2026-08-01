// Tests for encodeDisplayName / formatFromAddress (From-header RFC 5322 quoting).

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { encodeDisplayName, formatFromAddress, resolveTestRecipient, OrgBrand } from '../orgBrand.ts';

// Minimal brand stub — only the two fields formatFromAddress reads matter.
function brandWith(sender_name: string, sender_email = 'sender@mail.enrops.com'): OrgBrand {
  return {
    org_id: 'x', org_name: 'x', sender_name, sender_email,
    reply_to: 'x@x.com', alert_email: 'x@x.com', logo_url: null,
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

Deno.test('resolveTestRecipient: an explicit address still works with no tenant inbox', () => {
  // Refusing must not block the normal path: every admin surface passes the
  // logged-in operator's own address, so a missing org address does not stop
  // an operator testing against themselves.
  const brand = { ...brandWith('Acme'), tenant_alert_email: null };
  assertEquals(resolveTestRecipient(brand, 'admin@acme.com'), 'admin@acme.com');
});
