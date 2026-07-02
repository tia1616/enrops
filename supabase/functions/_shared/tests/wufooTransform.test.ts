// Tests for wufooTransform. Pure-function tests; no Supabase or Wufoo network.
// Fixture is modeled on Shoreview Chess's real Wufoo membership form.
// Run: deno test supabase/functions/_shared/tests/wufooTransform.test.ts

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
  wufooEntryToContact,
  wufooEntriesToContacts,
  WufooFieldMapping,
} from '../wufooTransform.ts';

// His form fields, assigned placeholder Wufoo field ids (real ids come from
// /fields.json at connect time; the transform is agnostic to the actual ids).
const SHOREVIEW_MAPPING: WufooFieldMapping = {
  email: 'Field10',
  parent_first: 'Field6',
  parent_last: 'Field7',
  child_first: 'Field2',
  child_last: 'Field3',
  phone: 'Field8',
  tag_fields: ['Field1'], // Membership Options -> tier tag
  static_tags: ['wufoo'],
};

function shoreviewEntry(overrides: Record<string, unknown> = {}) {
  return {
    EntryId: '42',
    Field1: 'All-Inclusive $120',
    Field2: 'Aiden',
    Field3: 'Bell',
    Field4: '0', // USCF ID — not mapped to a contact
    Field6: 'Marcus',
    Field7: 'Bell',
    Field8: '510-555-0101',
    Field9: '510-555-9999', // emergency phone — not mapped to a contact
    Field10: 'Marcus.Bell@Example.com',
    DateCreated: '2026-07-02 10:00:00',
    ...overrides,
  };
}

Deno.test('maps his form entry to the contact shape (tier -> tag, email lowercased)', () => {
  const c = wufooEntryToContact(shoreviewEntry(), SHOREVIEW_MAPPING);
  assertEquals(c.email, 'marcus.bell@example.com');
  assertEquals(c.parent_name, 'Marcus Bell');
  assertEquals(c.phone, '510-555-0101');
  assertEquals(c.child_first_name, 'Aiden');
  assertEquals(c.child_last_name, 'Bell');
  assertEquals(c.tags, ['All-Inclusive $120', 'wufoo']);
});

Deno.test('multi-value tier cell splits into multiple tags', () => {
  const c = wufooEntryToContact(
    shoreviewEntry({ Field1: 'All-Inclusive $120, vip' }),
    SHOREVIEW_MAPPING,
  );
  assertEquals(c.tags, ['All-Inclusive $120', 'vip', 'wufoo']);
});

Deno.test('missing optional fields become null, not empty string', () => {
  const c = wufooEntryToContact(
    { Field10: 'solo@example.com' },
    SHOREVIEW_MAPPING,
  );
  assertEquals(c.email, 'solo@example.com');
  assertEquals(c.parent_name, null);
  assertEquals(c.phone, null);
  assertEquals(c.child_first_name, null);
  assertEquals(c.child_last_name, null);
  // Only the static tag survives when the tier cell is absent.
  assertEquals(c.tags, ['wufoo']);
});

Deno.test('single full-name field variant (parent_full) works', () => {
  const c = wufooEntryToContact(
    { FieldA: 'jane@example.com', FieldB: 'Jane Q. Doe' },
    { email: 'FieldA', parent_full: 'FieldB' },
  );
  assertEquals(c.parent_name, 'Jane Q. Doe');
  assertEquals(c.tags, []);
});

Deno.test('whitespace in values is trimmed', () => {
  const c = wufooEntryToContact(
    shoreviewEntry({ Field1: '  vip  ', Field6: '  Marcus  ', Field10: '  Marcus.Bell@Example.com  ' }),
    SHOREVIEW_MAPPING,
  );
  assertEquals(c.email, 'marcus.bell@example.com');
  assertEquals(c.parent_name, 'Marcus Bell');
  assertEquals(c.tags, ['vip', 'wufoo']);
});

Deno.test('wufooEntriesToContacts drops rows with no valid email', () => {
  const entries = [
    shoreviewEntry(), // valid
    shoreviewEntry({ Field10: 'not-an-email' }), // invalid -> dropped
    shoreviewEntry({ Field10: '' }), // empty -> dropped
    shoreviewEntry({ Field10: 'second@example.com' }), // valid
  ];
  const contacts = wufooEntriesToContacts(entries, SHOREVIEW_MAPPING);
  assertEquals(contacts.length, 2);
  assertEquals(contacts.map((c) => c.email), ['marcus.bell@example.com', 'second@example.com']);
});
