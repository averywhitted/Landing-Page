# Going live

Every step, in order. Steps marked **(Avery)** happen in a dashboard or your
Terminal; nothing here is run automatically. Budget about an hour.

## Before launch day

- [ ] **(Avery)** Bring the test setup up to date (new database table, the
      key for the admin-page iCloud password, and the latest code), then try
      the new pieces in test mode:
      ```
      cd "/Users/averywhitted/Documents/GitHub/Landing Page/booking" && npm run cf -- d1 migrations apply averywhitted-booking --remote && ./scripts/push-secrets.sh && npm run deploy -- --var SITE_URL:http://localhost:8743
      ```
- [ ] Approve (or change) the bundle refund policy for student cancellations,
      so those refunds can be automatic like single sessions.
- [ ] Approve the wording for the policies page (repeating sessions, refund
      requests, payment deadlines, payment requests).
- [ ] **(Avery)** Zoom: add the "Delete a meeting" permission
      (`meeting:delete:meeting:admin`) to the Server-to-Server app.
- [ ] **(Avery)** Stripe (live mode): Settings > Emails > turn on
      "Successful payments" receipts.

## 1. Stripe live mode (Avery)

1. In Stripe, switch off **Test mode**.
2. **Developers > API keys > Create restricted key**, named "Booking service",
   with these permissions (everything else "None"):
   - Checkout Sessions: **Write**
   - Refunds: **Write**
   - Promotion Codes: **Read**
3. Save it to Keychain (paste when asked; it isn't shown):
   ```
   security add-generic-password -a "$USER" -s stripe-live-key -w
   ```
4. **Developers > Webhooks > Add endpoint**:
   - URL: `https://book.averywhitted.com/api/stripe/webhook`
   - Events: `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`
5. Reveal the endpoint's **Signing secret** and save it:
   ```
   security add-generic-password -a "$USER" -s stripe-live-webhook-secret -w
   ```
6. **Settings > Branding**: logo, colors (brand #1f47f5, accent #e3f24d).
7. **Settings > Payment methods** (live): make sure Apple Pay and Google Pay are on.
8. Create a 100%-off promo code (Products > Coupons) for the first real test.

## 2. Clear the test data (Avery)

Admin page > **Settings** > **Clear all test data** (type CLEAR). This removes
test sessions from your Coaching calendar and Zoom too. Your settings stay.

## 3. Turnstile (Avery)

Cloudflare > Turnstile > your widget > Settings > hostnames: keep
`averywhitted.com` and `www.averywhitted.com`; **remove** `localhost` and
`192.168.1.155`.

## 4. Switch the booking service to live (Avery)

```
cd "/Users/averywhitted/Documents/GitHub/Landing Page/booking" && ./scripts/push-secrets.sh live && npm run deploy
```

(No `--var SITE_URL` this time: the real address comes from wrangler.toml.)
The admin page's mode tag should now say **Live**.

## 5. Publish the website (Claude prepares, Avery approves and pushes)

Claude merges the `booking-service` branch into `master` (bringing in the
podcast sync commit and restamping version tags), without any of Avery's
uncommitted edits. Avery reviews, then pushes; GitHub Pages publishes it.

## 6. Real-world check (Avery, on your phone)

1. On averywhitted.com, book a session with the 100%-off code.
2. Book another with a real card at a low price (or your own card on a $1 test
   price set from the admin page's "Book a student").
3. Check: emails, Coaching calendar, Zoom link, admin page.
4. Cancel the real-card one from the email link and confirm the refund.
5. Try the booking pop-up flow that gave trouble before (switch sessions, back,
   close and reopen).

## 7. Retire Cal.com (Avery)

1. Put any upcoming Cal.com bookings on your iCloud calendar (so the new
   system blocks those times), or re-book them from the admin page.
2. Update any Cal.com links outside this site (social bios, email signature).
3. Cancel the Cal.com plan.

## If something goes wrong

- The admin page's **Needs attention** tab lists anything stuck.
- You'll be emailed if iCloud can't be reached, or emails keep failing.
- Backups: Settings > Download a backup; nightly copies are kept 30 days.
