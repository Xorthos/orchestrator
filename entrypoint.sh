#!/bin/sh
set -e

REPO_DIR="/workspace/repo"
REPO_URL="https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git"

# --- Git identity ---
git config --global user.name "${GIT_USER_NAME:-${GITHUB_OWNER}}"
git config --global user.email "${GIT_USER_EMAIL:-${GITHUB_OWNER}@users.noreply.github.com}"

# --- HTTPS credential helper so git push works ---
git config --global credential.helper store
printf 'https://%s:%s@github.com\n' "${GITHUB_OWNER}" "${GITHUB_TOKEN}" \
  > ~/.git-credentials
chmod 600 ~/.git-credentials

# --- Clone or update the target repo ---
if [ -d "${REPO_DIR}/.git" ]; then
  echo "Repo already cloned — pulling latest…"
  cd "${REPO_DIR}"
  git fetch --all
  DEFAULT_BRANCH=$(git remote show origin | sed -n 's/.*HEAD branch: //p')
  git checkout "${DEFAULT_BRANCH}"
  git pull
else
  echo "Cloning ${REPO_URL} → ${REPO_DIR}…"
  git clone "${REPO_URL}" "${REPO_DIR}"
fi

# --- Hand off to the Node.js app ---
exec node /app/dist/index.js
