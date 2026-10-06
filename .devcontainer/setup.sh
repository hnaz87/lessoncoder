#!/usr/bin/env bash
# Runs once when the codespace is created: builds .env from Codespaces secrets.
set -e
[ -f .env ] || cp .env.example .env
setvar() { # setvar KEY VALUE — replace or append KEY=VALUE in .env
  local k="$1" v="$2"
  if grep -q "^$k=" .env; then sed -i "s|^$k=.*|$k=$v|" .env; else echo "$k=$v" >> .env; fi
}
[ -n "$GEMINI_API_KEY" ] && setvar GEMINI_API_KEY "$GEMINI_API_KEY"
grep -q '^SESSION_SECRET=change-me' .env && setvar SESSION_SECRET "$(openssl rand -hex 32)"
setvar COOKIE_SECURE 1
echo "✓ .env ready"
