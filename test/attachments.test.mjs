import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { AttachmentStore } from "../attachments.mjs";

const request = (data, name = "file.bin") => {
  const stream = Readable.from([Buffer.from(data)]);
  stream.headers = {
    "x-file-name": encodeURIComponent(name),
    "content-length": String(Buffer.byteLength(data)),
  };
  return stream;
};

test("expires abandoned uploads without removing published files", async () => {
  const store = new AttachmentStore({ maxFileSize: 8, maxStorageSize: 16 });
  const abandoned = await store.upload(request("pending"), "alice");
  const published = await store.upload(request("sent"), "alice");
  store.get(published.id).attached = true;
  store.prune(Date.now() + 11 * 60 * 1000);
  assert.equal(store.get(abandoned.id), undefined);
  assert.ok(store.get(published.id));
  assert.equal(store.bytes, 4);
  store.clear();
  assert.equal(store.bytes, 0);
  assert.equal(store.files.size, 0);
});

test("reserves capacity for concurrent uploads and releases it after abort", async () => {
  const store = new AttachmentStore({
    maxFileSize: 8,
    maxStorageSize: 8,
    maxConcurrentUploads: 1,
  });
  const slow = new PassThrough();
  slow.headers = { "x-file-name": "slow.bin" };
  const uploading = store.upload(slow, "alice");
  assert.equal(store.reserved, 8);
  await assert.rejects(
    store.upload(request("a"), "bob"),
    (error) => error.status === 429,
  );
  slow.destroy(new Error("Connection aborted"));
  await assert.rejects(uploading, /Connection aborted/);
  assert.equal(store.reserved, 0);
  assert.equal(store.uploading, 0);
  assert.equal(store.bytes, 0);
  assert.equal((await store.upload(request("12345678"), "bob")).size, 8);
});

test("reserves a shared byte budget, including in-flight uploads", async () => {
  const store = new AttachmentStore({ maxFileSize: 8, maxStorageSize: 8 });
  const slow = new PassThrough();
  slow.headers = { "x-file-name": "slow.bin", "content-length": "8" };
  const uploading = store.upload(slow, "alice");
  await assert.rejects(
    store.upload(request("a"), "bob"),
    (error) => error.status === 507,
  );
  slow.end("12345678");
  await uploading;
  assert.equal(store.reserved, 0);
  assert.equal(store.bytes, 8);
});

const room = { id: "room-1", name: "general" };
const startUpload = (store, size = 8, clientId = "request-1234567890") =>
  store.start({ name: "file.bin", size, clientId }, "alice", room);
const chunkRequest = (data, offset = 0) => {
  const stream = request(data);
  stream.headers["upload-offset"] = String(offset);
  return stream;
};

test("resumable uploads reserve the full budget and accept only confirmed offsets", async () => {
  const store = new AttachmentStore({ maxStorageSize: 8, chunkSize: 4 });
  const file = startUpload(store);
  assert.equal(store.reserved, 8);
  assert.equal(
    startUpload(store).id,
    file.id,
    "creation retries are idempotent",
  );
  assert.throws(
    () => startUpload(store, 1, "another-1234567890"),
    (error) => error.status === 507,
  );
  assert.equal((await store.append(chunkRequest("abcd"), file)).offset, 4);
  await assert.rejects(
    store.append(chunkRequest("abcd"), file),
    (error) => error.status === 409,
  );
  await assert.rejects(
    store.append(chunkRequest("abcde", 4), file),
    (error) => error.status === 413,
  );
  assert.equal(file.offset, 4);
  assert.equal(
    (await store.append(chunkRequest("efgh", 4), file)).complete,
    true,
  );
  assert.equal(store.get(file.id).data.toString(), "abcdefgh");
  assert.equal(store.reserved, 0);
  assert.equal(store.bytes, 8);
  assert.equal(store.fileCount(), 1, "completed upload counts once");
  store.remove(file.id);
  assert.equal(store.bytes, 0);
  assert.equal(store.uploads.size, 0);
});

test("a disconnected chunk preserves previous chunks, not partially received bytes", async () => {
  const store = new AttachmentStore({ chunkSize: 4 });
  const file = startUpload(store);
  await store.append(chunkRequest("abcd"), file);
  const slow = new PassThrough();
  slow.headers = { "upload-offset": "4", "content-length": "4" };
  const uploading = store.append(slow, file);
  slow.write("ef");
  slow.destroy(new Error("Disconnected"));
  await assert.rejects(uploading, /Disconnected/);
  assert.equal(file.offset, 4);
  assert.equal(file.chunks.length, 1);
  assert.equal(store.uploading, 0);
  await store.append(chunkRequest("efgh", 4), file);
  assert.equal(store.get(file.id).data.toString(), "abcdefgh");
});

test("cancelling an active chunk cannot resurrect a file or consume its released reservation", async () => {
  const store = new AttachmentStore({ maxStorageSize: 8 });
  const file = startUpload(store);
  const slow = new PassThrough();
  slow.headers = { "upload-offset": "0" };
  const uploading = store.append(slow, file);
  store.remove(file.id);
  assert.equal(store.reserved, 0);
  const replacement = startUpload(store, 8, "replacement-123456");
  slow.end("abcdefgh");
  await assert.rejects(uploading, (error) => error.status === 404);
  assert.equal(store.get(file.id), undefined);
  assert.equal(store.reserved, 8);
  assert.equal(store.bytes, 0);
  store.remove(replacement.id);
  assert.equal(store.reserved, 0);
});

test("resumable chunks share the legacy concurrency limit and reject simultaneous writes", async () => {
  const store = new AttachmentStore({ maxConcurrentUploads: 1 });
  const file = startUpload(store);
  const second = startUpload(store, 1, "second-1234567890");
  const slow = new PassThrough();
  slow.headers = { "upload-offset": "0" };
  const uploading = store.append(slow, file);
  await assert.rejects(
    store.append(chunkRequest("a"), second),
    (error) => error.status === 429,
  );
  await assert.rejects(
    store.append(chunkRequest("a"), file),
    (error) => error.status === 409,
  );
  await assert.rejects(
    store.upload(request("a"), "bob"),
    (error) => error.status === 429,
  );
  slow.end("abcdefgh");
  await uploading;
  assert.equal(store.uploading, 0);
});

test("partial and completed pending uploads expire; room deletion clears reservations and data", async () => {
  const store = new AttachmentStore({ chunkSize: 4 });
  const partial = startUpload(store);
  const complete = startUpload(store, 0, "empty-1234567890");
  await store.append(chunkRequest("abcd"), partial);
  assert.equal(store.status(complete).complete, true);
  store.prune(Date.now() + 11 * 60 * 1000);
  assert.equal(store.uploads.size, 0);
  assert.equal(store.files.size, 0);
  assert.equal(store.reserved, 0);
  startUpload(store);
  startUpload(store, 0, "empty-1234567890");
  store.removeRoom(room.name);
  assert.equal(store.reserved, 0);
  assert.equal(store.bytes, 0);
  assert.equal(store.uploads.size, 0);
});

test("upload declarations, ownership, file counts and chunk headers are validated", async () => {
  const store = new AttachmentStore({ maxFiles: 1 });
  for (const size of [-1, 0.5, "8", Number.MAX_SAFE_INTEGER])
    assert.throws(() => startUpload(store, size));
  const file = startUpload(store);
  assert.throws(
    () => startUpload(store, 1),
    (error) => error.status === 409,
  );
  assert.throws(
    () => startUpload(store, 1, "another-1234567890"),
    (error) => error.status === 507,
  );
  assert.throws(
    () => store.ownedUpload(file.id, "bob", room.id),
    (error) => error.status === 404,
  );
  assert.throws(
    () => store.ownedUpload(file.id, "alice", "other-room"),
    (error) => error.status === 404,
  );
  for (const offset of [undefined, "-1", "0.1", "", "Infinity", "00"]) {
    const stream = chunkRequest("a");
    stream.headers["upload-offset"] = offset;
    await assert.rejects(
      store.append(stream, file),
      (error) => error.status === 400,
    );
  }
  await assert.rejects(
    store.append(chunkRequest(""), file),
    (error) => error.status === 400,
  );
  assert.equal(file.offset, 0);
});
