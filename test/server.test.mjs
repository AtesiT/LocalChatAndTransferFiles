import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createChatServer } from "../server.mjs";

async function setup(t) {
  const server = createChatServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, data, token, extraHeaders = {}) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(data),
    });
    return { status: response.status, ...(await response.json()) };
  };
  t.after(async () => {
    server.stop();
    server.closeAllConnections();
    if (server.listening) await once(server, "close");
  });
  return { base, post };
}

async function events(base, token, t) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events?token=${token}`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queued = [];
  const waiting = [];
  let stopped = false;
  const pump = async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!type || !data) continue;
          const item = { type, data: JSON.parse(data) };
          const index = waiting.findIndex((waiter) => waiter.type === type);
          if (index >= 0) waiting.splice(index, 1)[0].resolve(item.data);
          else queued.push(item);
        }
      }
    } catch (error) {
      if (!stopped) throw error;
    }
  };
  const running = pump();
  const close = () => {
    stopped = true;
    controller.abort();
  };
  t.after(async () => {
    close();
    await running;
  });
  return {
    close,
    async next(type) {
      const index = queued.findIndex((item) => item.type === type);
      if (index >= 0) return queued.splice(index, 1)[0].data;
      let timer;
      try {
        return await Promise.race([
          new Promise((resolve) => waiting.push({ type, resolve })),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out waiting for ${type}`)),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

test("serves the offline frontend, security headers and no arbitrary files", async (t) => {
  const { base } = await setup(t);
  for (const path of ["/", "/app.js", "/styles.css"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok(response.headers.get("content-security-policy"));
  }
  assert.equal((await fetch(base + "/server.mjs")).status, 404);
  assert.equal((await fetch(base + "/.git/config")).status, 404);
  assert.equal((await fetch(base + "/api/events?token=invalid")).status, 401);
  assert.equal((await fetch(base + "/", { method: "HEAD" })).status, 200);
});

test("validates names, messages, authentication, JSON and origin", async (t) => {
  const { base, post } = await setup(t);
  assert.equal((await post("/api/session", { name: "   " })).status, 400);
  assert.equal(
    (await post("/api/session", { name: "a".repeat(25) })).status,
    400,
  );
  assert.equal(
    (await post("/api/session", { name: "bad\u0000name" })).status,
    400,
  );
  assert.equal(
    (
      await post("/api/session", { name: "Alex" }, null, {
        Origin: "http://evil.example",
      })
    ).status,
    403,
  );
  const alex = await post("/api/session", { name: "  Alex   Doe  " });
  assert.equal(alex.status, 201);
  assert.equal(alex.user.name, "Alex Doe");
  assert.equal((await post("/api/messages", { text: "hello" })).status, 401);
  assert.equal(
    (await post("/api/messages", { text: " " }, alex.token)).status,
    400,
  );
  assert.equal(
    (await post("/api/messages", { text: "x".repeat(2001) }, alex.token))
      .status,
    400,
  );
  assert.equal(
    (await post("/api/messages", { text: "😀".repeat(2000) }, alex.token))
      .status,
    201,
  );
  assert.equal(
    (await post("/api/messages", { text: "hello" }, alex.token)).message.name,
    "Alex Doe",
  );
  assert.equal(
    (
      await fetch(base + "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(base + "/api/session", { method: "POST", body: "{}" })).status,
    415,
  );
});

test("broadcasts chat and presence, deduplicates tabs, replays history on reconnect", async (t) => {
  const { base, post } = await setup(t);
  const alex = await post("/api/session", { name: "Alex" });
  const sam = await post("/api/session", { name: "Sam" });
  const a = await events(base, alex.token, t);
  const ready = await a.next("ready");
  assert.equal(ready.messages.length, 0);
  assert.deepEqual(ready.users, [alex.user]);
  await a.next("presence");
  const b = await events(base, sam.token, t);
  assert.equal((await b.next("ready")).users.length, 2);
  assert.equal((await a.next("presence")).length, 2);
  const secondTab = await events(base, alex.token, t);
  assert.equal((await secondTab.next("ready")).users.length, 2);
  await a.next("presence");
  const result = await post(
    "/api/messages",
    { text: '<script>alert("test")</script>\nHello, room!' },
    alex.token,
  );
  assert.equal(result.status, 201);
  assert.deepEqual(await a.next("message"), result.message);
  assert.deepEqual(await b.next("message"), result.message);
  assert.equal(result.message.userId, alex.user.id);
  secondTab.close();
  assert.equal((await a.next("presence")).length, 2);
  a.close();
  const c = await events(base, alex.token, t);
  assert.deepEqual((await c.next("ready")).messages, [result.message]);
  c.close();
  // Presence may first report the reconnect, then the disconnect.
  let users;
  do {
    users = await b.next("presence");
  } while (users.some((person) => person.id === alex.user.id));
  assert.deepEqual(users, [sam.user]);
});

test("limits message flooding and retains only the latest 100 messages", async (t) => {
  const { base, post } = await setup(t);
  let last;
  for (let userIndex = 0; userIndex < 9; userIndex++) {
    last = await post("/api/session", { name: `User ${userIndex}` });
    for (let i = 0; i < 12; i++)
      assert.equal(
        (await post("/api/messages", { text: `${userIndex}-${i}` }, last.token))
          .status,
        201,
      );
    assert.equal(
      (await post("/api/messages", { text: "Too fast" }, last.token)).status,
      429,
    );
  }
  const stream = await events(base, last.token, t);
  const { messages } = await stream.next("ready");
  assert.equal(messages.length, 100);
  assert.equal(messages[0].text, "0-8");
  assert.equal(messages.at(-1).text, "8-11");
});

test("throttles repeated session creation", async (t) => {
  const { post } = await setup(t);
  for (let i = 0; i < 30; i++)
    assert.equal((await post("/api/session", { name: "Alex" })).status, 201);
  assert.equal((await post("/api/session", { name: "Alex" })).status, 429);
});

test("checks session validity and rejects oversized request bodies", async (t) => {
  const { base, post } = await setup(t);
  assert.equal((await fetch(base + "/api/session")).status, 401);
  const joined = await post("/api/session", { name: "Alex" });
  const response = await fetch(base + "/api/session", {
    headers: { Authorization: `Bearer ${joined.token}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).user, joined.user);
  assert.equal(
    (await post("/api/messages", { text: "x".repeat(20000) }, joined.token))
      .status,
    413,
  );
  assert.equal(
    (await post("/api/messages", { text: "Still working" }, joined.token))
      .status,
    201,
  );
});

test("preserves UTF-8 characters split across incoming network packets", async (t) => {
  const { base } = await setup(t);
  const payload = Buffer.from(JSON.stringify({ name: "Я😀" }));
  const split = payload.indexOf(Buffer.from("😀")) + 1;
  const result = await new Promise((resolve, reject) => {
    const request = http.request(
      base + "/api/session",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            ...JSON.parse(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      },
    );
    request.on("error", reject);
    request.write(payload.subarray(0, split));
    setTimeout(() => request.end(payload.subarray(split)), 10);
  });
  assert.equal(result.status, 201);
  assert.equal(result.user.name, "Я😀");
});
