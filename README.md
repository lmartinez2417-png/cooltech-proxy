# CoolTech AI Proxy

Secure proxy server that connects the CoolTech field app to Anthropic AI.
Your API key stays on this server — techs never see it.

## Deploy to Railway (free, 5 minutes)

1. Go to railway.app and sign up (free)
2. Click "New Project" → "Deploy from GitHub repo"
   OR click "New Project" → "Deploy from template" → select Node
3. Drag this folder into Railway OR push to a GitHub repo first
4. In Railway dashboard → your project → Variables tab, add:
   - Key: ANTHROPIC_API_KEY
   - Value: your key from console.anthropic.com
5. Railway gives you a URL like: https://cooltech-proxy-production.up.railway.app
6. Copy that URL into the CoolTech app Settings → Proxy URL

## Deploy to Render (free tier available)

1. Go to render.com → New → Web Service
2. Connect your GitHub repo (or use manual deploy)
3. Set Build Command: npm install
4. Set Start Command: npm start
5. Add Environment Variable: ANTHROPIC_API_KEY = your key
6. Deploy — you get a URL like: https://cooltech-proxy.onrender.com
7. Copy that URL into the CoolTech app Settings → Proxy URL

## Test it's working

Visit your proxy URL in a browser — you should see:
{"status":"CoolTech AI Proxy running","ok":true}
