const MAX_MESSAGE_LENGTH = 3800;

function escapeHtml(value) {
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

export async function sendTelegram(text, config, logger = null) {
  const token = config.telegram?.botToken;
  const chatId = config.telegram?.chatId;
  if (!token || !chatId) {
    logger?.debug("Telegram not configured; skipping alert.");
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  let ok = true;
  for (const part of chunk(text)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: part,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        logger?.warn(`Telegram send failed: HTTP ${response.status} ${body.slice(0, 200)}`);
        ok = false;
      }
    } catch (error) {
      logger?.warn(`Telegram send failed: ${error.message}`);
      ok = false;
    } finally {
      clearTimeout(timer);
    }
  }
  return ok;
}
