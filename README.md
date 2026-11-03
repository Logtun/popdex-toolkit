# PopDEX Toolkit

A set of free tools for PopDEX traders: check MegaPop tickets against the Bitcoin-drawn Pop Hash and share a result card, estimate liquidation price and PnL before opening a trade, and watch live funding rates across every market.

**Live:** https://popdex-toolkit.vercel.app/

## Features

### MegaPop Draw Checker
- Pick any MegaPop epoch and see its status, prize pool and Pop Hash.
- **Bitcoin-verified Pop Hash:** the site finds the first Bitcoin block at or after the draw time and recomputes the Pop Hash from the last six digits of that block's hash, then shows whether it matches the official on-chain result.
- **Ticket check:** paste ticket numbers to see how many digits match and which prize tier each ticket reaches.
- **Wallet lookup:** enter a wallet address to load all of its tickets for an epoch, with ticket counts cross-checked on-chain.
- **Result cards and X share:** generate a 1200x675 result card (best match, prize tier, optional shortened wallet). Card designs rotate by epoch. Sharing uploads the card and creates a share page whose link preview on X shows the card; on phones the share sheet opens with the image attached.
- Countdown to the next draw.

### Liquidation & PnL Calculator
- Estimated liquidation price, margin, fees and PnL for a single position, using PopDEX's live market config, margin tiers and fee rates.
- **Portfolio mode** (cross margin): several positions together.

### Funding Rate Board
- Live funding rates for every PopDEX market, merged with tickers.
- **7-day history:** tap a market to see every settled funding rate of the last 7 days, with average, lowest and highest.

## Tech

- Static HTML, CSS and vanilla JavaScript (no build step, no framework). Result cards are drawn on canvas in the browser.
- A Cloudflare Worker (`_worker.js`) that proxies and decodes PopDEX's public APIs (they answer without CORS headers), finds the Bitcoin draw block, and stores share cards.
- Cloudflare R2 for share-card images and finalised draw results. No user data is stored and no secrets are needed.

## Data sources

- PopDEX public REST API (`api.popdex.xyz`): market config, futures margin tiers, fee rates, funding rates, funding-rate history, tickers and MegaPop wallet tickets.
- MegaPop on-chain precompile (`0x...1013`) read through PopDEX's public Web3 RPC.
- Bitcoin blocks from mempool.space, with blockstream.info as backup.
- PopDEX docs: https://popdex.xyz/docs

## Deploy

You need a Cloudflare account and Node.js.

```
npx wrangler r2 bucket create popdex-toolkit-cards
npx wrangler deploy
```

Bindings the worker expects: `CARDS` (R2 bucket) and `ASSETS` (static files). The same folder also works on Cloudflare Pages (the root `_worker.js` runs in advanced mode) with the same bindings.

If you deploy on your own domain, replace `https://popdex-toolkit.vercel.app` in `_worker.js` and the meta tags in `index.html` with your URL.

## Credits

Built by Alogi Olatunde ([@iamlogtun](https://x.com/iamlogtun)).

## License

MIT, see [LICENSE](LICENSE).
