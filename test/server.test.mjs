import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createChatServer } from "../server.mjs";

async function setup(t, limits, options) {
  const server = createChatServer(limits, options);
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
  return { base, post, server };
}

async function events(base, token, t, path = `/api/events?token=${token}`) {
  const controller = new AbortController();
  const response = await fetch(base + path, {
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
    assert.equal(
      (await post("/api/session", { name: `Alex ${i}` })).status,
      201,
    );
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
  assert.equal((await fetch(base + "/api/rooms")).status, 200);
  assert.equal(
    (await post("/api/rooms", { name: "secret", password: "test-password" }))
      .status,
    400,
  );
  const alice = await post("/api/session", { name: "Alice" });
  const secret = await post(
    "/api/rooms",
    { name: "secret", password: "test-password" },
    alice.token,
  );
  assert.equal(secret.status, 201);
  assert.deepEqual(secret.room, {
    id: secret.room.id,
    name: "secret",
    protected: true,
    isOwner: true,
  });
  assert.equal(secret.user.name, "Alice");
  assert.equal(
    (await post("/api/session", { name: "Bob", room: "secret" })).status,
    403,
  );
  assert.equal(
    (
      await post("/api/session", {
        name: "Bob",
        room: "secret",
        password: "wrong",
      })
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
  assert.deepEqual(open.room, {
    id: open.room.id,
    name: "open",
    protected: false,
    isOwner: true,
  });
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
      { id: alice.room.id, name: "general", protected: false, count: 0 },
      { id: secret.room.id, name: "secret", protected: true, count: 0 },
      { id: open.room.id, name: "open", protected: false, count: 0 },
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

test("room listings are available before login, carry live counts, and deduplicate tabs", async (t) => {
  const { base, post } = await setup(t);
  const catalog = await events(base, null, t, "/api/rooms/events");
  const initial = await catalog.next("rooms");
  assert.equal(initial.rooms[0].name, "general");
  assert.equal(initial.rooms[0].count, 0);
  const created = await post("/api/rooms", {
    name: "from-login",
    nickname: "Alice",
    password: "test-password",
  });
  assert.equal(created.status, 201);
  const added = await catalog.next("rooms");
  assert.equal(added.rooms.find((room) => room.name === "from-login").count, 0);
  const first = await events(base, created.token, t);
  await first.next("ready");
  assert.equal(
    (await catalog.next("rooms")).rooms.find(
      (room) => room.name === "from-login",
    ).count,
    1,
  );
  const tab = await events(base, created.token, t);
  await tab.next("ready");
  assert.equal(
    (await catalog.next("rooms")).rooms.find(
      (room) => room.name === "from-login",
    ).count,
    1,
  );
  first.close();
  assert.equal(
    (await catalog.next("rooms")).rooms.find(
      (room) => room.name === "from-login",
    ).count,
    1,
  );
  tab.close();
  assert.equal(
    (await catalog.next("rooms")).rooms.find(
      (room) => room.name === "from-login",
    ).count,
    0,
  );
});

test("empty rooms expire, revoke old tokens and files, and cannot be accessed after name reuse", async (t) => {
  const { base, post } = await setup(t, undefined, { roomGraceMs: 90 });
  const catalog = await events(base, null, t, "/api/rooms/events");
  await catalog.next("rooms");
  const created = await post("/api/rooms", {
    name: "ephemeral",
    nickname: "Alice",
  });
  const stream = await events(base, created.token, t);
  await stream.next("ready");
  const file = await upload(
    base,
    created.token,
    "private.bin",
    "private bytes",
  );
  assert.equal(
    (
      await post(
        "/api/messages",
        { attachmentId: file.attachment.id },
        created.token,
      )
    ).status,
    201,
  );
  stream.close();
  let snapshot;
  do {
    snapshot = await catalog.next("rooms");
  } while (snapshot.rooms.some((room) => room.name === "ephemeral"));
  assert.deepEqual(
    snapshot.rooms.map((room) => room.name),
    ["general"],
  );
  assert.equal(
    (
      await fetch(base + "/api/session", {
        headers: { Authorization: `Bearer ${created.token}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (await post("/api/messages", { text: "cannot resurrect" }, created.token))
      .status,
    401,
  );
  const replacement = await post("/api/rooms", {
    name: "ephemeral",
    nickname: "Bob",
  });
  assert.notEqual(replacement.room.id, created.room.id);
  assert.equal(
    (await fetch(`${base}/api/events?token=${created.token}`)).status,
    401,
  );
  assert.equal(
    (
      await post("/api/session", {
        name: "Alice",
        room: "ephemeral",
        roomId: created.room.id,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(
        `${base}/api/files/${file.attachment.id}?token=${replacement.token}`,
      )
    ).status,
    404,
  );
});

test("a reconnect within the empty-room grace period preserves history", async (t) => {
  const { base, post } = await setup(t, undefined, { roomGraceMs: 150 });
  const created = await post("/api/rooms", {
    name: "reconnect",
    nickname: "Alice",
  });
  const first = await events(base, created.token, t);
  await first.next("ready");
  const message = await post(
    "/api/messages",
    { text: "Keep history" },
    created.token,
  );
  first.close();
  const second = await events(base, created.token, t);
  assert.deepEqual((await second.next("ready")).messages, [message.message]);
  // Crossing the deletion deadline must not delete an occupied room.
  await new Promise((resolve) => setTimeout(resolve, 190));
  const list = await (await fetch(base + "/api/rooms")).json();
  assert.equal(list.rooms.find((room) => room.id === created.room.id).count, 1);
});

test("an in-flight upload cannot survive deletion or publish into a recreated room", async (t) => {
  const { base, post } = await setup(
    t,
    { maxFileSize: 8, maxStorageSize: 8 },
    { roomGraceMs: 100 },
  );
  const catalog = await events(base, null, t, "/api/rooms/events");
  await catalog.next("rooms");
  const created = await post("/api/rooms", {
    name: "upload-race",
    nickname: "Alice",
  });
  let request;
  const completed = new Promise((resolve, reject) => {
    request = http.request(
      base + "/api/files",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${created.token}`,
          "Content-Type": "application/octet-stream",
          "X-File-Name": "slow.bin",
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
  });
  let snapshot;
  do {
    snapshot = await catalog.next("rooms");
  } while (snapshot.rooms.some((room) => room.id === created.room.id));
  request.end("5678");
  assert.equal(await completed, 401);
  const replacement = await post("/api/rooms", {
    name: "upload-race",
    nickname: "Bob",
  });
  assert.equal(
    (await upload(base, replacement.token, "new.bin", "12345678")).status,
    201,
    "failed upload must release its bytes and reservations",
  );
});

test("reserves nicknames before room selection and rejects duplicates across entry APIs", async (t) => {
  const { base, post } = await setup(t);
  const alice = await post("/api/nickname", { name: "  Alice  " });
  assert.equal(alice.status, 201);
  assert.equal(alice.user.name, "Alice");
  for (const name of ["Alice", "ALICE", "Ａｌｉｃｅ"]) {
    const conflict = await post("/api/nickname", { name });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.code, "NICKNAME_TAKEN");
  }
  assert.equal((await post("/api/session", { name: "Alice" })).status, 409);
  assert.equal(
    (await post("/api/rooms", { name: "claimed", nickname: "Alice" })).status,
    409,
  );
  assert.equal(
    (await (await fetch(base + "/api/rooms")).json()).rooms.some(
      (room) => room.name === "claimed",
    ),
    false,
  );
  assert.equal(
    (
      await post(
        "/api/messages",
        { text: "cannot send from lobby" },
        alice.identityToken,
      )
    ).status,
    401,
  );
  assert.equal(
    (await upload(base, alice.identityToken, "file", "data")).status,
    401,
  );
  assert.equal(
    (await fetch(`${base}/api/events?token=${alice.identityToken}`)).status,
    401,
  );
  const joined = await post(
    "/api/session",
    { name: "Alice" },
    alice.identityToken,
  );
  assert.equal(joined.status, 201);
  assert.equal(joined.user.id, alice.user.id);
  const privateRoom = await post(
    "/api/rooms",
    { name: "private", password: "test-password" },
    alice.identityToken,
  );
  assert.equal(privateRoom.status, 201);
  assert.equal(privateRoom.user.id, alice.user.id);
  const aliceInOtherRoom = await post("/api/session", {
    name: "Alice",
    room: "private",
    password: "test-password",
  });
  assert.equal(aliceInOtherRoom.status, 409);
});

test("nickname claims are atomic and owner-authorized renames release the old name", async (t) => {
  const { base, post } = await setup(t);
  const results = await Promise.all([
    post("/api/nickname", { name: "Race" }),
    post("/api/nickname", { name: "race" }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const owner = results.find((result) => result.status === 201);
  const bob = await post("/api/session", { name: "Bob" });
  assert.equal(
    (await post("/api/nickname", { name: "Bob" }, owner.identityToken)).status,
    409,
  );
  assert.equal(
    (await post("/api/session", { name: "Bob" }, owner.identityToken)).status,
    409,
  );
  const joined = await post(
    "/api/session",
    { name: owner.user.name },
    owner.identityToken,
  );
  const a = await events(base, joined.token, t);
  await a.next("ready");
  const renamed = await post(
    "/api/session",
    { name: "New name" },
    joined.token,
  );
  assert.equal(renamed.status, 201);
  assert.equal(renamed.user.id, owner.user.id);
  assert.deepEqual(await a.next("profile"), renamed.user);
  const second = await events(base, renamed.token, t);
  assert.equal(
    (await second.next("ready")).users.length,
    1,
    "the same owner does not appear twice while replacing a room grant",
  );
  assert.equal(
    (await post("/api/nickname", { name: owner.user.name })).status,
    201,
  );
  assert.equal(
    (
      await fetch(base + "/api/nickname", {
        headers: { Authorization: `Bearer ${bob.identityToken}` },
      })
    ).status,
    200,
  );
});

test("unused nickname reservations expire without granting ownership to old credentials", async (t) => {
  const { base, post } = await setup(t, undefined, { nicknameGraceMs: 50 });
  const first = await post("/api/nickname", { name: "Temporary" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const replacement = await post("/api/nickname", { name: "temporary" });
  assert.equal(replacement.status, 201);
  assert.notEqual(replacement.user.id, first.user.id);
  assert.equal(
    (
      await fetch(base + "/api/nickname", {
        headers: { Authorization: `Bearer ${first.identityToken}` },
      })
    ).status,
    401,
  );
});

test("a connected participant keeps their nickname even before the next heartbeat", async (t) => {
  const { base, post } = await setup(t, undefined, { nicknameGraceMs: 50 });
  const alice = await post("/api/session", { name: "Alice" });
  const connection = await events(base, alice.token, t);
  await connection.next("ready");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal((await post("/api/nickname", { name: "alice" })).status, 409);
  assert.equal(
    (await post("/api/messages", { text: "Still here" }, alice.token)).status,
    201,
  );
});

async function resumableApi(base, token, method, id, data, headers = {}) {
  const response = await fetch(`${base}/api/uploads${id ? `/${id}` : ""}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    ...(data !== undefined ? { body: data } : {}),
  });
  return { status: response.status, ...(await response.json()) };
}
const declare = (
  base,
  token,
  name = "notes.txt",
  size = 8,
  clientId = "upload-request-123456",
) =>
  resumableApi(
    base,
    token,
    "POST",
    null,
    JSON.stringify({ name, size, clientId }),
    { "Content-Type": "application/json" },
  );
const appendChunk = (base, token, id, data, offset = 0, headers = {}) =>
  resumableApi(base, token, "PATCH", id, data, {
    "Content-Type": "application/octet-stream",
    "Upload-Offset": String(offset),
    ...headers,
  });

test("resumable upload API recovers lost responses, retains ownership across rename and publishes a batch once", async (t) => {
  const { base, post } = await setup(t, { chunkSize: 4 });
  const alice = await post("/api/session", { name: "Alice" });
  const bob = await post("/api/session", { name: "Bob" });
  const stream = await events(base, bob.token, t);
  await stream.next("ready");
  const first = await declare(base, alice.token);
  assert.equal(first.status, 201);
  const id = first.upload.id;
  assert.equal(
    (await appendChunk(base, alice.token, id, "abcd")).upload.offset,
    4,
  );
  assert.equal((await appendChunk(base, alice.token, id, "abcd")).status, 409);
  assert.equal((await declare(base, alice.token)).upload.id, id);
  assert.equal(
    (await resumableApi(base, alice.token, "GET", id)).upload.offset,
    4,
  );
  assert.equal((await resumableApi(base, bob.token, "GET", id)).status, 404);
  assert.equal((await appendChunk(base, bob.token, id, "efgh", 4)).status, 404);
  const renamed = await post(
    "/api/session",
    { name: "Alice2", room: "general" },
    alice.token,
  );
  assert.equal(
    (await appendChunk(base, renamed.token, id, "efgh", 4)).upload.complete,
    true,
  );
  assert.equal(
    (await resumableApi(base, renamed.token, "GET", id)).upload.offset,
    8,
  );
  const empty = await declare(
    base,
    renamed.token,
    "empty.txt",
    0,
    "empty-request-123456",
  );
  assert.equal(empty.upload.complete, true);
  const payload = {
    text: "two files",
    attachmentIds: [id, empty.upload.id],
    clientMessageId: "message-request-123456",
  };
  const published = await post("/api/messages", payload, renamed.token);
  assert.equal(published.status, 201);
  assert.equal(published.message.attachments.length, 2);
  assert.deepEqual(
    (await stream.next("message")).attachments,
    published.message.attachments,
  );
  assert.equal(
    (await post("/api/messages", payload, renamed.token)).message.id,
    published.message.id,
  );
  assert.equal(
    (
      await post(
        "/api/messages",
        { ...payload, text: "changed" },
        renamed.token,
      )
    ).status,
    409,
  );
  const download = await fetch(`${base}/api/files/${id}`, {
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  assert.equal(await download.text(), "abcdefgh");
  assert.equal(
    (await resumableApi(base, renamed.token, "DELETE", id)).status,
    409,
  );
});

test("upload cancellation is owner-only, frees capacity and rejects cross-origin writes", async (t) => {
  const { base, post } = await setup(t, { maxStorageSize: 8, chunkSize: 4 });
  const alice = await post("/api/session", { name: "Alice" });
  const bob = await post("/api/session", { name: "Bob" });
  const { upload } = await declare(base, alice.token);
  assert.equal(
    (
      await appendChunk(base, alice.token, upload.id, "abcd", 0, {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await resumableApi(base, alice.token, "DELETE", upload.id, undefined, {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await resumableApi(base, bob.token, "DELETE", upload.id)).status,
    404,
  );
  assert.equal((await declare(base, bob.token, "b.txt", 1)).status, 507);
  assert.equal(
    (await appendChunk(base, alice.token, upload.id, "abcd")).status,
    200,
  );
  assert.equal(
    (await resumableApi(base, alice.token, "DELETE", upload.id)).status,
    200,
  );
  assert.equal(
    (await resumableApi(base, alice.token, "GET", upload.id)).status,
    404,
  );
  assert.equal((await declare(base, bob.token)).status, 201);
});

test("batch publication validates every attachment atomically, count, duplicates and room grants", async (t) => {
  const { base, post } = await setup(t, { maxFilesPerMessage: 2 });
  const alice = await post("/api/session", { name: "Alice" });
  const otherRoom = await post(
    "/api/rooms",
    { name: "private", nickname: "Alice" },
    alice.token,
  );
  const bob = await post("/api/session", { name: "Bob" });
  const { upload } = await declare(base, alice.token, "empty", 0);
  const { upload: secret } = await declare(base, otherRoom.token, "secret", 0);
  assert.equal(
    (await resumableApi(base, otherRoom.token, "GET", upload.id)).status,
    404,
  );
  assert.equal(
    (await post("/api/messages", { attachmentIds: [upload.id] }, bob.token))
      .status,
    400,
  );
  for (const ids of [
    [upload.id, "missing"],
    [upload.id, upload.id],
    [upload.id, secret.id],
    ["a", "b", "c"],
    "wrong",
    [null],
  ]) {
    assert.equal(
      (await post("/api/messages", { attachmentIds: ids }, alice.token)).status,
      400,
    );
  }
  assert.equal(
    (
      await post(
        "/api/messages",
        { attachmentId: upload.id, attachmentIds: [] },
        alice.token,
      )
    ).status,
    400,
  );
  const published = await post(
    "/api/messages",
    { attachmentIds: [upload.id] },
    alice.token,
  );
  assert.equal(
    published.status,
    201,
    "invalid batches never consume a valid attachment",
  );
  assert.equal(published.message.attachments[0].size, 0);
});

test("batch attachment history eviction removes every file", async (t) => {
  const { base, post } = await setup(t);
  const alice = await post("/api/session", { name: "Alice" });
  const ids = [];
  for (let i = 0; i < 3; i++)
    ids.push(
      (
        await declare(
          base,
          alice.token,
          `${i}.txt`,
          0,
          `file-request-123456-${i}`,
        )
      ).upload.id,
    );
  await post("/api/messages", { attachmentIds: ids }, alice.token);
  // Rate limits apply per grant; the same identity may reconnect without losing ownership.
  for (let i = 0; i < 10; i++) {
    const session = await post(
      "/api/session",
      { name: "Alice", room: "general" },
      alice.token,
    );
    for (let j = 0; j < 10; j++)
      assert.equal(
        (await post("/api/messages", { text: `${i}-${j}` }, session.token))
          .status,
        201,
      );
  }
  for (const id of ids) {
    const response = await fetch(`${base}/api/files/${id}`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    assert.equal(response.status, 404);
    assert.equal(
      (await resumableApi(base, alice.token, "GET", id)).status,
      404,
    );
  }
});

test("deleting a room during a chunk releases its reservation and never revives the old generation", async (t) => {
  const { base, post } = await setup(
    t,
    { maxFileSize: 8, maxStorageSize: 8 },
    { roomGraceMs: 100 },
  );
  const catalog = await events(base, null, t, "/api/rooms/events");
  await catalog.next("rooms");
  const created = await post("/api/rooms", {
    name: "chunk-race",
    nickname: "Alice",
  });
  const { upload: pending } = await declare(base, created.token);
  let request;
  const completed = new Promise((resolve, reject) => {
    request = http.request(
      `${base}/api/uploads/${pending.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${created.token}`,
          "Content-Type": "application/octet-stream",
          "Upload-Offset": "0",
          "Content-Length": "8",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.write("abcd");
  });
  let snapshot;
  do {
    snapshot = await catalog.next("rooms");
  } while (snapshot.rooms.some((room) => room.id === created.room.id));
  request.end("efgh");
  assert.equal(await completed, 404);
  const replacement = await post("/api/rooms", {
    name: "chunk-race",
    nickname: "Bob",
  });
  assert.notEqual(replacement.room.id, created.room.id);
  assert.equal((await declare(base, replacement.token)).status, 201);
  assert.equal(
    (await resumableApi(base, replacement.token, "GET", pending.id)).status,
    404,
  );
});

test("retrying upload creation does not consume the new-upload throttle", async (t) => {
  const { base, post } = await setup(t);
  const alice = await post("/api/session", { name: "Alice" });
  let id;
  for (let i = 0; i < 35; i++) {
    const response = await declare(base, alice.token, "empty.txt", 0);
    assert.equal(response.status, 201);
    id ||= response.upload.id;
    assert.equal(response.upload.id, id);
  }
  for (let i = 1; i < 30; i++)
    assert.equal(
      (
        await declare(
          base,
          alice.token,
          "empty.txt",
          0,
          `different-request-${i}`,
        )
      ).status,
      201,
    );
  assert.equal(
    (await declare(base, alice.token, "empty.txt", 0, "one-too-many-123456"))
      .status,
    429,
  );
  assert.equal((await declare(base, alice.token, "empty.txt", 0)).status, 201);
  assert.equal(
    (await declare(base, alice.identityToken, "empty.txt", 0)).status,
    401,
  );
});

test("explicit logout immediately frees the nickname, revokes every grant, closes streams and updates counts", async (t) => {
  const { base, post } = await setup(t);
  const alice = await post("/api/session", { name: "Alice" });
  const bob = await post("/api/session", { name: "Bob" });
  const privateRoom = await post(
    "/api/rooms",
    { name: "logout-room" },
    alice.token,
  );
  const general = await events(base, alice.token, t);
  const duplicate = await events(base, alice.token, t);
  const privateStream = await events(base, privateRoom.token, t);
  for (const stream of [general, duplicate, privateStream])
    await stream.next("ready");
  const watcher = await events(base, bob.token, t);
  await watcher.next("ready");
  await watcher.next("presence");
  assert.equal(
    (
      await post("/api/logout", {}, alice.token, {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal((await post("/api/logout", {})).status, 401);
  assert.equal(
    (await post("/api/logout", {}, alice.identityToken)).status,
    200,
  );
  for (const stream of [general, duplicate, privateStream])
    assert.deepEqual(await stream.next("logged-out"), {});
  const presence = await watcher.next("presence");
  assert.deepEqual(
    presence.map((person) => person.name),
    ["Bob"],
  );
  const catalog = await (await fetch(base + "/api/rooms")).json();
  assert.equal(catalog.rooms.find((room) => room.name === "general").count, 1);
  assert.equal(
    catalog.rooms.find((room) => room.name === "logout-room").count,
    0,
  );
  for (const token of [alice.token, privateRoom.token, alice.identityToken]) {
    assert.equal(
      (
        await fetch(base + "/api/nickname", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (await post("/api/messages", { text: "revoked" }, token)).status,
      401,
    );
    assert.equal(
      (await fetch(base + `/api/events?token=${token}`)).status,
      401,
    );
  }
  const replacement = await post("/api/nickname", { name: "ALICE" });
  assert.equal(replacement.status, 201);
  assert.notEqual(replacement.user.id, alice.user.id);
  assert.equal((await post("/api/logout", {}, alice.token)).status, 401);
  assert.equal(
    (await post("/api/logout", {}, replacement.identityToken)).status,
    200,
    "roomless nickname can also be released",
  );
});

test("logout frees unpublished upload capacity but preserves published attachments for others", async (t) => {
  const { base, post } = await setup(t, { maxStorageSize: 12 });
  const alice = await post("/api/session", { name: "Alice" });
  const bob = await post("/api/session", { name: "Bob" });
  const published = await upload(base, alice.token, "shared.txt", "keep");
  await post(
    "/api/messages",
    { attachmentId: published.attachment.id },
    alice.token,
  );
  const pending = await declare(base, alice.token, "pending", 6);
  const legacy = await upload(base, alice.token, "legacy", "xx");
  assert.equal(legacy.status, 201);
  assert.equal((await declare(base, bob.token, "full", 1)).status, 507);
  assert.equal((await post("/api/logout", {}, alice.token)).status, 200);
  assert.equal((await declare(base, bob.token, "free", 8)).status, 201);
  assert.equal(
    (await resumableApi(base, alice.token, "GET", pending.upload.id)).status,
    401,
  );
  const download = await fetch(`${base}/api/files/${published.attachment.id}`, {
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "keep");
});

test("an authenticated request waiting for its body cannot reclaim a nickname after logout", async (t) => {
  const { base, post, server } = await setup(t);
  const alice = await post("/api/session", { name: "Alice" });
  const arrived = once(server, "request");
  let request;
  const completed = new Promise((resolve, reject) => {
    request = http.request(
      base + "/api/session",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.write('{"name":"Alice",');
  });
  // Wait until the server has authenticated the headers and is reading the body.
  await arrived;
  await new Promise((resolve) => request.write('"room":', resolve));
  assert.equal((await post("/api/logout", {}, alice.token)).status, 200);
  request.end('"general"}');
  assert.equal(await completed, 401);
  assert.equal((await post("/api/nickname", { name: "Alice" })).status, 201);
});

test("replies use a bounded server-authored snapshot and reject foreign-room or forged targets", async (t) => {
  const { base, post } = await setup(t);
  const alice = await post("/api/session", { name: "Alice" });
  const bob = await post("/api/session", { name: "Bob" });
  const bobStream = await events(base, bob.token, t);
  await bobStream.next("ready");
  const original = (
    await post("/api/messages", { text: "Original question" }, alice.token)
  ).message;
  const response = await post(
    "/api/messages",
    {
      text: "Answer",
      replyToId: original.id,
      replyTo: { name: "Forged", preview: "Forged" },
      clientMessageId: "reply-request-123456",
    },
    bob.token,
  );
  assert.equal(response.status, 201);
  assert.deepEqual(response.message.replyTo, {
    id: original.id,
    userId: alice.user.id,
    name: "Alice",
    preview: "Original question",
  });
  await bobStream.next("message"); // original
  assert.deepEqual(
    (await bobStream.next("message")).replyTo,
    response.message.replyTo,
  );
  const repeated = await post(
    "/api/messages",
    {
      text: "Answer",
      replyToId: original.id,
      clientMessageId: "reply-request-123456",
    },
    bob.token,
  );
  assert.equal(repeated.message.id, response.message.id);
  assert.equal(
    (
      await post(
        "/api/messages",
        {
          text: "Answer",
          replyToId: null,
          clientMessageId: "reply-request-123456",
        },
        bob.token,
      )
    ).status,
    409,
  );
  const room = await post("/api/rooms", { name: "reply-private" }, alice.token);
  const secret = (await post("/api/messages", { text: "Secret" }, room.token))
    .message;
  for (const id of [
    secret.id,
    "00000000-0000-0000-0000-000000000000",
    {},
    "invalid",
  ]) {
    const invalid = await post(
      "/api/messages",
      { text: "No", replyToId: id },
      bob.token,
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.message, undefined);
  }
  assert.equal(
    (
      await post(
        "/api/messages",
        { text: "", replyToId: original.id },
        bob.token,
      )
    ).status,
    400,
    "a quote is not an otherwise empty message",
  );
});

test("reply snapshots survive target eviction; retries deduplicate even when the original has expired", async (t) => {
  const { base, post } = await setup(t);
  const alice = await post("/api/session", { name: "Alice" });
  const original = (
    await post("/api/messages", { text: "😀".repeat(300) }, alice.token)
  ).message;
  const payload = {
    text: "Answer",
    replyToId: original.id,
    clientMessageId: "retained-reply-123456",
  };
  const reply = (await post("/api/messages", payload, alice.token)).message;
  assert.equal([...reply.replyTo.preview].length, 240);
  for (let i = 0; i < 9; i++) {
    const session = await post("/api/session", { name: "Alice" }, alice.token);
    for (let j = 0; j < 11; j++)
      assert.equal(
        (await post("/api/messages", { text: `fill ${i}-${j}` }, session.token))
          .status,
        201,
      );
  }
  assert.equal(
    (
      await post(
        "/api/messages",
        { text: "stale", replyToId: original.id },
        alice.token,
      )
    ).code,
    "REPLY_UNAVAILABLE",
  );
  assert.equal(
    (await post("/api/messages", payload, alice.token)).message.id,
    reply.id,
  );
  const history = await events(base, alice.token, t);
  const ready = await history.next("ready");
  assert.equal(
    ready.messages.some((message) => message.id === original.id),
    false,
  );
  assert.deepEqual(
    ready.messages.find((message) => message.id === reply.id).replyTo,
    reply.replyTo,
  );
});

test("file-only replies and attachment validation are atomic", async (t) => {
  const { base, post } = await setup(t);
  const alice = await post("/api/session", { name: "Alice" });
  const file = (await upload(base, alice.token, "original.txt", "data"))
    .attachment;
  const original = (
    await post("/api/messages", { attachmentId: file.id }, alice.token)
  ).message;
  const attachment = (await declare(base, alice.token, "answer.txt", 0)).upload;
  const invalid = await post(
    "/api/messages",
    {
      attachmentIds: [attachment.id],
      replyToId: "00000000-0000-0000-0000-000000000000",
    },
    alice.token,
  );
  assert.equal(invalid.status, 400);
  const reply = await post(
    "/api/messages",
    { attachmentIds: [attachment.id], replyToId: original.id },
    alice.token,
  );
  assert.equal(reply.status, 201);
  assert.equal(reply.message.replyTo.preview, "original.txt");
  assert.equal(reply.message.attachments.length, 1);
});

test("mentions are server-derived from online room participants and retain identity across rename", async (t) => {
  const { base, post } = await setup(t);
  const alice = await post("/api/session", { name: "Alice" });
  const bob = await post("/api/session", { name: "Боб Smith" });
  const bobStream = await events(base, bob.token, t);
  await bobStream.next("ready");
  const privateRoom = await post("/api/rooms", {
    name: "mention-private",
    nickname: "Secret",
  });
  const privateStream = await events(base, privateRoom.token, t);
  await privateStream.next("ready");
  const text = "Hello @БОБ Smith! @Secret @Unknown me@Боб Smith";
  const message = (
    await post(
      "/api/messages",
      { text, mentions: [{ id: privateRoom.user.id }] },
      alice.token,
    )
  ).message;
  assert.equal(message.mentions.length, 1);
  assert.equal(message.mentions[0].id, bob.user.id);
  assert.equal(
    text.slice(message.mentions[0].start, message.mentions[0].end),
    "@БОБ Smith",
  );
  await post("/api/session", { name: "Robert", room: "general" }, bob.token);
  assert.equal(
    (await post("/api/messages", { text: "@Боб Smith" }, alice.token)).message
      .mentions,
    undefined,
  );
  assert.equal(
    (await post("/api/messages", { text: "@Robert" }, alice.token)).message
      .mentions[0].id,
    bob.user.id,
  );
  assert.equal(
    message.mentions[0].name,
    "Боб Smith",
    "published metadata never silently changes on rename",
  );
});

const manage = (post, owner, action, input = {}) =>
  post(`/api/rooms/${owner.room.id}/${action}`, input, owner.token);

test("room management is creator-only, generation-scoped, and never available in general", async (t) => {
  const { base, post } = await setup(t);
  const alice = await post("/api/session", { name: "Alice" });
  const owner = await post(
    "/api/rooms",
    { name: "owned", password: "old" },
    alice.token,
  );
  const guest = await post("/api/session", {
    name: "Guest",
    room: "owned",
    password: "old",
  });
  assert.equal(owner.room.isOwner, true);
  assert.equal(guest.room.isOwner, false);
  assert.equal(alice.room.isOwner, false);
  for (const action of ["delete", "kick", "password"]) {
    const input = {
      confirmName: "owned",
      userId: owner.user.id,
      password: "hijack",
      isOwner: true,
    };
    assert.equal(
      (await post(`/api/rooms/${owner.room.id}/${action}`, input)).status,
      401,
    );
    assert.equal(
      (await post(`/api/rooms/${owner.room.id}/${action}`, input, guest.token))
        .status,
      403,
    );
    assert.equal(
      (await post(`/api/rooms/${owner.room.id}/${action}`, input, alice.token))
        .status,
      404,
      "another room's grant is not management access",
    );
    assert.equal(
      (await manage(post, alice, action, input)).status,
      403,
      "general has no creator controls",
    );
  }
  assert.equal(
    (await manage(post, owner, "kick", { userId: owner.user.id })).status,
    400,
  );
  assert.equal(
    (await manage(post, owner, "delete", { confirmName: "wrong" })).status,
    400,
  );
  assert.equal(
    (await manage(post, owner, "password", { password: "x".repeat(129) }))
      .status,
    400,
  );
  assert.equal(
    (
      await post(
        `/api/rooms/${owner.room.id}/password`,
        { password: "bad" },
        owner.token,
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const renamed = await post(
    "/api/session",
    { name: "Renamed", room: "owned" },
    owner.token,
  );
  assert.equal(renamed.room.isOwner, true);
  const resumed = await post(
    "/api/session",
    { name: "Renamed", room: "owned" },
    owner.identityToken,
  );
  assert.equal(
    resumed.status,
    201,
    "creator identity can recover their own room grant without the password",
  );
  assert.equal(resumed.room.isOwner, true);
  const info = await (
    await fetch(base + "/api/session", {
      headers: { Authorization: `Bearer ${resumed.token}` },
    })
  ).json();
  assert.equal(info.room.isOwner, true);
  const publicList = await (await fetch(base + "/api/rooms")).json();
  assert.equal(
    "ownerId" in publicList.rooms.find((room) => room.id === owner.room.id),
    false,
  );
  assert.equal(
    "isOwner" in publicList.rooms.find((room) => room.id === owner.room.id),
    false,
  );
});

test("password rotation revokes all guest room grants, keeps creator/other rooms, and releases only guest pending files", async (t) => {
  const { base, post } = await setup(t, { maxStorageSize: 12 });
  const owner = await post("/api/rooms", {
    name: "rotate",
    password: "old",
    nickname: "Owner",
  });
  const guest = await post("/api/session", {
    name: "Guest",
    room: "rotate",
    password: "old",
  });
  const duplicate = await post(
    "/api/session",
    { name: "Guest", room: "rotate" },
    guest.token,
  );
  const lobby = await post(
    "/api/session",
    { name: "Guest", room: "general" },
    guest.identityToken,
  );
  const ownerStream = await events(base, owner.token, t);
  const guestStream = await events(base, guest.token, t);
  const duplicateStream = await events(base, duplicate.token, t);
  const lobbyStream = await events(base, lobby.token, t);
  for (const stream of [ownerStream, guestStream, duplicateStream, lobbyStream])
    await stream.next("ready");
  const shared = (await upload(base, owner.token, "shared.txt", "keep"))
    .attachment;
  await post("/api/messages", { attachmentId: shared.id }, owner.token);
  const ownerPending = (
    await declare(base, owner.token, "owner", 2, "owner-pending-123456")
  ).upload;
  const guestPending = (
    await declare(base, guest.token, "guest", 4, "guest-pending-123456")
  ).upload;
  const lobbyPending = (
    await declare(base, lobby.token, "lobby", 2, "lobby-pending-123456")
  ).upload;
  const changed = await manage(post, owner, "password", { password: "new" });
  assert.equal(changed.status, 200);
  assert.equal(changed.room.protected, true);
  assert.equal(changed.room.isOwner, true);
  assert.equal((await ownerStream.next("room-updated")).isOwner, true);
  for (const stream of [guestStream, duplicateStream, lobbyStream])
    assert.deepEqual(await stream.next("room-left"), {
      roomId: owner.room.id,
      reason: "password-changed",
    });
  for (const token of [guest.token, duplicate.token]) {
    assert.equal(
      (await post("/api/messages", { text: "revoked" }, token)).status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/api/files/${shared.id}?token=${token}`)).status,
      401,
    );
    assert.equal(
      (await resumableApi(base, token, "GET", guestPending.id)).status,
      401,
    );
  }
  assert.equal(
    (
      await post(
        "/api/messages",
        { text: "other room still works" },
        lobby.token,
      )
    ).status,
    201,
  );
  assert.equal(
    (await resumableApi(base, lobby.token, "GET", lobbyPending.id)).status,
    200,
  );
  assert.equal(
    (await resumableApi(base, owner.token, "GET", ownerPending.id)).status,
    200,
  );
  assert.equal(
    (await declare(base, owner.token, "released", 4, "released-pending-123456"))
      .status,
    201,
  );
  assert.equal(
    (
      await post(
        "/api/session",
        { name: "Guest", room: "rotate", password: "old" },
        guest.identityToken,
      )
    ).status,
    403,
  );
  const rejoined = await post(
    "/api/session",
    { name: "Guest", room: "rotate", password: "new" },
    guest.identityToken,
  );
  assert.equal(rejoined.status, 201);
  assert.equal(rejoined.room.isOwner, false);
  assert.equal(
    (await resumableApi(base, rejoined.token, "GET", guestPending.id)).status,
    404,
  );
  assert.equal(
    await (
      await fetch(`${base}/api/files/${shared.id}?token=${rejoined.token}`)
    ).text(),
    "keep",
  );
  assert.equal(
    (await manage(post, owner, "password", { password: "" })).room.protected,
    false,
  );
  assert.equal(
    (await post("/api/session", { name: "Public", room: "rotate" })).status,
    201,
  );
});

test("kick disconnects every target grant in this room without releasing the nickname or banning re-entry", async (t) => {
  const { base, post } = await setup(t);
  const owner = await post("/api/rooms", { name: "kick", nickname: "Owner" });
  const guest = await post("/api/session", { name: "Guest", room: "kick" });
  const duplicate = await post(
    "/api/session",
    { name: "Guest", room: "kick" },
    guest.token,
  );
  const streams = [];
  for (const token of [owner.token, guest.token, duplicate.token]) {
    const stream = await events(base, token, t);
    await stream.next("ready");
    streams.push(stream);
  }
  const file = (await upload(base, guest.token, "published", "bytes"))
    .attachment;
  await post("/api/messages", { attachmentId: file.id }, guest.token);
  const pending = (await declare(base, guest.token)).upload;
  assert.equal(
    (await manage(post, owner, "kick", { userId: guest.user.id })).status,
    200,
  );
  for (const stream of streams.slice(1))
    assert.equal((await stream.next("room-left")).reason, "kicked");
  for (const token of [guest.token, duplicate.token])
    assert.equal(
      (
        await fetch(base + "/api/session", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      401,
    );
  assert.equal(
    (await post("/api/nickname", { name: "Guest" })).status,
    409,
    "kick does not release nickname ownership",
  );
  assert.equal(
    (await manage(post, owner, "kick", { userId: guest.user.id })).status,
    404,
  );
  const rooms = await (await fetch(base + "/api/rooms")).json();
  assert.equal(rooms.rooms.find((room) => room.id === owner.room.id).count, 1);
  const rejoined = await post(
    "/api/session",
    { name: "Guest", room: "kick" },
    guest.identityToken,
  );
  assert.equal(rejoined.status, 201, "kick is not a ban");
  assert.equal(
    (await resumableApi(base, rejoined.token, "GET", pending.id)).status,
    404,
  );
  assert.equal(
    await (
      await fetch(`${base}/api/files/${file.id}?token=${rejoined.token}`)
    ).text(),
    "bytes",
    "published history is not erased by kick",
  );
});

test("creator deletion immediately clears room data, revokes tokens and preserves nickname identities", async (t) => {
  const { base, post } = await setup(t, { maxStorageSize: 8 });
  const owner = await post("/api/rooms", {
    name: "delete-me",
    nickname: "Owner",
  });
  const guest = await post("/api/session", {
    name: "Guest",
    room: "delete-me",
  });
  const streams = [];
  for (const token of [owner.token, guest.token]) {
    const stream = await events(base, token, t);
    await stream.next("ready");
    streams.push(stream);
  }
  const file = (await upload(base, guest.token, "file", "1234")).attachment;
  await post(
    "/api/messages",
    { text: "private history", attachmentId: file.id },
    guest.token,
  );
  await declare(base, owner.token, "pending", 4);
  assert.equal(
    (await manage(post, owner, "delete", { confirmName: "delete-me" })).status,
    200,
  );
  for (const stream of streams)
    assert.equal((await stream.next("room-left")).reason, "deleted");
  const catalog = await (await fetch(base + "/api/rooms")).json();
  assert.equal(
    catalog.rooms.some((room) => room.id === owner.room.id),
    false,
  );
  for (const token of [owner.token, guest.token])
    assert.equal(
      (await post("/api/messages", { text: "revoked" }, token)).status,
      401,
    );
  for (const token of [owner.identityToken, guest.identityToken])
    assert.equal(
      (
        await fetch(base + "/api/nickname", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      200,
    );
  const replacement = await post(
    "/api/rooms",
    { name: "delete-me" },
    guest.identityToken,
  );
  assert.notEqual(replacement.room.id, owner.room.id);
  assert.equal(replacement.room.isOwner, true);
  assert.equal(
    (
      await manage(post, { ...owner, token: replacement.token }, "delete", {
        confirmName: "delete-me",
      })
    ).status,
    404,
  );
  const ready = await (await events(base, replacement.token, t)).next("ready");
  assert.equal(ready.messages.length, 0);
  assert.equal(
    (await fetch(`${base}/api/files/${file.id}?token=${replacement.token}`))
      .status,
    404,
  );
  assert.equal(
    (
      await declare(
        base,
        replacement.token,
        "full-size",
        8,
        "full-size-pending-123456",
      )
    ).status,
    201,
  );
});

test("reusing a creator's nickname after logout never transfers ownership", async (t) => {
  const { post } = await setup(t);
  const owner = await post("/api/rooms", {
    name: "orphaned",
    nickname: "Owner",
  });
  const guest = await post("/api/session", { name: "Guest", room: "orphaned" });
  assert.equal((await post("/api/logout", {}, owner.token)).status, 200);
  const impostor = await post("/api/session", {
    name: "Owner",
    room: "orphaned",
  });
  assert.notEqual(impostor.user.id, owner.user.id);
  assert.equal(impostor.room.isOwner, false);
  assert.equal(
    (
      await manage(post, { ...owner, token: impostor.token }, "delete", {
        confirmName: "orphaned",
      })
    ).status,
    403,
  );
  assert.equal(
    (await post("/api/messages", { text: "room still available" }, guest.token))
      .status,
    201,
  );
});

test("kicking during an active chunk cannot revive the upload or keep its reservation", async (t) => {
  const { base, post, server } = await setup(t, {
    maxFileSize: 8,
    maxStorageSize: 8,
  });
  const owner = await post("/api/rooms", {
    name: "kick-upload",
    nickname: "Owner",
  });
  const guest = await post("/api/session", {
    name: "Guest",
    room: "kick-upload",
  });
  const { upload: pending } = await declare(base, guest.token);
  const arrived = once(server, "request");
  let request;
  const completed = new Promise((resolve, reject) => {
    request = http.request(
      `${base}/api/uploads/${pending.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${guest.token}`,
          "Content-Type": "application/octet-stream",
          "Upload-Offset": "0",
          "Content-Length": "8",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.write("abcd");
  });
  await arrived;
  assert.equal(
    (await manage(post, owner, "kick", { userId: guest.user.id })).status,
    200,
  );
  request.end("efgh");
  assert.equal(await completed, 404);
  assert.equal(
    (await declare(base, owner.token, "full", 8, "replacement-12345678"))
      .status,
    201,
  );
  const rejoined = await post(
    "/api/session",
    { name: "Guest", room: "kick-upload" },
    guest.identityToken,
  );
  assert.equal(
    (await resumableApi(base, rejoined.token, "GET", pending.id)).status,
    404,
  );
});

test("a guest's pending room-entry request cannot reuse a grant revoked by a kick", async (t) => {
  const { base, post, server } = await setup(t);
  const owner = await post("/api/rooms", {
    name: "kick-entry",
    password: "secret",
    nickname: "Owner",
  });
  const guest = await post("/api/session", {
    name: "Guest",
    room: "kick-entry",
    password: "secret",
  });
  const arrived = once(server, "request");
  let request;
  const completed = new Promise((resolve, reject) => {
    request = http.request(
      base + "/api/session",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${guest.token}`,
          "Content-Type": "application/json",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.write('{"name":"Guest",');
  });
  await arrived;
  await manage(post, owner, "kick", { userId: guest.user.id });
  request.end('"room":"kick-entry"}');
  assert.equal(await completed, 401);
});

test("room-management attempts are rate-limited per creator identity", async (t) => {
  const { post } = await setup(t);
  const owner = await post("/api/rooms", {
    name: "management-limit",
    nickname: "Owner",
  });
  for (let i = 0; i < 12; i++)
    assert.equal(
      (await manage(post, owner, "kick", { userId: "missing" })).status,
      404,
    );
  const renewed = await post(
    "/api/session",
    { name: "Owner", room: "management-limit" },
    owner.identityToken,
  );
  assert.equal(
    (await manage(post, renewed, "password", { password: "new" })).status,
    429,
  );
});
