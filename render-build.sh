#!/usr/bin/env bash
# exit on error
set -o errexit

# Install dependencies required for Chrome
apt-get update
apt-get install -y wget gnupg

# Add Google Chrome repository
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list

# Update and install Google Chrome
apt-get update
apt-get install -y google-chrome-stable

# Print Chrome version and path for debugging
google-chrome --version
which google-chrome-stable

# Set environment variables
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Install Node.js dependencies
yarn install 