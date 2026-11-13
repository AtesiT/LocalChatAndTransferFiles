import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createChatServer } from "../server.mjs";

async function setup(t, limits) {
  const server = createChatServer(limits);
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

async function upload(base, token, name, data, headers = {}) {
  const response = await fetch(base + "/api/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-File-Name": encodeURIComponent(name),
      ...headers,
    },
    body: data,
  });
  return { status: response.status, ...(await response.json()) };
}

test("shares binary attachments via live chat, history and authenticated downloads", async (t) => {
  const { base, post } = await setup(t);
  const alice = await post("/api/session", { name: "Alice" });
  const bob = await post("/api/session", { name: "Bob" });
  const receiver = await events(base, bob.token, t);
  await receiver.next("ready");
  const bytes = Buffer.from([0, 255, 1, 13, 10, 128, 42]);
  const name = 'проект 😀 "notes".bin';
  const result = await upload(base, alice.token, name, bytes);
  assert.equal(result.status, 201);
  assert.equal(result.attachment.name, name);
  assert.equal(result.attachment.size, bytes.length);
  assert.equal("data" in result.attachment, false);
  const path = `/api/files/${result.attachment.id}`;
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal(
    (await fetch(base + path + `?token=${bob.token}`)).status,
    404,
    "pending uploads are private",
  );
  assert.equal(
    (
      await post(
        "/api/messages",
        { attachmentId: result.attachment.id },
        bob.token,
      )
    ).status,
    400,
  );
  const sent = await post(
    "/api/messages",
    { text: "Binary test", attachmentId: result.attachment.id },
    alice.token,
  );
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.message.attachment, result.attachment);
  assert.deepEqual(await receiver.next("message"), sent.message);
  assert.equal(
    (
      await post(
        "/api/messages",
        { attachmentId: result.attachment.id },
        alice.token,
      )
    ).status,
    400,
    "attachments cannot be reused",
  );
  const download = await fetch(base + path + `?token=${bob.token}`);
  assert.equal(download.status, 200);
  assert.equal(
    download.headers.get("content-type"),
    "application/octet-stream",
  );
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.match(download.headers.get("content-security-policy"), /sandbox/);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  assert.ok(download.headers.get("content-disposition").includes("UTF-8''"));
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  const head = await fetch(base + path, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const replay = await events(base, alice.token, t);
  assert.deepEqual((await replay.next("ready")).messages, [sent.message]);
  assert.equal(
    (await fetch(base + "/api/files/../../server.mjs?token=" + bob.token))
      .status,
    404,
  );
});

test("accepts attachment-only and empty-file messages; sanitizes file names", async (t) => {
  const { base, post } = await setup(t);
  const alice = await post("/api/session", { name: "Alice" });
  const file = await upload(
    base,
    alice.token,
    "../folder\\<img onerror=alert(1)>\r\n.html",
    Buffer.alloc(0),
  );
  assert.equal(file.status, 201);
  assert.equal(file.attachment.name, "<img onerror=alert(1)>__.html");
  const sent = await post(
    "/api/messages",
    { attachmentId: file.attachment.id },
    alice.token,
  );
  assert.equal(sent.status, 201);
  assert.equal(sent.message.text, "");
  const download = await fetch(
    `${base}/api/files/${file.attachment.id}?token=${alice.token}`,
  );
  assert.equal(download.status, 200);
  assert.equal((await download.arrayBuffer()).byteLength, 0);
  assert.equal(
    (await post("/api/messages", { attachmentId: {} }, alice.token)).status,
    400,
  );
  assert.equal(
    (await post("/api/messages", { attachmentId: "missing" }, alice.token))
      .status,
    400,
  );
});

test("enforces upload validation, origin, per-file size and upload rate limits", async (t) => {
  const { base, post } = await setup(t, { maxFileSize: 8 });
  const alice = await post("/api/session", { name: "Alice" });
  assert.equal((await upload(base, null, "a", "a")).status, 401);
  assert.equal(
    (
      await upload(base, alice.token, "a", "a", {
        Origin: "http://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await upload(base, alice.token, "a", "a", { "Content-Type": "text/html" }))
      .status,
    415,
  );
  assert.equal((await upload(base, alice.token, "", "a")).status, 400);
  assert.equal(
    (await upload(base, alice.token, "a".repeat(181), "a")).status,
    400,
  );
  assert.equal(
    (await upload(base, alice.token, "a", "a", { "X-File-Name": "%ZZ" }))
      .status,
    400,
  );
  assert.equal(
    (await upload(base, alice.token, "big", "123456789")).status,
    413,
  );
  assert.equal(
    (await upload(base, alice.token, "small", "12345678")).status,
    201,
  );
  assert.equal((await upload(base, alice.token, "small", "1")).status, 201);
  assert.equal((await upload(base, alice.token, "small", "1")).status, 429);
});

test("reclaims file storage when an attachment's message leaves history", async (t) => {
  const { base, post } = await setup(t, { maxFileSize: 8, maxStorageSize: 8 });
  const alice = await post("/api/session", { name: "Alice" });
  const first = await upload(base, alice.token, "first.bin", Buffer.alloc(8));
  assert.equal(first.status, 201);
  assert.equal(
    (
      await post(
        "/api/messages",
        { attachmentId: first.attachment.id },
        alice.token,
      )
    ).status,
    201,
  );
  assert.equal(
    (await upload(base, alice.token, "full.bin", Buffer.alloc(1))).status,
    507,
  );
  for (let i = 0; i < 10; i++) {
    const filler = await post("/api/session", { name: `Filler ${i}` });
    for (let j = 0; j < 10; j++)
      assert.equal(
        (await post("/api/messages", { text: `${i}-${j}` }, filler.token))
          .status,
        201,
      );
  }
  assert.equal(
    (
      await fetch(
        `${base}/api/files/${first.attachment.id}?token=${alice.token}`,
      )
    ).status,
    404,
  );
  assert.equal(
    (await upload(base, alice.token, "new.bin", Buffer.alloc(8))).status,
    201,
  );
});

test("rejects oversized chunked uploads and remains usable afterward", async (t) => {
  const { base, post } = await setup(t, { maxFileSize: 8 });
  const alice = await post("/api/session", { name: "Alice" });
  const status = await new Promise((resolve, reject) => {
    const request = http.request(
      base + "/api/files",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/octet-stream",
          "X-File-Name": "chunked.bin",
          "Transfer-Encoding": "chunked",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.write("1234");
    request.end("56789");
  });
  assert.equal(status, 413);
  assert.equal(
    (await upload(base, alice.token, "valid.bin", "12345678")).status,
    201,
  );
});

test("creates public/protected rooms and validates room entry grants", async (t) => {
  const { base, post } = await setup(t);
  assert.equal((await fetch(base + "/api/rooms")).status, 401);
  assert.equal(
    (await post("/api/rooms", { name: "secret", password: "test-password" }))
      .status,
    401,
  );
  const alice = await post("/api/session", { name: "Alice" });
  const secret = await post(
    "/api/rooms",
    { name: "secret", password: "test-password" },
    alice.token,
  );
  assert.equal(secret.status, 201);
  assert.deepEqual(secret.room, { name: "secret", protected: true });
  assert.equal(secret.user.name, "Alice");
  assert.equal(
    (await post("/api/session", { name: "Bob", room: "secret" })).status,
    403,
  );
  assert.equal(
    (
      await post(
        "/api/session",
        { name: "Bob", room: "secret", password: "wrong" },
        alice.token,
      )
    ).status,
    403,
  );
  const bob = await post("/api/session", {
    name: "Bob",
    room: "secret",
    password: "test-password",
  });
  assert.equal(bob.status, 201);
  const renamed = await post(
    "/api/session",
    { name: "Robert", room: "secret" },
    bob.token,
  );
  assert.equal(
    renamed.status,
    201,
    "an existing room grant permits nickname changes without re-entering the password",
  );
  const open = await post("/api/rooms", { name: "open" }, alice.token);
  assert.equal(open.status, 201);
  assert.deepEqual(open.room, { name: "open", protected: false });
  assert.equal(
    (await post("/api/session", { name: "Carol", room: "open" })).status,
    201,
  );
  assert.equal(
    (await post("/api/session", { name: "Carol", room: "missing" })).status,
    404,
  );
  assert.equal(
    (await post("/api/session", { name: "Carol", room: "../secret" })).status,
    400,
  );
  assert.equal(
    (await post("/api/rooms", { name: "secret" }, alice.token)).status,
    409,
  );
  const listing = await fetch(base + "/api/rooms", {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  assert.deepEqual(await listing.json(), {
    rooms: [
      { name: "general", protected: false },
      { name: "secret", protected: true },
      { name: "open", protected: false },
    ],
  });
  const info = await fetch(base + "/api/session", {
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  assert.deepEqual((await info.json()).room, bob.room);
});

test("isolates live messages, history, presence and file downloads between rooms", async (t) => {
  const { base, post } = await setup(t);
  const publicUser = await post("/api/session", { name: "Public" });
  const creator = await post(
    "/api/rooms",
    { name: "private", password: "test-password" },
    publicUser.token,
  );
  const member = await post("/api/session", {
    name: "Member",
    room: "private",
    password: "test-password",
  });
  const pub = await events(base, publicUser.token, t);
  assert.deepEqual((await pub.next("ready")).users, [publicUser.user]);
  const priv = await events(base, creator.token, t);
  assert.deepEqual((await priv.next("ready")).users, [creator.user]);
  const peer = await events(base, member.token, t);
  assert.deepEqual((await peer.next("ready")).users, [
    creator.user,
    member.user,
  ]);
  const file = await upload(
    base,
    creator.token,
    "private.txt",
    "Private file contents",
  );
  const privateMessage = await post(
    "/api/messages",
    { text: "private message", attachmentId: file.attachment.id },
    creator.token,
  );
  assert.equal(privateMessage.status, 201);
  assert.deepEqual(await priv.next("message"), privateMessage.message);
  assert.deepEqual(await peer.next("message"), privateMessage.message);
  const publicMessage = await post(
    "/api/messages",
    { text: "public message", room: "private" },
    publicUser.token,
  );
  assert.deepEqual(
    await pub.next("message"),
    publicMessage.message,
    "private broadcasts do not reach the public stream; body fields cannot change room grants",
  );
  const secondPrivate = await post(
    "/api/messages",
    { text: "another private message" },
    member.token,
  );
  assert.deepEqual(
    await priv.next("message"),
    secondPrivate.message,
    "public broadcasts do not reach private streams",
  );
  const filePath = `${base}/api/files/${file.attachment.id}`;
  assert.equal(
    (await fetch(filePath + `?token=${publicUser.token}`)).status,
    404,
  );
  assert.equal(
    (await fetch(filePath + `?token=${publicUser.token}`, { method: "HEAD" }))
      .status,
    404,
  );
  const download = await fetch(filePath + `?token=${member.token}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "Private file contents");
  const pending = await upload(base, creator.token, "pending.txt", "pending");
  assert.equal(
    (
      await post(
        "/api/messages",
        { attachmentId: pending.attachment.id },
        publicUser.token,
      )
    ).status,
    400,
  );
  const publicReplay = await events(base, publicUser.token, t);
  assert.deepEqual((await publicReplay.next("ready")).messages, [
    publicMessage.message,
  ]);
  const privateReplay = await events(base, member.token, t);
  assert.deepEqual((await privateReplay.next("ready")).messages, [
    privateMessage.message,
    secondPrivate.message,
  ]);
});

test("public history eviction cannot remove private-room messages or files", async (t) => {
  const { base, post } = await setup(t);
  const publicUser = await post("/api/session", { name: "Public" });
  const creator = await post(
    "/api/rooms",
    { name: "private", password: "test-password" },
    publicUser.token,
  );
  const file = await upload(base, creator.token, "kept.txt", "Keep me");
  const privateMessage = await post(
    "/api/messages",
    { attachmentId: file.attachment.id },
    creator.token,
  );
  for (let i = 0; i < 10; i++) {
    const filler = await post("/api/session", { name: `Filler ${i}` });
    for (let j = 0; j < 10; j++)
      assert.equal(
        (await post("/api/messages", { text: `${i}-${j}` }, filler.token))
          .status,
        201,
      );
  }
  const replay = await events(base, creator.token, t);
  assert.deepEqual((await replay.next("ready")).messages, [
    privateMessage.message,
  ]);
  assert.equal(
    (
      await fetch(
        `${base}/api/files/${file.attachment.id}?token=${creator.token}`,
      )
    ).status,
    200,
  );
});

test("throttles password guessing and room creation", async (t) => {
  const { post } = await setup(t);
  const user = await post("/api/session", { name: "User" });
  assert.equal(
    (
      await post(
        "/api/rooms",
        { name: "secret", password: "test-password" },
        user.token,
      )
    ).status,
    201,
  );
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await post("/api/session", {
          name: "Guest",
          room: "secret",
          password: "wrong",
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await post("/api/session", {
        name: "Guest",
        room: "secret",
        password: "test-password",
      })
    ).status,
    429,
  );
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await post("/api/rooms", { name: `open-${i}` }, user.token)).status,
      201,
    );
  assert.equal(
    (await post("/api/rooms", { name: "too-many" }, user.token)).status,
    429,
  );
});
