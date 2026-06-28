// /api/goldrush.js
// -----------------------------------------------------------------------
// Vercel Serverless Function — GoldRush / Covalent proxy
// -----------------------------------------------------------------------
// This is the piece that lets the dashboard make REAL GoldRush calls
// without ever putting the API key in the browser. The key lives only
// here, on the server, as an environment variable.
//
// SETUP ON VERCEL:
//   1. Project → Settings → Environment Variables
//   2. Add:  GOLDRUSH_API_KEY = cqt_xxxxxxxxxxxxxxxx   (Production + Preview)
//   3. Redeploy (env vars only take effect on a new deployment)
//
// LOCAL DEV (optional):
//   - Create a `.env.local` file NEXT TO this api/ folder (never commit it):
//       GOLDRUSH_API_KEY=cqt_xxxxxxxxxxxxxxxx
//   - Run with the Vercel CLI: `vercel dev`
//
// FRONTEND CONTRACT:
//   GET /api/goldrush?chain=eth-mainnet&wallet=vitalik.eth
//   -> { address, chain, items: [{ symbol, balance, quote }], source: "live" }
//   On any failure this returns a 4xx/5xx with an { error } body — the
//   frontend's GOLDRUSH_FETCH() catches that and falls back to simulated
//   data automatically, so the dashboard never breaks if the env var is
//   missing or GoldRush has a hiccup.
// -----------------------------------------------------------------------

const ALLOWED_CHAINS = new Set([
  "eth-mainnet",
  "base-mainnet",
  "arbitrum-mainnet",
  "optimism-mainnet",
  "matic-mainnet",
  "bsc-mainnet",
  "avalanche-mainnet",
  "solana-mainnet"
]);

const DEFAULT_WALLET = "vitalik.eth";

// Accepts: ENS names, EVM hex addresses, or Solana base58 addresses.
const WALLET_PATTERN = /^([a-zA-Z0-9_-]+\.eth|0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

module.exports = async function handler(req, res) {
  // CORS — relax/restrict to your deployed domain as needed.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.GOLDRUSH_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "GOLDRUSH_API_KEY is not configured on the server.",
      hint: "Set it in Vercel -> Project Settings -> Environment Variables, then redeploy."
    });
    return;
  }

  const chain = String((req.query && req.query.chain) || "eth-mainnet");
  const wallet = String((req.query && req.query.wallet) || DEFAULT_WALLET);

  if (!ALLOWED_CHAINS.has(chain)) {
    res.status(400).json({ error: "Unsupported chain: " + chain });
    return;
  }
  if (!WALLET_PATTERN.test(wallet)) {
    res.status(400).json({ error: "Invalid wallet/address format" });
    return;
  }

  try {
    const upstreamUrl =
      "https://api.covalenthq.com/v1/" + chain + "/address/" +
      encodeURIComponent(wallet) + "/balances_v2/";

    const upstream = await fetch(upstreamUrl, {
      headers: { Authorization: "Bearer " + apiKey }
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      res.status(upstream.status).json({
        error: "GoldRush upstream error",
        status: upstream.status,
        detail: detail.slice(0, 300)
      });
      return;
    }

    const json = await upstream.json();
    const rawItems = (json && json.data && json.data.items) || [];

    // Balances come back as raw base-unit integer strings — they MUST be
    // divided by 10^contract_decimals to be a real token amount. This was
    // missing in the original client-side parsing.
    const items = rawItems.slice(0, 8).map(function (it) {
      return {
        symbol: it.contract_ticker_symbol,
        balance: toHumanReadable(it.balance, it.contract_decimals),
        quote: it.quote
      };
    });

    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    res.status(200).json({
      address: (json.data && json.data.address) || wallet,
      chain: chain,
      items: items,
      source: "live"
    });
  } catch (err) {
    res.status(502).json({ error: "Proxy fetch failed", detail: String(err) });
  }
};

function toHumanReadable(balance, decimals) {
  if (balance == null || decimals == null) return null;
  const n = parseFloat(balance) / Math.pow(10, decimals);
  if (Number.isNaN(n)) return null;
  // keep it readable in a small UI card
  return n >= 1 ? +n.toFixed(4) : +n.toFixed(8);
}
