#!/bin/sh
# Copies the booking service's keys from this Mac's Keychain into Cloudflare's
# encrypted secret storage. Values are piped straight across: they are never
# printed, written to a file, or stored in this repo.
#
#   ./scripts/push-secrets.sh
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

echo "Copying keys from Keychain to Cloudflare..."
push STRIPE_SECRET_KEY      stripe-test-key
push STRIPE_WEBHOOK_SECRET  stripe-webhook-secret
push RESEND_API_KEY         resend-booking-key
push ZOOM_ACCOUNT_ID        zoom-account-id
push ZOOM_CLIENT_ID         zoom-client-id
push ZOOM_CLIENT_SECRET     zoom-client-secret
push TURNSTILE_SECRET_KEY   turnstile-secret-key

# Random values the service generates once and must keep:
#   HASH_SALT           scrambles visitors' IP addresses before storing them
#   MANAGE_LINK_SECRET  signs clients' reschedule/cancel links (changing it
#                       would break every link already emailed)
existing=$(./scripts/wrangler.sh secret list 2>/dev/null)
for name in HASH_SALT MANAGE_LINK_SECRET; do
  if printf '%s' "$existing" | grep -q "\"$name\""; then
    echo "  kept    $name (already set)"
  elif openssl rand -hex 32 | ./scripts/wrangler.sh secret put "$name" >/dev/null 2>&1; then
    echo "  saved   $name (new random value)"
  else
    echo "  FAILED  $name"
  fi
done
echo "Done. (ICLOUD_APP_PASSWORD was saved earlier.)"
