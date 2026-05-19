# marketing-send — ad_hoc_recipient_ids test plan

Chunk 3.6.02 added an optional `ad_hoc_recipient_ids` param. These three invocations cover the contract. Run with `mode: 'preview'` only — never `send` during contract testing.

Replace `<CAMPAIGN_ID>` with a real `marketing_campaigns.id` for the test org, and `<REC_ID_*>` with real `marketing_recipients.id` values. Use `<FOREIGN_REC_ID>` for a recipient row belonging to a *different* organization.

## 1. Legacy mode — backwards compatibility

**Input**
```json
{ "campaign_id": "<CAMPAIGN_ID>", "mode": "preview" }
```

**Expected**
- `200 OK`
- `ad_hoc_mode: false`
- `schools_targeted`, `total_recipients`, `results[]` identical to pre-chunk-02 behavior
- `skipped_no_school_match: 0`

**Why this matters**
Existing campaigns (saved school_list + filter) must produce byte-equivalent output. Compare against a baseline captured before this chunk was deployed.

---

## 2. Ad-hoc preview — happy path

**Input**
```json
{
  "campaign_id": "<CAMPAIGN_ID>",
  "mode": "preview",
  "ad_hoc_recipient_ids": ["<REC_ID_1>", "<REC_ID_2>"]
}
```
Both recipient IDs must belong to the campaign's org AND have a `school_name` that maps to a campaign display name via `template_data.school_name_aliases` (or matches a display name directly).

**Expected**
- `200 OK`
- `ad_hoc_mode: true`
- `total_recipients: 2`
- `schools_targeted` = number of unique schools across the 2 recipients
- `skipped_no_school_match: 0`
- `results[*].html` rendered per school

---

## 3. Cross-tenant rejection

**Input**
```json
{
  "campaign_id": "<CAMPAIGN_ID>",
  "mode": "preview",
  "ad_hoc_recipient_ids": ["<REC_ID_1>", "<FOREIGN_REC_ID>"]
}
```

**Expected**
- `403 Forbidden`
- Body: `{ "error": "recipient_org_mismatch", "requested": 2, "resolved": 1 }`
- No emails rendered. No `marketing_sends` rows written.

**Why this matters**
Multi-tenant safety — a malicious or buggy caller cannot use the AI builder path to leak content into another org's recipient list.

---

## Additional guards (not in the 3 required tests, but covered by `parseRequest`)

- `ad_hoc_recipient_ids` longer than 5000 → `413 { error: 'ad_hoc_recipient_ids_too_large' }`
- `ad_hoc_recipient_ids` not an array → `400`
- Recipient with unmapped school_name → counted under `skipped_no_school_match`, send proceeds for the others (does not reject the request)
