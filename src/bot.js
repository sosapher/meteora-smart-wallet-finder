import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "./config.js";
import { writeAllWalletsText, writeSmartWalletText } from "./output.js";
import { loadState } from "./state.js";
import {
  escapeHtml,
  getTelegramMe,
  getTelegramUpdates,
  sendTelegramDocument,
  sendTelegramMessage,
} from "./telegram.js";

const MAX_TAIL_LINES = 20;
const KILL_GRACE_MS = 10_000;

const SCAN_LIMITS = {
  "--pools": { min: 1, max: 100 },
  "--top": { min: 1, max: 200 },
  "--min-score": { min: 0, max: 100 },
};

export const SCAN_USAGE =
  "Usage: <code>/scan [--pools 1-100] [--top 1-200] [--min-score 0-100] [--refresh]</code>";

export function helpText() {
  return [
    "🤖 <b>Meteora Smart Wallet Finder</b>",
    "<i>Read-only control bot. No private keys, no transactions.</i>",
    "",
    "<b>Commands</b>",
    "/scan — run a scan with default settings",
    "/scan --pools 5 --top 10 — quick scan",
    "/scan --refresh — ignore cache",
    "/stop — stop the running scan",
    "/status — show scan status",
    "/last — show top wallets from the last scan",
    "/export — send the latest GMGN file",
    "/export new — send only new GMGN wallets",
    "/export full — send the full GMGN list",
    "/exporttxt — send smart wallets as a ranked .txt file",
    "/exporttxtfull — send every wallet ever found, ranked by tier",
    "/id — show this chat ID",
    "/help — show this message",
    "",
    SCAN_USAGE,
    "",
    "<i>Merging into Meridian stays manual: run</i> <code>node finder.js export --merge</code> <i>on the VPS.</i>",
  ].join("\n");
}

export function parseBotCommand(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/")) return null;

  const [raw, ...args] = trimmed.split(/\s+/);
  const name = raw.slice(1).split("@")[0].toLowerCase();
  if (!name) return null;
  return { name, args };
}

export function buildScanArgs(tokens = []) {
  const out = [];
  const seen = new Set();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index]);
    const [flag, inlineValue] = token.split("=", 2);

    if (flag === "--refresh") {
      if (inlineValue !== undefined) {
        throw new Error("--refresh does not take a value");
      }
      if (!seen.has(flag)) out.push(flag);
      seen.add(flag);
      continue;
    }

    const limits = SCAN_LIMITS[flag];
    if (!limits) {
      throw new Error(`Unknown option: ${flag}`);
    }
    if (seen.has(flag)) {
      throw new Error(`Duplicate option: ${flag}`);
    }

    let value = inlineValue;
    if (value === undefined) {
      value = tokens[index + 1];
      index += 1;
    }
    if (value === undefined || value === "") {
      throw new Error(`${flag} needs a number`);
    }

    const number = Number(value);
    if (!Number.isInteger(number) || number < limits.min || number > limits.max) {
      throw new Error(`${flag} must be an integer ${limits.min}-${limits.max}`);
    }

    out.push(flag, String(number));
    seen.add(flag);
  }

  return out;
}

export function allowedChatIds(config) {
  const raw = config.telegram?.allowedChatIds;
  const values = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,\s]+/);
  const ids = values.map((value) => String(value).trim()).filter(Boolean);
  if (ids.length === 0 && config.telegram?.chatId) {
    ids.push(String(config.telegram.chatId));
  }
  return new Set(ids);
}

export function createBotState() {
  return {
    child: null,
    startedAt: 0,
    startedBy: null,
    killRequested: false,
    killTimer: null,
    scanArgs: [],
    tail: [],
  };
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatAge(iso) {
  const timestamp = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(timestamp)) return "unknown time";
  const age = Date.now() - timestamp;
  if (age < 60_000) return "just now";
  return `${formatDuration(age)} ago`;
}

export function readLastScan(config) {
  const file = path.join(config.paths.dataDir, "last-scan.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function formatStatus(state, lastScan) {
  const lines = ["🤖 <b>Bot online</b>"];

  if (state.child) {
    const elapsed = formatDuration(Date.now() - state.startedAt);
    const options = state.scanArgs.length > 0
      ? `<code>${escapeHtml(state.scanArgs.join(" "))}</code>`
      : "default settings";
    lines.push(`Scan: <b>running</b> · ${elapsed} · ${options}`);
  } else {
    lines.push("Scan: idle");
  }

  if (lastScan?.meta) {
    lines.push(
      `Last scan: ${formatAge(lastScan.meta.generatedAt)} · ` +
        `✅ ${lastScan.meta.recommended ?? 0} recommended · ` +
        `👀 ${lastScan.meta.watch ?? 0} watch`,
    );
  } else {
    lines.push("Last scan: none yet");
  }

  return lines.join("\n");
}

export function formatLastScan(lastScan, { limit = 8, header = true } = {}) {
  if (!lastScan?.meta && !lastScan?.candidates?.length) {
    return "No scan results yet. Send /scan to start one.";
  }

  const meta = lastScan.meta || {};

  if (!lastScan.candidates?.length) {
    const lines = [];
    if (header) {
      lines.push(`📊 <b>Last scan</b> · ${formatAge(meta.generatedAt)}`);
    }
    lines.push(`${meta.poolsScanned ?? "?"} pools scanned · no candidates found.`);
    lines.push(
      "Upstream data can be rate-limited. Try /scan --refresh again in a few minutes.",
    );
    return lines.join("\n");
  }

  const lines = [];

  if (header) {
    lines.push(`📊 <b>Last scan</b> · ${formatAge(meta.generatedAt)}`);
  }
  lines.push(
    `${meta.poolsScanned ?? "?"} pools · ${meta.candidatesFound ?? "?"} candidates · ` +
      `${meta.deepChecked ?? "?"} checked`,
  );
  lines.push(
    `✅ ${meta.recommended ?? 0} recommended · 👀 ${meta.watch ?? 0} watch`,
  );
  lines.push("");

  const actionable = lastScan.candidates.filter(
    (candidate) =>
      candidate.score?.status === "recommended" ||
      candidate.score?.status === "watch",
  );
  const source = actionable.length > 0 ? actionable : lastScan.candidates;
  const candidates = source.slice(0, limit);
  candidates.forEach((candidate, index) => {
    const score = candidate.score || {};
    const metrics = candidate.metrics || {};
    lines.push(
      `${index + 1}. <b>${score.score ?? 0}</b> ${score.tier ?? "?"} · ` +
        `<code>${escapeHtml(candidate.address || "")}</code>`,
    );
    lines.push(
      `   win ${metrics.winRatePct ?? 0}% · fee ${metrics.feeYieldPct ?? 0}% · ` +
        `ROI ${metrics.netRoiPct ?? 0}% · ${metrics.n ?? 0} closed`,
    );
    if (metrics.hygiene?.walletAgeDays != null) {
      lines.push(
        `   on-chain age ${metrics.hygiene.walletAgeDays}d · ` +
          `SOL ${metrics.hygiene.solBalance}` +
          (metrics.hygiene.sharedFunderCount > 1
            ? ` · shared funder x${metrics.hygiene.sharedFunderCount}`
            : ""),
      );
    }
    if (score.status) {
      lines.push(`   status ${score.status}${score.qualified ? "" : " (gated)"}`);
    }
  });

  if (source.length > limit) {
    lines.push("");
    lines.push(`<i>+${source.length - limit} more in exports/recommended.md</i>`);
  }

  return lines.join("\n");
}

/**
 * Turn a message into a reply plus an optional action. Pure function so the
 * command layer is easy to test.
 */
export function commandPlan({ text, state, config, lastScan = null }) {
  const parsed = parseBotCommand(text);
  if (!parsed) return null;

  switch (parsed.name) {
    case "start":
    case "help":
      return { reply: helpText() };

    case "id":
      return {
        reply:
          `Chat ID: <code>${escapeHtml(state.chatId ?? "unknown")}</code>\n` +
          "Use this value in <code>telegram.allowedChatIds</code>.",
      };

    case "status":
      return { reply: formatStatus(state, lastScan) };

    case "last":
      return { reply: formatLastScan(lastScan) };

    case "export": {
      const mode = String(parsed.args[0] || "auto").toLowerCase();
      if (!["auto", "new", "full"].includes(mode)) {
        return {
          reply:
            "Usage: <code>/export</code>, <code>/export new</code>, or " +
            "<code>/export full</code>.",
        };
      }
      return { action: { type: "export", mode } };
    }

    case "exporttxt":
      return { action: { type: "exporttxt" } };

    case "exporttxtfull":
      return { action: { type: "exporttxtfull" } };

    case "scan": {
      if (state.child) {
        return {
          reply: `⏳ A scan is already running (${formatDuration(Date.now() - state.startedAt)}). Use /status or /stop.`,
        };
      }
      try {
        const scanArgs = buildScanArgs(parsed.args);
        const options = scanArgs.length > 0
          ? `<code>${escapeHtml(scanArgs.join(" "))}</code>`
          : "default settings";
        return {
          reply: `🚀 <b>Scan started</b> · ${options}\nUse /status to check progress or /stop to cancel.`,
          action: { type: "scan", args: scanArgs },
        };
      } catch (error) {
        return { reply: `❌ ${escapeHtml(error.message)}\n\n${SCAN_USAGE}` };
      }
    }

    case "stop":
      if (!state.child) return { reply: "No scan is running." };
      return {
        reply: "🛑 Stopping the running scan...",
        action: { type: "stop" },
      };

    default:
      return {
        reply: `Unknown command: /${escapeHtml(parsed.name)}\n\n${helpText()}`,
        action: null,
      };
  }
}

function offsetPath(config) {
  return path.join(config.paths.dataDir, "telegram-offset.json");
}

function loadOffset(config) {
  try {
    const data = JSON.parse(fs.readFileSync(offsetPath(config), "utf8"));
    const offset = Number(data.offset);
    return Number.isInteger(offset) && offset >= 0 ? offset : null;
  } catch {
    return null;
  }
}

function saveOffset(config, offset) {
  const file = offsetPath(config);
  const temp = `${file}.tmp`;
  try {
    fs.writeFileSync(
      temp,
      `${JSON.stringify({ offset, updatedAt: new Date().toISOString() })}\n`,
    );
    fs.renameSync(temp, file);
  } catch {
    // Offset persistence is best-effort.
  }
}

function appendTail(state, chunk) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  state.tail.push(...lines);
  if (state.tail.length > MAX_TAIL_LINES) {
    state.tail.splice(0, state.tail.length - MAX_TAIL_LINES);
  }
}

function startScan({ state, config, configPath, scanArgs, chatId, logger }) {
  const childArgs = [path.join(ROOT, "finder.js"), "scan", ...scanArgs];
  if (configPath) childArgs.push("--config", configPath);

  const child = spawn(process.execPath, childArgs, {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  state.child = child;
  state.startedAt = Date.now();
  state.startedBy = chatId;
  state.killRequested = false;
  state.scanArgs = scanArgs;
  state.tail = [];

  child.stdout.on("data", (chunk) => appendTail(state, chunk));
  child.stderr.on("data", (chunk) => appendTail(state, chunk));

  child.on("error", (error) => {
    state.child = null;
    sendTelegramMessage(
      chatId,
      `❌ <b>Could not start scan</b>\n<code>${escapeHtml(error.message)}</code>`,
      config,
      logger,
    );
  });

  child.on("exit", (code, signal) => {
    if (state.child !== child) return;

    const elapsed = formatDuration(Date.now() - state.startedAt);
    const wasStopped = state.killRequested;

    state.child = null;
    state.killRequested = false;
    if (state.killTimer) {
      clearTimeout(state.killTimer);
      state.killTimer = null;
    }

    if (wasStopped) {
      sendTelegramMessage(
        chatId,
        `🛑 <b>Scan stopped</b> after ${elapsed}.`,
        config,
        logger,
      );
      logger.info(`Telegram scan stopped by chat ${chatId} after ${elapsed}`);
      return;
    }

    if (code === 0) {
      const lastScan = readLastScan(config);
      const summary = formatLastScan(lastScan, { limit: 5, header: false });
      sendTelegramMessage(
        chatId,
        `✅ <b>Scan finished</b> in ${elapsed}\n\n${summary}`,
        config,
        logger,
      );
      logger.info(`Telegram scan finished in ${elapsed}`);
      return;
    }

    const tail = state.tail.join("\n").slice(-1200);
    sendTelegramMessage(
      chatId,
      `❌ <b>Scan failed</b> after ${elapsed} ` +
        `(exit ${code ?? "?"}${signal ? `, ${signal}` : ""})\n` +
        `<pre>${escapeHtml(tail || "no output")}</pre>`,
      config,
      logger,
    );
    logger.warn(`Telegram scan failed: exit ${code ?? "?"} ${signal ?? ""}`);
  });

  logger.info(
    `Telegram scan started by chat ${chatId}: ${scanArgs.join(" ") || "defaults"}`,
  );
}

function stopScan(state, logger) {
  if (!state.child) return false;
  state.killRequested = true;

  try {
    state.child.kill("SIGTERM");
  } catch (error) {
    logger.warn(`Could not send SIGTERM to scan: ${error.message}`);
  }

  if (state.killTimer) clearTimeout(state.killTimer);
  state.killTimer = setTimeout(() => {
    if (!state.child) return;
    logger.warn("Scan did not stop in time; sending SIGKILL.");
    try {
      state.child.kill("SIGKILL");
    } catch {
      // The child may have exited between the check and the kill.
    }
  }, KILL_GRACE_MS);

  return true;
}

function isFatalTelegramError(error) {
  const message = String(error?.message || "");
  return /HTTP (401|404|409)|Conflict|Unauthorized|Not Found|terminated by other/i.test(
    message,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function latestOffset(config, logger) {
  const updates = await getTelegramUpdates({
    config,
    offset: -1,
    timeoutSeconds: 0,
    limit: 1,
    logger,
  });
  if (updates.length === 0) return 0;
  return updates[updates.length - 1].update_id + 1;
}

function readGmgnFile(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function handleExport({ chatId, mode, config, logger }) {
  const settings = config.export?.gmgn || {};
  const fullPath = path.join(
    config.paths.exportDir,
    settings.fileName || "gmgn-follow.json",
  );
  const newPath = path.join(
    config.paths.exportDir,
    settings.newFileName || "gmgn-new.json",
  );

  let target = mode === "new" ? newPath : mode === "full" ? fullPath : null;
  if (!target) {
    const newWallets = readGmgnFile(newPath);
    target = newWallets && newWallets.length > 0 ? newPath : fullPath;
  }

  if (!fs.existsSync(target)) {
    await sendTelegramMessage(
      chatId,
      "❌ No GMGN export found yet. Run /scan first.",
      config,
      logger,
    );
    return;
  }

  const wallets = readGmgnFile(target);
  if (!wallets) {
    await sendTelegramMessage(
      chatId,
      `❌ Could not read <code>${escapeHtml(path.basename(target))}</code>.`,
      config,
      logger,
    );
    return;
  }
  if (wallets.length === 0) {
    await sendTelegramMessage(
      chatId,
      `❌ <code>${escapeHtml(path.basename(target))}</code> is empty. ` +
        "Run /scan first, or use /export full.",
      config,
      logger,
    );
    return;
  }

  const label = target === newPath ? "🆕 GMGN new" : "📋 GMGN full";
  const caption =
    `${label}: ${wallets.length} wallet(s)\n` +
    "Import: https://gmgn.ai/follow -> Batch import";
  const ok = await sendTelegramDocument(chatId, target, {
    caption,
    config,
    logger,
  });
  if (!ok) {
    await sendTelegramMessage(
      chatId,
      "❌ Failed to send the GMGN file. Check the bot logs.",
      config,
      logger,
    );
  }
}

async function handleExportTxt({ chatId, config, logger }) {
  const lastScan = readLastScan(config);
  if (!lastScan) {
    await sendTelegramMessage(
      chatId,
      "❌ No scan result yet. Run /scan first.",
      config,
      logger,
    );
    return;
  }

  const candidates = Array.isArray(lastScan.candidates)
    ? lastScan.candidates
    : [];
  const result = writeSmartWalletText(candidates, config, {
    source: "data/last-scan.json",
  });

  if (result.count === 0) {
    await sendTelegramMessage(
      chatId,
      "❌ No smart wallets matched the export criteria. " +
        "Run /scan with a lower --min-score or adjust export.minScore.",
      config,
      logger,
    );
    return;
  }

  const caption =
    `📄 Smart wallets: ${result.count} wallet(s)\n` +
    "Sorted by score, best first.";
  const ok = await sendTelegramDocument(chatId, result.path, {
    caption,
    config,
    logger,
  });
  if (!ok) {
    await sendTelegramMessage(
      chatId,
      "❌ Failed to send the smart wallet text file. Check the bot logs.",
      config,
      logger,
    );
  }
}

async function handleExportTxtFull({ chatId, config, logger }) {
  const state = loadState(path.join(config.paths.dataDir, "state.json"));
  const wallets = Object.values(state.wallets || {});

  if (wallets.length === 0) {
    await sendTelegramMessage(
      chatId,
      "❌ No wallets recorded yet. Run /scan first.",
      config,
      logger,
    );
    return;
  }

  const result = writeAllWalletsText(wallets, config, {
    source: "data/state.json",
    scanAt: state.lastScanAt,
  });
  const caption =
    `📚 All wallets: ${result.count}\n` +
    "Sorted by tier (S best), then score. Nothing filtered.";
  const ok = await sendTelegramDocument(chatId, result.path, {
    caption,
    config,
    logger,
  });
  if (!ok) {
    await sendTelegramMessage(
      chatId,
      "❌ Failed to send the all-wallets text file. Check the bot logs.",
      config,
      logger,
    );
  }
}

export async function runBot(ctx) {
  const { config, configPath, logger } = ctx;
  const token = config.telegram?.botToken;

  if (!token) {
    throw new Error(
      "Telegram bot token is not configured. Set telegram.botToken in config.json " +
        "or export TELEGRAM_BOT_TOKEN.",
    );
  }

  const allowed = allowedChatIds(config);
  if (allowed.size === 0) {
    throw new Error(
      "No allowed Telegram chat IDs configured. Set telegram.allowedChatIds " +
        "(or TELEGRAM_CHAT_ID) to your numeric chat ID. Use @userinfobot in " +
        "Telegram if you do not know it.",
    );
  }

  let me;
  try {
    me = await getTelegramMe(config, logger);
  } catch (error) {
    throw new Error(
      `Telegram rejected the bot token: ${error.message}. Check telegram.botToken.`,
    );
  }

  const state = createBotState();
  let stopping = false;
  let pollController = null;

  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    logger.info("Telegram bot stopping...");
    pollController?.abort();
    if (state.child) stopScan(state, logger);
  };

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  let offset = loadOffset(config);
  if (offset === null) {
    // First start: skip commands sent while the bot was offline instead of
    // replaying a backlog of scans.
    offset = await latestOffset(config, logger);
    saveOffset(config, offset);
  }

  logger.info(
    `Telegram bot @${me?.username || "unknown"} online. ` +
      `Authorized chats: ${[...allowed].join(", ")}.`,
  );

  let backoffMs = 1000;

  while (!stopping) {
    pollController = new AbortController();
    let updates;

    try {
      updates = await getTelegramUpdates({
        config,
        offset,
        signal: pollController.signal,
        logger,
      });
      backoffMs = 1000;
    } catch (error) {
      if (stopping || error.name === "AbortError") break;
      if (isFatalTelegramError(error)) throw error;

      logger.warn(
        `Telegram polling failed: ${error.message}; retrying in ${backoffMs / 1000}s`,
      );
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
      continue;
    } finally {
      pollController = null;
    }

    for (const update of updates) {
      offset = Math.max(offset, Number(update.update_id || 0) + 1);
      saveOffset(config, offset);

      const message = update.message;
      const chatId = message?.chat?.id != null ? String(message.chat.id) : null;
      if (!message || !chatId || !message.text || message.from?.is_bot) continue;

      if (!allowed.has(chatId)) {
        logger.warn(
          `Ignoring Telegram command from unauthorized chat ${chatId}. ` +
            "Add it to telegram.allowedChatIds if this is you.",
        );
        continue;
      }

      const lastScan = readLastScan(config);
      const plan = commandPlan({
        text: message.text,
        state: { ...state, chatId },
        config,
        lastScan,
      });
      if (!plan) continue;

      if (plan.action?.type === "export") {
        await handleExport({
          chatId,
          mode: plan.action.mode,
          config,
          logger,
        });
        continue;
      }

      if (plan.action?.type === "exporttxt") {
        await handleExportTxt({ chatId, config, logger });
        continue;
      }

      if (plan.action?.type === "exporttxtfull") {
        await handleExportTxtFull({ chatId, config, logger });
        continue;
      }

      await sendTelegramMessage(chatId, plan.reply, config, logger);

      if (plan.action?.type === "scan") {
        startScan({
          state,
          config,
          configPath,
          scanArgs: plan.action.args,
          chatId,
          logger,
        });
      } else if (plan.action?.type === "stop") {
        stopScan(state, logger);
      }
    }
  }

  if (state.child) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          state.child?.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        resolve();
      }, 5000);
      state.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  process.removeListener("SIGINT", requestStop);
  process.removeListener("SIGTERM", requestStop);
  logger.info("Telegram bot stopped.");
  return state;
}
