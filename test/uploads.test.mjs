import { test } from "node:test";
import assert from "node:assert/strict";
import { UploadQueue, requestId } from "../public/uploads.js";

const file = (name = "test.bin", size = 8) =>
  Object.assign(new Blob([Buffer.alloc(size)]), { name });
const queue = (limit = 10) =>
  new UploadQueue({ credential: () => "room-token", change() {}, limit });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("request IDs work without secure-context randomUUID and queues bound file selection", () => {
  assert.match(requestId(), /^[a-f0-9]{32}$/);
  assert.notEqual(requestId(), requestId());
  const uploads = queue(2);
  uploads.add(file());
  uploads.add(file());
  assert.throws(() => uploads.add(file()), /up to 2/);
  uploads.cancel(uploads.entries[0]);
  assert.equal(uploads.entries.length, 1);
  uploads.locked = true;
  uploads.cancel(uploads.entries[0]);
  assert.equal(
    uploads.entries.length,
    1,
    "cannot cancel after atomic publication begins",
  );
});

test("cancelling during upload creation deletes the eventual reservation and leaves other files alone", async () => {
  const uploads = queue();
  uploads.add(file("cancel"));
  uploads.add(file("keep", 0));
  const first = uploads.entries[0];
  const gate = deferred();
  const calls = [];
  uploads.request = async (path, options = {}) => {
    calls.push([path, options.method]);
    if (options.method === "DELETE") return { cancelled: true };
    const { name, size } = JSON.parse(options.body);
    if (name === "cancel") await gate.promise;
    return { upload: { id: name, size, offset: size, complete: true } };
  };
  const sending = uploads.uploadAll();
  uploads.cancel(first);
  gate.resolve();
  assert.deepEqual(await sending, ["keep"]);
  assert.ok(
    calls.some(
      ([path, method]) => path === "/api/uploads/cancel" && method === "DELETE",
    ),
  );
  assert.equal(uploads.entries[0].state, "ready");
});

test("manual resume retains file identity and starts from the server-confirmed offset", async () => {
  const uploads = queue();
  uploads.add(file());
  let paused = false;
  const offsets = [];
  const declarations = [];
  uploads.request = async (path, options) => {
    if (options?.method === "POST") {
      declarations.push(JSON.parse(options.body));
      return {
        upload: { id: "upload", offset: 0, complete: false, chunkSize: 4 },
      };
    }
    return {
      upload: { id: "upload", offset: 4, complete: false, chunkSize: 4 },
    };
  };
  uploads.chunk = async (entry, status) => {
    offsets.push(status.offset);
    if (status.offset === 0)
      return { offset: 4, complete: false, chunkSize: 4 };
    if (!paused) {
      paused = true;
      throw Object.assign(new Error("Rejected"), { status: 413 });
    }
    return { offset: 8, complete: true };
  };
  await assert.rejects(uploads.uploadAll(), /Rejected/);
  assert.match(uploads.entries[0].state, /paused/);
  assert.equal(uploads.entries[0].offset, 4);
  assert.deepEqual(await uploads.uploadAll(), ["upload"]);
  assert.deepEqual(offsets, [0, 4, 4]);
  assert.equal(declarations.length, 1);
});

test("lost final chunk responses are reconciled without retransmission", async () => {
  const uploads = queue();
  uploads.add(file());
  let chunks = 0;
  uploads.request = async (path, options) => ({
    upload:
      options?.method === "POST"
        ? { id: "upload", offset: 0, complete: false, chunkSize: 8 }
        : { id: "upload", offset: 8, complete: true, chunkSize: 8 },
  });
  uploads.chunk = async () => {
    chunks++;
    throw new Error("Response lost after commit");
  };
  assert.deepEqual(await uploads.uploadAll(), ["upload"]);
  assert.equal(chunks, 1);
  assert.equal(uploads.entries[0].offset, 8);
  assert.equal(uploads.entries[0].state, "ready");
});

test("expired pending buffers restart under the same idempotent client request ID", async () => {
  const uploads = queue();
  uploads.add(file("empty", 0));
  const entry = uploads.entries[0];
  entry.id = "expired";
  const clientId = entry.clientId;
  uploads.request = async (path, options) => {
    if (path.endsWith("expired"))
      throw Object.assign(new Error("Expired"), { status: 404 });
    assert.equal(JSON.parse(options.body).clientId, clientId);
    return { upload: { id: "replacement", offset: 0, complete: true } };
  };
  assert.deepEqual(await uploads.uploadAll(), ["replacement"]);
});

test("a batch pins its room credential even if the visible room changes mid-upload", async () => {
  let credential = "original-room";
  const uploads = new UploadQueue({
    credential: () => credential,
    change() {},
  });
  uploads.add(file("first"));
  uploads.add(file("second"));
  const credentials = [];
  uploads.request = async (path, options, token) => {
    credentials.push(token);
    credential = "another-room";
    return {
      upload: { id: JSON.parse(options.body).name, offset: 8, complete: true },
    };
  };
  assert.deepEqual(await uploads.uploadAll(), ["first", "second"]);
  assert.deepEqual(credentials, ["original-room", "original-room"]);
});
