/**
 * Rhine Cleaning War Room — Backend Server
 * Deploy to Railway: railway.app
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const JOBBER_CLIENT_ID = process.env.JOBBER_CLIENT_ID;
const JOBBER_CLIENT_SECRET = process.env.JOBBER_CLIENT_SECRET;
const QB_CLIENT_ID = process.env.QB_CLIENT_ID;
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const JOBBER_API_VERSION = '2023-11-15';
const DATA_FILE = path.join(__dirname, 'data.json');
const TOKENS_FILE = path.join(__dirname, 'tokens.json');

let cachedData = null;
let jobberTokens = null;
let qbTokens = null;
let todos = { todos: [], notes: '' };

// ── STATE ─────────────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
      jobberTokens = saved.jobber || null;
      qbTokens = saved.qb || null;
      console.log('[State] Tokens loaded — Jobber:', !!jobberTokens, 'QB:', !!qbTokens);
    }
  } catch(e) {}

  try {
    if (fs.existsSync(DATA_FILE)) {
      cachedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch(e) {}

  if (!jobberTokens && process.env.JOBBER_REFRESH_TOKEN) {
    jobberTokens = { refresh_token: process.env.JOBBER_REFRESH_TOKEN };
    console.log('[State] Jobber token from env');
  }

  if (!qbTokens && process.env.QB_REFRESH_TOKEN) {
    qbTokens = { refresh_token: process.env.QB_REFRESH_TOKEN, realm_id: process.env.QB_REALM_ID };
    console.log('[State] QB token from env');
  }
}

function saveAllTokens() {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify({ jobber: jobberTokens, qb: qbTokens }, null, 2));
  } catch(e) {}
}

function saveData(d) {
  cachedData = d;
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch(e) {}
}

// ── HTTP HELPERS ──────────────────────────────────────────────────────────────
function httpsRequest(method, hostname, pathname, headers, data) {
  return new Promise((resolve, reject) => {
    const body = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : '';
    const opts = {
      hostname, path: pathname, method,
      headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }
    };
    const req = https.request(opts, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(resp) }); }
        catch(e) { resolve({ status: res.statusCode, data: resp }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── JOBBER OAUTH ──────────────────────────────────────────────────────────────
function getJobberAuthUrl(baseUrl) {
  return `https://api.getjobber.com/api/oauth/authorize?client_id=${JOBBER_CLIENT_ID}&redirect_uri=${encodeURIComponent(baseUrl + '/auth/jobber/callback')}&response_type=code`;
}

async function exchangeJobberCode(code, baseUrl) {
  const data = new URLSearchParams({
    client_id: JOBBER_CLIENT_ID, client_secret: JOBBER_CLIENT_SECRET,
    code, redirect_uri: baseUrl + '/auth/jobber/callback', grant_type: 'authorization_code'
  }).toString();
  const res = await httpsRequest('POST', 'api.getjobber.com', '/api/oauth/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, data);
  if (res.data.access_token) {
    jobberTokens = { ...res.data, refreshed_at: new Date().toISOString() };
    saveAllTokens();
    console.log('[Jobber OAuth] ✓ Connected');
    return true;
  }
  console.error('[Jobber OAuth] Failed:', JSON.stringify(res.data));
  return false;
}

async function refreshJobberToken() {
  if (!jobberTokens?.refresh_token) throw new Error('No Jobber refresh token');
  const data = new URLSearchParams({
    client_id: JOBBER_CLIENT_ID, client_secret: JOBBER_CLIENT_SECRET,
    refresh_token: jobberTokens.refresh_token, grant_type: 'refresh_token'
  }).toString();
  const res = await httpsRequest('POST', 'api.getjobber.com', '/api/oauth/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, data);
  if (res.data.access_token) {
    jobberTokens = { ...jobberTokens, ...res.data, refreshed_at: new Date().toISOString() };
    saveAllTokens();
    return res.data.access_token;
  }
  jobberTokens = null;
  throw new Error('Jobber token refresh failed: ' + JSON.stringify(res.data));
}

async function getJobberToken() {
  if (!jobberTokens) throw new Error('Jobber not connected. Visit /auth/jobber');
  return await refreshJobberToken();
}

// ── JOBBER GRAPHQL ─────────────────────────────────────────────────────────────
async function jobberGQL(query) {
  const token = await getJobberToken();
  const res = await httpsRequest('POST', 'api.getjobber.com', '/api/graphql',
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION },
    { query });
  return res.data;
}

// ── QUICKBOOKS OAUTH ──────────────────────────────────────────────────────────
function getQBAuthUrl(baseUrl) {
  const scopes = 'com.intuit.quickbooks.accounting';
  return `https://appcenter.intuit.com/connect/oauth2?client_id=${QB_CLIENT_ID}&redirect_uri=${encodeURIComponent(baseUrl + '/auth/quickbooks/callback')}&response_type=code&scope=${scopes}&state=warroom`;
}

async function exchangeQBCode(code, realmId, baseUrl) {
  const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
  const data = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: baseUrl + '/auth/quickbooks/callback'
  }).toString();
  const res = await httpsRequest('POST', 'oauth.platform.intuit.com', '/oauth2/v1/tokens/bearer',
    { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` }, data);
  if (res.data.access_token) {
    qbTokens = { ...res.data, realm_id: realmId, refreshed_at: new Date().toISOString() };
    saveAllTokens();
    console.log('[QB OAuth] ✓ Connected, realm:', realmId);
    return true;
  }
  console.error('[QB OAuth] Failed:', JSON.stringify(res.data));
  return false;
}

async function refreshQBToken() {
  if (!qbTokens?.refresh_token) throw new Error('No QB refresh token');
  const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
  const data = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: qbTokens.refresh_token }).toString();
  const res = await httpsRequest('POST', 'oauth.platform.intuit.com', '/oauth2/v1/tokens/bearer',
    { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` }, data);
  if (res.data.access_token) {
    qbTokens = { ...qbTokens, ...res.data, refreshed_at: new Date().toISOString() };
    saveAllTokens();
    return res.data.access_token;
  }
  throw new Error('QB token refresh failed');
}

async function getQBToken() {
  if (!qbTokens) throw new Error('QuickBooks not connected. Visit /auth/quickbooks');
  // QB tokens last 1 hour, refresh tokens last 100 days
  try { return await refreshQBToken(); } catch(e) { throw e; }
}

// ── QUICKBOOKS API ────────────────────────────────────────────────────────────
async function qbQuery(query) {
  const token = await getQBToken();
  const realmId = qbTokens.realm_id;
  const encodedQuery = encodeURIComponent(query);
  const res = await httpsRequest('GET', 'quickbooks.api.intuit.com',
    `/v3/company/${realmId}/query?query=${encodedQuery}&minorversion=65`,
    { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
  return res.data;
}

async function syncQBData() {
  console.log('[QB Sync] Starting...');
  try {
    const [plRes, invoiceRes, expenseRes] = await Promise.all([
      qbQuery(`SELECT * FROM Profit WHERE startdate='${new Date().getFullYear()}-01-01' AND enddate='${new Date().toISOString().split('T')[0]}'`).catch(() => null),
      qbQuery(`SELECT * FROM Invoice WHERE Balance > '0' MAXRESULTS 20`).catch(() => null),
      qbQuery(`SELECT * FROM Purchase MAXRESULTS 20`).catch(() => null)
    ]);

    const invoices = invoiceRes?.QueryResponse?.Invoice || [];
    const purchases = expenseRes?.QueryResponse?.Purchase || [];

    const totalOutstanding = invoices.reduce((s, i) => s + (parseFloat(i.Balance) || 0), 0);
    const totalExpenses = purchases.reduce((s, p) => s + (parseFloat(p.TotalAmt) || 0), 0);

    const qbData = {
      lastUpdated: new Date().toISOString(),
      outstanding: totalOutstanding.toFixed(2),
      outstandingCount: invoices.length,
      totalExpenses: totalExpenses.toFixed(2),
      recentInvoices: invoices.slice(0, 10).map(i => ({
        id: i.Id,
        number: i.DocNumber,
        customer: i.CustomerRef?.name || 'Unknown',
        amount: i.TotalAmt,
        balance: i.Balance,
        dueDate: i.DueDate
      })),
      recentExpenses: purchases.slice(0, 10).map(p => ({
        id: p.Id,
        vendor: p.EntityRef?.name || 'Unknown',
        amount: p.TotalAmt,
        date: p.TxnDate
      }))
    };

    console.log(`[QB Sync] ✓ Done — $${totalOutstanding.toFixed(2)} outstanding, ${invoices.length} invoices`);
    return qbData;
  } catch(e) {
    console.error('[QB Sync] Failed:', e.message);
    return null;
  }
}

// ── JOBBER DATA SYNC ──────────────────────────────────────────────────────────
async function syncJobberData() {
  console.log('[Jobber Sync] Starting...');
  try {
    const [jobsRes, clientRes, invRes, quotesRes] = await Promise.all([
      jobberGQL(`{ jobs { totalCount nodes { id title jobStatus total startAt client { name } } } }`),
      jobberGQL(`{ clients { totalCount nodes { id name } } }`),
      jobberGQL(`{ invoices { totalCount nodes { id invoiceNumber total invoiceStatus client { name } } } }`),
      jobberGQL(`{ quotes { totalCount nodes { id quoteNumber quoteStatus client { name } } } }`)
    ]);

    const jobs = jobsRes?.data?.jobs;
    const clients = clientRes?.data?.clients;
    const invoices = invRes?.data?.invoices;
    const quotes = quotesRes?.data?.quotes;

    const outstanding = invoices?.nodes?.filter(i => !['paid','PAID'].includes(i.invoiceStatus))?.reduce((s,i) => s+(parseFloat(i.total)||0), 0) || 0;
    const today = new Date().toDateString();
    const todaysJobs = jobs?.nodes?.filter(j => j.startAt && new Date(j.startAt).toDateString() === today) || [];

    const jobberData = {
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

    console.log(`[Jobber Sync] ✓ Done — ${jobberData.summary.totalJobs} jobs, ${jobberData.summary.totalClients} clients`);
    return jobberData;
  } catch(e) {
    console.error('[Jobber Sync] Failed:', e.message);
    throw e;
  }
}

async function syncAll() {
  const [jobberData, qbData] = await Promise.allSettled([
    syncJobberData(),
    qbTokens ? syncQBData() : Promise.resolve(null)
  ]);

  const data = {
    lastUpdated: new Date().toISOString(),
    jobber: jobberData.status === 'fulfilled' ? jobberData.value : null,
    quickbooks: qbData.status === 'fulfilled' ? qbData.value : null
  };

  saveData(data);
  return data;
}

// ── HTTP SERVER ────────────────────────────────────────────────────────────────
function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(body);
}

function sendHTML(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

function successPage(title, message, frontendUrl) {
  return `<html><body style="font-family:sans-serif;padding:40px;background:#0A0F0D;color:#E8F5F0;text-align:center">
    <h1 style="color:#00C48C">✓ ${title}</h1>
    <p style="color:#7A9E8E;margin:16px 0">${message}</p>
    <a href="${frontendUrl}" style="color:#00C48C;font-size:14px">→ Open War Room</a>
  </body></html>`;
}

async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
  const frontendUrl = process.env.FRONTEND_URL || '#';

  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    res.end(); return;
  }

  let body = '';
  if (req.method === 'POST') {
    await new Promise(resolve => { req.on('data', c => body += c); req.on('end', resolve); });
  }

  // Health
  if (pathname === '/' || pathname === '/health') {
    return sendJSON(res, 200, {
      status: 'ok',
      jobber: !!jobberTokens,
      quickbooks: !!qbTokens,
      lastSync: cachedData?.lastUpdated || null
    });
  }

  // ── JOBBER AUTH ───────────────────────────────────────────────────────────
  if (pathname === '/auth' || pathname === '/auth/jobber') {
    res.writeHead(302, { Location: getJobberAuthUrl(baseUrl) }); res.end(); return;
  }

  if (pathname === '/auth/jobber/callback') {
    const code = parsed.query.code;
    if (!code) { sendHTML(res, '<h1>Error: No code</h1>'); return; }
    const ok = await exchangeJobberCode(code, baseUrl);
    if (ok) {
      try { await syncAll(); } catch(e) {}
      sendHTML(res, successPage('Jobber Connected!', 'Your war room is now connected to Jobber. Syncing every 30 minutes.', frontendUrl));
    } else {
      sendHTML(res, `<html><body style="padding:40px"><h1>Auth failed. <a href="/auth/jobber">Try again</a></h1></body></html>`);
    }
    return;
  }

  // ── QUICKBOOKS AUTH ───────────────────────────────────────────────────────
  if (pathname === '/auth/quickbooks') {
    res.writeHead(302, { Location: getQBAuthUrl(baseUrl) }); res.end(); return;
  }

  if (pathname === '/auth/quickbooks/callback') {
    const code = parsed.query.code;
    const realmId = parsed.query.realmId;
    if (!code || !realmId) { sendHTML(res, '<h1>Error: Missing params</h1>'); return; }
    const ok = await exchangeQBCode(code, realmId, baseUrl);
    if (ok) {
      try { await syncAll(); } catch(e) {}
      sendHTML(res, successPage('QuickBooks Connected!', 'Your war room is now connected to QuickBooks.', frontendUrl));
    } else {
      sendHTML(res, `<html><body style="padding:40px"><h1>QB Auth failed. <a href="/auth/quickbooks">Try again</a></h1></body></html>`);
    }
    return;
  }

  // ── API ───────────────────────────────────────────────────────────────────
  if (pathname === '/api/data') {
    if (!cachedData) {
      if (!jobberTokens) return sendJSON(res, 401, { error: 'Not authenticated', authUrl: '/auth/jobber' });
      try { const data = await syncAll(); return sendJSON(res, 200, data); }
      catch(e) { return sendJSON(res, 500, { error: e.message }); }
    }
    return sendJSON(res, 200, cachedData);
  }

  if (pathname === '/api/sync' && req.method === 'POST') {
    try { const data = await syncAll(); return sendJSON(res, 200, { success: true, data }); }
    catch(e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/todos' && req.method === 'GET') return sendJSON(res, 200, todos);
  if (pathname === '/api/todos' && req.method === 'POST') {
    try { todos = JSON.parse(body); return sendJSON(res, 200, { success: true }); }
    catch(e) { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
  }

  if (pathname === '/api/status') {
    return sendJSON(res, 200, {
      jobber: !!jobberTokens,
      quickbooks: !!qbTokens,
      lastSync: cachedData?.lastUpdated,
      jobCount: cachedData?.jobber?.summary?.totalJobs || 0,
      clientCount: cachedData?.jobber?.summary?.totalClients || 0,
      qbOutstanding: cachedData?.quickbooks?.outstanding || '0.00'
    });
  }

  if (pathname === '/webhooks/jobber' && req.method === 'POST') {
    setTimeout(() => syncAll().catch(console.error), 2000);
    return sendJSON(res, 200, { received: true });
  }

  return sendJSON(res, 404, { error: 'Not found' });
}

// ── START ─────────────────────────────────────────────────────────────────────
loadState();

const server = http.createServer(async (req, res) => {
  try { await handleRequest(req, res); }
  catch(e) { console.error('[Server Error]', e.message); sendJSON(res, 500, { error: 'Internal error' }); }
});

server.listen(PORT, () => {
  console.log('═══════════════════════════════════════');
  console.log('  Rhine Cleaning War Room — Backend');
  console.log(`  Port: ${PORT}`);
  console.log(`  Jobber: ${jobberTokens ? '✓' : '✗ visit /auth/jobber'}`);
  console.log(`  QuickBooks: ${qbTokens ? '✓' : '✗ visit /auth/quickbooks'}`);
  console.log('═══════════════════════════════════════');
  if (jobberTokens || qbTokens) syncAll().catch(console.error);
});

setInterval(() => {
  if (jobberTokens || qbTokens) {
    console.log('[Scheduler] Auto-sync...');
    syncAll().catch(console.error);
  }
}, 30 * 60 * 1000);

process.on('SIGTERM', () => server.close());
