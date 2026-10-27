const MAX_MESSAGE_LENGTH = 3800;
const DEFAULT_API_BASE = "https://api.telegram.org";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function chunk(text, size = MAX_MESSAGE_LENGTH) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > size) {
    let cut = remaining.lastIndexOf("\n", size);
    if (cut <= 0) cut = size;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiBase(config) {
  return String(config.telegram?.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
}

/**
 * Low-level Telegram Bot API call. Handles timeouts, aborts, and one retry
 * when Telegram asks us to slow down (HTTP 429).
 */
export async function callTelegram(
  config,
  method,
  payload = {},
  { logger = null, timeoutMs = 15_000, signal = null } = {},
) {
  const token = config.telegram?.botToken;
  if (!token) throw new Error("Telegram bot token is not configured");

  const url = `${apiBase(config)}/bot${token}/${method}`;
  let waitMs = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (waitMs > 0) await sleep(waitMs);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));

      if (response.ok && body.ok) return body.result;

      if (response.status === 429 && attempt === 0) {
        waitMs = Math.min(10, Number(body.parameters?.retry_after ?? 1)) * 1000;
        logger?.warn(
          `Telegram rate limit hit on ${method}; retrying in ${waitMs / 1000}s`,
        );
        continue;
      }

      const description = body.description || response.statusText || "unknown error";
      throw new Error(
        `Telegram ${method} failed (HTTP ${response.status}): ${description}`,
      );
    } catch (error) {
      if (error.name === "AbortError") {
        if (signal?.aborted) throw error;
        throw new Error(`Telegram ${method} timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  throw new Error(`Telegram ${method} failed after retry`);
}

export async function getTelegramMe(config, logger = null) {
  return callTelegram(config, "getMe", {}, { logger });
}

/**
 * Fetch new updates with long polling. Returns an array of update objects.
 */
export async function getTelegramUpdates({
  config,
  offset = 0,
  timeoutSeconds = null,
  limit = 100,
  signal = null,
  logger = null,
}) {
  const pollSeconds = Math.max(
    0,
    Number(timeoutSeconds ?? config.telegram?.pollTimeoutSeconds ?? 30),
  );
  const result = await callTelegram(
    config,
    "getUpdates",
    {
      offset,
      limit,
      timeout: pollSeconds,
      allowed_updates: ["message"],
    },
    {
      logger,
      signal,
      timeoutMs: (pollSeconds + 15) * 1000,
    },
  );
  return Array.isArray(result) ? result : [];
}

/**
 * Send a message to a specific chat. Returns false instead of throwing so
 * notification failures never break a scan.
 */
export async function sendTelegramMessage(chatId, text, config, logger = null) {
  const token = config.telegram?.botToken;
  if (!token || !chatId) {
    logger?.debug("Telegram not configured; skipping message.");
    return false;
  }

  let ok = true;
  for (const part of chunk(text)) {
    try {
      await callTelegram(
        config,
        "sendMessage",
        {
          chat_id: chatId,
          text: part,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        },
        { logger },
      );
    } catch (error) {
      logger?.warn(`Telegram send failed: ${error.message}`);
      ok = false;
    }
  }
  return ok;
}

export async function sendTelegram(text, config, logger = null) {
  return sendTelegramMessage(config.telegram?.chatId, text, config, logger);
}

export function formatCandidateAlert(candidates) {
  const lines = ["🆕 <b>Smart wallet candidate</b>", ""];
  for (const candidate of candidates.slice(0, 5)) {
    const metrics = candidate.metrics;
    lines.push(
      `<b>${candidate.score.score}</b> (${candidate.score.tier}) · ` +
        `${metrics.n} closed · win ${metrics.winRatePct}%`,
    );
    lines.push(`<code>${candidate.address}</code>`);
    lines.push(
      `fee ${metrics.feeYieldPct}% · ROI ${metrics.netRoiPct}% · PF ${metrics.profitFactor}`,
    );
    lines.push(
      `hold ${metrics.avgHoldHours}h · range ${metrics.medianWidthBins} bins · ` +
        `${metrics.poolCount} pool(s)`,
    );
    if (candidate.score.warnings.length > 0) {
      lines.push(`⚠️ ${escapeHtml(candidate.score.warnings.slice(0, 3).join(", "))}`);
    }
    lines.push("");
  }
  lines.push("<i>Read-only research. Verify manually before adding.</i>");
  return lines.join("\n");
}
