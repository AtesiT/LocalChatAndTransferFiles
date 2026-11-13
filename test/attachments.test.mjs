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
