#!/usr/bin/env bash
# exit on error
set -o errexit

echo "Starting Render build script..."

# Install dependencies required for Chrome
echo "Installing dependencies for Chrome..."
apt-get update
apt-get install -y wget gnupg ca-certificates

# Add Google Chrome repository
echo "Adding Google Chrome repository..."
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list

# Update and install Google Chrome
echo "Installing Google Chrome..."
apt-get update
apt-get install -y google-chrome-stable

# Print Chrome version and path for debugging
echo "Chrome version:"
google-chrome --version
echo "Chrome path:"
which google-chrome-stable
ls -la /usr/bin/google-chrome*

# Set environment variables
echo "Setting environment variables..."
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
export NODE_ENV=production

# Install Node.js dependencies
echo "Installing Node.js dependencies..."
yarn install

echo "Build script completed successfully." 