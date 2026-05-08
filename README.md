# Rhine Cleaning War Room — Backend

## Deploy to Railway (5 minutes)

### Step 1: Create GitHub repo
1. Go to github.com and create a new repo called `rhine-war-room-backend`
2. Upload all files from this folder

### Step 2: Deploy on Railway
1. Go to railway.app
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repo
4. Railway auto-detects Node.js and deploys

### Step 3: Add environment variables in Railway
Go to your service → Variables → Add all from .env.example:
- JOBBER_CLIENT_ID
- JOBBER_CLIENT_SECRET  
- JOBBER_REFRESH_TOKEN
- FRONTEND_URL (your Netlify URL)

### Step 4: Get your Railway URL
Railway gives you a URL like: `rhine-war-room-backend.up.railway.app`

### Step 5: Connect Jobber
Visit: `https://your-railway-url.up.railway.app/auth`
This opens the proper OAuth flow — click Authorize in Jobber.

### Step 6: Update Jobber callback URL
In developer.getjobber.com → Rhine War Room app:
Set Callback URL to: `https://your-railway-url.up.railway.app/auth/callback`

### Step 7: Update frontend
In your Netlify index.html, replace:
`const BACKEND = 'REPLACE_WITH_RAILWAY_URL'`
with:
`const BACKEND = 'https://your-railway-url.up.railway.app'`

### Step 8: Add Jobber webhooks (real-time updates)
In Jobber developer portal → your app → Webhooks:
Add webhook URL: `https://your-railway-url.up.railway.app/webhooks/jobber`
Select topics: jobs, invoices, clients, quotes

## API Endpoints
- GET /health — server status
- GET /auth — start Jobber OAuth
- GET /auth/callback — OAuth callback
- GET /api/data — get Jobber data
- POST /api/sync — force sync
- GET /api/todos — get todos
- POST /api/todos — save todos
- POST /webhooks/jobber — receive Jobber webhooks
