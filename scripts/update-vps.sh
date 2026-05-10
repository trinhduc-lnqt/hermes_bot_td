#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PM2_NAME="${PM2_NAME:-hermes-bot}"
BRANCH="${BRANCH:-}"

cd "$APP_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is not installed."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not installed."
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Repo has local uncommitted changes. Refusing to pull."
  git status --short
  exit 1
fi

if [ -z "$BRANCH" ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi

if [ "$BRANCH" = "HEAD" ] || [ -z "$BRANCH" ]; then
  echo "ERROR: Cannot detect current branch. Set BRANCH=main or BRANCH=master and rerun."
  exit 1
fi

BEFORE="$(git rev-parse HEAD)"
echo "Fetching origin/$BRANCH..."
git fetch origin "$BRANCH"

REMOTE="$(git rev-parse "origin/$BRANCH")"
if [ "$BEFORE" = "$REMOTE" ]; then
  echo "Already up to date at ${BEFORE:0:7}."
else
  echo "Updating ${BEFORE:0:7} -> ${REMOTE:0:7}..."
  git pull --ff-only origin "$BRANCH"

  if git diff --name-only "$BEFORE..HEAD" | grep -Eq '^(package.json|package-lock.json)$'; then
    echo "Dependencies changed. Running npm install..."
    npm install
  fi
fi

if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
    echo "Restarting PM2 process: $PM2_NAME"
    pm2 restart "$PM2_NAME" --update-env
  else
    echo "PM2 process '$PM2_NAME' not found. Starting it..."
    pm2 start src/bot.js --name "$PM2_NAME"
  fi
  pm2 save || true
else
  echo "PM2 is not installed. Start the bot manually with: npm start"
fi

echo "Done. Current commit: $(git rev-parse --short HEAD)"
