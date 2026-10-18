# Dev Log — averywhitted.com (site + booking service)

## Resume here
_Updated 2026-10-18 12:17 EDT · branch `master` @ `08a81fe` · working tree: release script committed in the same commit as this entry_

**Project:** Avery's static site on GitHub Pages (master) plus the in-house booking service in `booking/` (Cloudflare Worker + D1, Stripe, Resend, iCloud CalDAV, Zoom), live at book.averywhitted.com since 2026-09-29.
**Current goal:** Avery tries the new admin (follow-ups, phone layout, dark mode) on a real phone.

**Where things stand:**
- LIVE (Avery deployed 2026-10-18, migration 0019 applied, master pushed): follow-up prompts and phone polish + dark mode. 145 tests pass.
- Releases: `cd booking && npm run release` (pull, stamp check, tests, migrations, deploy, push, in that order); `npm run release -- --check` does the safe steps only.
- Admin on phones: slim one-row header, one-line student rows, week calendar by default (first names only in narrow columns), bottom tabs, Connections chip, "⋯" card menus.
- Undo: dismissing a follow-up, marking/unmarking a no-show, and cancelling a scheduled check-in email happen at once with Undo; payment reminders, resending an invite, Keep this time, and re-sending a payment request wait 5 seconds with Undo (sent at once if the page closes). Refunds, withdrawing a payment request, merging, turning emails back on, and settings resets still ask for confirmation.
- Dark mode follows the device; Settings > Appearance can force Light or Dark (saved per browser).

**Next steps:**
1. Avery tries the admin on their phone, in both themes, and reports anything off.
2. Future releases: Avery runs `npm run release` from `booking/`.

**Waiting on the user / open questions:**
- Feedback from a real phone.

**Watch out for:**
- Never push, deploy, or run remote migrations yourself; Avery does (memory: booking-wip-no-public).
- Migration 0019 rebuilds `nudge_emails`; apply it before deploying.
- Admin colours are theme tokens in `booking/admin/index.html` (`:root`, plus a dark block under `prefers-color-scheme` and `[data-theme="dark"]`). Use tokens, not hex, for new styles. The CSP blocks inline scripts, so a forced theme is applied by `app.js` (a brief flash is possible).
- Test "refund safety: a cancellation racing a reschedule…" is flaky; unrelated.
- Admin UI preview: `booking/.test-build/mock-sync.sh` copies the admin into `.test-build/mock/` (mock data from `.test-build/dump.mjs`); view at `/booking/.test-build/mock/index.html` on the static-site preview. All git-ignored.

**Key files:** `booking/admin/app.js.txt` + `booking/admin/index.html` (admin UI), `booking/src/followups.ts`, `booking/src/nudges.ts`, `booking/migrations/0019_followups.sql`
**Run / test:** `cd booking && npm test` · `npm run preview-emails`

## History
<!-- newest first -->

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
