# Spec Chunk 2 of 3 (REWRITE): Data Model + Upload-First Onboarding Flow

## LOCKED VOCABULARY (see Chunk 0)
- **Curriculum** = reusable lesson library. Lives in `curricula`. UI: "Curriculum."
- **Program** = scheduled offering. Lives in `programs`. UI: "Program."
- **Session** = single class meeting.
- **Term** = time window.
- Do NOT use "Class" / "Course" / "Offering" anywhere.

## Prerequisites
- **Chunk 0 complete**: vocabulary standardized across codebase, `MULTITENANT_AUDIT.md` seeded
- Chunk 1 complete: `extract-curriculum-details` edge function validated against all three test docs

## What this chunk builds
- New `curricula` table + supporting tables for documents and extracted fields
- FK on existing `programs` table linking to `curricula`
- Backfill script for existing FA26 programs
- Upload-first onboarding flow: provider uploads doc as Step 1, AI extracts in Step 2, provider answers gaps + reviews in Step 3 (Chunk 3 builds Step 3's review screen)

This chunk gets the data model right and ships Steps 1-2 of the flow.

---

## Data model

### Migration 1: New `curricula` table

```sql
create table curricula (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  
  -- Core fields (AI-populated, human-editable)
  name text not null,
  short_description text,
  age_range_min int,
  age_range_max int,
  session_count int,
  format text check (format in ('afterschool', 'summer_camp', 'other')),
  session_types_supported text[] default '{}',
  themes text[] default '{}',
  narrative_arc text,
  skills_overall text[] default '{}',
  materials text[] default '{}',
  instructor_guide_notes text,
  
  -- Status tracking
  status text not null default 'draft' check (status in ('draft', 'extracted', 'published')),
  
  -- Metadata
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index curricula_org_id_idx on curricula(organization_id);
create index curricula_status_idx on curricula(status);
```

**RLS:** Org-scoped. Admins read/write within their org. Mirror existing patterns.

### Migration 2: New `curriculum_sessions` table

Per-session data lives separately because sessions are a 1-to-many relationship and we'll query them individually for recaps.

```sql
create table curriculum_sessions (
  id uuid primary key default gen_random_uuid(),
  curriculum_id uuid not null references curricula(id) on delete cascade,
  organization_id uuid not null references organizations(id),
  
  session_number int not null,
  title text,
  description text,
  skills_practiced text[] default '{}',
  materials_session text[] default '{}',
  recap_template text,
  parent_engagement_question text,
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  
  unique(curriculum_id, session_number)
);

create index curriculum_sessions_curriculum_id_idx on curriculum_sessions(curriculum_id);
```

**RLS:** Org-scoped via curriculum_id join.

### Migration 3: New `curriculum_documents` table

Tracks uploaded/linked source documents.

```sql
create table curriculum_documents (
  id uuid primary key default gen_random_uuid(),
  curriculum_id uuid not null references curricula(id) on delete cascade,
  organization_id uuid not null references organizations(id),
  
  source_type text not null check (source_type in ('upload', 'drive_link')),
  storage_path text,
  drive_url text,
  original_filename text,
  mime_type text,
  
  extraction_status text not null default 'pending' check (extraction_status in ('pending', 'processing', 'complete', 'failed')),
  extraction_result jsonb,
  extraction_error text,
  extracted_text text,
  
  uploaded_at timestamptz not null default now(),
  
  constraint document_source_check check (
    (source_type = 'upload' and storage_path is not null) or
    (source_type = 'drive_link' and drive_url is not null)
  )
);

create index curriculum_documents_curriculum_id_idx on curriculum_documents(curriculum_id);
```

**RLS:** Org-scoped.

### Migration 4: New `curriculum_extracted_fields` table

Audit trail of AI extraction, plus a place to mark fields as human-approved.

```sql
create table curriculum_extracted_fields (
  id uuid primary key default gen_random_uuid(),
  curriculum_id uuid not null references curricula(id) on delete cascade,
  organization_id uuid not null references organizations(id),
  
  field_name text not null,
  extracted_value jsonb,
  confidence float check (confidence >= 0 and confidence <= 1),
  source_document_id uuid references curriculum_documents(id),
  human_approved boolean not null default false,
  human_edited_value jsonb,
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  
  unique(curriculum_id, field_name)
);
```

**RLS:** Org-scoped.

### Migration 5: Link existing `programs` table to `curricula`

```sql
alter table programs add column curriculum_id uuid references curricula(id);
create index programs_curriculum_id_idx on programs(curriculum_id);
```

Nullable for now — existing programs will be backfilled but new programs created from the scheduling flow (built later) will require curriculum_id.

### Migration 6: Supabase Storage bucket

Bucket: `curriculum-documents`
Path pattern: `{organization_id}/{curriculum_id}/{document_id}-{original_filename}`
Private bucket. RLS: admins read/write within their org.

### File limits
- Max 25 MB per file
- Max 10 files per curriculum
- Allowed mime types: `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/plain`, `text/markdown`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- Reject everything else with clear inline message

---

## Backfill script

Before the new tables are in heavy use, run a one-time script to create `curricula` rows for J2S's existing FA26 programs.

**Location:** `scripts/backfill-curricula.ts`

**Logic:**
1. Query distinct `curriculum` text values from existing `programs` table (or whatever column currently holds the curriculum name)
2. For each unique name, create a `curricula` row with:
   - `name` = the curriculum name
   - `organization_id` = J2S org id
   - `status` = 'draft'
   - Everything else null
3. Update each `programs` row to set `curriculum_id` to the matching curriculum

After this runs:
- Every existing program is linked to a curriculum
- All curricula are at `status='draft'` (no AI extraction yet)
- When Jessica uploads curriculum docs through the onboarding flow, those drafts get enriched

Run from CLI with confirmation prompt. Print summary: "Created N curricula, linked M programs."

**Do NOT run automatically as part of the migration.** Jessica runs it manually after reviewing the migration succeeded.

---

## UI: Upload-first onboarding flow

Route: `/admin/curricula/new`

**Word everywhere in the UI: "Curriculum."** Not "Program." This is the library, not the scheduled offering.

### Step 1 — Upload (this is the first thing the provider sees)

Single screen, prominent drop zone.

- Heading: "Add a curriculum to your library"
- Subheading: "Drop your lesson plan or curriculum guide here. We'll read it and pull out the details for you."
- Single large drop zone (the Instructor Guide / Lesson Plans equivalent — this is the primary doc)
- Drag-and-drop OR click-to-browse
- Accepted file types listed below the drop zone: `.pdf`, `.docx`, `.txt`, `.md`, `.xlsx`
- "Or link a Google Doc" expandable section below (Chunk 2.5 makes this fully work; for this chunk, just persist the link)
- After file uploads, two smaller optional drop zones appear:
  - "Materials list (optional)"
  - "Student materials / journals (optional)"

Primary CTA: "Extract details with AI" (disabled until at least one file in primary zone)

**On click:**
1. Create `curricula` row with `status='draft'` and `name` = filename minus extension (placeholder, AI will overwrite)
2. Create `curriculum_documents` rows for each uploaded file
3. Trigger extraction (the actual wiring is the start of Step 2)
4. Route to Step 2

### Step 2 — Extraction in progress (the magic moment)

Route: `/admin/curricula/:id/extracting`

Calm, centered, not frantic.

- Heading: "Reading your curriculum..."
- Below: live status messages stream via Supabase Realtime subscription on `curriculum_documents` table
- Each message fades in:
  - "Reading your curriculum..."
  - "Pulling out the lesson structure..."
  - "Writing recap templates for each session..."
  - "Drafting a parent description..."
  - "Done!"
- When all docs complete, primary CTA appears: "Review →"

If extraction fails:
- Show: "Something went wrong reading [filename]."
- Two buttons: "Try again" (re-invokes function) and "Continue anyway" (routes to Step 3 with whatever did extract)

On success, also persist extracted data:
- Update `curricula` row with extracted curriculum-level fields (name, short_description, age_range_min/max, session_count, format, session_types_supported, themes, narrative_arc, skills_overall, materials, instructor_guide_notes)
- Insert `curriculum_sessions` rows (one per session)
- Insert `curriculum_extracted_fields` rows for audit/confidence tracking
- Update `curricula.status = 'extracted'`

### Step 3 — Review (placeholder for Chunk 3)

For this chunk, just render: "Review screen coming in next build phase. [Back to curricula list]"

Chunk 3 builds the full review screen with editable fields, AI-asks-follow-up-questions for low-confidence fields, and the publish action.

---

## Curricula list page (`/admin/curricula`)

Group by status: Draft / Extracted / Published.

Each card:
- Curriculum name
- Status badge
- If extracted: session count, age range, last edited
- CTA depends on status:
  - Draft → "Add curriculum docs →" (routes to upload)
  - Extracted → "Review and publish →" (placeholder for Chunk 3)
  - Published → "Edit" + (eventually) "Schedule a program from this"

"+ New curriculum" button in header routes to `/admin/curricula/new`.

---

## Multi-tenant audit log

Create `MULTITENANT_AUDIT.md` at repo root if it doesn't exist. Seed with known hardcoded items:

```
# Enrops Multi-Tenant Audit

Running list of hardcoded J2S references that need extraction to config/DB before tenant 2 onboards (target: July 31, 2026).

## Frontend
- [ ] Home.jsx has J2S-hardcoded copy, hero, tagline
- [ ] Home page term filter is FA26-only
- [ ] tenants.js district map is J2S-only

## Pricing & terms
- [ ] Term codes (FA26, SP26, WI27) are J2S-specific naming
- [ ] VIP $240/term pricing hardcoded
- [ ] Distance bonus 5000 cents hardcoded in DB trigger — should be `organizations.default_distance_bonus_cents`
- [ ] Cycle naming logic ("SU26" → "Summer 2026") works for quarter system, may break for other cadences

## Email & comms
- [ ] Email templates name J2S explicitly in body copy
- [ ] Resend send domain `updates.journeytosteam.com` — needs `org_branding.send_domain` per-tenant

## Cron & scheduling
- [ ] Reminder cron deadline (3 days) hardcoded — fine for v1

## Curriculum Onboarding — Chunk 2 (date when complete)
- [ ] (Append new hardcoded references found or introduced)
```

Append to this file as you find more. Don't fix existing items in this chunk — audit is tracking discipline, not a sweep.

---

## Build rules
1. Read this chunk end-to-end before writing code
2. Confirm Chunk 1 is complete and prompt is locked
3. Checklist before coding
4. Multi-tenant: every query filters by `organization_id`, no hardcoded J2S references
5. RLS on every new table BEFORE writing code that touches it
6. Mockup the upload screen first — it's the entry point
7. Files local + present
8. No deploy until live test passes end-to-end with a real curriculum doc
9. Word everywhere: "Curriculum," not "Program"

---

## Verification before merging

1. Run all migrations in order
2. Walk through upload flow with LEGO Game Makers doc:
   - Upload doc
   - Confirm `curricula` row created at `status='draft'`
   - Confirm `curriculum_documents` row created with `storage_path` populated
   - Confirm file actually lives in Supabase Storage at the expected path
   - Click "Extract details with AI"
   - Watch Step 2 status messages stream
   - Confirm extraction completes
   - Confirm `curricula` row updated with extracted fields
   - Confirm `curriculum_sessions` rows created (should be 11 for LEGO Game Makers)
   - Confirm `curriculum_extracted_fields` rows created with confidence scores
   - Confirm `curricula.status = 'extracted'`
3. Try invalid file type → graceful error
4. Try 30 MB file → graceful error
5. Try linking a Drive URL → row created with `source_type='drive_link'` (extraction will fail until Chunk 2.5; that's fine)
6. Run the backfill script on a test DB → confirm curricula rows created, programs linked
7. Multi-tenant check: create test second org, confirm curricula don't cross-contaminate

---

## Out of scope (Chunk 3 territory)
- Review screen
- Editing curricula
- Follow-up questions for low-confidence fields
- Publishing flow
- Re-extraction when new docs are added
- Drive link content fetch (Chunk 2.5)
- Coachmarks / walkthrough (defer entirely)

---

## When this chunk is done
- Data model in place
- Backfill script ready
- Upload-first onboarding flow ships Steps 1-2
- Extraction wiring is live (the function from Chunk 1 is now called by the UI)
- Provider can upload a doc and watch AI extract it
- Review screen is the next thing to build (Chunk 3)
