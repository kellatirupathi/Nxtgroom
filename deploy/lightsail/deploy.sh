#!/usr/bin/env bash
# Build and release the API on the Lightsail instance.
#
#   deploy/lightsail/deploy.sh             # deploy the latest origin/main
#   deploy/lightsail/deploy.sh <git-ref>   # deploy a branch, tag or commit
#   deploy/lightsail/deploy.sh --rollback  # return to the previous release
#
# Each release is an image tagged with its commit. If the new container does
# not become live within the timeout, the previous image is started again.
# Avoid deploying during the 9 AM and 6 PM attendance rushes: a restart drops
# requests that are in flight.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$REPO_DIR/grooming_api_node"
STATE_DIR="$REPO_DIR/deploy/lightsail/.state"
CURRENT_FILE="$STATE_DIR/current-tag"
PREVIOUS_FILE="$STATE_DIR/previous-tag"
KEEP_IMAGES=3
LIVE_TIMEOUT_SECONDS=90

mkdir -p "$STATE_DIR"
cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "grooming_api_node/.env is missing; create it before deploying." >&2
  exit 1
fi
chmod 600 .env

compose() { docker compose "$@"; }

wait_until_live() {
  local waited=0
  until curl -fsS --max-time 3 http://127.0.0.1:8000/health/live >/dev/null 2>&1; do
    if (( waited >= LIVE_TIMEOUT_SECONDS )); then return 1; fi
    sleep 3
    waited=$(( waited + 3 ))
  done
}

start_tag() {
  IMAGE_TAG="$1" compose up -d --no-build --remove-orphans
}

if [[ "${1:-}" == "--rollback" ]]; then
  if [[ ! -s "$PREVIOUS_FILE" ]]; then
    echo "No previous release recorded." >&2
    exit 1
  fi
  target="$(cat "$PREVIOUS_FILE")"
  echo "==> Rolling back to $target"
  start_tag "$target"
  wait_until_live || { echo "Rollback target did not become live; check: docker logs facultytrack-api" >&2; exit 1; }
  cp "$CURRENT_FILE" "$PREVIOUS_FILE" 2>/dev/null || true
  echo "$target" > "$CURRENT_FILE"
  echo "Rolled back to $target."
  exit 0
fi

REF="${1:-origin/main}"
echo "==> Fetching $REF"
git -C "$REPO_DIR" fetch --prune origin
git -C "$REPO_DIR" checkout --quiet --detach "$REF"
TAG="$(git -C "$REPO_DIR" rev-parse --short=12 HEAD)"
PREVIOUS_TAG="$(cat "$CURRENT_FILE" 2>/dev/null || true)"

echo "==> Building image facultytrack-api:$TAG"
IMAGE_TAG="$TAG" compose build --pull

echo "==> Starting $TAG"
start_tag "$TAG"

if ! wait_until_live; then
  echo "!! $TAG did not become live within ${LIVE_TIMEOUT_SECONDS}s. Last log lines:" >&2
  docker logs --tail 40 facultytrack-api >&2 || true
  if [[ -n "$PREVIOUS_TAG" ]]; then
    echo "==> Restoring $PREVIOUS_TAG" >&2
    start_tag "$PREVIOUS_TAG"
    wait_until_live || echo "!! The previous release is not live either; investigate now." >&2
  fi
  exit 1
fi

[[ -n "$PREVIOUS_TAG" && "$PREVIOUS_TAG" != "$TAG" ]] && echo "$PREVIOUS_TAG" > "$PREVIOUS_FILE"
echo "$TAG" > "$CURRENT_FILE"

echo "==> Readiness (MongoDB, R2 and all four workers)"
# Workers report their first progress a few seconds after start.
sleep 10
if curl -fsS --max-time 10 http://127.0.0.1:8000/health/ready; then
  echo
else
  echo
  echo "!! Live but not ready yet. Re-check in a minute: curl -s http://127.0.0.1:8000/health/ready" >&2
fi

echo "==> Removing old images (keeping the newest $KEEP_IMAGES)"
docker image ls facultytrack-api --format '{{.CreatedAt}}\t{{.Tag}}' \
  | sort -r | tail -n +$(( KEEP_IMAGES + 1 )) | cut -f2 \
  | grep -vx -e "$TAG" -e "${PREVIOUS_TAG:-__none__}" \
  | xargs -r -I{} docker image rm "facultytrack-api:{}" >/dev/null 2>&1 || true
docker image prune -f >/dev/null

echo "Deployed $TAG."
