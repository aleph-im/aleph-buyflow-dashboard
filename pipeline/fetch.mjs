#!/usr/bin/env node
/**
 * Buy-flow dashboard data pipeline.
 *
 * Fetches:
 *  1. Credit purchases from the public Credit API (https://credit.aleph.im).
 *  2. TokenPaymentsProcessed events from the AlephPaymentProcessor contract
 *     on Ethereum mainnet (market-buy + burn + distribution per processing run).
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

const CONFIG = {
  rpcUrl: process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com",
  creditApi: process.env.CREDIT_API_URL || "https://credit.aleph.im",
  contract: "0x6b55F32Ea969910838defd03746Ced5E2AE8cB8B",
  deployBlock: 24270182, // ~2026-01-19
  // keccak256("TokenPaymentsProcessed(address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint8,bool)")
  topicTokenPaymentsProcessed: "0x3db36cd2496ef869c223c05bc35ff9785f5cc1ffeca2b221d884488c4282cbbc",
  logChunkSize: 10000, // capped to keep eth_getLogs responses under the endpoint's payload limit (HTTP 413)
  schemaVersion: 1,
};

// Known tokens; anything unknown is resolved on-chain via symbol()/decimals().
const KNOWN_TOKENS = {
  "0x27702a26126e0b3702af63ee09ac4d1a084ef628": { symbol: "ALEPH", decimals: 18 },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
};

let rpcId = 0;
async function rpcOnce(method, params) {
  const res = await fetch(CONFIG.rpcUrl, {
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
// blocks; retry transient failures with backoff.
async function rpc(method, params, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await rpcOnce(method, params);
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

const hex = (n) => "0x" + n.toString(16);
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

  for (let start = fromBlock; start <= latestBlock; start += CONFIG.logChunkSize) {
    const end = Math.min(start + CONFIG.logChunkSize - 1, latestBlock);
    const logs = await rpc("eth_getLogs", [{
      address: CONFIG.contract,
      fromBlock: hex(start),
      toBlock: hex(end),
      topics: [CONFIG.topicTokenPaymentsProcessed],
    }]);
    for (const log of logs) {
      const blockNumber = Number(BigInt(log.blockNumber));
      const block = await rpc("eth_getBlockByNumber", [log.blockNumber, false]);
      const token = topicAddress(log.topics[1]);
      const { symbol, decimals } = await tokenInfo(token, tokenCache);
      const isStable = word(log.data, 7) === 1n;
      events.push({
        blockNumber,
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

  events.sort((a, b) => a.blockNumber - b.blockNumber);
  return { latestBlock, events };
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

function aggregate(payments, chainEvents, latestBlock) {
  const completed = payments.filter((p) => p.status === "COMPLETED" && p.prices);

  // USD actually paid = credits granted minus bonus, at the USD credit price.
  const usdOf = (p) =>
    (p.prices.credit_amount - (p.prices.credit_bonus_amount ?? 0)) * p.prices.credit_price_usdc;

  const byMonth = {};
  for (const p of completed) {
    const m = monthOf(p.created_at);
    byMonth[m] ??= { month: m, usd: 0, purchases: 0, credits: 0 };
    byMonth[m].usd += usdOf(p);
    byMonth[m].purchases += 1;
    byMonth[m].credits += p.prices.credit_amount;
  }
  for (const e of chainEvents) {
    const m = monthOf(e.timestamp);
    byMonth[m] ??= { month: m, usd: 0, purchases: 0, credits: 0 };
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
      processingRuns: chainEvents.length,
      alephMarketBought: sum(chainEvents, (e) => (e.marketBuy ? e.alephReceived : 0)),
      alephDistributed: sum(chainEvents, (e) => e.alephToDistribution),
      alephBurned: sum(chainEvents, (e) => e.alephBurned),
      burnActivated: chainEvents.some((e) => e.alephBurned > 0),
      events: chainEvents,
    },
    monthly: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)),
  };
}

async function main() {
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(OUT_PATH, "utf8"));
    if (previous.schemaVersion !== CONFIG.schemaVersion) previous = null; // full rescan on schema change
  } catch {
    /* first run */
  }

  const [{ latestBlock, events }, payments] = await Promise.all([
    fetchChainEvents(previous),
    fetchCreditPayments(),
  ]);

  // Guardrail: refuse to overwrite a good cache with an emptier one.
  if (previous) {
    if (events.length < previous.chain.events.length)
      throw new Error("Refusing to write: fewer chain events than previous cache");
    if (payments.filter((p) => p.status === "COMPLETED").length < previous.credits.completedPurchases)
      throw new Error("Refusing to write: fewer completed payments than previous cache");
  }

  const out = aggregate(payments, events, latestBlock);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 1) + "\n");
  console.log(
    `ok: ${out.credits.completedPurchases} purchases ($${out.credits.totalUsd.toFixed(2)}), ` +
      `${out.chain.processingRuns} processing runs, scanned to block ${latestBlock}`,
  );
}

main().catch((err) => {
  console.error(`pipeline failed: ${err.message}`);
  process.exit(1);
});
