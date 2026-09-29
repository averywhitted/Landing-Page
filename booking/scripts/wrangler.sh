#!/bin/sh
# Runs Wrangler with the limited Cloudflare key stored in your Mac's Keychain.
# The key is read at run time and never written to a file or to this repo.
CLOUDFLARE_API_TOKEN="$(security find-generic-password -s cloudflare-booking-token -w 2>/dev/null)"
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "No Cloudflare key found in Keychain (cloudflare-booking-token)." >&2
  exit 1
fi
export CLOUDFLARE_API_TOKEN
exec npx wrangler "$@"
