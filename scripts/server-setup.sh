#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu/Debian VPS. Run as a user with sudo:
#   curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/scripts/server-setup.sh | bash -s -- <git-clone-url>
# or copy this file to the server and run:  bash server-setup.sh git@github.com:<you>/<repo>.git
set -euo pipefail
REPO="${1:-}"
APP_DIR="$HOME/codelesson-ai"
[ -n "$REPO" ] || { echo "Usage: bash server-setup.sh <git clone URL of your repo>"; exit 1; }

echo "==> Installing Docker, git and curl"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sudo sh; fi
sudo apt-get update -qq && sudo apt-get install -y -qq git curl openssl >/dev/null
sudo usermod -aG docker "$USER" || true

mkdir -p ~/.ssh && chmod 700 ~/.ssh
if [[ "$REPO" == git@* ]] && [ ! -f ~/.ssh/repo_deploy_key ]; then
  echo "==> Creating a read-only deploy key so this server can pull your (private) repo"
  ssh-keygen -t ed25519 -N "" -f ~/.ssh/repo_deploy_key -C "codelesson-server" >/dev/null
  cat >> ~/.ssh/config <<CFG
Host github.com
  IdentityFile ~/.ssh/repo_deploy_key
  IdentitiesOnly yes
CFG
  ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
  echo
  echo "Add this key in GitHub → your repo → Settings → Deploy keys → Add deploy key (leave 'write access' off):"
  echo; cat ~/.ssh/repo_deploy_key.pub; echo
  read -rp "Press Enter once the deploy key is added… " _ </dev/tty
fi

echo "==> Cloning $REPO"
[ -d "$APP_DIR/.git" ] || git clone "$REPO" "$APP_DIR"
cd "$APP_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  read -rp "Gemini API key (free at https://aistudio.google.com/apikey): " GK </dev/tty
  sed -i "s|^GEMINI_API_KEY=.*|GEMINI_API_KEY=$GK|; s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|; s|^COOKIE_SECURE=.*|COOKIE_SECURE=1|" .env
  chmod 600 .env
fi

echo "==> Creating the key GitHub Actions uses to deploy here"
if [ ! -f ~/.ssh/github_actions ]; then
  ssh-keygen -t ed25519 -N "" -f ~/.ssh/github_actions -C "github-actions-deploy" >/dev/null
  cat ~/.ssh/github_actions.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
fi

echo "==> Starting CodeLesson AI"
sudo docker compose up -d --build

cat <<DONE

✓ CodeLesson AI is running on port 3000.

Finish auto-deploy: in GitHub → your repo → Settings → Secrets and variables → Actions, add:
  VPS_HOST      $(curl -fsS https://api.ipify.org 2>/dev/null || echo '<this server IP>')
  VPS_USER      $USER
  VPS_SSH_KEY   (the whole private key below, including the BEGIN/END lines)

$(cat ~/.ssh/github_actions)

Then set up HTTPS (see README › Deploying to a server). Log out and back in once so your user can run docker without sudo.
DONE
