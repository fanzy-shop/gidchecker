const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for file uploads
const upload = multer({ 
  dest: path.join(__dirname, '..', 'uploads'),
  limits: { fileSize: 2 * 1024 * 1024 } // 2MB limit
});

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
    // Try to load from root directory first (for Docker)
    let cookiesPath = path.join(__dirname, '..', 'cookies.json');
    if (!fs.existsSync(cookiesPath)) {
      // Try alternative path (for local development)
      cookiesPath = path.join(__dirname, 'cookies.json');
    }
    
    if (fs.existsSync(cookiesPath)) {
      const cookiesData = fs.readFileSync(cookiesPath, 'utf8');
      return JSON.parse(cookiesData);
    }
    
    // Create empty cookies file if it doesn't exist
    const sampleCookiesPath = path.join(__dirname, 'sample-cookies.json');
    if (fs.existsSync(sampleCookiesPath)) {
      const sampleCookiesData = fs.readFileSync(sampleCookiesPath, 'utf8');
      fs.writeFileSync(cookiesPath, sampleCookiesData, 'utf8');
      console.log('Created cookies.json from sample file');
      return JSON.parse(sampleCookiesData);
    } else {
      fs.writeFileSync(cookiesPath, '[]', 'utf8');
      console.log('Created empty cookies.json file');
    }
    
    console.warn('No cookies available. Please upload cookies via /cookieupload');
    return [];
  } catch (error) {
    console.error('Error loading cookies:', error);
    return [];
  }
};

// Save cookies to file
const saveCookies = (cookies) => {
  try {
    // Try to save to root directory first (for Docker)
    let cookiesPath = path.join(__dirname, '..', 'cookies.json');
    if (!fs.existsSync(path.dirname(cookiesPath))) {
      // Use alternative path (for local development)
      cookiesPath = path.join(__dirname, 'cookies.json');
    }
    
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error saving cookies:', error);
    return false;
  }
};

// Create a single browser instance that can be reused
let browser;
let isInitializing = false;
let lastRequestTime = 0;
const activeRequests = new Map(); // Track active requests
const pagePool = new Map(); // Pool of pre-initialized pages by game
const MAX_POOL_SIZE = 10; // Maximum number of pages to keep in the pool per game
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
  try {
    await page.bringToFront();
    // Force the page to be active
    await page.evaluate(() => {
      window.focus();
      document.body.click();
    });
  } catch (error) {
    console.error('Error bringing page to front:', error);
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
        '--disable-translate'
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
    
    const pages = await Promise.all(promises);
    gamePool.push(...pages);
    
    console.log(`Initialized ${createCount} pages in the pool for game ${gameId}. Total: ${gamePool.length}`);
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
        timeout: 20000
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
  
  // Ensure we don't overwhelm the site with requests
  const now = Date.now();
  if (now - lastRequestTime < 100) {
    await delay(100 - (now - lastRequestTime));
  }
  lastRequestTime = Date.now();
  
  // Track this request
  activeRequests.set(requestId, { gameId, playerId, startTime });
  
  // Get a page for this request
  let page = null;
  
  try {
    // Initialize browser if not already done
    if (!browser || !(await isBrowserHealthy())) {
      await initBrowser();
      if (!browser) {
        return res.status(500).json({ error: 'Failed to initialize browser' });
      }
    }
    
    // Get a page from the pool or create a new one
    page = await getPage(gameId);
    
    // Bring the page to front to ensure it's active
    await bringToFront(page);
    
    // Click the switch icon
    try {
      await page.waitForSelector(gameConfig.selectors.switchIcon, { timeout: 5000 });
      await page.click(gameConfig.selectors.switchIcon);
      logWithTiming("Clicked switch icon", 0.2, requestId);
    } catch (error) {
      logWithTiming('Switch icon not found, reloading page...', null, requestId);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await delay(1000);
      await bringToFront(page);
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
      
      return res.status(400).json({
        error: 'Invalid Game ID',
        game: gameId,
        id: playerId,
        during: durationSec
      });
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
      return res.status(404).json({ 
        error: 'Player not found',
        game: gameId,
        id: playerId,
        during: durationSec
      });
    }
    
    logWithTiming(`Success: ID ${playerId} -> ${playerInfo.name} (${durationSec}s)`, null, requestId);
    return res.json({
      game: gameId,
      id: playerId,
      name: playerInfo.name,
      during: durationSec
    });
    
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
    
    return res.status(500).json({ 
      error: 'Failed to check player ID',
      game: gameId,
      id: playerId,
      during: durationSec
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
      }
      h1 {
        color: #333;
      }
      textarea {
        width: 100%;
        height: 300px;
        margin: 10px 0;
        padding: 10px;
        font-family: monospace;
        border: 1px solid #ddd;
        border-radius: 4px;
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
      }
      button:hover {
        background-color: #45a049;
      }
      .info {
        background-color: #f8f9fa;
        padding: 15px;
        border-left: 4px solid #17a2b8;
        margin: 20px 0;
      }
      .success {
        background-color: #d4edda;
        color: #155724;
        padding: 15px;
        border-radius: 4px;
        margin-top: 15px;
      }
      .error {
        background-color: #f8d7da;
        color: #721c24;
        padding: 15px;
        border-radius: 4px;
        margin-top: 15px;
      }
      .tab {
        overflow: hidden;
        border: 1px solid #ccc;
        background-color: #f1f1f1;
        border-radius: 4px 4px 0 0;
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
      }
      .tab button:hover {
        background-color: #ddd;
      }
      .tab button.active {
        background-color: #4CAF50;
        color: white;
      }
      .tabcontent {
        display: none;
        padding: 20px;
        border: 1px solid #ccc;
        border-top: none;
        border-radius: 0 0 4px 4px;
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
    </style>
  </head>
  <body>
    <h1>Upload Midasbuy Cookies</h1>
    
    <div class="info">
      <p>You can upload your Midasbuy cookies either by pasting JSON data or by uploading a cookies.json file.</p>
    </div>
    
    <div class="tab">
      <button class="tablinks active" onclick="openTab(event, 'PasteJSON')">Paste JSON</button>
      <button class="tablinks" onclick="openTab(event, 'UploadFile')">Upload File</button>
    </div>
    
    <div id="PasteJSON" class="tabcontent show">
      <div class="info">
        <p>Paste your Midasbuy cookies in JSON format below. The cookies should be in the format:</p>
        <pre>[
  {
    "name": "cookie_name",
    "value": "cookie_value",
    "domain": ".midasbuy.com",
    "path": "/",
    "expires": -1,
    "size": 123,
    "httpOnly": true,
    "secure": true,
    "session": false
  },
  ...
]</pre>
      </div>
      
      <form id="cookieForm" action="/cookieupload" method="post">
        <textarea id="cookieData" name="cookieData" placeholder="Paste your cookies here in JSON format"></textarea>
        <button type="submit">Upload Cookies</button>
      </form>
    </div>
    
    <div id="UploadFile" class="tabcontent">
      <div class="info">
        <p>Upload your cookies.json file. The file should contain a JSON array of cookie objects.</p>
      </div>
      
      <form id="fileUploadForm" action="/cookieupload/file" method="post" enctype="multipart/form-data">
        <div class="file-input-container">
          <input type="file" id="cookieFile" name="cookieFile" accept=".json">
          <button type="submit">Upload File</button>
        </div>
      </form>
    </div>
    
    <div id="message"></div>
    
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
      
      // JSON paste form submission
      document.getElementById('cookieForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const cookieData = document.getElementById('cookieData').value;
        
        try {
          // Validate JSON
          JSON.parse(cookieData);
          
          const response = await fetch('/cookieupload', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ cookies: cookieData })
          });
          
          const result = await response.json();
          
          const messageDiv = document.getElementById('message');
          if (response.ok) {
            messageDiv.className = 'success';
            messageDiv.textContent = 'Cookies uploaded successfully! The server will be restarted to apply the new cookies.';
          } else {
            messageDiv.className = 'error';
            messageDiv.textContent = \`Error: \${result.error || 'Unknown error occurred'}\`;
          }
        } catch (error) {
          const messageDiv = document.getElementById('message');
          messageDiv.className = 'error';
          messageDiv.textContent = 'Invalid JSON format. Please check your cookie data.';
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
          return;
        }
        
        const formData = new FormData();
        formData.append('cookieFile', fileInput.files[0]);
        
        try {
          const response = await fetch('/cookieupload/file', {
            method: 'POST',
            body: formData
          });
          
          const result = await response.json();
          
          const messageDiv = document.getElementById('message');
          if (response.ok) {
            messageDiv.className = 'success';
            messageDiv.textContent = 'Cookies uploaded successfully! The server will be restarted to apply the new cookies.';
          } else {
            messageDiv.className = 'error';
            messageDiv.textContent = \`Error: \${result.error || 'Unknown error occurred'}\`;
          }
        } catch (error) {
          const messageDiv = document.getElementById('message');
          messageDiv.className = 'error';
          messageDiv.textContent = 'Error uploading file. Please try again.';
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
    
    // Validate cookie format
    if (!Array.isArray(cookieData)) {
      return res.status(400).json({ error: 'Cookies must be an array' });
    }
    
    // Check if cookies have required fields
    for (const cookie of cookieData) {
      if (!cookie.name || !cookie.value) {
        return res.status(400).json({ error: 'Each cookie must have at least a name and value' });
      }
    }
    
    // Save cookies to file
    if (!saveCookies(cookieData)) {
      return res.status(500).json({ error: 'Failed to save cookies' });
    }
    
    // Restart browser to apply new cookies
    console.log('New cookies uploaded. Restarting browser...');
    await initBrowser();
    
    return res.json({ success: true, message: 'Cookies uploaded successfully' });
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
      return res.status(400).json({ error: 'Invalid JSON file format' });
    }
    
    // Validate cookie format
    if (!Array.isArray(cookieData)) {
      return res.status(400).json({ error: 'Cookies must be an array' });
    }
    
    // Check if cookies have required fields
    for (const cookie of cookieData) {
      if (!cookie.name || !cookie.value) {
        return res.status(400).json({ error: 'Each cookie must have at least a name and value' });
      }
    }
    
    // Save cookies to file
    if (!saveCookies(cookieData)) {
      return res.status(500).json({ error: 'Failed to save cookies' });
    }
    
    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    // Restart browser to apply new cookies
    console.log('New cookies uploaded via file. Restarting browser...');
    await initBrowser();
    
    return res.json({ success: true, message: 'Cookies uploaded successfully from file' });
  } catch (error) {
    console.error('Error in cookie file upload:', error);
    return res.status(500).json({ error: 'Server error while processing cookie file' });
  }
});

// Initialize browser when server starts
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  await initBrowser();
}); 