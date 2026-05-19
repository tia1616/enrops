# Marketing Merge Tokens

Reference list of `{{token}}` placeholders Don can use in his email body and subject, and the renderer (`marketing-send`) substitutes per-recipient at send time.

**Source of truth:** the live Supabase schema (`marketing_recipients`, `organizations`, `org_branding`, `programs`, `promo_codes`). Tokens map 1:1 to columns or to simple computations on those columns. **Nothing in this list requires Don to know anything specific about the data** — the renderer fills in the real values right before each email goes out.

Status legend:
- 🟢 **Live** — implemented in `marketing-send` and ready to use.
- 🟡 **Planned for chunk 07** — defined here so Don's prompt can reference them; renderer support lands when chunk 07 wires the real send.
- 🔵 **Future** — useful but not yet scoped.

---

## Per-recipient tokens (one value per email sent)

| Token | Source | Status | Fallback when missing | Example |
|---|---|---|---|---|
| `{{first_name}}` | `marketing_recipients.parent_name` → first word | 🟡 | `"there"` | `Hi {{first_name}},` → `Hi Maria,` |
| `{{parent_name}}` | `marketing_recipients.parent_name` (full) | 🟡 | `"there"` | `{{parent_name}}` → `Maria Reyes` |
| `{{child_first_name}}` | `marketing_recipients.child_first_name` | 🟡 | `"your child"` | `{{child_first_name}}` → `Liam` |
| `{{child_last_name}}` | `marketing_recipients.child_last_name` | 🔵 | `""` | rarely needed |
| `{{school}}` | `marketing_recipients.school_name` → mapped to display via `template_data.school_name_aliases` if present | 🟡 | `"your school"` | `at {{school}}` → `at Hillsboro Family Center` |
| `{{city}}` | `marketing_recipients.city` | 🔵 | `""` | for geo-segmented copy |
| `{{zip}}` | `marketing_recipients.zip` | 🔵 | `""` | |
| `{{geo_segment}}` | `marketing_recipients.geo_segment` | 🔵 | `""` | e.g., `"hillsboro"` |
| `{{unsubscribe_url}}` | HMAC-signed link, computed per-recipient | 🟢 | always present | already auto-injected by `marketing-send` |

## Per-org tokens (same value for everyone in this campaign)

| Token | Source | Status | Fallback | Example |
|---|---|---|---|---|
| `{{org_name}}` | `organizations.name` | 🟡 | `"our team"` | `Journey to STEAM` |
| `{{sender_name}}` | `organizations.default_sender_name` | 🟡 | `{{org_name}}` | `Jessica @ Journey to STEAM` |
| `{{sender_email}}` | `organizations.default_sender_email` | 🟢 | (errors if missing) | already used as `From:` header |
| `{{register_url}}` | `https://enrops.com/${organizations.slug}` | 🟡 | platform default | `https://enrops.com/j2s` |
| `{{reply_to}}` | `org_branding.email_reply_to` → fallback `organizations.email` | 🟢 | platform default | already used as `Reply-To` header |
| `{{logo_url}}` | `organizations.logo_email_url` → fallback `organizations.logo_url` | 🟢 | text wordmark | injected into header HTML |
| `{{closer}}` | `organizations.brand_voice.closer` | 🟡 | omitted | `Future-ready skills, right after school.` |
| `{{phone}}` | `organizations.phone` | 🔵 | omitted | `(971) 258-2178` |
| `{{website}}` | `organizations.website` | 🔵 | `{{register_url}}` | |

## Per-program tokens (computed from this recipient's school's programs)

These need the renderer to join `marketing_recipients.school_name` → `program_locations` → `programs` for this org's current term, then pick a representative program (or aggregate across pathways).

| Token | Source | Status | Notes |
|---|---|---|---|
| `{{savings}}` | `programs.price_cents - programs.early_bird_price_cents`, formatted as `$NN` | 🟡 | If a school has multiple programs, use the max savings. Omit if no early-bird active. |
| `{{early_bird_price}}` | `programs.early_bird_price_cents` formatted as `$NNN` | 🟡 | Per-program; use minimum across the school's pathways |
| `{{regular_price}}` | `programs.price_cents` formatted as `$NNN` | 🟡 | |
| `{{early_bird_deadline}}` | `programs.early_bird_deadline` formatted as `"June 5"` | 🟡 | Use earliest deadline across the school |
| `{{first_session_date}}` | `programs.first_session_date` formatted as `"September 10"` | 🟡 | |
| `{{session_count}}` | `programs.session_count` | 🔵 | "12 sessions" |
| `{{day_of_week}}` | `programs.day_of_week` | 🔵 | "Mondays" |
| `{{curriculum}}` | `programs.curriculum` | 🔵 | Don should generally NOT reference specific curriculum names; this token exists for when the operator explicitly mentioned one in the topic |
| `{{vip_price}}` | `programs.vip_price_cents` (or `vip_new_price_cents`) formatted as `$NNN/term` | 🔵 | |

## Per-campaign tokens (set at draft time, same across all sends in this campaign)

| Token | Source | Status | Notes |
|---|---|---|---|
| `{{topic}}` | First entry in `marketing_campaigns.draft_inputs.what` | 🟡 | Useful for subject-line reuse |
| `{{topics_list}}` | Comma-joined `draft_inputs.what` | 🔵 | For multi-topic campaigns |
| `{{promo_code}}` | `promo_codes.code` joined via `programs.active_promo_code_id` for this campaign | 🟡 | Only present if a code is approved |
| `{{promo_amount}}` | `promo_codes.discount_value` formatted as `$NN off` or `NN% off` | 🟡 | |

---

## Formatting rules

- **Currency**: cents → dollars. `8900` → `$89`. Trim cents unless non-zero. Never show `$89.00`.
- **Dates**: use the org's timezone (`organizations.timezone`). Default format: `Month D` (e.g., `June 5`). Long format: `Weekday, Month D` for first-session dates (`Wednesday, September 10`).
- **First names**: capitalize the first letter. Trim whitespace. If the source has a comma (`"Reyes, Maria"`), use the second part.

## Implementation notes for chunk 07

The current `marketing-send` renders emails using server-side string interpolation (e.g., `Hi ${firstName},` inside a JS template literal). It does **NOT** process `{{token}}` syntax. Chunk 07 adds a token-replacement pass:

1. Load the recipient row (`marketing_recipients`) — already done for `firstName`.
2. Load this recipient's school's program rows (`programs` joined via `program_locations` for matching `school_name`).
3. Build a `tokens` map: `{ first_name, school, savings, early_bird_deadline, ... }`.
4. Run a single pass over the rendered HTML + subject + body_text: `text.replace(/{{(\w+)}}/g, (_, key) => tokens[key] ?? '')`.
5. If any token is missing from the map, substitute the fallback from this doc.

**Don's prompt already tells him to use these tokens** (chunk 03 v3) — the renderer just needs to honor them.

## What Don should NOT do

Per the anti-hallucination rules baked into Don's system prompt:

- Never write a specific dollar amount inline (`Save $90!`) — use `{{savings}}` instead.
- Never write a specific school name — use `{{school}}`.
- Never invent a child's name — use `{{child_first_name}}` or `"your child"`.
- Never invent a promo code — only reference `{{promo_code}}` if the operator approved one.
- Never invent dates beyond the touchpoint's own scheduled send time — use `{{early_bird_deadline}}` or `{{first_session_date}}`.

If Don needs a specific fact that doesn't have a token here, he should use generic phrasing instead of inventing one.

---

## Versioning

- **v1 — 2026-05-19**: initial list. Live = 🟢, planned for chunk 07 = 🟡, future = 🔵. Derived directly from Supabase schema.
