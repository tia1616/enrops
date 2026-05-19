# marketing-draft-campaign — test plan

Chunk 3.6.03. Once deployed, exercise these cases against a real Supabase project. Requires Chunk 3.6.01 migration to be applied (new columns on `organizations`, `marketing_recipients`, `marketing_campaigns`, `program_locations`).

All requests go to `POST /functions/v1/marketing-draft-campaign` with `Authorization: Bearer <user_jwt>`.

## 1. Parents — master_list (happy path)

```json
{
  "organization_id": "1adf10ad-d091-4aa0-82e3-af331468ea2b",
  "inputs": {
    "what": "Fall 2026 early-bird registration is open",
    "who": { "audience": "parents", "filter": { "type": "master_list" } },
    "duration": "2 weeks",
    "channels": ["email"]
  }
}
```

**Expect**
- `200 OK`
- `campaign_id` returned
- `draft.subject` non-empty, <= ~80 chars
- `draft.body_html` non-empty
- `recipients.count` > 0
- `recipients.segment_summary` ~= "all parents on the master list"
- Row inserted into `marketing_campaigns` with `draft_source='ai_assisted'`, `status='draft'`, `organization_id` matches

## 2. Parents — school-specific

```json
{
  "organization_id": "<J2S_ORG_ID>",
  "inputs": {
    "what": "Cannady fall after-school programs",
    "who": { "audience": "parents", "filter": { "type": "school", "school_ids": ["<PROGRAM_LOCATION_UUID>"] } },
    "duration": "1 month",
    "channels": ["email"]
  }
}
```

**Expect**
- `200 OK`
- `recipients.ids` only contains parents whose `school_name` matches the resolved location name or its `name_aliases`
- `segment_summary` includes the resolved location name

## 3. Cross-tenant rejection (403)

Same payload as #1 but use a JWT for a user whose `org_members` row does NOT include `1adf10ad-d091-4aa0-82e3-af331468ea2b` and who is NOT in `platform_admins`.

**Expect**
- `403 Forbidden`
- `error: forbidden: caller has no admin access to this organization`
- No row written to `marketing_campaigns`

## 4. Org-not-configured (400)

Temporarily null out `default_sender_email` for the test org, then re-run case #1. Restore the value afterward.

**Expect**
- `400 Bad Request`
- `{ error: "org_not_configured", missing: ["default_sender_email"] }`
- No row written to `marketing_campaigns`

## 5. Zero recipients (200 + warning)

```json
{
  "organization_id": "<ORG_ID>",
  "inputs": {
    "what": "Test with no recipients",
    "who": { "audience": "parents", "filter": { "type": "segment", "segments": ["bogus_segment_xyz"] } },
    "duration": "1 week",
    "channels": ["email"]
  }
}
```

**Expect**
- `200 OK`
- `recipients.count === 0`
- `recipients.ids === []`
- `warning === "no_recipients_matched"`
- Draft row still inserted (admin can adjust filter and re-resolve)

## 6. Audience not implemented (501)

```json
{
  "organization_id": "<ORG_ID>",
  "inputs": {
    "what": "Reminder to partners",
    "who": { "audience": "partners", "filter": { "type": "all" } },
    "duration": "1 week",
    "channels": ["email"]
  }
}
```

**Expect**
- `501 Not Implemented`
- `{ error: "audience partners not yet implemented", audience: "partners", supported_in_v1: ["parents"] }`
- No call to Claude, no DB write

Same shape for `audience: "instructors"`.

## 7. Multi-channel selection (200, only email rendered)

```json
{
  "organization_id": "<ORG_ID>",
  "inputs": {
    "what": "Summer camps + Fall after-school",
    "who": { "audience": "parents", "filter": { "type": "master_list" } },
    "duration": "2 months",
    "channels": ["email", "social", "flyer"]
  }
}
```

**Expect**
- `200 OK`
- `draft` contains email content only
- System prompt logged includes "v1 only generates email content; other channels surface a 'coming soon' pill"

## 8. Claude timeout (504)

Hard to force in production. To simulate locally: set `CLAUDE_TIMEOUT_MS = 1` in the source, redeploy, run case #1.

**Expect**
- `504 Gateway Timeout`
- `error: draft_timeout`
- No row in `marketing_campaigns`

## Required environment variables

- `ANTHROPIC_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MARKETING_DRAFT_MODEL` (optional; defaults to `claude-opus-4-6` — Opus 4.6 chosen over Sonnet 4.6 for warmer parent-facing copy; Opus 4.7 was rejected for over-thinking the draft)
