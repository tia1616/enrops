import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { descriptionAfterClassChange } from '../programDescription.ts';

Deno.test('change class: the new class description replaces the old one', () => {
  assertEquals(
    descriptionAfterClassChange({ isFirstMatch: false, current: 'Minecraft blurb', target: 'Pokemon blurb' }),
    'Pokemon blurb',
  );
});

Deno.test('change class to one with no description: none, never the old class text', () => {
  assertEquals(descriptionAfterClassChange({ isFirstMatch: false, current: 'Minecraft blurb', target: null }), null);
  assertEquals(descriptionAfterClassChange({ isFirstMatch: false, current: 'Minecraft blurb', target: '   ' }), null);
});

Deno.test('first match keeps the operator\'s own description', () => {
  assertEquals(
    descriptionAfterClassChange({ isFirstMatch: true, current: 'Our own words', target: 'Class blurb' }),
    'Our own words',
  );
});

Deno.test('first match fills an empty description from the class', () => {
  assertEquals(descriptionAfterClassChange({ isFirstMatch: true, current: '', target: 'Class blurb' }), 'Class blurb');
  assertEquals(descriptionAfterClassChange({ isFirstMatch: true, current: null, target: null }), null);
});
