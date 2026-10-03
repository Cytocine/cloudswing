# Cytocine Levels — PWA

Static site, no build step. Deploy via GitHub → Cloudflare Pages.

## 1. Push to GitHub
    cd cytocine-pwa
    git init && git add . && git commit -m "Cytocine PWA"
    git branch -M main
    git remote add origin https://github.com/<you>/cytocine.git
    git push -u origin main

Consider making the repo private.

## 2. Cloudflare Pages
Workers & Pages → Create → Pages → Connect to Git → pick the repo.
- Framework preset: None
- Build command: (empty)
- Build output directory: /

You get https://<project>.pages.dev (HTTPS, required for PWAs).

## 3. Install
- iPhone: Safari → Share → Add to Home Screen
- Android / desktop Chrome or Edge: install icon in the address bar or menu

## Updating
Edit files, bump VERSION in sw.js, push. Cloudflare redeploys automatically.

## Notes
- Alpaca keys live in each browser's localStorage, never in the repo.
- The service worker caches only the app shell; Alpaca API and WebSocket traffic is never cached.
- Chart libraries are vendored in vendor/ so the shell loads offline (market data still needs network).
