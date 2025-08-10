FROM node:18-slim

# Install dependencies for Puppeteer
RUN apt-get update \
    && apt-get install -y chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
       ca-certificates libxss1 \
       --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables for Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

# Create app directory
WORKDIR /app

# Copy package.json, package-lock.json and .npmrc
COPY package*.json .npmrc ./

# Install app dependencies using package-lock.json
# Modified to use Railway's required cache mount format
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm ci --only=production

# Bundle app source
COPY . .

# Create uploads directory
RUN mkdir -p uploads

# Expose port
EXPOSE 3000

# Start the app
CMD ["npm", "start"] 