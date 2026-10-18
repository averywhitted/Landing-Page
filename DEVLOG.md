# Dev Log — averywhitted.com (site + booking service)

## Resume here
_Updated 2026-10-18 11:24 EDT · branch `master` @ `6099805` · working tree: uncommitted: follow-up prompts + admin phone layout (booking/), DEVLOG.md, `_config.yml` exclude_

**Project:** Avery's static site on GitHub Pages (master) plus the in-house booking service in `booking/` (Cloudflare Worker + D1, Stripe, Resend, iCloud CalDAV, Zoom), live at book.averywhitted.com since 2026-09-29.
**Current goal:** Booking admin: "time to follow up" prompts and a usable phone layout.

**Where things stand:**
- Follow-up prompts built and tested (144 tests pass): a student whose last session was 7+ days ago (Settings: Off/3/5/7/10/14/21/30) with nothing booked shows in Needs attention (Email / Book / Dismiss), gets a "Follow up" button in Students, and is listed in a once-a-day 9 AM email to Avery (Settings toggle). New "After a recent session" email template, suggested under 60 days.
- Admin phone layout reworked: bottom tab bar, Connections collapsed to one chip, full-width filter rows with Show/Sort dropdowns, card buttons as 1-2 main buttons + "⋯" menu, "Live" badge moved to Settings (header only flags Test mode). Checked at 375px and 1200px in a mock page; not yet seen on a real phone or live data.
- NOT committed, migration NOT applied, worker NOT deployed.

**Next steps:**
1. Avery reviews, then commit on master (include DEVLOG.md and `_config.yml`).
2. Avery applies migration 0019 to remote D1, then deploys the worker (commands in the History entry below). No site files depend on this, so pushing master can happen any time.
3. Avery opens the admin on their phone and reports anything off.
4. Then, if wanted: the suggestions list from the 2026-10-18 entry.

**Waiting on the user / open questions:**
- Approval to commit; Avery runs the migration and deploy themself.
- Whether the "⋯" menu on desktop is OK (applied at all widths, not only phones).

**Watch out for:**
- Never push, deploy, or run remote migrations yourself; Avery does (memory: booking-wip-no-public).
- Migration 0019 rebuilds `nudge_emails` (SQLite can't change its CHECK to allow 'followup'). Apply it before deploying, or sending the new template fails.
- Test "refund safety: a cancellation racing a reschedule…" is flaky (failed once, passed 3 reruns); unrelated to this work.
- Admin UI preview: `booking/.test-build/dump.mjs` (built from a scratchpad script) makes mock API data from the real code; `booking/.test-build/mock-sync.sh` copies the admin into `.test-build/mock/`; view via the static-site preview at `/booking/.test-build/mock/index.html`. All git-ignored.
- New email headings need a PNG from `booking/tools/render-headings.html` plus entries in `src/email-headings.ts` and `HEADING_TITLES` (a test enforces it).

**Key files:** `booking/src/followups.ts` (who's due, dismiss, daily email), `booking/src/nudges.ts` (templates, warnings), `booking/src/config.ts` (followUpDays/followUpEmail), `booking/admin/app.js.txt` + `booking/admin/index.html` (admin UI), `booking/migrations/0019_followups.sql`
**Run / test:** `cd booking && npm test` · `npm run preview-emails` then open `/booking/.email-previews/` on the static-site preview

## History
<!-- newest first -->

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
