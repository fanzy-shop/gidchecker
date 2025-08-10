const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Game configuration
const SUPPORTED_GAMES = {
  hok: {
    name: "Honor of Kings",
    url: "https://www.midasbuy.com/midasbuy/br/redeem/hok",
    selectors: {
      switchIcon: 'i.i-midas\\:switch.icon',
      inputField: '.SelectServerBox_input_wrap_box__qq\\+Iq input',
      clearButton: '.SelectServerBox_clean_btn__l9g-e',
      confirmButton: '.Button_btn__P0ibl.Button_btn_primary__1ncdM',
      errorMessage: '.SelectServerBox_error_text__JWMz-',
      playerName: '.UserDataBox_text__PBFYE'
    },
    errorText: 'ID de jogo inválida'
  },
  pubg: {
    name: "PUBG Mobile",
    url: "https://www.midasbuy.com/midasbuy/br/redeem/pubgm",
    selectors: {
      switchIcon: 'i.i-midas\\:switch.icon',
      inputField: '.SelectServerBox_input_wrap_box__qq\\+Iq input',
      clearButton: '.SelectServerBox_clean_btn__l9g-e',
      confirmButton: '.Button_btn__P0ibl.Button_btn_primary__1ncdM',
      errorMessage: '.SelectServerBox_error_text__JWMz-',
      playerName: '.UserDataBox_text__PBFYE'
    },
    errorText: 'ID de jogo inválida'
  }
  // Add more games here in the future
};

// Load cookies from file
const loadCookies = () => {
  try {
    const cookiesPath = path.join(__dirname, '..', 'cookies.json');
    if (fs.existsSync(cookiesPath)) {
      const cookiesData = fs.readFileSync(cookiesPath, 'utf8');
      return JSON.parse(cookiesData);
    }
    console.warn('Cookies file not found');
    return [];
  } catch (error) {
    console.error('Error loading cookies:', error);
    return [];
  }
};

// Create a single browser instance that can be reused
let browser;
let isInitializing = false;
const activeRequests = new Map(); // Track active requests
const pagePool = new Map(); // Pool of pre-initialized pages by game
const MAX_POOL_SIZE = 10; // Maximum number of pages to keep in the pool per game
const MAX_CONCURRENT_REQUESTS = 20; // Maximum number of concurrent requests
const requestQueue = new Map(); // Queue for requests by game

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

// Initialize browser on startup
async function initBrowser() {
  if (isInitializing) return;
  
  isInitializing = true;
  
  try {
    if (browser) {
      await browser.close().catch(() => {});
    }
    
    browser = await puppeteer.launch({
      headless: "new", // Hide browser for production
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
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
        '--disable-background-networking',
        '--disable-breakpad',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--disable-features=site-per-process,TranslateUI,BlinkGenPropertyTrees'
      ],
      defaultViewport: { width: 1366, height: 768 }
    });
    
    console.log('Browser initialized successfully');
    
    // Pre-initialize pages for each supported game
    for (const gameId of Object.keys(SUPPORTED_GAMES)) {
      await initPagePool(gameId, 5); // Increase initial pool size
      
      // Initialize request queue for each game
      if (!requestQueue.has(gameId)) {
        requestQueue.set(gameId, []);
      }
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
    
    for (let i = 0; i < count; i++) {
      try {
        const page = await createPreloadedPage(gameId);
        gamePool.push(page);
      } catch (error) {
        console.error(`Error creating page for game ${gameId}:`, error);
      }
    }
    console.log(`Initialized ${gamePool.length} pages in the pool for game ${gameId}`);
  } catch (error) {
    console.error(`Error initializing page pool for game ${gameId}:`, error);
  }
}

// Create a preloaded page for a specific game
async function createPreloadedPage(gameId) {
  const gameConfig = SUPPORTED_GAMES[gameId];
  if (!gameConfig) {
    throw new Error(`Game ${gameId} not supported`);
  }
  
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  
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
  
  // Load cookies
  const cookies = loadCookies();
  if (cookies.length > 0) {
    await page.setCookie(...cookies);
  }
  
  // Navigate to the game's page
  await page.goto(gameConfig.url, {
    waitUntil: 'domcontentloaded',
    timeout: 20000
  });
  
  return page;
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
        timeout: 20000
      });
      gamePool.push(page);
      
      // Process next request in queue if any
      processNextInQueue(gameId);
    } else {
      await page.close().catch(() => {});
    }
  } catch (error) {
    await page.close().catch(() => {});
    
    // Process next request in queue even if there was an error
    processNextInQueue(gameId);
  }
}

// Process the next request in the queue for a specific game
async function processNextInQueue(gameId) {
  if (!requestQueue.has(gameId)) {
    return;
  }
  
  const queue = requestQueue.get(gameId);
  if (queue.length === 0) {
    return;
  }
  
  // Get the next request from the queue
  const nextRequest = queue.shift();
  
  // Execute the request
  try {
    const result = await checkPlayerId(nextRequest.gameId, nextRequest.playerId, nextRequest.requestId);
    nextRequest.resolve(result);
  } catch (error) {
    nextRequest.reject(error);
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

// Get the number of active requests for a game
function getActiveRequestsCount(gameId) {
  let count = 0;
  for (const [_, data] of activeRequests.entries()) {
    if (data.gameId === gameId) {
      count++;
    }
  }
  return count;
}

// Check if we should queue a request
function shouldQueueRequest(gameId) {
  const activeCount = getActiveRequestsCount(gameId);
  return activeCount >= MAX_CONCURRENT_REQUESTS / Object.keys(SUPPORTED_GAMES).length;
}

// Add a request to the queue
function addToQueue(gameId, playerId, requestId) {
  return new Promise((resolve, reject) => {
    if (!requestQueue.has(gameId)) {
      requestQueue.set(gameId, []);
    }
    
    const queue = requestQueue.get(gameId);
    queue.push({ gameId, playerId, requestId, resolve, reject });
    
    logWithTiming(`Request queued. Queue length: ${queue.length}`, null, requestId);
  });
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

// Core function to check player ID
async function checkPlayerId(gameId, playerId, requestId) {
  const startTime = Date.now();
  
  // Track this request
  activeRequests.set(requestId, { gameId, playerId, startTime });
  
  // Get a page for this request
  let page = null;
  
  try {
    const gameConfig = SUPPORTED_GAMES[gameId];
    
    // Get a page from the pool or create a new one
    page = await getPage(gameId);
    
    // Click the switch icon
    try {
      await page.waitForSelector(gameConfig.selectors.switchIcon, { timeout: 5000 });
      await page.click(gameConfig.selectors.switchIcon);
      logWithTiming("Clicked switch icon", 0.2, requestId);
    } catch (error) {
      logWithTiming('Switch icon not found, reloading page...', null, requestId);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(gameConfig.selectors.switchIcon, { timeout: 5000 });
      await page.click(gameConfig.selectors.switchIcon);
    }
    
    // Wait for the player ID input field
    logWithTiming("Waiting for input field...", 0.2, requestId);
    await page.waitForSelector(gameConfig.selectors.inputField, { timeout: 5000 });
    
    // First click the clear button if it exists and is visible
    await page.evaluate((selector) => {
      const clearBtn = document.querySelector(selector);
      if (clearBtn && window.getComputedStyle(clearBtn).display !== 'none') {
        clearBtn.click();
      }
    }, gameConfig.selectors.clearButton);
    
    // Type the player ID with faster typing
    logWithTiming(`Typing player ID: ${playerId}`, 0.5, requestId);
    await typeHumanLike(page, gameConfig.selectors.inputField, playerId, requestId);
    
    // Click the confirm button
    logWithTiming("Clicking confirm button", 0.5, requestId);
    await page.waitForSelector(gameConfig.selectors.confirmButton, { timeout: 5000 });
    await page.click(gameConfig.selectors.confirmButton);
    
    // Wait for the player name to appear or error message
    logWithTiming("Waiting for response...", null, requestId);
    await delay(800);
    
    // Check for invalid game ID message
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
      logWithTiming(`Invalid Game ID: ${playerId}`, null, requestId);
      const durationSec = msToSeconds(Date.now() - startTime);
      
      // Return page to the pool
      releasePage(page, gameId).catch(() => {});
      
      // Remove from active requests
      activeRequests.delete(requestId);
      
      return {
        status: 400,
        body: {
          error: 'Invalid Game ID',
          game: gameId,
          id: playerId,
          during: durationSec
        }
      };
    }
    
    // Wait for player name element
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
    
    // Calculate duration in seconds
    const durationMs = Date.now() - startTime;
    const durationSec = msToSeconds(durationMs);
    
    // Return page to the pool
    releasePage(page, gameId).catch(() => {});
    
    // Remove from active requests
    activeRequests.delete(requestId);
    
    if (!playerInfo.found) {
      logWithTiming(`Player not found: ${playerId}`, null, requestId);
      return {
        status: 404,
        body: { 
          error: 'Player not found',
          game: gameId,
          id: playerId,
          during: durationSec
        }
      };
    }
    
    logWithTiming(`Success: ID ${playerId} -> ${playerInfo.name} (${durationSec}s)`, null, requestId);
    return {
      status: 200,
      body: {
        game: gameId,
        id: playerId,
        name: playerInfo.name,
        during: durationSec
      }
    };
    
  } catch (error) {
    console.error(`[${requestId}] Error checking player ID ${playerId}:`, error);
    
    // Calculate duration even for errors
    const durationMs = Date.now() - startTime;
    const durationSec = msToSeconds(durationMs);
    
    // Close the page on error instead of returning to pool
    if (page) {
      await page.close().catch(() => {});
    }
    
    // Remove from active requests
    activeRequests.delete(requestId);
    
    return {
      status: 500,
      body: { 
        error: 'Failed to check player ID',
        game: gameId,
        id: playerId,
        during: durationSec
      }
    };
  }
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
  const { gameId, playerId } = req.params;
  const requestId = generateRequestId();
  
  // Check if the game is supported
  if (!SUPPORTED_GAMES[gameId]) {
    return res.status(400).json({ 
      error: 'Game not supported',
      supported_games: Object.keys(SUPPORTED_GAMES)
    });
  }
  
  if (!playerId) {
    return res.status(400).json({ error: 'Player ID is required' });
  }
  
  // Initialize browser if not already done
  if (!browser || !(await isBrowserHealthy())) {
    await initBrowser();
    if (!browser) {
      return res.status(500).json({ error: 'Failed to initialize browser' });
    }
  }
  
  try {
    // Check if we should queue this request
    if (shouldQueueRequest(gameId)) {
      // Add to queue and wait for result
      const result = await addToQueue(gameId, playerId, requestId);
      return res.status(result.status).json(result.body);
    } else {
      // Process immediately
      const result = await checkPlayerId(gameId, playerId, requestId);
      return res.status(result.status).json(result.body);
    }
  } catch (error) {
    console.error(`[${requestId}] Request failed:`, error);
    return res.status(500).json({ 
      error: 'Server error',
      message: error.message
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
  
  const queueSizes = {};
  for (const [gameId, queue] of requestQueue.entries()) {
    queueSizes[gameId] = queue.length;
  }
  
  const status = {
    activeRequests: Array.from(activeRequests.entries()).map(([id, data]) => ({
      id,
      game: data.gameId,
      playerId: data.playerId,
      duration: msToSeconds(Date.now() - data.startTime)
    })),
    activeCount: activeRequests.size,
    poolSizes,
    queueSizes,
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

// Initialize browser when server starts
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  await initBrowser();
}); 