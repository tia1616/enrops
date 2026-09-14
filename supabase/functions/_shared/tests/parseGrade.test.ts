// Pins the grade parser both roster importers share.
//
// The reason this file exists: "K" used to return null, so the most common value
// on a primary-school roster imported as no grade at all. Every assertion below
// that mentions K is that defect, held down.
//
// Run: deno test supabase/functions/_shared/tests/parseGrade.test.ts
import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseGrade } from '../parseGrade.ts';

Deno.test('K is Kindergarten, not nothing - the defect this file exists for', () => {
  assertEquals(parseGrade('K'), 0);
  assertEquals(parseGrade('k'), 0);
  assertEquals(parseGrade(' K '), 0);
  assertEquals(parseGrade('Kinder'), 0);
  assertEquals(parseGrade('Kindergarten'), 0);
  assertEquals(parseGrade('KG'), 0);
});

Deno.test('Pre-K is tested before K, or a pre-schooler becomes a kindergartener', () => {
  assertEquals(parseGrade('Pre-K'), -1);
  assertEquals(parseGrade('PreK'), -1);
  assertEquals(parseGrade('pre k'), -1);
  assertEquals(parseGrade('PK'), -1);
  assertEquals(parseGrade('Preschool'), -1);
});

Deno.test('the numeric spellings a school actually types', () => {
  assertEquals(parseGrade('3'), 3);
  assertEquals(parseGrade(5), 5);
  assertEquals(parseGrade('1st'), 1);
  assertEquals(parseGrade('Grade 4'), 4);
  assertEquals(parseGrade(' 6 '), 6);
  assertEquals(parseGrade('12'), 12);
});

Deno.test('zero stays zero and is never confused with absent', () => {
  assertEquals(parseGrade(0), 0);
  assertEquals(parseGrade('0'), 0);
  // The whole point: absent and Kindergarten are different answers.
  assertEquals(parseGrade(''), null);
  assertEquals(parseGrade(null), null);
  assertEquals(parseGrade(undefined), null);
});

Deno.test('unreadable is null, never a guess', () => {
  assertEquals(parseGrade('n/a'), null);
  assertEquals(parseGrade('unknown'), null);
  assertEquals(parseGrade('   '), null);
});

Deno.test('out of range is refused rather than stored', () => {
  assertEquals(parseGrade('17'), null);
  assertEquals(parseGrade('-2'), null);
  assertEquals(parseGrade('1999'), null); // a stray birth year in the grade column
});
