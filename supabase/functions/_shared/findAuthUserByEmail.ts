// Find an auth user by email address, across ALL pages.
//
// WHY THIS EXISTS
// `auth.admin.listUsers()` with no arguments returns only the FIRST page --
// 50 users, newest first. Every caller that then does `.find(u => u.email === x)`
// is therefore only searching the 50 most recently created accounts, and reads
// "no such user" for everybody older. Prod is long past 50 users, so in practice
// the check answers correctly only for accounts created in the last few days.
//
// This has now bitten in four places: auth-send-magic-link (old instructors got
// a bogus "already registered", old parents got a silent no-op with no email),
// invite-parents (duplicate createUser attempts and un-healed parents.auth_id),
// stripe-webhook (existence check read FALSE and only reached the right branch
// because createUser threw), and the two invite functions this module was
// extracted for, where a miss is fatal: admin-invite and contractor-invite sit
// inside the createUser "already registered" recovery path, so failing to find
// the account returns 500 auth_create_failed and the invite just fails.
//
// perPage matches admin-list-members and invite-parents. We return as soon as
// the address is found, so the common case still reads a single page, and stop
// early on a short page rather than burning requests. MAX_PAGES is a runaway
// cap, not an expected limit.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const PER_PAGE = 1000;
const MAX_PAGES = 50;

export async function findAuthUserByEmail(admin: SupabaseClient, email: string) {
  const target = email.trim().toLowerCase();
  if (!target) return null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) {
      // Report "could not look up", never "does not exist" -- the caller's next
      // decision depends on the difference.
      console.error('listUsers failed:', error.message);
      return null;
    }
    const users = data?.users ?? [];
    const hit = users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit;
    if (users.length < PER_PAGE) return null;
  }
  console.error(`findAuthUserByEmail: hit MAX_PAGES (${MAX_PAGES}) without a match`);
  return null;
}
