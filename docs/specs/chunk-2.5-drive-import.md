# Spec Chunk 2.5 of 4 (REWRITE): Google Drive Import

## LOCKED VOCABULARY (see Chunk 0)
"Curriculum" = lesson library, "Program" = scheduled offering. Never substitute.

## Why this chunk exists
Jessica's existing J2S curriculum library lives in Google Drive. She needs to import from Drive, not just upload files. This unblocks dogfooding the curriculum onboarding flow with real J2S content.

Slots between Chunk 2 (data model + upload + Step 1-2 of flow) and Chunk 3 (review screen). By end, providers can upload OR link Drive docs; both paths feed the same `curriculum_documents` table.

## Prerequisites
- Chunks 1 and 2 complete
- Google Cloud project set up (steps below)

---

## What this chunk builds

1. Google OAuth connection per organization
2. Drive link validation in the curriculum upload zone
3. Drive document fetch → store as text in `curriculum_documents.extracted_text`
4. Token storage with refresh handling

---

## Architectural decision: snapshot on link

When the provider links a Drive doc, immediately fetch the content and store it as a snapshot. The Drive doc becomes a snapshot at link time. If the doc changes later, the provider re-links — same UX as re-uploading.

Simpler downstream code: extraction reads `extracted_text` whether the source was upload-and-parse or Drive-and-fetch. "Refresh from Drive" button can come later if it becomes a real need.

---

## Data model

### Migration: extend `curriculum_documents` table

The `extracted_text` column already exists from Chunk 2. No schema change needed.

### New table: `organization_google_tokens`

```sql
create table organization_google_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  scopes text[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, user_id)
);
```

**RLS:** Only the user who granted the token can read it. Admins can see a connection exists for the org (boolean), but not the token itself. Mirror any existing OAuth patterns.

**Encryption:** Store tokens encrypted using Supabase Vault. Do NOT store raw tokens in plaintext. If Vault isn't wired up in this codebase yet, flag it and pause — talk to Jessica before persisting any tokens.

---

## Google Cloud setup (Jessica does this before Claude Code writes code)

1. Create Google Cloud project (or use existing Enrops one — check first)
2. Enable Google Drive API
3. Create OAuth 2.0 credentials (Web application)
4. Authorized redirect URIs:
   - Production: `https://enrops.com/auth/google/callback`
   - Dev: `http://localhost:5173/auth/google/callback`
5. Scopes: `https://www.googleapis.com/auth/drive.readonly` (read-only, never write)
6. Add Jessica's Google account as a test user during dev
7. Provide CLIENT_ID, CLIENT_SECRET, redirect URIs to Claude Code via env vars

**Claude Code does NOT proceed until Jessica completes setup and provides credentials.**

---

## OAuth flow

### Settings page connection card

In `/admin/settings` (create if doesn't exist), add a "Connections" section.

Card:
- Title: "Google Drive"
- Description: "Connect your Google Drive to import curriculum documents directly into Enrops."
- Status: "Not connected" / "Connected as [email]"
- CTA: "Connect Google Drive" / "Disconnect"

### Initiate connection

Click "Connect" → redirect to Google OAuth consent screen with configured client_id, scopes, redirect URI. Include `state` param (random UUID) for CSRF protection.

### Callback handler

`/auth/google/callback`:
1. Validate state parameter
2. Exchange code for tokens (access_token, refresh_token, expires_in) via Google's token endpoint
3. Encrypt tokens
4. Upsert into `organization_google_tokens` (organization_id, user_id)
5. Redirect to `/admin/settings` with success toast

### Disconnect

Delete the row from `organization_google_tokens`. Optionally call Google's revocation endpoint (best practice, not required v1).

---

## Drive link handling in curriculum upload

Update Chunk 2's Step 1 upload zone to actually fetch Drive content when a link is added.

### Provider pastes a Drive link

1. Validate URL matches `docs.google.com/document/d/{fileId}/...` pattern
2. Extract `fileId`
3. Check if org has active Google connection in `organization_google_tokens`
4. If NOT connected: inline message "Connect Google Drive to import this document. [Connect →]" linking to settings
5. If connected: call edge function `fetch-drive-document` with fileId

### Edge function: `fetch-drive-document`

**Input:** `file_id`, `organization_id`

**Steps:**
1. Look up org's Google tokens
2. If `token_expires_at` is past, refresh using `refresh_token` (Google token endpoint, update row)
3. Get file metadata: `GET https://www.googleapis.com/drive/v3/files/{fileId}?fields=mimeType,name`
4. Based on mimeType, fetch content:
   - `application/vnd.google-apps.document` → `GET .../files/{fileId}/export?mimeType=text/plain`
   - `application/pdf` → `GET .../files/{fileId}?alt=media` (raw, will be parsed downstream)
   - `application/vnd.openxmlformats-officedocument.wordprocessingml.document` → `GET .../files/{fileId}?alt=media` (raw)
   - Other Google native types → export as `text/plain`
5. Return text content + metadata (filename, mimeType)

### After fetch succeeds

Create `curriculum_documents` row:
- `source_type='drive_link'`
- `drive_url` = original URL
- `original_filename` = from Drive metadata
- `mime_type` = from Drive metadata
- `extracted_text` = fetched text content
- `extraction_status='pending'` (Chunk 3 will run AI extraction)

Show linked doc inline below drop zone (same UX as uploaded files). Include remove (×) button.

### Error handling

Inline messages in the upload zone (not modals):
- Token expired, refresh failed → "Your Google connection expired. [Reconnect →]"
- Doc not found / no access → "We couldn't access that document. Make sure it's in a Drive you own and try again."
- Rate limited → "Google is rate-limiting us. Try again in a minute."

---

## What changes in Chunk 3

Chunk 3's `extract-curriculum-details` function already reads `extracted_text` when present. No change needed in Chunk 3 — Drive-linked and uploaded docs flow through the same extraction path.

---

## Build rules
1. Read this chunk end-to-end before writing code
2. Confirm Chunks 1 and 2 are complete
3. **Confirm Jessica has completed Google Cloud setup and provided credentials BEFORE writing any code**
4. Checklist before coding
5. Multi-tenant: tokens org-scoped, never cross orgs
6. Tokens MUST be encrypted at rest — pause if Vault not wired up
7. Use Google's recommended OAuth library (`google-auth-library` for Node), don't hand-roll
8. Test with Jessica's Google account before deploying

---

## Multi-tenant audit log

Append to `MULTITENANT_AUDIT.md`:
- Watch for hardcoded Google Cloud client IDs in dev vs prod
- "Connect Google Drive" copy on settings card should NOT mention J2S
- Redirect URIs hardcoded to enrops.com + localhost — fine for v1, multi-domain later

---

## Verification before shipping

1. Connect Jessica's Google account via OAuth
2. Confirm tokens land in `organization_google_tokens`, encrypted
3. Paste a Drive link to one of three test docs (LEGO Game Makers, Minecraft Makers, Toy Designers)
4. Confirm `curriculum_documents` row created with `extracted_text` populated
5. Confirm text matches original doc
6. Disconnect → confirm tokens removed
7. Re-connect → confirm flow works again
8. Multi-tenant: create test second org, confirm they can't see or use J2S's tokens

---

## Out of scope (defer)
- Drive folder selection (paste links only for v1)
- Drive document picker UI (Google's picker JS lib is its own project)
- Auto-import existing curriculum library in bulk (one-off migration script later, after Chunks 1-3 ship)
- Webhook for "Drive doc updated, re-extract"
- Other Google Workspace integrations (Sheets, Slides)
- Microsoft OneDrive / Dropbox / Box

---

## Effort estimate
~1-2 days assuming Google Cloud setup is straightforward. OAuth + token refresh is well-trodden ground; complexity is token encryption + redirect URI gotchas.
