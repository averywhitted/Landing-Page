# Dev Log — averywhitted.com (site + booking service)

## Resume here
_Updated 2026-11-01 11:50 EST · branch `master` @ `bfe4ad2` (GitHub same) · working tree: promo codes from admin committed with this entry, NOT released_

**Project:** Avery's static site on GitHub Pages (master) plus the in-house booking service in `booking/` (Cloudflare Worker + D1, Stripe, Resend, iCloud CalDAV, Zoom), live at book.averywhitted.com since 2026-09-29.
**Current goal:** Make Stripe promo codes from the admin page (Settings > Promo codes). Built and tested locally; needs a Stripe key permission change, then a release.

**Where things stand:**
- `booking/src/promos.ts` (validation, plain-English errors) + `booking/src/stripe.ts` (`listPromotionCodes`, `createPromotionCode`, `setPromotionCodeActive`, pinned `Stripe-Version: 2024-06-20`). Endpoints `GET/POST /api/admin/promo-codes`, `POST /api/admin/promo-codes/:id/active`. Nothing stored in D1; no migration.
- Admin (`booking/admin/app.js.txt`, `promoPanel`, `openNewPromo`, `setPromoActive`): list (working codes, "Show old codes" for off / used up / ended), New promo code dialog (code or "Make one up", % or $ off, optional last day, total uses, private note), Copy link (booking link with ?promo=), Turn off with Undo, Turn on. Booking link dialog suggests working codes.
- Off-Stripe payments and 15-minute lengths: live since 2026-10-25 (`booking/src/offline.ts`, migration 0020).
- 158 tests pass. Promo UI checked in a mock admin (desktop, 375px dark): create, duplicate refusal, off + Undo, copy link; no console errors. Not tried against real Stripe.

**Next steps:**
1. Avery: Stripe dashboard > Developers > API keys > the booking site's restricted live key > Edit: Coupons = Write, Promotion codes = Write. Without it the panel shows a message saying exactly that.
2. Release: `cd "/Users/averywhitted/Documents/GitHub/Landing Page/booking" && npm run release` (no migration).
3. Make a throwaway code on the live admin, open its Copy link, check Stripe Checkout shows the discount, then turn it off.
4. Still open: Leslie Davis's $100 cash (profile > $130 session > Record payment); admin phone test from 2026-10-18.

**Waiting on the user / open questions:**
- The Stripe key permission (step 1).

**Watch out for:**
- Releases: Avery runs them unless they explicitly ask me to in the chat (memory: booking-wip-no-public). From this app, `git push` hangs on the macOS Keychain helper; push with the GitHub CLI's login instead (memory has the command).
- Promo calls pin API version 2024-06-20 on purpose: newer versions moved `coupon` into a `promotion` field. Don't drop the pin without changing request/response shapes.
- Stripe can't limit a code to once per student (no Stripe customers here) or to certain services (line items are ad-hoc products). "Total uses" counts everyone.
- A promo call refused for missing permission logs a Stripe error, so the Stripe light can go amber until the next success.
- `amount_cents` (bookings, packages) and `paid_cents` (requests) are card-only: what Stripe can refund. Never fold off-Stripe money into them. "Owed" must use `dueCents()` / `DUE_SQL()` and `requestDue()`.
- Test "refund safety: a cancellation racing a reschedule…" is flaky; unrelated. Repeat tests compare times with `weeksLater()`, never `+ 7 * DAY`.
- Mock admin for UI checks: `booking/.test-build/mock/admin.html` (gitignored; data from `.test-build/dump-mock.mjs`, fake promo API inline), served by the `static-site` preview.

**Key files:** `booking/src/promos.ts`, `booking/src/stripe.ts` (promo section), `booking/admin/app.js.txt` (promo section above Connections), `booking/test/harness.ts` (fake coupons/promotion codes)
**Run / test:** `cd booking && npm test` · `npm run preview-emails` · `npm run release -- --check`

## History
<!-- newest first -->

### 2026-11-01 11:50 — Make Stripe promo codes from the admin page
**Asked:** Feature request: create Stripe discount codes from the admin page.
**Done:**
- `booking/src/stripe.ts`: each code is a coupon (`duration: once`, named after the code) plus one promotion code (limits on the promotion code: `max_redemptions`, `expires_at`; `metadata.created_by=admin`, optional `note`). If the promotion code is refused, the coupon is deleted. `stripe()` gained DELETE, an optional `Stripe-Version`, and `status` on errors.
- `booking/src/promos.ts`: checks code (same rule as ?promo= links), 1-100% or $1-$1,000 off, uses 1-10,000, last day = end of that day Eastern (up to 5 years). 401/403 -> how to fix the key; duplicate active code -> 409.
- `booking/src/index.ts`: three admin endpoints. `booking/admin/app.js.txt`: Promo codes panel at the top of Settings (redraws alone so unsaved settings edits survive), dialog, Turn off with Undo (reversible, so no confirm), Copy link, suggestions in the Booking link dialog.
- Tests: fake coupons/promotion codes in `test/harness.ts`; 2 new tests (create/validate/duplicate/list/promo link/off/on; missing permission). 158/158 pass.
**Decisions:** Codes live only in Stripe (no D1 table) so dashboard-made codes show too and nothing can drift. Left out per-student limits and per-service codes (Stripe can't enforce either with this checkout setup) and "first-time customers only" (unreliable without Stripe customers).
**State:** committed with this entry; not released; mock-admin checked, not run against real Stripe.
**Next:** Avery adds Coupons + Promotion codes Write to the live restricted key, then `npm run release`.

### 2026-11-01 — Repeat tests broke on the clock change; release
**Asked:** Release the Stripe expire fix (`071a64a`).
**Done:** The release dry run stopped: 5 "repeating:" tests failed today (Nov 1, clocks went back). Same failures on the pre-October code (`005f340`), so not caused by recent work. Live code is right: `sameTimeWeeksLater` in `booking/src/series.ts` keeps the Eastern clock time, so a week later is 7 days + 1 hour across the change; the tests assumed exactly 7 x 24 hours. `test/booking.test.ts` now uses a `weeksLater()` helper, plus a new fixed-date test pinning the behaviour for both clock changes in 2026.
**State:** 156/156 tests pass; test-only change, committed; release run right after.

### 2026-10-25 21:00 — Closing an already-expired Stripe page showed as a Stripe error
**Asked:** Avery saw "Stripe refused POST checkout/sessions/expire (400): ... has a status of `expired`".
**Done:** `expireCheckoutSession` (`booking/src/stripe.ts`) now looks the page up first and only asks Stripe to expire it if it's still open. Before, Stripe's refusal was logged as an error (Connections > Stripe turned amber) even though the code then carried on correctly; recording payments and cancelling were never actually affected. New test "closing a payment page that already timed out isn't logged as a Stripe error".
**State:** committed, not released; 155/155 tests pass. The amber light clears on the next successful Stripe action (a checkout page or refund) after release.

### 2026-10-25 20:10 — Cash for payment requests and bundles; then release
**Asked:** Build the two follow-ups (recording a cash bundle purchase, applying cash to a payment request), then release.
**Done:**
- Migration 0020 extended before it was ever applied: `offline_payments` gains `request_id`/`package_id` (exactly one of booking or package; waived not allowed for bundles); `payment_requests.offline_cents/waived_cents` + trigger; `packages.offline_cents`.
- `offline.ts`: `adminRecordRequestPayment` (part or all, closes an open checkout; all marks the request paid), `adminSellBundle` (active bundle, 90-day use-by, ledger entry, confirmation email unless unticked, no admin email), Remove handles all three kinds.
- `requests.ts`: `requestDue`; checkout, reminder emails and the student page use what's left. `packages.ts`: cash bundles show the total paid, `cancelQuote` counts cash for the policy amount, online cancel refused. Bundle cancelled email says any refund comes from Avery directly. CSV: bundle and request rows; card request rows only when card money exists.
- Endpoints: `POST /api/admin/payment-requests/:id/offline-payment`, `POST /api/admin/packages/sell`.
- 3 new tests (154 total, all pass).
**Decisions:** Cash bundles are full-price sales (no partial); students can't cancel them online because there's no card payment to refund. Avery asked me to release this time, overriding the usual "Avery runs releases" rule for this request.
**State:** RELEASED 2026-10-25 ~20:15-20:30 EDT. Migration 0020 applied to live D1 (`migrations list` shows none pending), worker deployed (version dac3227a), master pushed to `37feffc`, Pages build succeeded; live `booking.js?v=b6bda54e`, manage and bundle pages checked. First release run stopped safely on a pulled podcast page with an old `?v=` tag (stamped and committed as `37feffc`); the push step hung on the Keychain helper and was redone with the GitHub CLI's login.
**Next:** Record Leslie's $100.

### 2026-10-25 19:25 — Payments outside Stripe; 15-minute session lengths
**Asked:** Leslie Davis paid $100 cash on a $130 session but her profile showed $130 owed; Avery wanted a clean way to handle off-Stripe payments. Also: Avery gave Leslie 1 hr 15 min for $130, so booking needs 15-minute length steps (was 15/30/60/90 only).
**Done:**
- `booking/src/offline.ts` + migration 0020: record cash/Venmo/Zelle/check/other or "waive" against a session; partial leaves the rest payable by link; full marks it paid like a card payment (Zoom link, calendar, series). Remove/Undo reverses it. Endpoints `POST /api/admin/bookings/:id/offline-payment`, `POST /api/admin/offline-payments/:id/remove`.
- Owed totals (Students list, delete check, reminders) subtract offline + waived via `dueCents`/`DUE_SQL`. Calendar event shows e.g. "30.00 USD due (100.00 USD paid outside Stripe)". CSV export gets "Payment outside Stripe"/"Waived" rows. Backup, clear-test-data, delete and merge include the new table.
- Cancelling a cash-paid session never refunds through Stripe; admin cancel dialog and Avery's cancellation email say to return it by hand.
- Receipt email `offlinePaymentReceived` (optional checkbox, on by default).
- Custom lengths: `findService` generates `coaching-45/75/105/...180`; `findPublicService` for public booking and availability; availability allows the custom length only with a valid manage link for that booking; `book/booking.js` + `book/manage/index.html` pass the service to the reschedule picker. Assets restamped.
- Fixed test "repeating: a set number of sessions ends by itself" (assumed exactly 14×24h; fails near a clock change since sessions keep Eastern clock time; failed on untouched HEAD too).
**Decisions:** Separate table + running totals instead of reusing `amount_cents`, so cash can never reach Stripe refund code. Custom lengths admin-only and pro rata by default; standard public prices unchanged.
**State:** committed with this entry, not deployed; 151/151 tests pass; admin dialog verified in mock preview only (not on the live admin).
**Next:** Avery runs `npm run release`, then records Leslie's $100.

### 2026-10-18 12:17 — One-command release script
**Asked:** After a push was refused (GitHub had two "Sync podcast episodes" commits from the 6-hourly Action), make sure future releases pull first and run in the right order.
**Done:** `booking/scripts/release.sh` (`npm run release`): stops unless on a clean master; `git pull --rebase`; runs `stamp-assets.py` and stops if booking.js/css tags were stale; `npm test`; `d1 migrations apply --remote`; `npm run deploy`; `git push` (pulls and retries once if the podcast bot pushed meanwhile). `--check` runs the safe steps and lists pending migrations (read only).
**Decisions:** The podcast Action only touches `podcast/` and `sitemap.xml`, so it can't conflict with booking work and needs no change; the only effect was the refused push. Migrations come before the deploy so new code never meets an old database.
**State:** Committed with this entry. Checked locally: refuses a dirty tree; `--check` passes steps 1-4 (the live migration list was blocked in my test on purpose). Not run for real.
**Next:** Avery uses it for the next release.

### 2026-10-18 12:05 — Admin: phone header, one-line students, week view, Undo, dark mode
**Asked:** For phones: smaller header, one-line student rows, week view by default (day and month still available), Undo for quick actions while keeping confirmation for risky ones, dark mode; then the command to push and migrate.
**Done:**
- `booking/admin/index.html`: phone header in one row (Test mode badge moved under the name at all widths, link icon, "+ Book"); one-line student rows (name, then owes / next / last; Edit only in the profile on phones); week grid fits 7 columns; all colours turned into theme tokens with a dark set; Undo button in toasts.
- `booking/admin/app.js.txt`: `toast(text, isErr, undo, ms)`, `undoable()` (act now, Undo reverses) and `delayed()` (5 s wait, flushed with keepalive on pagehide); week is the default scale everywhere; Appearance select in Settings (`admin-theme` in localStorage).
- Worker: `POST /api/admin/students/:id/follow-up/restore`, `POST /api/admin/nudges/:id/restore` (only admin-cancelled, still in the future). 1 new test.
**Decisions:** Things that send an email can't be unsent, so they wait 5 s instead of offering a reverse action. Refunds, withdrawals, merges, resubscribes and resets keep confirm(). The header fix also fixed a bug where the too-wide header pushed the bottom tabs off screen.
**State:** Committed with this entry. `npm test` 145/145. Checked in the mock admin at 375px, light and dark (Undo flows and theme switch exercised). Not deployed. Go-live: `cd "/Users/averywhitted/Documents/GitHub/Landing Page/booking" && npm run cf -- d1 migrations apply averywhitted-booking --remote && npm run deploy && cd .. && git push origin master`.
**Next:** Avery deploys and checks on a real phone.

### 2026-10-18 11:24 — Follow-up prompts; admin phone layout
**Asked:** Be prompted to re-engage a student one week after their latest session if nothing is booked; asked whether a "seen recently" email existed (it didn't: all four templates assumed 60+ days and warned under 60). Phone fixes: Connections as one expandable chip, tabs and sort filters overflowing, cluttered card buttons, move "Live" to Settings, plus suggestions.
**Done:**
- `booking/src/followups.ts`: `followUpsDue` (last confirmed session ended N+ days and under 60 days ago, nothing upcoming, not dismissed for that session, no check-in sent/scheduled since, not unsubscribed/don't-email), `dismissFollowUp`, `sendFollowUpDigest` (cron, once a day from 9 AM ET, each student once per session; tracked in `alerts_sent` kind 'followups').
- Migration 0019: `customers.followup_done_for`, `followup_emailed_for` (both hold the session start the prompt was about); `nudge_emails` rebuilt to allow template 'followup'.
- Template "After a recent session" (subject "Following up", heading reuses "Checking in"); the "only N days ago" warning is skipped for it (`recentWarning` returned separately to the dialog). Avery's email `adminFollowUps` with new heading PNG `time-to-follow-up.png`.
- Settings: `followUpDays` (default 7), `followUpEmail` (default on); saving settings now keeps fields left out of the request. Overview returns `problems.followUps` and `followUpDays`; route `POST /api/admin/students/:id/follow-up/dismiss`.
- Admin UI: follow-up panel in Needs attention (counts toward the tab, red only for real problems), "Ready to follow up" filter, Follow-up settings, Payments mode line in Settings; `act()`/`actionsHtml()`/`menuHtml()` helpers put secondary card/row actions in a "⋯" menu (opens upward near the bottom); phone CSS ≤700px: bottom tab bar with icons ("To do" for Needs attention), Connections chip, full-width toolbars with Show/Sort selects, 16px inputs so iPhones don't zoom; tab switches scroll to top. Card button "Send payment reminder" renamed "Remind to pay".
- 2 new tests; 2 existing check-in tests updated for the new template and `recentWarning`. `_config.yml` now excludes DEVLOG.md from the site.
**Decisions:** In-admin list plus optional daily email (not one email per student) so Avery isn't spammed; 60 days hands off to the existing check-in flow; "⋯" menu used at every width for consistency.
**State:** Uncommitted. `npm test` 144/144 (one known flaky test). Verified in a mock admin at 375px and 1200px; no console errors. Not deployed. To ship: `cd "/Users/averywhitted/Documents/GitHub/Landing Page/booking" && npm run cf -- d1 migrations apply averywhitted-booking --remote && npm run deploy`.
**Next:** Suggestions offered to Avery (none built): smaller phone header (brand + Booking link take ~1/4 of the screen), compact one-line student rows on phones, a "Today" strip with the next session's Join Zoom, an agenda view instead of the cramped month calendar on phones, Undo toasts instead of confirm() for quick actions, admin dark mode.
