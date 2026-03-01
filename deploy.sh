#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/dev/apps/mom-email"
DATA_DIR="${APP_DIR}/data"
CONTAINER_NAME="mom-sandbox"

cd "$APP_DIR"

echo "Installing dependencies..."
npm install

echo "Building..."
npm run build

echo "Ensuring data directory exists..."
mkdir -p "$DATA_DIR"

echo "Setting up Docker sandbox container..."
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "  Starting existing container: $CONTAINER_NAME"
        docker start "$CONTAINER_NAME"
    else
        echo "  Container $CONTAINER_NAME already running"
    fi
else
    echo "  Creating container: $CONTAINER_NAME"
    docker run -d \
        --name "$CONTAINER_NAME" \
        -v "${DATA_DIR}:/workspace" \
        alpine:latest \
        tail -f /dev/null
fi

echo "Installing systemd service..."
sudo cp "${APP_DIR}/mom-email.service" /etc/systemd/system/mom-email.service
sudo systemctl daemon-reload
sudo systemctl enable mom-email
sudo systemctl restart mom-email

# Read WEBHOOK_PORT from .env (default 3000)
WEBHOOK_PORT=$(grep -oP '^WEBHOOK_PORT=\K.*' "${APP_DIR}/.env" 2>/dev/null || echo "3000")

echo "Setting up Tailscale Funnel on port ${WEBHOOK_PORT}..."
tailscale funnel --bg "$WEBHOOK_PORT"

echo "Done!"
echo ""
tailscale funnel status
