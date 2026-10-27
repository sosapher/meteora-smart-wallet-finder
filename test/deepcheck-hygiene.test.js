import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Cache } from "../src/cache.js";
import { DEFAULT_CONFIG, deepMerge } from "../src/config.js";
import { scoreWallet } from "../src/score.js";
import { deepCheckCandidate } from "../src/wallets.js";

const WALLET = "7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK";
const FUNDER = "28F7nEtbmHJbAZkDH6U6LYNvWrXksDSoGUhhrdvyTs6L";
const POOL = "2tFYCTqYJ2pyrb7CeA824o2Ybq3jq7agvr3Qpv2uVDmL";
const SYSTEM = "11111111111111111111111111111111";

function baseConfig(overrides = {}) {
  return deepMerge(DEFAULT_CONFIG, overrides);
}

function position(index, now) {
  const closedAt = now - (index + 1) * 3_600_000;
  const createdAt = closedAt - 24 * 3_600_000;
  return {
    positionAddress: `position-${index}`,
    allTimeDeposits: { total: { usd: 1_000 } },
    allTimeFees: { total: { usd: 100 } },
    allTimeWithdrawals: { total: { usd: 0 } },
    pnlUsd: 150,
    pnlPctChange: 15,
    createdAt: new Date(createdAt).toISOString(),
    closedAt: new Date(closedAt).toISOString(),
    lowerBinId: 10,
    upperBinId: 50,
    isOutOfRange: false,
  };
}

test("deepCheckCandidate merges Helius hygiene into metrics and scoring", async (t) => {
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);
  const calls = [];

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const send = (payload) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };

      if (request.method === "GET" && url.pathname === "/portfolio/open") {
        return send({
          totalPositions: 1,
          pools: [
            {
              poolAddress: POOL,
              poolName: "TEST-SOL",
              listPositions: [],
              outOfRange: false,
            },
          ],
        });
      }

      if (request.method === "GET" && url.pathname.startsWith("/positions/")) {
        return send({
          positions: Array.from({ length: 6 }, (_, index) => position(index, now)),
          hasNext: false,
          totalCount: 6,
        });
      }

      const payload = body ? JSON.parse(body) : {};
      calls.push(payload.method);

      if (payload.method === "getBalance") {
        return send({ jsonrpc: "2.0", id: payload.id, result: 5_000_000_000 });
      }
      if (payload.method === "getSignaturesForAddress") {
        return send({
          jsonrpc: "2.0",
          id: payload.id,
          result: [
            { signature: "sig-new", blockTime: nowSeconds - 3600, err: null },
            { signature: "sig-old", blockTime: nowSeconds - 86_400 * 100, err: null },
          ],
        });
      }
      if (payload.method === "getTransaction") {
        return send({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            blockTime: nowSeconds - 86_400 * 100,
            transaction: {
              message: {
                accountKeys: [{ pubkey: FUNDER }, { pubkey: WALLET }],
              },
            },
            meta: {
              preBalances: [10_000_000_000, 0],
              postBalances: [9_000_000_000, 1_000_000_000],
            },
          },
        });
      }
      if (payload.method === "getAccountInfo") {
        return send({
          jsonrpc: "2.0",
          id: payload.id,
          result: { value: { executable: false, owner: SYSTEM, lamports: 1 } },
        });
      }

      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected method" }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;
  const config = baseConfig({
    api: {
      meteoraDataApi: base,
      timeoutMs: 5_000,
      retries: 0,
      minIntervalMs: 0,
    },
    discovery: {
      concurrency: 1,
      maxPoolsPerWallet: 1,
      openCacheTtlMinutes: 10,
      pnlCacheTtlMinutes: 60,
    },
    hygiene: {
      rpcUrl: `${base}/?api-key=secret-test-key`,
      minWalletAgeDays: 30,
      maxSignaturePages: 1,
      signaturePageSize: 100,
    },
  });

  const cache = new Cache(
    fs.mkdtempSync(path.join(os.tmpdir(), "swf-deepcheck-")),
  );
  const candidate = {
    address: WALLET,
    short: "7Weigv...GkK",
    pools: [{ address: POOL, name: "TEST-SOL" }],
    appearances: 1,
  };

  const result = await deepCheckCandidate(candidate, {
    config,
    cache,
    logger: null,
    allPools: [],
    refresh: true,
    maxPools: 1,
  });

  assert.equal(result.metrics.n, 6);
  assert.equal(result.metrics.hygiene.enabled, true);
  assert.equal(result.metrics.hygiene.walletAgeDays, 100);
  assert.equal(result.metrics.hygiene.funder, FUNDER);
  assert.equal(result.metrics.hygiene.funderType, "wallet");
  assert.ok(!result.metrics.flags.includes("new_wallet"));
  assert.ok(calls.includes("getBalance"));
  assert.ok(calls.includes("getSignaturesForAddress"));
  assert.ok(calls.includes("getTransaction"));

  const score = scoreWallet(result.metrics, config);
  assert.equal(
    score.gates.find((gate) => gate.code === "wallet_age")?.ok,
    true,
  );
  assert.ok(
    score.reasons.some((reason) => /wallet age 100d/.test(reason)),
  );
});
