#!/usr/bin/env node
/**
 * Buy-flow dashboard data pipeline.
 *
 * Fetches:
 *  1. Credit purchases from the public Credit API (https://credit.aleph.im).
 *  2. TokenPaymentsProcessed events from the AlephPaymentProcessor contract
 *     on Ethereum mainnet (market-buy + burn + distribution per processing run).
 *
 * Revenue definition: the headline (`revenue.totalUsd`) counts every payment
 * the processor processed, valued in USD — NOT just Credit-API purchases.
 * Most revenue reaches the contract as direct ALEPH transfers (consolidated
 * PAYG and off-API payments), which the Credit API never sees; counting only
 * `credits.totalUsd` badly understates it. ALEPH amounts are valued at the
 * platform's own rate (credit_price_usdc / credit_price_aleph) nearest in
 * time; stables at face value.
 *
 * Writes a single static JSON cache (web/data/flow.json) consumed by the
 * static frontend. No database.
 *
 * Honesty guardrails:
 *  - Exits non-zero on any fetch/decode failure. Never writes a partial or
 *    zeroed cache over a good one (network-dashboard P0-03 lesson).
 *  - Incremental: resumes the on-chain scan from the last scanned block kept
 *    in the previous cache, and keeps previously decoded events.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "data", "flow.json");

// Keyless public endpoints tried in order — publicnode started requiring a
// token for heavier eth_getLogs calls (HTTP 403), which silently killed the
// hourly refresh, so never depend on a single provider.
//
// Only general-purpose nodes belong here. Transaction relays (flashbots,
// mevblocker) answer eth_getLogs with an empty array instead of an error,
// which is indistinguishable from "no events" — see LOG_CANARY below.
const RPC_URLS = [
  ...(process.env.ETH_RPC_URL ? [process.env.ETH_RPC_URL] : []),
  "https://ethereum-rpc.publicnode.com",
  "https://1rpc.io/eth",
  "https://eth.llamarpc.com",
];

const CONFIG = {
  creditApi: process.env.CREDIT_API_URL || "https://credit.aleph.im",
  contract: "0x6b55F32Ea969910838defd03746Ced5E2AE8cB8B",
  deployBlock: 24270182, // ~2026-01-19
  // keccak256("TokenPaymentsProcessed(address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint8,bool)")
  topicTokenPaymentsProcessed: "0x3db36cd2496ef869c223c05bc35ff9785f5cc1ffeca2b221d884488c4282cbbc",
  logChunkSize: 10000, // capped to keep eth_getLogs responses under the endpoint's payload limit (HTTP 413)
  // v2 adds logIndex to chain events. Bumping also forces the one-time full
  // rescan that repairs the blocks lost to the silent-empty-getLogs bug.
  schemaVersion: 2,
};

// An endpoint that answers eth_getLogs with an empty array rather than an
// error creates a permanent, silent hole: the chunk looks event-free,
// lastScannedBlock advances past it, and the incremental scan never revisits
// those blocks. This is how the event in block 25552189 was lost. So no
// endpoint is trusted for logs until it has returned a log we know exists.
const LOG_CANARY = {
  block: 25221513, // first TokenPaymentsProcessed event ever emitted
};

// Known tokens; anything unknown is resolved on-chain via symbol()/decimals().
const KNOWN_TOKENS = {
  "0x27702a26126e0b3702af63ee09ac4d1a084ef628": { symbol: "ALEPH", decimals: 18 },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
};

let rpcId = 0;
async function rpcOnce(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} for ${method}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC error for ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

// Public RPCs are load-balanced across nodes that can disagree by a few
// blocks (transient failures), and providers change access policies
// (persistent failures) — retry with backoff AND rotate endpoints.
let rpcUrlIdx = 0;
async function rpc(method, params, attempts = 2 * RPC_URLS.length) {
  for (let i = 1; ; i++) {
    const url = RPC_URLS[rpcUrlIdx % RPC_URLS.length];
    try {
      return await rpcOnce(url, method, params);
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`RPC ${url} failed (${err.message}), rotating endpoint`);
      rpcUrlIdx++; // stick with the next endpoint until it also fails
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

const hex = (n) => "0x" + n.toString(16);

// eth_getLogs is the one call where a wrong-but-successful answer is
// unrecoverable, so it gets its own endpoint resolution: an endpoint must
// prove it indexes historical logs (LOG_CANARY) before any of its results
// are believed. If none can, we throw rather than write a cache with holes.
let logUrl = null;
const rejectedLogUrls = new Set();

async function servesLogs(url) {
  try {
    const logs = await rpcOnce(url, "eth_getLogs", [{
      address: CONFIG.contract,
      fromBlock: hex(LOG_CANARY.block),
      toBlock: hex(LOG_CANARY.block),
      topics: [CONFIG.topicTokenPaymentsProcessed],
    }]);
    return Array.isArray(logs) && logs.length > 0;
  } catch {
    return false;
  }
}

async function resolveLogUrl() {
  if (logUrl) return logUrl;
  for (const url of RPC_URLS) {
    if (rejectedLogUrls.has(url)) continue;
    if (await servesLogs(url)) {
      logUrl = url;
      return url;
    }
    console.warn(`RPC ${url} cannot serve historical logs — excluded from the scan`);
    rejectedLogUrls.add(url);
  }
  throw new Error(
    "No RPC endpoint can serve eth_getLogs for a known-present log. " +
      "Refusing to scan, because empty results here are silently written as 'no events'. " +
      "Set ETH_RPC_URL to an archive-capable endpoint.",
  );
}

async function getLogs(start, end) {
  for (let attempt = 1; ; attempt++) {
    const url = await resolveLogUrl();
    try {
      return await rpcOnce(url, "eth_getLogs", [{
        address: CONFIG.contract,
        fromBlock: hex(start),
        toBlock: hex(end),
        topics: [CONFIG.topicTokenPaymentsProcessed],
      }]);
    } catch (err) {
      if (attempt >= RPC_URLS.length + 1) throw err;
      console.warn(`eth_getLogs ${start}-${end} via ${url} failed (${err.message}), rotating`);
      rejectedLogUrls.add(url); // re-canary onto a different endpoint
      logUrl = null;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const word = (data, i) => BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64));
const topicAddress = (t) => "0x" + t.slice(26);

// Stringify bigints as decimal strings; format a display value separately so
// the frontend never does bigint math.
const units = (bi, decimals) => Number(bi) / 10 ** decimals;

async function tokenInfo(address, cache) {
  const key = address.toLowerCase();
  if (KNOWN_TOKENS[key]) return KNOWN_TOKENS[key];
  if (cache[key]) return cache[key];
  const [symRaw, decRaw] = await Promise.all([
    rpc("eth_call", [{ to: address, data: "0x95d89b41" }, "latest"]), // symbol()
    rpc("eth_call", [{ to: address, data: "0x313ce567" }, "latest"]), // decimals()
  ]);
  // symbol() returns abi-encoded string: offset, length, bytes
  const len = Number(BigInt("0x" + symRaw.slice(2 + 64, 2 + 128)));
  const symbol = Buffer.from(symRaw.slice(2 + 128, 2 + 128 + len * 2), "hex").toString("utf8");
  const info = { symbol, decimals: Number(BigInt(decRaw)) };
  cache[key] = info;
  return info;
}

async function fetchChainEvents(previous) {
  // Stay a few blocks behind head: other nodes behind the same balancer may
  // not have it yet ("block range extends beyond current head block").
  const latestBlock = Number(BigInt(await rpc("eth_blockNumber", []))) - 5;
  const fromBlock = previous?.chain?.lastScannedBlock
    ? previous.chain.lastScannedBlock + 1
    : CONFIG.deployBlock;
  const events = [...(previous?.chain?.events ?? [])];
  const tokenCache = {};

  // Keyed by log identity so a re-scan of an already-cached range updates in
  // place instead of duplicating (a full rescan replays every block).
  const byId = new Map(events.map((e) => [`${e.txHash}:${e.logIndex ?? 0}`, e]));

  for (let start = fromBlock; start <= latestBlock; start += CONFIG.logChunkSize) {
    const end = Math.min(start + CONFIG.logChunkSize - 1, latestBlock);
    const logs = await getLogs(start, end);
    for (const log of logs) {
      const blockNumber = Number(BigInt(log.blockNumber));
      const logIndex = Number(BigInt(log.logIndex));
      const block = await rpc("eth_getBlockByNumber", [log.blockNumber, false]);
      const token = topicAddress(log.topics[1]);
      const { symbol, decimals } = await tokenInfo(token, tokenCache);
      const isStable = word(log.data, 7) === 1n;
      byId.set(`${log.transactionHash}:${logIndex}`, {
        blockNumber,
        logIndex,
        timestamp: Number(BigInt(block.timestamp)) * 1000,
        txHash: log.transactionHash,
        token,
        tokenSymbol: symbol,
        sender: topicAddress(log.topics[2]),
        amountIn: units(word(log.data, 0), decimals),
        swapAmountIn: units(word(log.data, 1), decimals),
        alephReceived: units(word(log.data, 2), 18),
        alephBurned: units(word(log.data, 3), 18),
        alephToDistribution: units(word(log.data, 4), 18),
        // For stable tokens the developers cut is kept in the source token,
        // not swapped to ALEPH — track it in source-token units.
        toDevelopers: units(word(log.data, 5), decimals),
        toDevelopersToken: symbol,
        swapVersion: Number(word(log.data, 6)),
        isStable,
        marketBuy: word(log.data, 1) > 0n, // a swap happened → real market buy
      });
    }
  }

  const merged = [...byId.values()].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  );
  return { latestBlock, events: merged };
}

async function fetchCreditPayments() {
  const payments = [];
  const pageSize = 100;
  for (let page = 1; ; page++) {
    const res = await fetch(`${CONFIG.creditApi}/api/v0/payment?page=${page}&limit=${pageSize}`);
    if (!res.ok) throw new Error(`Credit API HTTP ${res.status} on page ${page}`);
    const body = await res.json();
    if (!Array.isArray(body.data)) throw new Error("Credit API: unexpected response shape");
    payments.push(...body.data);
    const { total } = body.pagination ?? {};
    if (!body.data.length || payments.length >= (total ?? 0)) break;
    if (page > 1000) throw new Error("Credit API: pagination runaway");
  }
  return payments;
}

function monthOf(tsMillis) {
  return new Date(tsMillis).toISOString().slice(0, 7); // YYYY-MM
}

// ALEPH/USD rate implied by each credit purchase (credit_price_usdc /
// credit_price_aleph) — the platform's own conversion rate at that moment.
// Lets us value direct-ALEPH payments in USD without an external price feed.
function buildAlephUsdRates(payments) {
  return payments
    .filter(
      (p) =>
        p.status === "COMPLETED" &&
        p.prices?.credit_price_aleph > 0 &&
        p.prices?.credit_price_usdc > 0,
    )
    .map((p) => ({ t: p.created_at, rate: p.prices.credit_price_usdc / p.prices.credit_price_aleph }))
    .sort((a, b) => a.t - b.t);
}

function nearestAlephUsd(rates, ts) {
  if (!rates.length) return null;
  let lo = 0;
  let hi = rates.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rates[mid].t < ts) lo = mid + 1;
    else hi = mid;
  }
  const prev = rates[lo - 1];
  const best = prev && Math.abs(prev.t - ts) < Math.abs(rates[lo].t - ts) ? prev : rates[lo];
  return best.rate;
}

function aggregate(payments, chainEvents, latestBlock) {
  const completed = payments.filter((p) => p.status === "COMPLETED" && p.prices);

  // USD actually paid = credits granted minus bonus, at the USD credit price.
  const usdOf = (p) =>
    (p.prices.credit_amount - (p.prices.credit_bonus_amount ?? 0)) * p.prices.credit_price_usdc;

  // Network revenue = USD value of every payment the processor processed.
  // Credit-API purchases are only a subset of what reaches the contract —
  // consolidated PAYG and off-API revenue arrive as direct ALEPH transfers —
  // so the headline is valued from the on-chain runs themselves: stables at
  // face value, ALEPH amounts at the platform's own rate at processing time.
  const alephUsdRates = buildAlephUsdRates(payments);
  const usdValueOf = (e) => {
    if (e.isStable) return e.amountIn;
    const rate = nearestAlephUsd(alephUsdRates, e.timestamp);
    if (rate == null) return null;
    return (e.tokenSymbol === "ALEPH" ? e.amountIn : e.alephReceived) * rate;
  };
  const events = chainEvents.map((e) => ({ ...e, usdValue: usdValueOf(e) }));

  const byMonth = {};
  for (const p of completed) {
    const m = monthOf(p.created_at);
    byMonth[m] ??= { month: m, usd: 0, purchases: 0, credits: 0 };
    byMonth[m].usd += usdOf(p);
    byMonth[m].purchases += 1;
    byMonth[m].credits += p.prices.credit_amount;
  }
  for (const e of events) {
    const m = monthOf(e.timestamp);
    byMonth[m] ??= { month: m, usd: 0, purchases: 0, credits: 0 };
    byMonth[m].processedUsd = (byMonth[m].processedUsd ?? 0) + (e.usdValue ?? 0);
    byMonth[m].alephBought = (byMonth[m].alephBought ?? 0) + (e.marketBuy ? e.alephReceived : 0);
    byMonth[m].alephDistributed = (byMonth[m].alephDistributed ?? 0) + e.alephToDistribution;
    byMonth[m].alephBurned = (byMonth[m].alephBurned ?? 0) + e.alephBurned;
  }

  const sum = (arr, f) => arr.reduce((acc, x) => acc + f(x), 0);
  const byCurrency = {};
  for (const p of completed) {
    const c = p.in_currency ?? "?";
    byCurrency[c] ??= { purchases: 0, usd: 0 };
    byCurrency[c].purchases += 1;
    byCurrency[c].usd += usdOf(p);
  }

  return {
    schemaVersion: CONFIG.schemaVersion,
    generatedAt: new Date().toISOString(),
    contract: CONFIG.contract,
    revenue: {
      totalUsd: sum(events, (e) => e.usdValue ?? 0),
      alephProcessed: sum(events, (e) => (e.tokenSymbol === "ALEPH" ? e.amountIn : e.alephReceived)),
      // Honesty surface: runs we could not value (no rate available).
      unpricedRuns: events.filter((e) => e.usdValue == null).length,
    },
    credits: {
      totalUsd: sum(completed, usdOf),
      totalCredits: sum(completed, (p) => p.prices.credit_amount),
      completedPurchases: completed.length,
      firstPurchaseAt: completed.length ? Math.min(...completed.map((p) => p.created_at)) : null,
      lastPurchaseAt: completed.length ? Math.max(...completed.map((p) => p.created_at)) : null,
      byCurrency,
      latest: [...completed]
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 15)
        .map((p) => ({
          createdAt: p.created_at,
          chain: p.chain,
          currency: p.in_currency,
          provider: p.provider_id,
          usd: usdOf(p),
          credits: p.prices.credit_amount,
          txHash: p.tx_hash ?? null,
        })),
    },
    chain: {
      lastScannedBlock: latestBlock,
      deployBlock: CONFIG.deployBlock,
      processingRuns: events.length,
      processedUsd: sum(events, (e) => e.usdValue ?? 0),
      alephMarketBought: sum(events, (e) => (e.marketBuy ? e.alephReceived : 0)),
      alephDistributed: sum(events, (e) => e.alephToDistribution),
      alephBurned: sum(events, (e) => e.alephBurned),
      burnActivated: events.some((e) => e.alephBurned > 0),
      events,
    },
    monthly: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)),
  };
}

async function main() {
  let cached = null;
  try {
    cached = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  } catch {
    /* first run */
  }
  // A schema change forces a full rescan (no incremental resume, no seed
  // events), but the cache is still the floor the result must clear — a
  // rebuild is exactly when a silent data loss would slip through.
  const previous = cached?.schemaVersion === CONFIG.schemaVersion ? cached : null;

  const [{ latestBlock, events }, payments] = await Promise.all([
    fetchChainEvents(previous),
    fetchCreditPayments(),
  ]);

  // Guardrail: refuse to overwrite a good cache with an emptier one.
  if (cached) {
    if (events.length < cached.chain.events.length)
      throw new Error(
        `Refusing to write: ${events.length} chain events < ${cached.chain.events.length} in previous cache`,
      );
    if (payments.filter((p) => p.status === "COMPLETED").length < cached.credits.completedPurchases)
      throw new Error("Refusing to write: fewer completed payments than previous cache");
  }

  const out = aggregate(payments, events, latestBlock);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 1) + "\n");
  console.log(
    `ok: revenue $${out.revenue.totalUsd.toFixed(2)} across ${out.chain.processingRuns} processing runs ` +
      `(${out.credits.completedPurchases} credit purchases: $${out.credits.totalUsd.toFixed(2)}), ` +
      `scanned to block ${latestBlock}`,
  );
}

main().catch((err) => {
  console.error(`pipeline failed: ${err.message}`);
  process.exit(1);
});
