export class HttpError extends Error {
  constructor(message, { status = 0, body = "", url = "", retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const hostSlots = new Map();

async function throttleHost(host, minIntervalMs) {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) return;
  const now = Date.now();
  const previous = hostSlots.get(host) || 0;
  const waitMs = Math.max(0, previous + minIntervalMs - now);
  hostSlots.set(host, now + waitMs);
  if (waitMs > 0) await sleep(waitMs);
}

function isRetryable(error) {
  if (error?.name === "AbortError") return true;
  if (error instanceof HttpError) {
    return (
      error.status === 0 ||
      error.status === 408 ||
      error.status === 409 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  const code = String(error?.cause?.code || error?.code || "");
  return ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(code);
}

/**
 * Fetch JSON with timeout, retries, per-host spacing and useful errors.
 */
export async function fetchJson(url, options = {}) {
  const {
    headers = {},
    timeoutMs = 25000,
    retries = 3,
    retryBaseMs = 600,
    minIntervalMs = 150,
    method = "GET",
    body,
  } = options;

  const host = new URL(url).host;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await throttleHost(host, minIntervalMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const finalHeaders = {
        accept: "application/json",
        "user-agent": "meteora-smart-wallet-finder/1.0",
        ...headers,
      };
      let finalBody = body;
      if (body !== undefined && typeof body !== "string") {
        finalHeaders["content-type"] = "application/json";
        finalBody = JSON.stringify(body);
      }

      const response = await fetch(url, {
        method,
        headers: finalHeaders,
        body: finalBody,
        signal: controller.signal,
      });
      const text = await response.text();

      if (!response.ok) {
        const retryAfter = Number(response.headers.get("retry-after") || 0);
        throw new HttpError(
          `HTTP ${response.status} for ${url}: ${text.slice(0, 300)}`,
          {
            status: response.status,
            body: text,
            url,
            retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 0,
          },
        );
      }

      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(`Invalid JSON from ${url}: ${text.slice(0, 200)}`, {
          status: response.status,
          body: text,
          url,
        });
      }
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryable(error)) break;
      const delay = error.retryAfterMs || Math.min(retryBaseMs * 2 ** attempt, 8000);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error(`Request failed: ${url}`);
}

/**
 * Run async tasks with bounded concurrency. Preserves input order.
 * A task that throws rejects the whole batch; callers should catch inside.
 */
export async function mapLimit(items, limit, fn) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) return;
      results[index] = await fn(list[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(Number(limit) || 1, list.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
