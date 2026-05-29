# Orphaned Registration Rules — SU26 Roster Building

**Purpose:** Tells the roster builder how to handle registrations whose Squarespace listing name does not match a current tracker curriculum. Use for enrollment counts AND rosters — orphan kids belong in the matched camp's roster.

**Where this runs:** Enforced by the `apps-script-roster-sync` Supabase edge function (see `ORPHAN_LISTINGS` const in `supabase/functions/apps-script-roster-sync/index.ts`). When a new orphan listing appears, add it to this doc's table **and** to the `ORPHAN_LISTINGS` const, then redeploy the edge function. Single-candidate slots match correctly without this map; it only matters when an orphan listing collides with a slot that has multiple candidate camps.

## Core Rule

A registration whose listing name has **no matching tracker curriculum** folds into the camp with the **same DATE + LOCATION + SESSION**. It is counted (and rostered) under the curriculum the tracker currently lists for that slot.

Match key = `(date_range, location_city, session)` where session ∈ {Morning, Afternoon, Full-Day}.

The orphan child's listing name is discarded for grouping; they join the roster of the matched camp.

## City → Tracker Venue

| Listing city | Tracker venue |
|---|---|
| Beaverton | Bricks & Minifigs |
| Hillsboro | Hillsboro P&R |
| Happy Valley | Happy Valley P&R |
| Vancouver | Firstenburg |
| Oregon City | St. Paul's Episcopal |
| Camas (7/6–7/30) | Lacamas Lodge |
| Camas (8/3) | Camas Community Center |
| Portland | **Ambiguous** — disambiguate by session + curriculum (see below) |

**Portland disambiguation:** Full-Day Portland → Catlin Gabel. Morning/Afternoon Portland → Overlook House.

## Known Orphan Listings (SU26)

| Original listing | Date | Location | Session | Orders | # Kids | → Camp |
|---|---|---|---|---|---|---|
| Bricks & Bots | 7/13–7/17 | Beaverton | Afternoon | #00109 Hulme (×2 kids), #00079 Gurumoorthy (×1 kid) | 3 | Bricks & Minifigs — Minecraft Makers (7/13 PM) |
| Bricks & Bots | 7/27–7/31 | Portland | Afternoon | #00111 Tanner (×2 kids) | 2 | Overlook House — Minecraft Makers (7/27 PM) |

> "Bricks & Bots" is a legacy Squarespace listing name with no matching tracker curriculum. Both instances fold to the Minecraft Makers afternoon slot at the same venue/date.

> **Heads-up:** the child's last name is not always the order/parent last name. The Gurumoorthy order (#00079) is for student **Vihaan Sabinesh**. Always match orphans by **order number** or **parent email**, never by student last name.

## Process for New Orphans

1. Identify any registration whose listing name has no matching tracker curriculum.
2. Extract `(date, location, session)` from the listing.
3. Map location city → tracker venue (table above; disambiguate Portland by session/curriculum).
4. Find the tracker camp matching that date + venue + session.
5. Add the child to that camp's roster under its current curriculum.
6. Key the registration to the child via **order number or parent email**, not student last name (parent and student last names often differ).
7. Log the orphan in the mapping table so counts and rosters stay reconciled.

## Verify-Later Flags

- Hema Gurumoorthy (#00079, hemalatha86@gmail.com) — student **Vihaan Sabinesh**. Partial refund, but kept in all 4 signed-up camps per Jessica. Verified 2026-05-29: all 4 camps `confirmed` in DB (7/6 Catlin Gabel Intro Robotics full-day, 7/13 AM LEGO Game Makers, 7/13 PM Minecraft Makers, 8/3 Catlin Gabel LEGO Superheroes).

## Audit Log

- **2026-05-29** — SU26 orphan rosters audited against Supabase. All 5 orphan kids (Breckin Hulme, Jensen Hulme, Vihaan Sabinesh, Emmett Tanner, Sydney Tanner) already on correct Minecraft Makers camp_sessions. No DB fixes required. Stray rows: Emmett + Sydney Tanner each have a `cancelled` "Next Level Robotics" registration on 7/27 (leftover from prior placement, harmless).
