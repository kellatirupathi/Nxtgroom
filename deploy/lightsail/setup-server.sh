#!/usr/bin/env bash
# One-time preparation of a fresh Lightsail Ubuntu 24.04 instance.
#
#   sudo deploy/lightsail/setup-server.sh api.example.com ops@example.com
#
# Run from inside the cloned repository. Before running:
#   1. The instance has a static IP attached.
#   2. The API hostname's DNS A record points at that static IP (Let's Encrypt
#      verifies it over HTTP).
#   3. The Lightsail firewall allows TCP 80 and 443 (and 22 from your IP).
#
# Safe to re-run: every step checks whether it has already been done.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "Usage: sudo $0 <api-hostname> <email-for-certificate-expiry-notices>" >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$REPO_DIR/grooming_api_node"
SITE_TEMPLATE="$REPO_DIR/deploy/lightsail/nginx/facultytrack-api.conf"
SITE_AVAILABLE="/etc/nginx/sites-available/facultytrack-api"
SITE_ENABLED="/etc/nginx/sites-enabled/facultytrack-api"
DEPLOY_USER="${SUDO_USER:-ubuntu}"

echo "==> Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl git nginx certbot docker.io docker-compose-v2 unattended-upgrades
systemctl enable --now docker nginx
usermod -aG docker "$DEPLOY_USER"

echo "==> Swap (2 GB): emergency memory so a spike slows the API instead of killing it"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
# Prefer RAM; touch swap only under real pressure.
echo 'vm.swappiness=10' > /etc/sysctl.d/99-facultytrack.conf
sysctl --system >/dev/null

echo "==> Nginx: temporary HTTP site for the certificate challenge"
mkdir -p /var/www/certbot
rm -f /etc/nginx/sites-enabled/default
if [[ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  cat > "$SITE_AVAILABLE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 503; }
}
EOF
  ln -sf "$SITE_AVAILABLE" "$SITE_ENABLED"
  nginx -t
  systemctl reload nginx

  echo "==> Requesting the Let's Encrypt certificate for $DOMAIN"
  certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" \
    --email "$EMAIL" --agree-tos --no-eff-email --non-interactive
fi

echo "==> Nginx: installing the HTTPS site"
sed "s/api\.example\.com/$DOMAIN/g" "$SITE_TEMPLATE" > "$SITE_AVAILABLE"
ln -sf "$SITE_AVAILABLE" "$SITE_ENABLED"
nginx -t
systemctl reload nginx

# certbot's systemd timer renews automatically; reload Nginx after each renewal.
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

echo "==> Checking the API environment file"
if [[ -f "$APP_DIR/.env" ]]; then
  chown "$DEPLOY_USER":"$DEPLOY_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "    $APP_DIR/.env found; permissions set to 600."
else
  echo "    $APP_DIR/.env is missing. Create it from .env.example (see DEPLOYMENT.md), then run deploy.sh."
fi

echo
echo "Setup complete."
echo "  - Log out and back in so '$DEPLOY_USER' can use Docker without sudo."
echo "  - Then run: deploy/lightsail/deploy.sh"
