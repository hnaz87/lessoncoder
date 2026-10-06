#!/usr/bin/env bash
# Runs every time the codespace starts: builds and starts the app and the Python sandbox.
set -e
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker compose up -d --build
echo
if ! grep -q '^GEMINI_API_KEY=.\+' .env; then
  echo "! No GEMINI_API_KEY yet. Get a free key at https://aistudio.google.com/apikey, add it to .env, then run: docker compose up -d"
fi
echo "✓ CodeLesson AI is starting — open the Ports tab and click the globe next to port 3000."
