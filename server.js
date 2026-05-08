/**
 * Rhine Cleaning War Room — Backend Server
 * Deploy to Railway: railway.app
 * 
 * Handles:
 * - Jobber OAuth (full flow with callback)
 * - Token storage and auto-refresh
 * - Jobber data sync every 30 minutes
 * - Jobber webhooks (real-time updates)
 * - Todos storage
 * - CORS for frontend
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.JOBBER_CLIENT_ID || '3fdfd77b-ab8f-44c2-8607-a6821592babe';
const CLIENT_SECRET = process.env.JOBBER_CLIENT_SECRET || '1818ca147d53bbe2ea5cf8c4e9f653dc4ce6f116e48f22823d36ef2df4faf709';
const API_VERSION = '2023-11-15';
const DATA_FILE = path.join(__dirname, 'data.json');
const TOKENS_FILE = path.join(__dirname, 'tokens.json');

// ── IN-MEMORY STATE ────────────────────────────────────────────────────────────
let cachedData = null;
let tokens = null;
let todos = { todos: [], notes: '' };

// ── LOAD PERSISTED STATE ──────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
      console.log('[State] Tokens loaded');
    }
  } catch(e) { console.log('[State] No tokens file'); }

  try {
    if (fs.existsSync(DATA_FILE)) {
      cachedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      console.log('[State] Cached data loaded');
    }
  } catch(e) { console.log('[State] No data file'); }

  // Load initial refresh token from env if no tokens file
  if (!tokens && process.env.JOBBER_REFRESH_TOKEN) {
    tokens = { refresh_token: process.env.JOBBER_REFRESH_TOKEN };
    console.log('[State] Using refresh token from env');
  }
}

function saveTokens(t) {
  tokens = t;
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2)); } catch(e) {}
}

function saveData(d) {
  cachedData = d;
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch(e) {}
}

// ── HTTP HELPERS ──────────────────────────────────────────────────────────────
function httpsPost(hostname, pathname, headers, data) {
  return new Promise((resolve, reject) => {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    const req = https.request({
      hostname, path: pathname, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => {
        try { resolve(JSON.parse(resp)); }
        catch(e) { resolve({ _raw: resp, _status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── JOBBER OAUTH ──────────────────────────────────────────────────────────────
function getAuthUrl(baseUrl) {
  const callback = `${baseUrl}/auth/callback`;
  return `https://api.getjobber.com/api/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(callback)}&response_type=code`;
}

async function exchangeCode(code, baseUrl) {
  const callback = `${baseUrl}/auth/callback`;
  const data = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: callback,
    grant_type: 'authorization_code'
  }).toString();

  const result = await httpsPost('api.getjobber.com', '/api/oauth/token', {
    'Content-Type': 'application/x-www-form-urlencoded'
  }, data);

  if (result.access_token) {
    saveTokens(result);
    console.log('[OAuth] ✓ Tokens saved');
    return true;
  }
  console.log('[OAuth] Exchange failed:', JSON.stringify(result));
  return false;
}

async function refreshAccessToken() {
  if (!tokens?.refresh_token) throw new Error('No refresh token');

  const data = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token'
  }).toString();

  const result = await httpsPost('api.getjobber.com', '/api/oauth/token', {
    'Content-Type': 'application/x-www-form-urlencoded'
  }, data);

  if (result.access_token) {
    saveTokens({ ...tokens, ...result });
    console.log('[Auth] ✓ Token refreshed');
    return result.access_token;
  }
  throw new Error('Token refresh failed: ' + JSON.stringify(result));
}

async function getAccessToken() {
  if (!tokens) throw new Error('Not authenticated. Visit /auth to connect Jobber.');
  
  // Check if token is expired (Jobber tokens last 1 hour)
  if (tokens.created_at) {
    const age = Date.now() - new Date(tokens.created_at).getTime();
    if (age > 55 * 60 * 1000) { // 55 minutes
      return await refreshAccessToken();
    }
  }
  
  return tokens.access_token || await refreshAccessToken();
}

// ── JOBBER GRAPHQL ─────────────────────────────────────────────────────────────
async function gql(query) {
  const token = await getAccessToken();
  const result = await httpsPost('api.getjobber.com', '/api/graphql', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'X-JOBBER-GRAPHQL-VERSION': API_VERSION
  }, { query });

  if (result.errors) {
    console.log('[GQL] Errors:', JSON.stringify(result.errors).slice(0, 200));
  }
  return result;
}

// ── JOBBER DATA SYNC ──────────────────────────────────────────────────────────
async function syncJobberData() {
  console.log('[Sync] Starting Jobber data sync...');

  try {
    const [jobsRes, clientRes, invRes, quotesRes] = await Promise.all([
      gql(`{ jobs { totalCount nodes { id title jobStatus total startAt client { name } } } }`),
      gql(`{ clients { totalCount nodes { id name } } }`),
      gql(`{ invoices { totalCount nodes { id invoiceNumber total invoiceStatus client { name } } } }`),
      gql(`{ quotes { totalCount nodes { id quoteNumber quoteStatus client { name } } } }`)
    ]);

    const jobs = jobsRes?.data?.jobs;
    const clients = clientRes?.data?.clients;
    const invoices = invRes?.data?.invoices;
    const quotes = quotesRes?.data?.quotes;

    const outstanding = invoices?.nodes
      ?.filter(i => !['paid','PAID'].includes(i.invoiceStatus))
      ?.reduce((s, i) => s + (parseFloat(i.total) || 0), 0) || 0;

    const today = new Date().toDateString();
    const todaysJobs = jobs?.nodes?.filter(j => j.startAt && new Date(j.startAt).toDateString() === today) || [];

    const data = {
      lastUpdated: new Date().toISOString(),
      summary: {
        accountName: 'RHINE CLEANING',
        totalJobs: jobs?.totalCount || 0,
        totalClients: clients?.totalCount || 0,
        totalInvoices: invoices?.totalCount || 0,
        outstandingInvoices: outstanding.toFixed(2),
        todaysJobCount: todaysJobs.length,
        activeQuotes: quotes?.totalCount || 0
      },
      jobs: jobs?.nodes || [],
      clients: clients?.nodes || [],
      invoices: invoices?.nodes || [],
      quotes: quotes?.nodes || [],
      todaysJobs
    };

    saveData(data);
    console.log(`[Sync] ✓ Done — ${data.summary.totalJobs} jobs, ${data.summary.totalClients} clients`);
    return data;

  } catch(e) {
    console.error('[Sync] Failed:', e.message);
    throw e;
  }
}

// ── HTTP SERVER ────────────────────────────────────────────────────────────────
function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(body);
}

function sendHTML(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    res.end();
    return;
  }

  // Read body for POST requests
  let body = '';
  if (method === 'POST' || method === 'PUT') {
    await new Promise(resolve => {
      req.on('data', chunk => body += chunk);
      req.on('end', resolve);
    });
  }

  // ── ROUTES ────────────────────────────────────────────────────────────────

  // Health check
  if (pathname === '/' || pathname === '/health') {
    sendJSON(res, 200, {
      status: 'ok',
      authenticated: !!tokens?.access_token,
      lastSync: cachedData?.lastUpdated || null,
      message: tokens ? 'Ready' : 'Visit /auth to connect Jobber'
    });
    return;
  }

  // Auth - redirects to Jobber OAuth
  if (pathname === '/auth') {
    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    const authUrl = getAuthUrl(baseUrl);
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // OAuth callback from Jobber
  if (pathname === '/auth/callback') {
    const code = parsed.query.code;
    if (!code) {
      sendHTML(res, '<h1>Error: No code received</h1>');
      return;
    }

    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    const success = await exchangeCode(code, baseUrl);

    if (success) {
      // Immediately sync data after auth
      try { await syncJobberData(); } catch(e) {}
      sendHTML(res, `
        <html><body style="font-family:sans-serif;padding:40px;background:#0A0F0D;color:#E8F5F0">
          <h1 style="color:#00C48C">✓ Jobber Connected!</h1>
          <p>Your war room is now connected to Jobber.</p>
          <p>Data syncing every 30 minutes automatically.</p>
          <br>
          <a href="${process.env.FRONTEND_URL || '#'}" style="color:#00C48C">→ Open War Room</a>
        </body></html>
      `);
    } else {
      sendHTML(res, '<html><body style="padding:40px"><h1>Auth failed. <a href="/auth">Try again</a></h1></body></html>');
    }
    return;
  }

  // Get Jobber data (used by frontend)
  if (pathname === '/api/data' && method === 'GET') {
    if (!cachedData) {
      if (!tokens) {
        sendJSON(res, 401, { error: 'Not authenticated', authUrl: '/auth' });
        return;
      }
      try {
        const data = await syncJobberData();
        sendJSON(res, 200, data);
      } catch(e) {
        sendJSON(res, 500, { error: e.message });
      }
      return;
    }
    sendJSON(res, 200, cachedData);
    return;
  }

  // Force sync
  if (pathname === '/api/sync' && method === 'POST') {
    try {
      const data = await syncJobberData();
      sendJSON(res, 200, { success: true, data });
    } catch(e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Todos - GET
  if (pathname === '/api/todos' && method === 'GET') {
    sendJSON(res, 200, todos);
    return;
  }

  // Todos - POST (save)
  if (pathname === '/api/todos' && method === 'POST') {
    try {
      todos = JSON.parse(body);
      sendJSON(res, 200, { success: true });
    } catch(e) {
      sendJSON(res, 400, { error: 'Invalid JSON' });
    }
    return;
  }

  // Jobber webhook receiver
  if (pathname === '/webhooks/jobber' && method === 'POST') {
    console.log('[Webhook] Received Jobber event');
    try {
      const event = JSON.parse(body);
      console.log('[Webhook] Topic:', event.topic || 'unknown');
      // Trigger a sync on relevant events
      if (event.topic && ['job', 'invoice', 'client', 'quote'].some(t => event.topic.includes(t))) {
        setTimeout(() => syncJobberData().catch(console.error), 2000);
      }
    } catch(e) {}
    sendJSON(res, 200, { received: true });
    return;
  }

  // Auth status
  if (pathname === '/api/status') {
    sendJSON(res, 200, {
      authenticated: !!tokens?.access_token,
      hasData: !!cachedData,
      lastSync: cachedData?.lastUpdated || null,
      jobCount: cachedData?.summary?.totalJobs || 0,
      clientCount: cachedData?.summary?.totalClients || 0
    });
    return;
  }

  // 404
  sendJSON(res, 404, { error: 'Not found', path: pathname });
}

// ── START SERVER ──────────────────────────────────────────────────────────────
loadState();

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch(e) {
    console.error('[Server] Unhandled error:', e.message);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log('═══════════════════════════════════════');
  console.log('  Rhine Cleaning War Room — Backend');
  console.log(`  Running on port ${PORT}`);
  console.log(`  Authenticated: ${!!tokens}`);
  console.log('═══════════════════════════════════════');

  if (!tokens) {
    console.log('\n  ⚠️  Not connected to Jobber yet.');
    console.log('  Visit /auth on your deployed URL to connect.\n');
  } else {
    // Start sync on boot
    syncJobberData().catch(console.error);
  }
});

// Auto-sync every 30 minutes
setInterval(() => {
  if (tokens) {
    console.log('[Scheduler] Running auto-sync...');
    syncJobberData().catch(console.error);
  }
}, 30 * 60 * 1000);

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  server.close();
});
