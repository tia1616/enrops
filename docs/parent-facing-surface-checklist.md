# Checklist: adding a parent- or partner-facing surface

Run this whenever you add a **new page or email that a parent or a school
partner sees**. It exists because the enrops attribution line kept being
re-invented per surface, and Jessica's footer copy checklist (2026-07-26) asked
for the line to ship on "every surface going forward" by default rather than as
a recurring ask.

Instructor-facing surfaces are **out of scope** for the attribution line — see
step 2.

---

## 1. Add the attribution line

Never hand-roll the copy. Import it.

**Web (React):**

```jsx
import PlatformFooterLine from '../components/PlatformFooterLine.jsx';

<PlatformFooterLine surface="regPage" tone="dark" />
```

**Email (edge function):**

```ts
import { renderPlatformFooterHtml, renderPlatformFooterText }
  from '../_shared/platformFooter.ts';

renderPlatformFooterHtml('receipt')   // the HTML footer
renderPlatformFooterText('receipt')   // the text/plain part — easy to forget
```

If the email is multipart, **both** calls are needed. The plain-text half was
shipped empty once already.

## 2. Decide whether the line belongs at all

| Audience | Line? |
|---|---|
| Parents / families | yes |
| School partners | yes |
| **Instructors / contractors** | **no** |
| Operator admin app | no — that shell is Enrops-branded already |

For lifecycle automations this is decided for you: call
`surfaceForAutomation(key, audience, recipientRole)`, which returns `null` when
no line should render. Pass the **per-recipient** role, not just the template's
`audience` column — a two-audience automation like `no_school_day` is stored as
`families` but also sends an instructor copy.

## 3. Pick the surface from the closed vocabulary

The `src` values live in `PLATFORM_FOOTER_SURFACES` (both twins). **Add your new
surface there first.** Passing a string that isn't in the map resolves to
`unknown` and logs an error — deliberately, so a typo shows up as one obvious
bucket instead of quietly inventing a metric.

Do **not** add UTM parameters. The standard is `?src=<surface>`, and the module
builds it.

## 4. Keep the twins in sync

`src/components/PlatformFooterLine.jsx` and
`supabase/functions/_shared/platformFooter.ts` hold the same logic because Vite
and Deno cannot import across each other's bundle roots. If you change one,
change the other.

`supabase/functions/_shared/tests/platformFooterTwinParity.test.ts` fails when
they drift. Do not loosen it — it exists because they *did* drift, and no
single-file check could see it.

## 5. Layout rules (from the checklist — don't "improve" these)

- The operator's branding is always primary. The line sits **below** their own
  footer content, smaller and quieter.
- **One line only.** No logo lockup, no second sentence, no badge graphic.
- `enrops` is lowercase everywhere, including at the start of a sentence.
- Never removable on Free, Pro-Lite or Pro. There is deliberately no prop to
  hide it.
- **Not during checkout.** The registration steps are the one flow we need
  finished; an outbound link next to the payment fields is an exit. Use
  `isCheckoutPath`.

## 6. Before you call it done

- [ ] The line renders on the **real page or a real send**, not just in a build.
      Check a non-J2S tenant — J2S has no trailing period in its name, which is
      how a double-period bug in the copyright line got missed once.
- [ ] Mobile: no horizontal overflow at 375px.
- [ ] The `?src=` on the rendered link matches the surface you intended.
- [ ] `deno test supabase/functions/_shared/tests/platformFooter*.test.ts`
