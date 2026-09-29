#!/bin/sh
# Copies the booking service's keys from this Mac's Keychain into Cloudflare's
# encrypted secret storage. Values are piped straight across: they are never
# printed, written to a file, or stored in this repo.
#
#   ./scripts/push-secrets.sh          test mode (Stripe test key and webhook)
#   ./scripts/push-secrets.sh live     live mode (real payments)
#
# Each line is: <Cloudflare secret name> <Keychain item name>
set -u
cd "$(dirname "$0")/.."

push() {
  name="$1"; item="$2"
  if ! security find-generic-password -s "$item" >/dev/null 2>&1; then
    echo "  skipped $name (no Keychain item \"$item\")"
    return
  fi
  if security find-generic-password -s "$item" -w | ./scripts/wrangler.sh secret put "$name" >/dev/null 2>&1; then
    echo "  saved   $name"
  else
    echo "  FAILED  $name (run: security find-generic-password -s $item -w | npm run cf -- secret put $name)"
  fi
}

mode="${1:-test}"
if [ "$mode" = "live" ]; then
  stripe_key=stripe-live-key; stripe_hook=stripe-live-webhook-secret
  # Never go live half set up: both live Stripe items must exist first.
  for item in "$stripe_key" "$stripe_hook"; do
    if ! security find-generic-password -s "$item" >/dev/null 2>&1; then
      echo "Missing Keychain item \"$item\". Nothing was changed."; exit 1
    fi
  done
  case "$(security find-generic-password -s "$stripe_key" -w)" in
    rk_live_*|sk_live_*) ;;
    *) echo "\"$stripe_key\" isn't a live Stripe key (it should start with rk_live_). Nothing was changed."; exit 1 ;;
  esac
elif [ "$mode" = "test" ]; then
  stripe_key=stripe-test-key; stripe_hook=stripe-webhook-secret
else
  echo "Use: ./scripts/push-secrets.sh [test|live]"; exit 1
fi

echo "Copying $mode keys from Keychain to Cloudflare..."
push STRIPE_SECRET_KEY      "$stripe_key"
push STRIPE_WEBHOOK_SECRET  "$stripe_hook"
push RESEND_API_KEY         resend-booking-key
push ZOOM_ACCOUNT_ID        zoom-account-id
push ZOOM_CLIENT_ID         zoom-client-id
push ZOOM_CLIENT_SECRET     zoom-client-secret
push TURNSTILE_SECRET_KEY   turnstile-secret-key

# Random values the service generates once and must keep:
#   HASH_SALT           scrambles visitors' IP addresses before storing them
#   MANAGE_LINK_SECRET  signs clients' reschedule/cancel links (changing it
#                       would break every link already emailed)
#   SECRETS_KEY         encrypts the iCloud password when it's changed from the
#                       admin page (changing it just falls back to the setup password)
existing=$(./scripts/wrangler.sh secret list 2>/dev/null)
for name in HASH_SALT MANAGE_LINK_SECRET SECRETS_KEY; do
  if printf '%s' "$existing" | grep -q "\"$name\""; then
    echo "  kept    $name (already set)"
  elif openssl rand -hex 32 | ./scripts/wrangler.sh secret put "$name" >/dev/null 2>&1; then
    echo "  saved   $name (new random value)"
  else
    echo "  FAILED  $name"
  fi
done
echo "Done. (ICLOUD_APP_PASSWORD was saved earlier.)"
