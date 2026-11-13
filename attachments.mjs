import { randomUUID } from "node:crypto";

export const FILE_LIMITS = Object.freeze({
  maxFileSize: 25 * 1024 * 1024,
  maxStorageSize: 100 * 1024 * 1024,
  maxConcurrentUploads: 2,
  maxFiles: 200,
});
const PENDING_TTL = 10 * 60 * 1000;
const fail = (message, status) => Object.assign(new Error(message), { status });

// Keep file bytes separate from message metadata so they never enter SSE/JSON.
export class AttachmentStore {
  constructor(limits = {}) {
    this.limits = { ...FILE_LIMITS, ...limits };
    this.files = new Map();
    this.bytes = 0;
    this.reserved = 0;
    this.uploading = 0;
  }

  metadata(file) {
    return { id: file.id, name: file.name, size: file.data.length };
  }

  get(id) {
    return this.files.get(id);
  }

  remove(id) {
    const file = this.files.get(id);
    if (file) {
      this.bytes -= file.data.length;
      this.files.delete(id);
    }
  }

  removeRoom(roomName) {
    for (const file of this.files.values())
      if (file.roomName === roomName) this.remove(file.id);
  }

  prune(now = Date.now()) {
    for (const file of this.files.values()) {
      if (!file.attached && now - file.created > PENDING_TTL)
        this.remove(file.id);
    }
  }

  clear() {
    this.files.clear();
    this.bytes = 0;
  }

  async upload(request, ownerId, roomName = "general") {
    this.prune();
    const { maxFileSize, maxStorageSize, maxConcurrentUploads, maxFiles } =
      this.limits;
    if (this.uploading >= maxConcurrentUploads)
      throw fail("Server is busy uploading files. Try again shortly.", 429);
    if (this.files.size + this.uploading >= maxFiles)
      throw fail("Too many stored files. Try again later.", 507);
    let name;
    try {
      name = decodeURIComponent(request.headers["x-file-name"] || "");
    } catch {
      throw fail("Invalid file name.", 400);
    }
    name = name
      .split(/[\\/]/)
      .at(-1)
      .replace(/[\p{Cc}\p{Cf}]/gu, "_")
      .trim();
    if (!name || name === "." || name === ".." || [...name].length > 180)
      throw fail("File names must contain 1–180 characters.", 400);
    const header = request.headers["content-length"];
    const expected = header === undefined ? null : Number(header);
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0))
      throw fail("Invalid file size.", 400);
    if (expected > maxFileSize)
      throw fail("File exceeds the upload size limit.", 413);
    const reservation = expected ?? maxFileSize;
    if (this.bytes + this.reserved + reservation > maxStorageSize)
      throw fail(
        "File buffer is full. Wait for older messages to leave history or restart the server.",
        507,
      );
    this.reserved += reservation;
    this.uploading++;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxFileSize) {
          request.resume();
          throw fail("File exceeds the upload size limit.", 413);
        }
        chunks.push(chunk);
      }
      if (expected !== null && size !== expected)
        throw fail("Incomplete upload. Please try again.", 400);
      const file = {
        id: randomUUID(),
        name,
        data: Buffer.concat(chunks),
        ownerId,
        roomName,
        attached: false,
        created: Date.now(),
      };
      this.files.set(file.id, file);
      this.bytes += size;
      return this.metadata(file);
    } finally {
      this.reserved -= reservation;
      this.uploading--;
    }
  }
}

export function downloadDisposition(name) {
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}
