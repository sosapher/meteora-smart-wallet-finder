import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedChatIds,
  buildScanArgs,
  commandPlan,
  createBotState,
  formatLastScan,
  formatStatus,
  parseBotCommand,
} from "../src/bot.js";

const CONFIG = {
  telegram: { allowedChatIds: [], chatId: "" },
  paths: { dataDir: "/tmp/does-not-exist" },
};

test("parseBotCommand handles commands and @bot suffixes", () => {
  assert.deepEqual(parseBotCommand("/scan --pools 5"), {
    name: "scan",
    args: ["--pools", "5"],
  });
  assert.deepEqual(parseBotCommand("/status@MyBot"), { name: "status", args: [] });
  assert.equal(parseBotCommand("hello"), null);
  assert.equal(parseBotCommand(""), null);
});

test("buildScanArgs accepts valid options and normalizes them", () => {
  assert.deepEqual(buildScanArgs([]), []);
  assert.deepEqual(
    buildScanArgs(["--pools", "5", "--top=10", "--min-score", "80", "--refresh"]),
    ["--pools", "5", "--top", "10", "--min-score", "80", "--refresh"],
  );
});

test("buildScanArgs rejects unsafe or invalid options", () => {
  assert.throws(() => buildScanArgs(["--merge"]), /Unknown option/);
  assert.throws(() => buildScanArgs(["--pools", "0"]), /integer 1-100/);
  assert.throws(() => buildScanArgs(["--pools", "101"]), /integer 1-100/);
  assert.throws(() => buildScanArgs(["--top", "5; rm -rf /"]), /integer 1-200/);
  assert.throws(() => buildScanArgs(["--pools"]), /needs a number/);
  assert.throws(() => buildScanArgs(["--pools=5", "--pools=6"]), /Duplicate/);
  assert.throws(() => buildScanArgs(["--refresh=yes"]), /does not take a value/);
});

test("allowedChatIds uses the allowlist, then falls back to chatId", () => {
  assert.deepEqual(
    [...allowedChatIds({ telegram: { allowedChatIds: ["123", 456] } })],
    ["123", "456"],
  );
  assert.deepEqual(
    [...allowedChatIds({ telegram: { chatId: "789", allowedChatIds: [] } })],
    ["789"],
  );
  assert.equal(
    allowedChatIds({ telegram: { chatId: "", allowedChatIds: [] } }).size,
    0,
  );
});

test("help and id commands reply without actions", () => {
  const state = { ...createBotState(), chatId: "42" };
  const help = commandPlan({ text: "/help", state, config: CONFIG });
  assert.match(help.reply, /\/scan/);
  assert.equal(help.action, undefined);

  const id = commandPlan({ text: "/id", state, config: CONFIG });
  assert.match(id.reply, /42/);
});

test("scan command produces a scan action with safe arguments", () => {
  const state = createBotState();
  const plan = commandPlan({
    text: "/scan --pools 5 --top 10",
    state,
    config: CONFIG,
  });

  assert.equal(plan.action.type, "scan");
  assert.deepEqual(plan.action.args, ["--pools", "5", "--top", "10"]);
  assert.match(plan.reply, /Scan started/);
});

test("scan command rejects bad arguments and concurrent scans", () => {
  const bad = commandPlan({
    text: "/scan --pools 999",
    state: createBotState(),
    config: CONFIG,
  });
  assert.match(bad.reply, /integer 1-100/);
  assert.equal(bad.action, undefined);

  const running = createBotState();
  running.child = {};
  running.startedAt = Date.now() - 5000;
  const busy = commandPlan({ text: "/scan", state: running, config: CONFIG });
  assert.match(busy.reply, /already running/);
  assert.equal(busy.action, undefined);
});

test("stop command only acts when a scan is running", () => {
  const idle = commandPlan({
    text: "/stop",
    state: createBotState(),
    config: CONFIG,
  });
  assert.match(idle.reply, /No scan/);

  const running = createBotState();
  running.child = {};
  const stop = commandPlan({ text: "/stop", state: running, config: CONFIG });
  assert.equal(stop.action.type, "stop");
});

test("export command plans GMGN document delivery", () => {
  const state = createBotState();

  const auto = commandPlan({ text: "/export", state, config: CONFIG });
  assert.equal(auto.action.type, "export");
  assert.equal(auto.action.mode, "auto");
  assert.equal(auto.reply, undefined);

  const fresh = commandPlan({ text: "/export new", state, config: CONFIG });
  assert.equal(fresh.action.mode, "new");

  const full = commandPlan({ text: "/export full", state, config: CONFIG });
  assert.equal(full.action.mode, "full");

  const invalid = commandPlan({
    text: "/export everything",
    state,
    config: CONFIG,
  });
  assert.match(invalid.reply, /Usage/);
  assert.equal(invalid.action, undefined);
});

test("exporttxt command plans a ranked text document", () => {
  const plan = commandPlan({
    text: "/exporttxt",
    state: createBotState(),
    config: CONFIG,
  });
  assert.equal(plan.action.type, "exporttxt");
  assert.equal(plan.reply, undefined);
});

test("formatStatus reports idle and running states", () => {
  const idle = formatStatus(createBotState(), null);
  assert.match(idle, /idle/);
  assert.match(idle, /none yet/);

  const running = createBotState();
  running.child = {};
  running.startedAt = Date.now() - 12_000;
  running.scanArgs = ["--pools", "5"];
  const text = formatStatus(running, {
    meta: { generatedAt: new Date().toISOString(), recommended: 3, watch: 2 },
  });
  assert.match(text, /running/);
  assert.match(text, /3 recommended/);
});

test("formatLastScan renders top wallets and handles empty state", () => {
  assert.match(formatLastScan(null), /No scan results/);

  const emptyScan = {
    meta: { generatedAt: new Date().toISOString(), poolsScanned: 1 },
    candidates: [],
  };
  assert.match(formatLastScan(emptyScan), /no candidates found/);

  const lastScan = {
    meta: {
      generatedAt: new Date(Date.now() - 60_000).toISOString(),
      poolsScanned: 20,
      candidatesFound: 295,
      deepChecked: 35,
      recommended: 12,
      watch: 5,
    },
    candidates: [
      {
        address: "BWAPhpTestAddress",
        score: { score: 95.5, tier: "S", status: "recommended", qualified: true },
        metrics: { winRatePct: 78, feeYieldPct: 4.2, netRoiPct: 12.3, n: 42 },
      },
    ],
  };

  const text = formatLastScan(lastScan);
  assert.match(text, /BWAPhpTestAddress/);
  assert.match(text, /95.5/);
  assert.match(text, /12 recommended/);
});
