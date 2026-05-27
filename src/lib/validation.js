// Shared input validators used across the onboarding wizard, admin
// AddInstructorModal, and anywhere else we collect a contractor's
// name/phone. Rules live here so the wizard, admin form, and any future
// instructor-facing forms all enforce identical gates.

// US phone: 10 digits, or 11 digits starting with 1.
export function phoneIsValid(s) {
  if (!s) return false;
  const digits = String(s).replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

// Gentle "looks like a real name" check. Catches keyboard mash like
// "hhhdfhd" or "asdfgh" without blocking real-world edge cases.
//  - Letters only (Unicode), plus spaces, hyphens, apostrophes, periods
//  - At least 2 chars
//  - Must contain at least one vowel — UNLESS exactly 2 chars (so names
//    like "Ng" or "Le" still pass)
//  - No run of 3+ identical letters in a row (catches "Aaaa" / "hhh...")
export function looksLikeName(s) {
  if (!s) return false;
  const trimmed = String(s).trim();
  if (trimmed.length < 2) return false;
  if (!/^[\p{L}\s'.\-]+$/u.test(trimmed)) return false;
  if (/(\p{L})\1{2,}/u.test(trimmed)) return false;
  if (trimmed.length > 2 && !/[aeiouyàáâãäåèéêëìíîïòóôõöùúûüýÿ]/i.test(trimmed)) return false;
  return true;
}

// Standard email shape. Not exhaustive (no RFC 5322) but catches the
// common typos we want to block.
export function emailIsValid(s) {
  if (!s) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
}
