const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const redis = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Redis Client Setup ---
const REDIS_URL = process.env.REDIS_URL || 'redis://default:FLnxkIZytEzbyILWMyYYdoMdPAEYQQlP@caboose.proxy.rlwy.net:24360';
let redisClient;

const initializeRedis = async () => {
    redisClient = redis.createClient({ url: REDIS_URL });

    redisClient.on('error', (err) => console.error('Redis Client Error', err));
    redisClient.on('connect', () => console.log('Connected to Redis'));
    redisClient.on('reconnecting', () => console.log('Reconnecting to Redis...'));

    try {
        await redisClient.connect();
    } catch (err) {
        console.error('Failed to connect to Redis:', err);
    }
};

// Configure multer for file uploads
const upload = multer({ 
  dest: path.join(__dirname, '..', 'uploads'),
  limits: { fileSize: 2 * 1024 * 1024 } // 2MB limit
});

app.use(cors());
app.use(express.json());

// Add production optimizations
if (process.env.NODE_ENV === 'production') {
  // Compression middleware for faster response times
  const compression = require('compression');
  app.use(compression());
  
  // Security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });
  
  console.log('Production optimizations enabled');
}

// Game configuration
const SUPPORTED_GAMES = {
  hok: {
    name: "Honor of Kings",
    url: "https://www.midasbuy.com/midasbuy/br/redeem/hok",
    selectors: {
      switchIcon: 'i[class*="switch"]',
      inputField: 'input[placeholder*="ID"]',
      clearButton: 'div[class*="clean_btn"]',
      confirmButton: 'div[class*="btn_primary"]',
      errorMessage: 'div[class*="error_text"]',
      playerName: 'div[class*="UserDataBox_text"]'
    },
    errorText: 'ID de jogo inválida'
  },
  pubg: {
    name: "PUBG Mobile",
    url: "https://www.midasbuy.com/midasbuy/br/redeem/pubgm",
    selectors: {
      switchIcon: 'i[class*="switch"]',
      inputField: 'input[placeholder*="ID"]',
      clearButton: 'div[class*="clean_btn"]',
      confirmButton: 'div[class*="btn_primary"]',
      errorMessage: 'div[class*="error_text"]',
      playerName: 'div[class*="UserDataBox_text"]'
    },
    errorText: 'ID de jogo inválida'
  }
  // Add more games here in the future
};

// Load cookies from Redis
const loadCookies = async () => {
  try {
    if (!redisClient || !redisClient.isOpen) {
        console.log("Redis client not connected, attempting to connect...");
        await initializeRedis();
    }
    const cookiesData = await redisClient.get('midasbuy:cookies');
    if (cookiesData) {
      return JSON.parse(cookiesData);
    }
    console.warn('No cookies found in Redis. Please upload cookies via /cookieupload');
    return [];
  } catch (error) {
    console.error('Error loading cookies from Redis:', error);
    return [];
  }
};

// Save cookies to Redis
const saveCookies = async (cookies) => {
  try {
    if (!redisClient || !redisClient.isOpen) {
        console.log("Redis client not connected, attempting to connect...");
        await initializeRedis();
    }
    // Store cookies in a compact format
    await redisClient.set('midasbuy:cookies', JSON.stringify(cookies));
    return true;
  } catch (error) {
    console.error('Error saving cookies to Redis:', error);
    return false;
  }
};

// Create a single browser instance that can be reused
let browser;
let isInitializing = false;
let lastRequestTime = 0;
const activeRequests = new Map(); // Track active requests
const pagePool = new Map(); // Pool of pre-initialized pages by game
const MAX_POOL_SIZE = 2; // Maximum number of pages to keep in the pool per game
const INITIAL_POOL_SIZE = 5; // Initial number of pages to create per game

// Helper function to add delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to log with timing
function logWithTiming(message, delayTime = null, requestId = '') {
  const timingStr = delayTime ? ` ${delayTime}s` : '';
  const idStr = requestId ? `[${requestId}] ` : '';
  console.log(`${idStr}${message}${timingStr}`);
}

// Helper function to simulate human typing - faster now
async function typeHumanLike(page, selector, text, requestId) {
  try {
    await page.focus(selector);
    
    // Clear via JavaScript (fastest method)
    await page.evaluate((sel) => {
      const input = document.querySelector(sel);
      if (input) {
        input.value = '';
        // Trigger input event
        const event = new Event('input', { bubbles: true });
        input.dispatchEvent(event);
      }
    }, selector);
    
    // Type the text super fast
    await page.keyboard.type(text, { delay: 0 });
    
    // Verify the input has the correct value
    const inputValue = await page.evaluate((sel) => {
      const input = document.querySelector(sel);
      return input ? input.value : '';
    }, selector);
    
    logWithTiming(`Input field value: ${inputValue}`, 0.5, requestId);
    
    // If the value is not what we expect, try again
    if (inputValue !== text) {
      await page.evaluate((sel, txt) => {
        const input = document.querySelector(sel);
        if (input) {
          input.value = txt;
          // Trigger input event
          const event = new Event('input', { bubbles: true });
          input.dispatchEvent(event);
        }
      }, selector, text);
    }
  } catch (error) {
    console.error(`${requestId ? `[${requestId}] ` : ''}Error in typeHumanLike:`, error);
    throw error;
  }
}

// Helper function to bring a page to front
async function bringToFront(page) {
  if (!page || page.isClosed()) {
    console.warn('Warning: Cannot bring page to front because it is already closed.');
    return;
  }
  try {
    await page.bringToFront();
    // Force the page to be active
    await page.evaluate(() => {
      window.focus();
      document.body.click();
    });
  } catch (error) {
    if (error.message.includes('Target closed')) {
        console.warn('Warning: Could not bring page to front because it was already closed.');
    } else {
        console.error('Error bringing page to front:', error);
    }
  }
}

// Initialize browser on startup
async function initBrowser() {
  if (isInitializing) return;
  
  isInitializing = true;
  
  try {
    if (browser) {
      await browser.close().catch(() => {});
    }
    
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1366,768',
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--mute-audio',
        '--no-default-browser-check',
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-sync',
        '--disable-translate',
        '--no-zygote' // Added for stability in containerized environments
      ],
      defaultViewport: { width: 1366, height: 768 }
    };
    
    // Use system Chromium if environment variable is set
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      console.log(`Using Chromium at: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    
    browser = await puppeteer.launch(launchOptions);
    
    console.log('Browser initialized successfully');
    
    // Pre-initialize pages for each supported game
    for (const gameId of Object.keys(SUPPORTED_GAMES)) {
      await initPagePool(gameId, INITIAL_POOL_SIZE);
    }
  } catch (error) {
    console.error('Failed to initialize browser:', error);
    // Clean up if initialization failed
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
  } finally {
    isInitializing = false;
  }
}

// Initialize a pool of pages for a specific game
async function initPagePool(gameId, count) {
  try {
    if (!SUPPORTED_GAMES[gameId]) {
      console.error(`Game ${gameId} not supported`);
      return;
    }
    
    if (!pagePool.has(gameId)) {
      pagePool.set(gameId, []);
    }
    
    const gamePool = pagePool.get(gameId);
    
    // Calculate how many pages we need to create to reach the desired count
    const createCount = Math.min(count, MAX_POOL_SIZE - gamePool.length);
    
    if (createCount <= 0) {
      return;
    }
    
    // Create pages in parallel for faster initialization
    const promises = [];
    for (let i = 0; i < createCount; i++) {
      promises.push(createPreloadedPage(gameId));
    }
    
    // Use Promise.allSettled to handle individual page creation failures
    const results = await Promise.allSettled(promises);
    
    let successfulCreations = 0;
    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        gamePool.push(result.value);
        successfulCreations++;
      } else if (result.status === 'rejected') {
        console.error(`Failed to create a page for game ${gameId}:`, result.reason.message);
      }
    });
    
    if (successfulCreations > 0) {
        console.log(`Successfully initialized ${successfulCreations} of ${createCount} pages for game ${gameId}. Total in pool: ${gamePool.length}`);
    }
    if (successfulCreations < createCount) {
        console.warn(`Failed to initialize ${createCount - successfulCreations} pages for game ${gameId}.`);
    }

  } catch (error) {
    console.error(`Critical error in initPagePool for game ${gameId}:`, error);
  }
}

// Create a preloaded page for a specific game
async function createPreloadedPage(gameId) {
  const gameConfig = SUPPORTED_GAMES[gameId];
  if (!gameConfig) {
    throw new Error(`Game ${gameId} not supported`);
  }
  
  let page;
  try {
    page = await browser.newPage();
    page.setDefaultTimeout(15000); // Increase timeout to 15 seconds
    
    // Optimize page performance
    await page.setCacheEnabled(true);
    await page.setRequestInterception(true);
    
    // Block unnecessary resources
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (resourceType === 'image' || resourceType === 'font' || resourceType === 'media') {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    // Load cookies from Redis
    const cookies = await loadCookies();
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
    }
    
    // Navigate to the game's page
    await page.goto(gameConfig.url, {
      waitUntil: 'domcontentloaded', 
      timeout: 120000 // Increased timeout to 120 seconds for initial load
    });
    
    // Wait for the page to be fully loaded
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60000 });
    
    return page;
  } catch (error) {
    // Close the failed page and re-throw the error
    if (page) {
      await page.close().catch(e => console.error('Error closing failed page:', e));
    }
    throw error;
  }
}

// Get a page from the pool or create a new one for a specific game
async function getPage(gameId) {
  if (!pagePool.has(gameId)) {
    pagePool.set(gameId, []);
  }
  
  const gamePool = pagePool.get(gameId);
  
  if (gamePool.length > 0) {
    return gamePool.pop();
  }
  
  // If pool is empty, create a new page
  console.log(`Page pool for ${gameId} is empty. Creating a new page.`);
  return await createPreloadedPage(gameId);
}

// Return a page to the pool or close it
async function releasePage(page, gameId) {
  if (!page) return;
  
  try {
    if (!pagePool.has(gameId)) {
      pagePool.set(gameId, []);
    }
    
    const gamePool = pagePool.get(gameId);
    
    if (gamePool.length < MAX_POOL_SIZE) {
      // Reset the page
      const gameConfig = SUPPORTED_GAMES[gameId];
      await page.goto(gameConfig.url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      gamePool.push(page);
      
      // If the pool is getting low, create more pages in the background
      if (gamePool.length < MAX_POOL_SIZE / 2) {
        setTimeout(() => {
          initPagePool(gameId, MAX_POOL_SIZE - gamePool.length).catch(console.error);
        }, 0);
      }
    } else {
      await page.close().catch(() => {});
    }
  } catch (error) {
    await page.close().catch(() => {});
  }
}

// Function to check if browser is working correctly
async function isBrowserHealthy() {
  if (!browser) return false;
  
  try {
    // Try to create a test page
    const testPage = await browser.newPage();
    await testPage.close();
    return true;
  } catch (e) {
    return false;
  }
}

// Close browser on server shutdown
process.on('SIGINT', async () => {
  if (browser) {
    await browser.close().catch(() => {});
  }
  process.exit();
});

// Convert milliseconds to seconds with 2 decimal places
function msToSeconds(ms) {
  return (ms / 1000).toFixed(2);
}

// Generate a unique request ID
function generateRequestId() {
  return Math.random().toString(36).substring(2, 8);
}

// Get base URL for API endpoints
function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// API endpoint to list all supported games
app.get('/api/supportedgames', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const gamesList = Object.entries(SUPPORTED_GAMES).map(([gameId, gameConfig]) => {
    return {
      id: gameId,
      name: gameConfig.name,
      endpoint: `${baseUrl}/api/${gameId}/{playerId}`,
      example: `${baseUrl}/api/${gameId}/123456789`
    };
  });
  
  return res.json({
    total: gamesList.length,
    games: gamesList
  });
});

// API endpoint to check player ID for a specific game
app.get('/api/:gameId/:playerId', async (req, res) => {
  const startTime = Date.now();
  const { gameId, playerId } = req.params;
  const requestId = generateRequestId();
  
  logWithTiming(`[START] Received request for game: ${gameId}, player: ${playerId}`, null, requestId);

  // Check if the game is supported
  if (!SUPPORTED_GAMES[gameId]) {
    return res.status(400).json({ 
      error: 'Game not supported',
      supported_games: Object.keys(SUPPORTED_GAMES)
    });
  }
  
  const gameConfig = SUPPORTED_GAMES[gameId];
  
  if (!playerId) {
    return res.status(400).json({ error: 'Player ID is required' });
  }
  
  // Track this request
  activeRequests.set(requestId, { gameId, playerId, startTime });
  
  let page = null;
  
  // Set a global timeout for the entire request
  const timeoutId = setTimeout(() => {
    if (!res.headersSent) {
      logWithTiming(`[TIMEOUT] Request for player ${playerId} timed out after 45 seconds`, null, requestId);
      res.status(504).json({
        error: 'Request timed out after 45 seconds. The server may be under high load or the target site is slow.',
        game: gameId,
        id: playerId,
        during: msToSeconds(Date.now() - startTime)
      });
    }
    activeRequests.delete(requestId);
    if (page) {
      // Close the page instead of releasing it to the pool, as it might be in a bad state
      page.close().catch(e => console.error(`[${requestId}] Error closing timed-out page:`, e));
    }
  }, 45000); // 45-second timeout

  try {
    logWithTiming(`[BROWSER] Checking browser health...`, null, requestId);
    if (!browser || !(await isBrowserHealthy())) {
      logWithTiming(`[BROWSER] Browser unhealthy or not initialized. Re-initializing...`, null, requestId);
      await initBrowser();
      if (!browser) {
        throw new Error('Failed to initialize browser');
      }
    }
    
    logWithTiming(`[POOL] Getting page from pool for game ${gameId}...`, null, requestId);
    page = await getPage(gameId);
    logWithTiming(`[PAGE] Got page. Bringing to front...`, null, requestId);
    await bringToFront(page);
    
    let switchIconClicked = false;
    
    logWithTiming(`[ACTION] Trying to click switch icon (Approach 1: Standard)...`, null, requestId);
    try {
      await page.waitForSelector(gameConfig.selectors.switchIcon, { timeout: 5000, visible: true });
      await page.click(gameConfig.selectors.switchIcon);
      logWithTiming(`[SUCCESS] Clicked switch icon (standard selector)`, null, requestId);
      switchIconClicked = true;
    } catch (error) {
      logWithTiming(`[INFO] Switch icon not found with standard selector. Trying next approach.`, null, requestId);
    }
    
    if (!switchIconClicked) {
      logWithTiming(`[ACTION] Trying to click switch icon (Approach 2: Reload & JS)...`, null, requestId);
      try {
        logWithTiming(`[PAGE] Reloading page...`, null, requestId);
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        await delay(2000);
        await bringToFront(page);
        
        const clickResult = await page.evaluate((selector) => {
          const elements = document.querySelectorAll('i.icon');
          for (const el of elements) {
            if (el.className.includes('switch')) {
              el.click();
              return true;
            }
          }
          
          // Try finding by partial class
          const switchElements = document.querySelectorAll('[class*="switch"]');
          if (switchElements.length > 0) {
            switchElements[0].click();
            return true;
          }
          
          return false;
        }, gameConfig.selectors.switchIcon);
        
        if (clickResult) {
          logWithTiming(`[SUCCESS] Clicked switch icon (JavaScript method)`, null, requestId);
          switchIconClicked = true;
        }
      } catch (error) {
        logWithTiming(`[INFO] Error during reload and JS click. Trying next approach.`, null, requestId);
      }
    }
    
    if (!switchIconClicked) {
      logWithTiming(`[ACTION] Trying to find input field directly (Approach 3)...`, null, requestId);
      try {
        await page.waitForSelector(gameConfig.selectors.inputField, { timeout: 8000, visible: true });
        logWithTiming(`[SUCCESS] Input field found directly. Switch icon not needed.`, null, requestId);
      } catch (inputError) {
        throw new Error('Could not find player ID input field after all attempts.');
      }
    }
    
    // Wait for the player ID input field, with a retry mechanism
    logWithTiming(`[ACTION] Waiting for player ID input field...`, null, requestId);
    try {
      await page.waitForSelector(gameConfig.selectors.inputField, { timeout: 8000, visible: true });
    } catch (error) {
      logWithTiming('Input field not found on first try. Reloading and retrying...', null, requestId);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      
      // We need to click the switch icon again after reload
      try {
        await page.waitForSelector(gameConfig.selectors.switchIcon, { timeout: 5000, visible: true });
        await page.click(gameConfig.selectors.switchIcon);
        logWithTiming("Clicked switch icon again after reload.", null, requestId);
      } catch (e) {
        logWithTiming("Switch icon not found after reload, but will still try to find input.", null, requestId);
      }

      await page.waitForSelector(gameConfig.selectors.inputField, { timeout: 15000, visible: true });
    }
    
    logWithTiming(`[ACTION] Clearing input field...`, null, requestId);
    await page.evaluate((selector) => {
      const clearBtn = document.querySelector(selector);
      if (clearBtn && window.getComputedStyle(clearBtn).display !== 'none') {
        clearBtn.click();
      }
    }, gameConfig.selectors.clearButton);
    
    logWithTiming(`[ACTION] Typing player ID: ${playerId}`, null, requestId);
    await typeHumanLike(page, gameConfig.selectors.inputField, playerId, requestId);
    
    logWithTiming(`[ACTION] Clicking confirm button...`, null, requestId);
    await page.waitForSelector(gameConfig.selectors.confirmButton, { timeout: 8000, visible: true });
    await page.click(gameConfig.selectors.confirmButton);
    
    logWithTiming(`[WAIT] Waiting for response after confirm click...`, null, requestId);
    await delay(1500); 
    
    logWithTiming(`[CHECK] Checking for invalid ID message...`, null, requestId);
    const isInvalidId = await page.evaluate((errorSelector, errorText) => {
      // Check for the error text div that's currently visible
      const errorElement = document.querySelector(errorSelector);
      if (errorElement && 
          errorElement.textContent.includes(errorText) && 
          window.getComputedStyle(errorElement).display !== 'none') {
        return true;
      }
      
      return false;
    }, gameConfig.selectors.errorMessage, gameConfig.errorText);
    
    if (isInvalidId) {
      logWithTiming(`[RESULT] Invalid Game ID found for: ${playerId}`, null, requestId);
      clearTimeout(timeoutId);
      releasePage(page, gameId).catch(() => {});
      activeRequests.delete(requestId);
      return res.status(400).json({
        error: 'Invalid Game ID',
        game: gameId,
        id: playerId,
        during: msToSeconds(Date.now() - startTime)
      });
    }
    
    logWithTiming(`[CHECK] Checking for player name...`, null, requestId);
    const playerInfo = await page.evaluate((nameSelector) => {
      // First check if there's a player name
      const nameElement = document.querySelector(nameSelector);
      if (nameElement) {
        return {
          found: true,
          name: nameElement.textContent.replace('VIP', '').trim()
        };
      }
      return { found: false };
    }, gameConfig.selectors.playerName);
    
    clearTimeout(timeoutId);
    releasePage(page, gameId).catch(() => {});
    activeRequests.delete(requestId);
    
    if (!playerInfo.found) {
      logWithTiming(`[RESULT] Player not found for: ${playerId}`, null, requestId);
      return res.status(404).json({ 
        error: 'Player not found',
        game: gameId,
        id: playerId,
        during: msToSeconds(Date.now() - startTime)
      });
    }
    
    logWithTiming(`[SUCCESS] Found player: ${playerInfo.name}`, null, requestId);
    return res.json({
      game: gameId,
      id: playerId,
      name: playerInfo.name,
      during: msToSeconds(Date.now() - startTime)
    });
    
  } catch (error) {
    clearTimeout(timeoutId);
    logWithTiming(`[ERROR] Unhandled error for player ${playerId}: ${error.message}`, null, requestId);
    
    // If headers have already been sent by the timeout, do nothing more.
    if (res.headersSent) {
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
      }
      activeRequests.delete(requestId);
      return;
    }
    
    if (page) {
      await page.close().catch(() => {});
    }
    
    activeRequests.delete(requestId);
    
    return res.status(500).json({ 
      error: 'Failed to check player ID due to an unexpected error',
      details: error.message,
      game: gameId,
      id: playerId,
      during: msToSeconds(Date.now() - startTime)
    });
  }
});

// Backward compatibility for old API endpoint
app.get('/api/:playerId', async (req, res) => {
  const { playerId } = req.params;
  // Redirect to the new endpoint structure with 'hok' as the default game
  res.redirect(`/api/hok/${playerId}`);
});

// Status endpoint to show active requests
app.get('/status', async (req, res) => {
  const poolSizes = {};
  for (const [gameId, pool] of pagePool.entries()) {
    poolSizes[gameId] = pool.length;
  }
  
  const status = {
    activeRequests: Array.from(activeRequests.entries()).map(([id, data]) => ({
      id,
      game: data.gameId,
      playerId: data.playerId,
      duration: msToSeconds(Date.now() - data.startTime)
    })),
    poolSizes,
    supportedGames: Object.keys(SUPPORTED_GAMES),
    browserActive: browser !== null && await isBrowserHealthy()
  };
  
  return res.json(status);
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const healthy = browser && await isBrowserHealthy();
  if (healthy) {
    return res.json({ status: 'ok' });
  } else {
    // Try to initialize if not healthy
    if (!isInitializing) {
      initBrowser().catch(console.error);
    }
    return res.status(503).json({ status: 'initializing' });
  }
});

// Root route - API documentation
app.get('/', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Midasbuy ID Checker API</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        max-width: 800px;
        margin: 0 auto;
        padding: 20px;
        line-height: 1.6;
      }
      h1, h2 {
        color: #333;
      }
      a {
        color: #4CAF50;
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
      .endpoint {
        background-color: #f8f9fa;
        padding: 15px;
        margin: 10px 0;
        border-left: 4px solid #4CAF50;
        border-radius: 4px;
      }
      .endpoint h3 {
        margin-top: 0;
      }
      code {
        background-color: #f1f1f1;
        padding: 2px 5px;
        border-radius: 3px;
        font-family: monospace;
      }
      .button {
        display: inline-block;
        background-color: #4CAF50;
        color: white;
        padding: 10px 15px;
        text-align: center;
        border-radius: 4px;
        margin: 10px 0;
      }
    </style>
  </head>
  <body>
    <h1>Midasbuy ID Checker API</h1>
    <p>This API allows you to check player IDs on Midasbuy for various games.</p>
    
    <h2>Available Endpoints</h2>
    
    <div class="endpoint">
      <h3>Check Player ID</h3>
      <code>GET ${baseUrl}/api/{gameId}/{playerId}</code>
      <p>Check a player ID for a specific game.</p>
      <p>Example: <a href="${baseUrl}/api/hok/5113048677740798346" target="_blank">${baseUrl}/api/hok/5113048677740798346</a></p>
    </div>
    
    <div class="endpoint">
      <h3>List Supported Games</h3>
      <code>GET ${baseUrl}/api/supportedgames</code>
      <p>Get a list of all supported games and their API endpoints.</p>
      <p>Example: <a href="${baseUrl}/api/supportedgames" target="_blank">${baseUrl}/api/supportedgames</a></p>
    </div>
    
    <div class="endpoint">
      <h3>Upload Cookies</h3>
      <code>GET ${baseUrl}/cookieupload</code>
      <p>Web interface for uploading Midasbuy cookies.</p>
      <p><a href="${baseUrl}/cookieupload" class="button">Upload Cookies</a></p>
    </div>
    
    <div class="endpoint">
      <h3>API Status</h3>
      <code>GET ${baseUrl}/status</code>
      <p>View API status, active requests, and page pool information.</p>
      <p><a href="${baseUrl}/status" target="_blank">${baseUrl}/status</a></p>
    </div>
    
    <div class="endpoint">
      <h3>Health Check</h3>
      <code>GET ${baseUrl}/health</code>
      <p>Check if the API is healthy and ready to process requests.</p>
      <p><a href="${baseUrl}/health" target="_blank">${baseUrl}/health</a></p>
    </div>
    
    <h2>Getting Started</h2>
    <p>To use this API, you need to:</p>
    <ol>
      <li>Upload your Midasbuy cookies via the <a href="${baseUrl}/cookieupload">Cookie Upload</a> page</li>
      <li>Check the <a href="${baseUrl}/api/supportedgames">supported games</a> to see available game IDs</li>
      <li>Make requests to <code>${baseUrl}/api/{gameId}/{playerId}</code> to check player IDs</li>
    </ol>
  </body>
  </html>
  `;
  
  res.send(html);
});

// Cookie upload endpoint - HTML form
app.get('/cookieupload', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Upload Midasbuy Cookies</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        max-width: 800px;
        margin: 0 auto;
        padding: 20px;
        background-color: #f9f9f9;
        color: #333;
        transition: all 0.3s ease;
      }
      h1, h2, h3 {
        color: #333;
        transition: color 0.3s ease;
      }
      textarea {
        width: 100%;
        height: 300px;
        margin: 10px 0;
        padding: 10px;
        font-family: monospace;
        border: 1px solid #ddd;
        border-radius: 4px;
        transition: border 0.3s ease, box-shadow 0.3s ease;
      }
      textarea:focus {
        outline: none;
        border-color: #4CAF50;
        box-shadow: 0 0 5px rgba(76, 175, 80, 0.3);
      }
      button {
        background-color: #4CAF50;
        color: white;
        padding: 10px 15px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 16px;
        margin-right: 10px;
        transition: background-color 0.3s ease, transform 0.1s ease;
      }
      button:hover {
        background-color: #45a049;
      }
      button:active {
        transform: scale(0.98);
      }
      .info {
        background-color: #f8f9fa;
        padding: 15px;
        border-left: 4px solid #17a2b8;
        margin: 20px 0;
        border-radius: 0 4px 4px 0;
        transition: transform 0.3s ease, box-shadow 0.3s ease;
      }
      .info:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.1);
      }
      .success {
        background-color: #d4edda;
        color: #155724;
        padding: 15px;
        border-radius: 4px;
        margin-top: 15px;
        animation: fadeIn 0.5s ease;
        border-left: 4px solid #155724;
      }
      .error {
        background-color: #f8d7da;
        color: #721c24;
        padding: 15px;
        border-radius: 4px;
        margin-top: 15px;
        animation: fadeIn 0.5s ease;
        border-left: 4px solid #721c24;
      }
      .tab {
        overflow: hidden;
        border: 1px solid #ccc;
        background-color: #f1f1f1;
        border-radius: 4px 4px 0 0;
        box-shadow: 0 2px 4px rgba(0,0,0,0.05);
      }
      .tab button {
        background-color: inherit;
        float: left;
        border: none;
        outline: none;
        cursor: pointer;
        padding: 14px 16px;
        transition: 0.3s;
        font-size: 16px;
        color: #333;
        margin: 0;
        position: relative;
      }
      .tab button:hover {
        background-color: #ddd;
      }
      .tab button.active {
        background-color: #4CAF50;
        color: white;
      }
      .tab button.active::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 3px;
        background-color: #2e7d32;
      }
      .tabcontent {
        display: none;
        padding: 20px;
        border: 1px solid #ccc;
        border-top: none;
        border-radius: 0 0 4px 4px;
        animation: fadeIn 0.5s ease;
        background-color: white;
        box-shadow: 0 2px 4px rgba(0,0,0,0.05);
      }
      .file-input-container {
        margin: 20px 0;
      }
      .file-input-container input[type="file"] {
        margin-bottom: 15px;
      }
      .show {
        display: block;
      }
      .format-toggle {
        margin-top: 10px;
        margin-bottom: 20px;
      }
      .format-toggle button {
        background-color: #f1f1f1;
        color: #333;
        padding: 5px 10px;
        margin-right: 5px;
        transition: all 0.3s ease;
      }
      .format-toggle button.active {
        background-color: #4CAF50;
        color: white;
      }
      pre {
        background-color: #f5f5f5;
        padding: 10px;
        border-radius: 4px;
        overflow-x: auto;
        border-left: 3px solid #4CAF50;
        transition: transform 0.3s ease;
      }
      pre:hover {
        transform: translateX(3px);
      }
      .custom-file-input {
        position: relative;
        display: inline-block;
        width: 100%;
        margin-bottom: 15px;
      }
      .custom-file-input input {
        position: absolute;
        left: 0;
        top: 0;
        opacity: 0;
        width: 100%;
        height: 100%;
        cursor: pointer;
        z-index: 10;
      }
      .custom-file-label {
        display: block;
        padding: 10px 15px;
        background-color: #f8f9fa;
        border: 1px dashed #ccc;
        border-radius: 4px;
        text-align: center;
        color: #666;
        transition: all 0.3s ease;
      }
      .custom-file-input:hover .custom-file-label {
        border-color: #4CAF50;
        background-color: #e8f5e9;
      }
      .file-name {
        margin-top: 5px;
        font-size: 14px;
        color: #4CAF50;
        display: none;
      }
      .loader-container {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(255, 255, 255, 0.8);
        z-index: 1000;
        justify-content: center;
        align-items: center;
      }
      .loader {
        border: 5px solid #f3f3f3;
        border-top: 5px solid #4CAF50;
        border-radius: 50%;
        width: 50px;
        height: 50px;
        animation: spin 1s linear infinite;
      }
      .loader-text {
        margin-top: 15px;
        font-weight: bold;
        color: #4CAF50;
      }
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .card {
        background-color: white;
        border-radius: 8px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        padding: 20px;
        margin-bottom: 20px;
        transition: all 0.3s ease;
      }
      .card:hover {
        box-shadow: 0 8px 15px rgba(0,0,0,0.1);
        transform: translateY(-3px);
      }
      .header {
        text-align: center;
        margin-bottom: 30px;
      }
      .header h1 {
        margin-bottom: 10px;
        color: #2e7d32;
      }
      .header p {
        color: #666;
        font-size: 16px;
      }
      .back-to-home {
        display: inline-block;
        margin-top: 20px;
        color: #4CAF50;
        text-decoration: none;
        transition: all 0.3s ease;
      }
      .back-to-home:hover {
        color: #2e7d32;
        text-decoration: underline;
      }
    </style>
  </head>
  <body>
    <div class="loader-container">
      <div class="loader"></div>
      <div class="loader-text">Processing cookies...</div>
    </div>
    
    <div class="header">
      <h1>Upload Midasbuy Cookies</h1>
      <p>Authenticate your API requests by uploading your Midasbuy cookies</p>
    </div>
    
    <div class="card">
      <div class="info">
        <p>You can upload your Midasbuy cookies either by pasting JSON data or by uploading a cookies.json file.</p>
        <p>We support multiple cookie formats from various browser extensions and developer tools.</p>
      </div>
      
      <div class="tab">
        <button class="tablinks active" onclick="openTab(event, 'PasteJSON')">Paste JSON</button>
        <button class="tablinks" onclick="openTab(event, 'UploadFile')">Upload File</button>
        <button class="tablinks" onclick="openTab(event, 'Help')">Help</button>
      </div>
      
      <div id="PasteJSON" class="tabcontent show">
        <div class="info">
          <p>Paste your Midasbuy cookies in JSON format below.</p>
          <div class="format-toggle">
            <strong>Example Format:</strong>
            <button onclick="showFormat('format1')" class="active" id="format1Btn">Standard Array</button>
            <button onclick="showFormat('format2')" id="format2Btn">Name-Value Object</button>
            <button onclick="showFormat('format3')" id="format3Btn">Browser Extension</button>
          </div>
          
          <div id="format1" class="format-example">
            <pre>[
  {
    "name": "cookie_name",
    "value": "cookie_value",
    "domain": ".midasbuy.com",
    "path": "/",
    "expires": -1,
    "httpOnly": true,
    "secure": true
  },
  ...
]</pre>
          </div>
          
          <div id="format2" class="format-example" style="display:none;">
            <pre>{
  "cookie_name1": "cookie_value1",
  "cookie_name2": "cookie_value2",
  "cookie_name3": "cookie_value3"
}</pre>
          </div>
          
          <div id="format3" class="format-example" style="display:none;">
            <pre>{
  "cookies": {
    "cookie_id_1": {
      "name": "cookie_name",
      "value": "cookie_value",
      "domain": ".midasbuy.com"
    },
    "cookie_id_2": {
      "name": "another_cookie",
      "value": "another_value",
      "domain": ".midasbuy.com"
    }
  }
}</pre>
          </div>
        </div>
        
        <form id="cookieForm" action="/cookieupload" method="post">
          <textarea id="cookieData" name="cookieData" placeholder="Paste your cookies here in JSON format"></textarea>
          <button type="submit">Upload Cookies</button>
        </form>
      </div>
      
      <div id="UploadFile" class="tabcontent">
        <div class="info">
          <p>Upload your cookies.json file. The file should contain cookies in one of the supported formats.</p>
          <p>You can export cookies using browser extensions like "EditThisCookie" or "Cookie-Editor".</p>
        </div>
        
        <form id="fileUploadForm" action="/cookieupload/file" method="post" enctype="multipart/form-data">
          <div class="file-input-container">
            <div class="custom-file-input">
              <input type="file" id="cookieFile" name="cookieFile" accept=".json">
              <div class="custom-file-label">
                <span>Choose file or drag & drop</span>
              </div>
            </div>
            <div class="file-name" id="fileName"></div>
            <button type="submit">Upload File</button>
          </div>
        </form>
      </div>
      
      <div id="Help" class="tabcontent">
        <h2>How to Get Midasbuy Cookies</h2>
        
        <div class="info">
          <h3>Method 1: Using Cookie-Editor Extension</h3>
          <ol>
            <li>Install the <a href="https://chrome.google.com/webstore/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm" target="_blank">Cookie-Editor extension</a> for Chrome</li>
            <li>Go to <a href="https://www.midasbuy.com" target="_blank">Midasbuy.com</a> and log in</li>
            <li>Click on the Cookie-Editor extension icon</li>
            <li>Click "Export" and select "JSON" format</li>
            <li>Copy the exported JSON or save it as a file</li>
            <li>Paste or upload the cookies here</li>
          </ol>
        </div>
        
        <div class="info">
          <h3>Method 2: Using Browser Developer Tools</h3>
          <ol>
            <li>Go to <a href="https://www.midasbuy.com" target="_blank">Midasbuy.com</a> and log in</li>
            <li>Open Developer Tools (F12 or right-click > Inspect)</li>
            <li>Go to the "Application" tab (Chrome) or "Storage" tab (Firefox)</li>
            <li>Find "Cookies" in the sidebar and click on "www.midasbuy.com"</li>
            <li>You'll need to manually copy these cookies into a JSON format</li>
          </ol>
        </div>
        
        <div class="info">
          <h3>Common Issues</h3>
          <ul>
            <li><strong>Invalid JSON format</strong>: Make sure your JSON is properly formatted without syntax errors</li>
            <li><strong>Missing name/value</strong>: Each cookie must have at least a name and value property</li>
            <li><strong>Wrong domain</strong>: Cookies should be for the .midasbuy.com domain</li>
          </ul>
        </div>
      </div>
    </div>
    
    <div id="message"></div>
    
    <a href="/" class="back-to-home">← Back to Home</a>
    
    <script>
      // Tab functionality
      function openTab(evt, tabName) {
        var i, tabcontent, tablinks;
        tabcontent = document.getElementsByClassName("tabcontent");
        for (i = 0; i < tabcontent.length; i++) {
          tabcontent[i].style.display = "none";
        }
        tablinks = document.getElementsByClassName("tablinks");
        for (i = 0; i < tablinks.length; i++) {
          tablinks[i].className = tablinks[i].className.replace(" active", "");
        }
        document.getElementById(tabName).style.display = "block";
        evt.currentTarget.className += " active";
      }
      
      // Format toggle functionality
      function showFormat(formatId) {
        document.getElementById('format1').style.display = 'none';
        document.getElementById('format2').style.display = 'none';
        document.getElementById('format3').style.display = 'none';
        document.getElementById(formatId).style.display = 'block';
        
        document.getElementById('format1Btn').classList.remove('active');
        document.getElementById('format2Btn').classList.remove('active');
        document.getElementById('format3Btn').classList.remove('active');
        document.getElementById(formatId + 'Btn').classList.add('active');
      }
      
      // Show loader function
      function showLoader() {
        document.querySelector('.loader-container').style.display = 'flex';
      }
      
      // Hide loader function
      function hideLoader() {
        document.querySelector('.loader-container').style.display = 'none';
      }
      
      // File input enhancement
      document.getElementById('cookieFile').addEventListener('change', function(e) {
        const fileName = e.target.files[0] ? e.target.files[0].name : '';
        if (fileName) {
          document.getElementById('fileName').textContent = 'Selected file: ' + fileName;
          document.getElementById('fileName').style.display = 'block';
          document.querySelector('.custom-file-label span').textContent = 'File selected';
        } else {
          document.getElementById('fileName').style.display = 'none';
          document.querySelector('.custom-file-label span').textContent = 'Choose file or drag & drop';
        }
      });
      
      // Drag and drop functionality
      const dropArea = document.querySelector('.custom-file-input');
      
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, preventDefaults, false);
      });
      
      function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
      }
      
      ['dragenter', 'dragover'].forEach(eventName => {
        dropArea.addEventListener(eventName, highlight, false);
      });
      
      ['dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, unhighlight, false);
      });
      
      function highlight() {
        dropArea.querySelector('.custom-file-label').style.borderColor = '#4CAF50';
        dropArea.querySelector('.custom-file-label').style.backgroundColor = '#e8f5e9';
      }
      
      function unhighlight() {
        dropArea.querySelector('.custom-file-label').style.borderColor = '#ccc';
        dropArea.querySelector('.custom-file-label').style.backgroundColor = '#f8f9fa';
      }
      
      dropArea.addEventListener('drop', handleDrop, false);
      
      function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        document.getElementById('cookieFile').files = files;
        
        const fileName = files[0] ? files[0].name : '';
        if (fileName) {
          document.getElementById('fileName').textContent = 'Selected file: ' + fileName;
          document.getElementById('fileName').style.display = 'block';
          document.querySelector('.custom-file-label span').textContent = 'File selected';
        }
      }
      
      // JSON paste form submission
      document.getElementById('cookieForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const cookieData = document.getElementById('cookieData').value;
        
        try {
          // Validate JSON
          JSON.parse(cookieData);
          
          // Show loader
          showLoader();
          
          const response = await fetch('/cookieupload', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ cookies: cookieData })
          });
          
          const result = await response.json();
          
          // Hide loader
          hideLoader();
          
          const messageDiv = document.getElementById('message');
          if (response.ok) {
            messageDiv.className = 'success';
            messageDiv.textContent = \`Success! \${result.cookieCount} cookies uploaded. The server is updating with new cookies.\`;
            
            // Clear the textarea after successful upload
            document.getElementById('cookieData').value = '';
          } else {
            messageDiv.className = 'error';
            messageDiv.textContent = \`Error: \${result.error || 'Unknown error occurred'}\`;
          }
          
          // Scroll to message
          messageDiv.scrollIntoView({ behavior: 'smooth' });
        } catch (error) {
          const messageDiv = document.getElementById('message');
          messageDiv.className = 'error';
          messageDiv.textContent = 'Invalid JSON format. Please check your cookie data.';
          
          // Scroll to message
          messageDiv.scrollIntoView({ behavior: 'smooth' });
        }
      });
      
      // File upload form submission
      document.getElementById('fileUploadForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const fileInput = document.getElementById('cookieFile');
        if (!fileInput.files || fileInput.files.length === 0) {
          const messageDiv = document.getElementById('message');
          messageDiv.className = 'error';
          messageDiv.textContent = 'Please select a file to upload.';
          
          // Scroll to message
          messageDiv.scrollIntoView({ behavior: 'smooth' });
          return;
        }
        
        // Show loader
        showLoader();
        
        const formData = new FormData();
        formData.append('cookieFile', fileInput.files[0]);
        
        try {
          const response = await fetch('/cookieupload/file', {
            method: 'POST',
            body: formData
          });
          
          const result = await response.json();
          
          // Hide loader
          hideLoader();
          
          const messageDiv = document.getElementById('message');
          if (response.ok) {
            messageDiv.className = 'success';
            messageDiv.textContent = \`Success! \${result.cookieCount} cookies uploaded. The server is updating with new cookies.\`;
            
            // Reset file input
            fileInput.value = '';
            document.getElementById('fileName').style.display = 'none';
            document.querySelector('.custom-file-label span').textContent = 'Choose file or drag & drop';
          } else {
            messageDiv.className = 'error';
            messageDiv.textContent = \`Error: \${result.error || 'Unknown error occurred'}\`;
          }
          
          // Scroll to message
          messageDiv.scrollIntoView({ behavior: 'smooth' });
        } catch (error) {
          // Hide loader
          hideLoader();
          
          const messageDiv = document.getElementById('message');
          messageDiv.className = 'error';
          messageDiv.textContent = 'Error uploading file. Please try again.';
          
          // Scroll to message
          messageDiv.scrollIntoView({ behavior: 'smooth' });
        }
      });
    </script>
  </body>
  </html>
  `;
  
  res.send(html);
});

// Cookie upload endpoint - POST handler for JSON paste
app.post('/cookieupload', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { cookies } = req.body;
    
    if (!cookies) {
      return res.status(400).json({ error: 'No cookie data provided' });
    }
    
    // Parse the cookie data
    let cookieData;
    try {
      cookieData = JSON.parse(cookies);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON format' });
    }
    
    // Process and normalize cookies
    const processedCookies = processCookies(cookieData);
    if (!processedCookies || processedCookies.length === 0) {
      return res.status(400).json({ error: 'No valid cookies found in the provided data' });
    }
    
    // Save cookies to Redis
    if (!(await saveCookies(processedCookies))) {
      return res.status(500).json({ error: 'Failed to save cookies to Redis' });
    }
    
    // Restart browser to apply new cookies
    console.log('New cookies uploaded. Restarting browser...');
    await initBrowser();
    
    return res.json({ 
      success: true, 
      message: 'Cookies uploaded successfully',
      cookieCount: processedCookies.length
    });
  } catch (error) {
    console.error('Error in cookie upload:', error);
    return res.status(500).json({ error: 'Server error while processing cookies' });
  }
});

// Cookie upload endpoint - POST handler for file upload
app.post('/cookieupload/file', upload.single('cookieFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Read the uploaded file
    const filePath = req.file.path;
    let cookieData;
    
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      cookieData = JSON.parse(fileContent);
      
      // Clean up the uploaded file
      fs.unlinkSync(filePath);
    } catch (e) {
      // Clean up the uploaded file even on error
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return res.status(400).json({ error: 'Invalid JSON file format: ' + e.message });
    }
    
    // Process and normalize cookies
    const processedCookies = processCookies(cookieData);
    if (!processedCookies || processedCookies.length === 0) {
      return res.status(400).json({ error: 'No valid cookies found in the uploaded file' });
    }
    
    // Save cookies to Redis
    if (!(await saveCookies(processedCookies))) {
      return res.status(500).json({ error: 'Failed to save cookies to Redis' });
    }
    
    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    // Restart browser to apply new cookies
    console.log('New cookies uploaded via file. Restarting browser...');
    await initBrowser();
    
    return res.json({ 
      success: true, 
      message: 'Cookies uploaded successfully from file',
      cookieCount: processedCookies.length
    });
  } catch (error) {
    console.error('Error in cookie file upload:', error);
    return res.status(500).json({ error: 'Server error while processing cookie file: ' + error.message });
  }
});

// Helper function to process and normalize cookies from various formats
function processCookies(cookieData) {
  // If it's not an array or object, return empty array
  if (typeof cookieData !== 'object') {
    return [];
  }
  
  // Handle different cookie formats
  let processedCookies = [];
  
  // Case 1: Array of cookie objects (standard format)
  if (Array.isArray(cookieData)) {
    processedCookies = cookieData.map(cookie => {
      // Ensure each cookie has at least name and value
      if (typeof cookie === 'object' && cookie !== null) {
        return {
          name: cookie.name || '',
          value: cookie.value || '',
          domain: cookie.domain || '.midasbuy.com',
          path: cookie.path || '/',
          expires: cookie.expires || -1,
          httpOnly: cookie.httpOnly || false,
          secure: cookie.secure || false,
          session: cookie.session || false
        };
      }
      return null;
    }).filter(cookie => cookie && cookie.name && cookie.value);
  }
  // Case 2: Object with cookie names as keys (common browser extension format)
  else if (!Array.isArray(cookieData) && cookieData !== null) {
    // Check if it has cookies property (some extensions nest under this)
    const cookiesObj = cookieData.cookies || cookieData;
    
    // Convert object to array of cookie objects
    for (const [key, value] of Object.entries(cookiesObj)) {
      if (typeof value === 'object' && value !== null) {
        // Format where object properties are cookie objects
        processedCookies.push({
          name: value.name || key,
          value: value.value || '',
          domain: value.domain || '.midasbuy.com',
          path: value.path || '/',
          expires: value.expires || -1,
          httpOnly: value.httpOnly || false,
          secure: value.secure || false,
          session: value.session || false
        });
      } else if (typeof value === 'string') {
        // Format where object keys are cookie names and values are cookie values
        processedCookies.push({
          name: key,
          value: value,
          domain: '.midasbuy.com',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: true,
          session: false
        });
      }
    }
  }
  
  // Filter out any cookies without name and value
  return processedCookies.filter(cookie => cookie && cookie.name && cookie.value);
}

// Initialize browser when server starts
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  await initializeRedis();
  await initBrowser();
}); 