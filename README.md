# Watch the cloud buy ALEPH — buy-flow dashboard

Public, daily-refreshing ledger of Aleph Cloud's token flow: credit purchases
(Credit API) and on-chain ALEPH conversion — market buys, distribution, burns —
decoded from the AlephPaymentProcessor contract on Ethereum mainnet.

Implements `aleph-coordination/BUYFLOW_DASHBOARD_SPEC.md` (v1).

## Layout

```
pipeline/fetch.mjs   zero-dependency Node ≥18 pipeline → web/data/flow.json
web/index.html       static single-page dashboard (no build step)
web/data/flow.json   generated cache — committed so the static site has data
.github/workflows/   hourly refresh + GitHub Pages deploy
```

## Run locally

```sh
node pipeline/fetch.mjs        # fetch + aggregate (incremental after first run)
npx serve web                  # or: python3 -m http.server -d web 8000
```

Env overrides: `ETH_RPC_URL` (default publicnode), `CREDIT_API_URL`
(default https://credit.aleph.im).

## Data sources

1. **AlephPaymentProcessor** — `0x6b55F32Ea969910838defd03746Ced5E2AE8cB8B`
   (Ethereum mainnet, deployed block 24,270,182). `TokenPaymentsProcessed`
   events, topic0 `0x3db36cd2…cbbc`: one event per processing run with swap,
   burn, distribution and developer amounts. Decoded against
   `aleph-contract-eth-credit/src/AlephPaymentProcessor.sol` (the repo-root
   `abi.json` there is stale — fewer fields than deployed).
2. **Credit API** — `GET https://credit.aleph.im/api/v0/payment` (paginated).
   USD figures = credits granted minus bonus credits, at `credit_price_usdc`;
   only `COMPLETED` payments count.

Field nuance: for stable-token payments the developers cut stays in the source
token (e.g. USDC) and only the remainder is swapped to ALEPH; for direct ALEPH
payments no swap occurs (`marketBuy: false`, not counted as market-bought).

## Honesty guardrails (from the spec — do not regress)

- **Never render zeros on failure.** The pipeline exits non-zero on any source
  error and refuses to overwrite a good cache with an emptier one; the frontend
  shows an explicit error panel if `flow.json` is missing and a stale banner if
  the cache is >24 h old.
- **Transparency framing, not scale.** Numbers are small (~$1.7K cumulative,
  2 processing runs as of 2026-06-10). Copy stays mechanism-first; no
  "massive buy pressure" language.
- **Burn lever shown explicitly**: "burn 0% — governance lever, unactivated".

## Deploy

The hourly workflow refreshes `web/data/flow.json`, commits it, and deploys to
two targets:

1. **Aleph Cloud web3 hosting** (canonical, dogfood) — `web/` is pinned to
   IPFS via [`aleph-im/web3-hosting-action`](https://github.com/aleph-im/web3-hosting-action)
   and linked to **flow.aleph.cloud**. Uses the `ALEPH_PRIVATE_KEY` repo secret
   (dedicated deploy wallet `0x246B97e5Ce59E445C6206cE5BB8663e2Bae06a50`).
   Required DNS at the `aleph.cloud` zone (OVH):
   - `flow` CNAME → `ipfs.public.aleph.sh.`
   - `_control.flow` TXT → `0x246B97e5Ce59E445C6206cE5BB8663e2Bae06a50`
2. **GitHub Pages** (mirror/staging) —
   https://aleph-im.github.io/aleph-buyflow-dashboard/
3. **Aleph aggregate** (data contract for other consumers, e.g. the network
   dashboard) — the flow data, minus run timestamps and rounded to 6 decimals,
   is published as a signed aggregate under the deploy wallet, **only when the
   content changes** (`pipeline/publish-aggregate.mjs` diffs against the live
   aggregate first):

   ```
   https://api2.aleph.im/api/v0/aggregates/0x246B97e5Ce59E445C6206cE5BB8663e2Bae06a50.json?keys=buyflow
   ```

   Freshness semantics: the aggregate updates on distributions/buys, not on a
   clock — use `web/data/flow.json`'s `generatedAt` (refreshed hourly) to
   check pipeline liveness.
