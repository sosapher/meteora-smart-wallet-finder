import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  callTelegram,
  getTelegramMe,
  getTelegramUpdates,
  sendTelegramDocument,
  sendTelegramMessage,
} from "../src/telegram.js";

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const contentType = String(request.headers["content-type"] || "");
        const payload = contentType.includes("application/json")
          ? body
            ? JSON.parse(body)
            : {}
          : { rawBody: body, contentType };
        const result = handler(request.url, payload);
        if (result.status && result.status !== 200) {
          response.writeHead(result.status, { "content-type": "application/json" });
        } else {
          response.writeHead(200, { "content-type": "application/json" });
        }
        response.end(JSON.stringify(result.body ?? { ok: true, result: true }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function makeConfig(base, token = "test-token") {
  return {
    telegram: {
      botToken: token,
      apiBase: base,
      pollTimeoutSeconds: 1,
    },
  };
}

test("Telegram client calls getMe, getUpdates, and sendMessage", async (t) => {
  const calls = [];
  const { server, base } = await startServer((url, payload) => {
    calls.push({ url, payload });
    if (url.endsWith("/getMe")) {
      return { body: { ok: true, result: { username: "test_bot" } } };
    }
    if (url.endsWith("/getUpdates")) {
      return {
        body: {
          ok: true,
          result: [
            {
              update_id: 7,
              message: { chat: { id: 42 }, text: "/status" },
            },
          ],
        },
      };
    }
    return { body: { ok: true, result: { message_id: 1 } } };
  });
  t.after(() => server.close());

  const config = makeConfig(base);

  const me = await getTelegramMe(config);
  assert.equal(me.username, "test_bot");

  const updates = await getTelegramUpdates({
    config,
    offset: 5,
    timeoutSeconds: 1,
  });
  assert.equal(updates[0].update_id, 7);
  const pollCall = calls.find((call) => call.url.endsWith("/getUpdates"));
  assert.equal(pollCall.payload.offset, 5);

  const sent = await sendTelegramMessage("42", "<b>hello</b>", config);
  assert.equal(sent, true);
  const sendCall = calls.find((call) => call.url.endsWith("/sendMessage"));
  assert.equal(sendCall.payload.chat_id, "42");
  assert.match(sendCall.payload.text, /hello/);
});

test("Telegram client retries once after HTTP 429", async (t) => {
  let attempts = 0;
  const { server, base } = await startServer(() => {
    attempts += 1;
    if (attempts === 1) {
      return {
        status: 429,
        body: {
          ok: false,
          description: "Too Many Requests",
          parameters: { retry_after: 0 },
        },
      };
    }
    return { body: { ok: true, result: { message_id: 2 } } };
  });
  t.after(() => server.close());

  const result = await callTelegram(
    makeConfig(base),
    "sendMessage",
    { chat_id: "42", text: "retry" },
  );
  assert.equal(attempts, 2);
  assert.equal(result.message_id, 2);
});

test("Telegram client reports API errors without leaking the token", async (t) => {
  const { server, base } = await startServer(() => ({
    status: 401,
    body: { ok: false, description: "Unauthorized" },
  }));
  t.after(() => server.close());

  await assert.rejects(
    () => callTelegram(makeConfig(base), "getMe"),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /test-token/);
      return true;
    },
  );
});

test("Telegram client sends a local file as a multipart document", async (t) => {
  const calls = [];
  const { server, base } = await startServer((url, payload) => {
    calls.push({ url, payload });
    return { body: { ok: true, result: { message_id: 9 } } };
  });
  t.after(() => server.close());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swf-telegram-"));
  const file = path.join(dir, "gmgn-follow.json");
  const wallets = [{ address: "wallet-1", name: "meteora-1", emoji: "⭐" }];
  fs.writeFileSync(file, JSON.stringify(wallets, null, 2));

  const ok = await sendTelegramDocument("42", file, {
    caption: "GMGN: 1 wallet(s)",
    config: makeConfig(base),
  });

  assert.equal(ok, true);
  const call = calls.find((entry) => entry.url.endsWith("/sendDocument"));
  assert.ok(call);
  assert.match(call.payload.contentType, /multipart\/form-data/);
  assert.match(call.payload.rawBody, /name="chat_id"/);
  assert.match(call.payload.rawBody, /42/);
  assert.match(call.payload.rawBody, /name="caption"/);
  assert.match(call.payload.rawBody, /GMGN: 1 wallet/);
  assert.match(call.payload.rawBody, /filename="gmgn-follow.json"/);
  assert.match(call.payload.rawBody, /wallet-1/);
});
