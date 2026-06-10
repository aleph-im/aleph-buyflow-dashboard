#!/usr/bin/env node
/**
 * Publish the buy-flow data as a signed Aleph aggregate (key: "buyflow")
 * under the deploy wallet, so any consumer (e.g. the network dashboard) can
 * read it from any CCN:
 *
 *   https://api2.aleph.im/api/v0/aggregates/0x246B97e5Ce59E445C6206cE5BB8663e2Bae06a50.json?keys=buyflow
 *
 * Volatile fields (generatedAt, lastScannedBlock) are stripped so the payload
 * is deterministic; the current aggregate is fetched first and the message is
 * only posted when the content actually changed — no network spam on the
 * hourly no-op runs.
 *
 * Signing is delegated to the `aleph` CLI (aleph-rs), which reads the key
 * from the ALEPH_PRIVATE_KEY env var in CI (or --account locally).
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FLOW_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "data", "flow.json");
const ADDRESS = "0x246B97e5Ce59E445C6206cE5BB8663e2Bae06a50";
const KEY = "buyflow";
const API = process.env.ALEPH_API_URL || "https://api2.aleph.im";

// Round all floats to 6 decimals: keeps the payload tidy and stable across
// the node's own JSON re-serialization.
function roundDeep(v) {
  if (typeof v === "number" && !Number.isInteger(v)) return parseFloat(v.toFixed(6));
  if (Array.isArray(v)) return v.map(roundDeep);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, roundDeep(x)]));
  return v;
}

function payloadFrom(flow) {
  // Deterministic subset: drop run timestamps, keep everything consumers need.
  const { generatedAt, ...rest } = flow;
  const { lastScannedBlock, ...chain } = rest.chain;
  return roundDeep({ ...rest, chain });
}

function deepEqual(a, b) {
  if (a === b) return true;
  // Aleph nodes re-serialize floats with slight representation drift —
  // compare numbers with relative tolerance instead of bit equality.
  if (typeof a === "number" && typeof b === "number")
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

async function currentAggregate() {
  const res = await fetch(`${API}/api/v0/aggregates/${ADDRESS}.json?keys=${KEY}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`aggregate fetch HTTP ${res.status}`);
  const body = await res.json();
  return body?.data?.[KEY] ?? null;
}

const flow = JSON.parse(readFileSync(FLOW_PATH, "utf8"));
const next = payloadFrom(flow);
const current = await currentAggregate();

if (current && deepEqual(current, next)) {
  console.log("aggregate unchanged — skipping publish");
  process.exit(0);
}

const args = ["aggregate", "create", "--key", KEY, "--json"];
if (!process.env.ALEPH_PRIVATE_KEY) args.push("--account", "buyflow-deploy");
const res = spawnSync("aleph", args, { input: JSON.stringify(next), encoding: "utf8" });
if (res.status !== 0) {
  console.error(res.stdout, res.stderr);
  throw new Error(`aleph aggregate create failed (exit ${res.status})`);
}
const out = JSON.parse(res.stdout);
console.log(`aggregate published: ${out.item_hash} (status ${out.message_status})`);
