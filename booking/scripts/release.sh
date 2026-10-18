#!/bin/sh
# Puts everything committed on master live, in the safe order:
#   1. checks you're on master with nothing uncommitted
#   2. pulls GitHub's changes first (the podcast sync commits there on its own)
#   3. checks the booking page version tags are current
#   4. runs the tests
#   5. applies any new database migrations      (live)
#   6. deploys the booking worker and admin     (live)
#   7. pushes master, which publishes the site  (live)
# It stops at the first problem, so nothing goes live if the tests fail, and the
# database is always updated before the code that needs it.
#
#   cd booking && npm run release              (does it)
#   cd booking && npm run release -- --check   (steps 1-4 only; nothing goes live)

set -eu

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
step() { printf '\n==> %s\n' "$1"; }
stop() { printf '\nStopped: %s\n' "$1" >&2; exit 1; }

step "Checking the working copy"
[ "$(git branch --show-current)" = "master" ] || stop "switch to master first (git checkout master)."
[ -z "$(git status --porcelain)" ] || { git status --short; stop "commit or set aside the changes above first."; }

step "Getting the latest from GitHub"
if [ "$CHECK_ONLY" = 1 ]; then
  git fetch --quiet origin master
  behind="$(git rev-list --count master..origin/master)"
  [ "$behind" = 0 ] && echo "Up to date." || echo "GitHub has $behind commit(s) you don't have yet; a real release pulls them first."
else
  git pull --rebase --quiet origin master || stop "the pull hit a conflict. Run 'git rebase --abort' to undo it, then ask for help."
  echo "Up to date."
fi

step "Checking the booking page version tags"
python3 booking/scripts/stamp-assets.py >/dev/null
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  stop "book/booking.js or booking.css changed without new version tags. They've just been updated: commit them, then run this again."
fi
echo "Current."

step "Running the tests"
cd "$ROOT/booking"
LOG="$(mktemp -t booking-release-tests)"
npm test --silent >"$LOG" 2>&1 || { tail -30 "$LOG"; stop "tests failed (full output: $LOG)."; }
grep -E "^ℹ (pass|fail)" "$LOG" || true

if [ "$CHECK_ONLY" = 1 ]; then
  step "Database migrations not yet applied (live database, read only)"
  npm run --silent cf -- d1 migrations list averywhitted-booking --remote || true
  printf '\nAll checks passed. Nothing was changed. Run "npm run release" to go live.\n'
  exit 0
fi

step "Applying new database migrations (Wrangler may ask you to confirm)"
npm run --silent cf -- d1 migrations apply averywhitted-booking --remote || stop "the migration failed, so nothing was deployed or pushed."

step "Deploying the booking worker"
npm run --silent deploy || stop "the deploy failed. The database is already updated (that's safe: new columns are unused until the new code is live). Fix the error and run this again."

step "Pushing master to GitHub (publishes the website)"
cd "$ROOT"
if ! git push --quiet origin master; then
  # The podcast sync may have committed in the last few minutes.
  git pull --rebase --quiet origin master || stop "the push was refused and the pull hit a conflict. Run 'git rebase --abort', then ask for help."
  git push --quiet origin master || stop "the push was refused twice. Run this again in a minute."
fi

printf '\nDone. Booking is deployed and master is on GitHub (the site updates in a minute or two).\n'
