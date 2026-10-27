import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Cache } from "../src/cache.js";
import { DEFAULT_CONFIG, deepMerge } from "../src/config.js";
import {
  annotateSharedFunders,
  applyHygieneMetrics,
  extractFundingSource,
  fetchWalletHygiene,
  hygieneEnabled,
  rpcCall,
} from "../src/hygiene.js";

const WALLET = "7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK";
const FUNDER = "28F7nEtbmHJbAZkDH6U6LYNvWrXksDSoGUhhrdvyTs6L";
const OTHER = "13ir3HLG7vUBidTNHY23Xdkeh6hte5z4QKqByPpJdEvs";
const SYSTEM = "11111111111111111111111111111111";

function baseConfig(overrides = {}) {
  return deepMerge(DEFAULT_CONFIG, overrides);
}

function tempCache() {
  return new Cache(fs.mkdtempSync(path.join(os.tmpdir(), "swf-hygiene-")));
}

test("hygieneEnabled requires a URL and an enabled flag", () => {
  assert.equal(hygieneEnabled(baseConfig()), false);
  assert.equal(
    hygieneEnabled(baseConfig({ hygiene: { rpcUrl: "http://localhost" } })),
    true,
  );
  assert.equal(
    hygieneEnabled(
      baseConfig({ hygiene: { rpcUrl: "http://localhost", enabled: false } }),
    ),
    false,
  );
});

test("extractFundingSource finds the fee payer that funded the wallet", () => {
  const transaction = {
    transaction: {
      message: {
        accountKeys: [{ pubkey: FUNDER }, { pubkey: WALLET }, { pubkey: SYSTEM }],
      },
    },
    meta: {
      preBalances: [10_000_000_000, 0, 1],
      postBalances: [9_000_000_000, 1_000_000_000, 1],
    },
  };

  const result = extractFundingSource(transaction, WALLET);
  assert.equal(result.funder, FUNDER);
  assert.equal(result.feePayer, FUNDER);
  assert.equal(result.walletDeltaLamports, 1_000_000_000);
});

test("extractFundingSource handles wallet-paid fees and empty transactions", () => {
  const transaction = {
    transaction: {
      message: {
        accountKeys: [{ pubkey: WALLET }, { pubkey: FUNDER }],
      },
    },
    meta: {
      preBalances: [1_000_000_000, 10_000_000_000],
      postBalances: [500_000_000, 9_500_000_000],
    },
  };
  assert.equal(extractFundingSource(transaction, WALLET).funder, FUNDER);
  assert.equal(extractFundingSource({}, WALLET).funder, null);
});

test("applyHygieneMetrics adds age, inactivity, and SOL warnings", () => {
  const config = baseConfig({ hygiene: { rpcUrl: "http://localhost" } });
  const metrics = { flags: [], n: 10 };

  const result = applyHygieneMetrics(
    metrics,
    {
      enabled: true,
      ageDays: 10,
      ageCapped: false,
      daysSinceLastSignature: 20,
      balanceSol: 0.01,
      funder: FUNDER,
      funderType: "wallet",
    },
    config,
  );

  assert.ok(result.flags.includes("new_wallet"));
  assert.ok(result.flags.includes("inactive_wallet"));
  assert.ok(result.flags.includes("low_sol"));
  assert.equal(result.hygiene.walletAgeDays, 10);
  assert.equal(result.hygiene.funder, FUNDER);
});

test("applyHygieneMetrics does not flag capped or healthy wallets", () => {
  const config = baseConfig({ hygiene: { rpcUrl: "http://localhost" } });
  const capped = applyHygieneMetrics(
    { flags: [], n: 10 },
    {
      enabled: true,
      ageDays: 5,
      ageCapped: true,
      daysSinceLastSignature: 1,
      balanceSol: 1,
    },
    config,
  );
  assert.ok(!capped.flags.includes("new_wallet"));
  assert.ok(capped.flags.includes("wallet_age_uncertain"));

  const healthy = applyHygieneMetrics(
    { flags: [], n: 10 },
    {
      enabled: true,
      ageDays: 200,
      ageCapped: false,
      daysSinceLastSignature: 1,
      balanceSol: 2,
    },
    config,
  );
  assert.deepEqual(healthy.flags, []);

  const failed = applyHygieneMetrics(
    { flags: [], n: 10 },
    { enabled: true, error: "rpc down", ageDays: null },
    config,
  );
  assert.ok(failed.flags.includes("hygiene_unknown"));

  const empty = applyHygieneMetrics(
    { flags: [], n: 10 },
    { enabled: true, ageDays: null, signatureCount: 0 },
    config,
  );
  assert.ok(empty.flags.includes("no_onchain_history"));
  assert.ok(!empty.flags.includes("hygiene_unknown"));
});

test("annotateSharedFunders flags only real wallet clusters", () => {
  const config = baseConfig({
    hygiene: { rpcUrl: "http://localhost", minSharedFunderWallets: 2 },
  });
  const candidate = (address, funder, funderType = "wallet") => ({
    address,
    metrics: {
      flags: [],
      hygiene: { enabled: true, funder, funderType },
    },
    score: { warnings: [] },
  });

  const a = candidate(WALLET, FUNDER);
  const b = candidate(OTHER, FUNDER);
  const c = candidate("C8v8P9JRWw8YPXE3HDXSWhhVCrHb8Ydw7DfZoQd2VBH", "FpfnQzbBk1oSTcJQbBFnnF2T1UM9bvd9439kJaJaw4b1");
  const program = candidate("AN2sTfonvsWP2yj4ymry7jW6QhJcQsLu8nJZAjNKkWJo", FUNDER, "program");

  annotateSharedFunders([a, b, c, program], config);

  assert.ok(a.metrics.flags.includes("shared_funder"));
  assert.ok(b.metrics.flags.includes("shared_funder"));
  assert.equal(a.metrics.hygiene.sharedFunderCount, 2);
  assert.match(a.score.warnings[0], /shares a funder/);
  assert.ok(!c.metrics.flags.includes("shared_funder"));
  assert.ok(!program.metrics.flags.includes("shared_funder"));
});

test("annotateSharedFunders respects ignoreFunders", () => {
  const config = baseConfig({
    hygiene: { rpcUrl: "http://localhost", ignoreFunders: [FUNDER] },
  });
  const candidate = (address) => ({
    address,
    metrics: { flags: [], hygiene: { enabled: true, funder: FUNDER, funderType: "wallet" } },
    score: { warnings: [] },
  });

  const a = candidate(WALLET);
  const b = candidate(OTHER);
  annotateSharedFunders([a, b], config);
  assert.ok(!a.metrics.flags.includes("shared_funder"));
  assert.ok(!b.metrics.flags.includes("shared_funder"));
});

function startRpcServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body);
        const result = handler(payload.method, payload.params, request.url);
        response.writeHead(result.status || 200, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify(result.body));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/?api-key=super-secret`,
      });
    });
  });
}

test("fetchWalletHygiene reads balance, history, funding, and caches calls", async (t) => {
  const calls = [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const signatures = [
    { signature: "sig-new", blockTime: nowSeconds - 3600, err: null },
    { signature: "sig-mid", blockTime: nowSeconds - 86_400 * 100, err: null },
  ];
  const older = [
    { signature: "sig-old", blockTime: nowSeconds - 86_400 * 200, err: null },
    { signature: "sig-oldest", blockTime: nowSeconds - 86_400 * 201, err: { err: "failed" } },
  ];

  const { server, url } = await startRpcServer((method, params) => {
    calls.push({ method, params });
    if (method === "getBalance") {
      return { body: { jsonrpc: "2.0", id: 1, result: 5_000_000_000 } };
    }
    if (method === "getSignaturesForAddress") {
      const batch = params[1].before ? older : signatures;
      return { body: { jsonrpc: "2.0", id: 1, result: batch } };
    }
    if (method === "getTransaction") {
      return {
        body: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            blockTime: nowSeconds - 86_400 * 200,
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
        },
      };
    }
    if (method === "getAccountInfo") {
      return {
        body: {
          jsonrpc: "2.0",
          id: 1,
          result: { value: { executable: false, owner: SYSTEM, lamports: 1 } },
        },
      };
    }
    return { status: 500, body: { error: "unexpected method" } };
  });
  t.after(() => server.close());

  const config = baseConfig({
    hygiene: {
      rpcUrl: url,
      maxSignaturePages: 2,
      signaturePageSize: 2,
      cacheTtlMinutes: 60,
    },
  });
  const cache = tempCache();

  const result = await fetchWalletHygiene(WALLET, config, cache, null);
  assert.equal(result.enabled, true);
  assert.equal(result.balanceSol, 5);
  assert.equal(result.ageCapped, true);
  assert.equal(result.signatureCount, 4);
  assert.equal(result.signaturePages, 2);
  assert.ok(result.ageDays > 199 && result.ageDays < 202);
  assert.equal(result.funder, FUNDER);
  assert.equal(result.funderType, "wallet");

  const before = calls.length;
  await fetchWalletHygiene(WALLET, config, cache, null);
  assert.equal(calls.length, before, "cached calls should not hit the RPC");
});

test("fetchWalletHygiene returns errors without leaking the API key", async (t) => {
  const { server, url } = await startRpcServer(() => ({
    status: 500,
    body: { error: "upstream down" },
  }));
  t.after(() => server.close());

  const config = baseConfig({ hygiene: { rpcUrl: url, retries: 0 } });
  const result = await fetchWalletHygiene(WALLET, config, null, null);

  assert.equal(result.enabled, true);
  assert.match(result.error, /HTTP 500/);
  assert.doesNotMatch(result.error, /super-secret/);

  await assert.rejects(
    () => rpcCall(config, "getBalance", [WALLET], { refresh: true }),
    (error) => {
      assert.doesNotMatch(error.message, /super-secret/);
      return true;
    },
  );
});
