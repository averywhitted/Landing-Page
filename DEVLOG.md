# Dev Log — averywhitted.com (site + booking service)

## Resume here
_Updated 2026-10-25 20:10 EDT · branch `master` @ `6dc343c` · working tree: bundle/request cash work committed with this entry; release run right after_

**Project:** Avery's static site on GitHub Pages (master) plus the in-house booking service in `booking/` (Cloudflare Worker + D1, Stripe, Resend, iCloud CalDAV, Zoom), live at book.averywhitted.com since 2026-09-29.
**Current goal:** Payments outside Stripe (sessions, payment requests, bundles) and 15-minute session lengths are released; Avery records Leslie Davis's $100 cash.

**Where things stand:**
- Off-Stripe money: `booking/src/offline.ts`, migration 0020 (`offline_payments` rows point at a booking, a request + booking, or a package; running totals `offline_cents`/`waived_cents` on bookings and payment_requests, `offline_cents` on packages; triggers cap them at the price).
- Admin: "Record payment" on unpaid sessions and open payment requests; profile "⋯ > Add a bundle" sells a bundle outside Stripe (or free at $0); profile "Paid outside Stripe" list with Remove (a bundle sale only while unused).
- Cash bundles can't be cancelled online (bundle page says to email); Avery cancels from admin, dialog shows the policy amount to give back by hand; no Stripe refund ever.
- Book a student lengths: 30 min to 3 hr in 15-minute steps (`coaching-<minutes>`, admin-only, pro rata by default).
- 154 tests pass. Dialogs checked in the mock admin (mock lacks `/api/services`; inject it to test Book a student / Add a bundle).

**Next steps:**
1. If the release didn't finish, run `cd booking && npm run release` (see History for what happened).
2. Avery: Leslie Davis's profile > her $130 session > Record payment: $100, Cash.
3. Admin phone test from 2026-10-18 is still open.

**Waiting on the user / open questions:**
- Feedback on the new dialogs from real use.

**Watch out for:**
- Releases: Avery runs them unless they explicitly ask me to in the chat (memory: booking-wip-no-public).
- `amount_cents` (bookings, packages) and `paid_cents` (requests) are card-only: what Stripe can refund. Never fold off-Stripe money into them.
- "Owed" must use `dueCents()` / `DUE_SQL()` (bookings.ts) and `requestDue()` (requests.ts).
- Deleting rows: `offline_payments` before `payment_requests`, `bookings`, `packages` (foreign keys).
- Test "refund safety: a cancellation racing a reschedule…" is flaky; unrelated.

**Key files:** `booking/src/offline.ts`, `booking/migrations/0020_offline_payments.sql`, `booking/src/requests.ts`, `booking/src/packages.ts`, `booking/admin/app.js.txt` (`openRecordPayment`, `openSellBundle`)
**Run / test:** `cd booking && npm test` · `npm run preview-emails` · `npm run release -- --check`

## History
<!-- newest first -->

### 2026-10-25 20:10 — Cash for payment requests and bundles; then release
**Asked:** Build the two follow-ups (recording a cash bundle purchase, applying cash to a payment request), then release.
**Done:**
- Migration 0020 extended before it was ever applied: `offline_payments` gains `request_id`/`package_id` (exactly one of booking or package; waived not allowed for bundles); `payment_requests.offline_cents/waived_cents` + trigger; `packages.offline_cents`.
- `offline.ts`: `adminRecordRequestPayment` (part or all, closes an open checkout; all marks the request paid), `adminSellBundle` (active bundle, 90-day use-by, ledger entry, confirmation email unless unticked, no admin email), Remove handles all three kinds.
- `requests.ts`: `requestDue`; checkout, reminder emails and the student page use what's left. `packages.ts`: cash bundles show the total paid, `cancelQuote` counts cash for the policy amount, online cancel refused. Bundle cancelled email says any refund comes from Avery directly. CSV: bundle and request rows; card request rows only when card money exists.
- Endpoints: `POST /api/admin/payment-requests/:id/offline-payment`, `POST /api/admin/packages/sell`.
- 3 new tests (154 total, all pass).
**Decisions:** Cash bundles are full-price sales (no partial); students can't cancel them online because there's no card payment to refund. Avery asked me to release this time, overriding the usual "Avery runs releases" rule for this request.
**State:** committed with this entry; release attempted right after (outcome in the next entry if it needed follow-up).
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
