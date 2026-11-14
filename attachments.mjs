import { randomUUID } from "node:crypto";

export const FILE_LIMITS = Object.freeze({
  maxFileSize: 25 * 1024 * 1024,
  maxStorageSize: 100 * 1024 * 1024,
  maxConcurrentUploads: 2,
  maxFiles: 200,
  chunkSize: 1024 * 1024,
  maxFilesPerMessage: 10,
});
const PENDING_TTL = 10 * 60 * 1000;
const fail = (message, status) => Object.assign(new Error(message), { status });

// Keep file bytes separate from message metadata so they never enter SSE/JSON.
export class AttachmentStore {
  constructor(limits = {}) {
    this.limits = { ...FILE_LIMITS, ...limits };
    this.files = new Map();
    this.uploads = new Map();
    this.legacyUploading = 0;
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
    const upload = this.uploads.get(id);
    if (file) {
      this.bytes -= file.data.length;
      this.files.delete(id);
    } else if (upload) this.reserved -= upload.size;
    if (upload) {
      upload.chunks = [];
      this.uploads.delete(id);
    }
  }

  removeOwner(identityId, sessionIds, roomName = null) {
    for (const file of [...this.files.values(), ...this.uploads.values()]) {
      if (
        !file.attached &&
        (roomName === null || file.roomName === roomName) &&
        (file.ownerIdentityId === identityId || sessionIds.has(file.ownerId))
      )
        this.remove(file.id);
    }
  }

  removeRoom(roomName) {
    for (const file of [...this.files.values(), ...this.uploads.values()])
      if (file.roomName === roomName) this.remove(file.id);
  }

  prune(now = Date.now()) {
    for (const file of [...this.files.values(), ...this.uploads.values()]) {
      if (!file.attached && !file.busy && now - file.created > PENDING_TTL)
        this.remove(file.id);
    }
  }

  clear() {
    for (const id of [...this.files.keys(), ...this.uploads.keys()])
      this.remove(id);
  }

  sanitizeName(name) {
    if (typeof name !== "string") throw fail("Invalid file name.", 400);
    name = name
      .split(/[\\/]/)
      .at(-1)
      .replace(/[\p{Cc}\p{Cf}]/gu, "_")
      .trim();
    if (!name || name === "." || name === ".." || [...name].length > 180)
      throw fail("File names must contain 1–180 characters.", 400);
    return name;
  }

  fileCount() {
    return (
      new Set([...this.files.keys(), ...this.uploads.keys()]).size +
      this.legacyUploading
    );
  }

  findUpload(clientId, ownerIdentityId, roomId) {
    return [...this.uploads.values()].find(
      (file) =>
        file.clientId === clientId &&
        file.ownerIdentityId === ownerIdentityId &&
        file.roomId === roomId,
    );
  }

  start({ name, size, clientId }, ownerIdentityId, room) {
    this.prune();
    name = this.sanitizeName(name);
    if (!Number.isSafeInteger(size) || size < 0)
      throw fail("Invalid file size.", 400);
    if (size > this.limits.maxFileSize)
      throw fail("File exceeds the upload size limit.", 413);
    if (
      typeof clientId !== "string" ||
      !/^[a-zA-Z0-9_-]{16,80}$/.test(clientId)
    )
      throw fail("Invalid upload request ID.", 400);
    const existing = this.findUpload(clientId, ownerIdentityId, room.id);
    if (existing) {
      if (existing.name !== name || existing.size !== size)
        throw fail("Upload request ID already belongs to another file.", 409);
      existing.created = Date.now();
      return existing;
    }
    if (this.fileCount() >= this.limits.maxFiles)
      throw fail("Too many stored files. Try again later.", 507);
    if (this.bytes + this.reserved + size > this.limits.maxStorageSize)
      throw fail(
        "File buffer is full. Remove unused uploads or try again later.",
        507,
      );
    const file = {
      id: randomUUID(),
      clientId,
      name,
      size,
      ownerIdentityId,
      roomId: room.id,
      roomName: room.name,
      offset: 0,
      chunks: [],
      busy: false,
      attached: false,
      created: Date.now(),
    };
    this.uploads.set(file.id, file);
    this.reserved += size;
    if (!size) this.finish(file);
    return file;
  }

  finish(file) {
    file.data = Buffer.concat(file.chunks, file.size);
    file.chunks = [];
    this.reserved -= file.size;
    this.bytes += file.size;
    this.files.set(file.id, file);
  }

  status(file) {
    return {
      id: file.id,
      name: file.name,
      size: file.size,
      offset: file.offset,
      complete: this.files.has(file.id),
      attached: file.attached,
      chunkSize: this.limits.chunkSize,
    };
  }

  ownedUpload(id, ownerIdentityId, roomId) {
    this.prune();
    const file = this.uploads.get(id);
    if (
      !file ||
      file.ownerIdentityId !== ownerIdentityId ||
      file.roomId !== roomId
    )
      throw fail("Upload expired or is unavailable.", 404);
    file.created = Date.now();
    return file;
  }

  async append(request, file) {
    if (file.attached || this.files.has(file.id))
      throw fail("Upload is already complete.", 409);
    if (file.busy)
      throw fail(
        "A chunk is already being uploaded. Check the offset and retry.",
        409,
      );
    const offsetHeader = request.headers["upload-offset"];
    if (
      typeof offsetHeader !== "string" ||
      !/^(0|[1-9]\d*)$/.test(offsetHeader)
    )
      throw fail("Invalid upload offset.", 400);
    if (Number(offsetHeader) !== file.offset)
      throw fail("Upload offset changed. Check its status and resume.", 409);
    if (this.uploading >= this.limits.maxConcurrentUploads)
      throw fail("Server is busy uploading files. Try again shortly.", 429);
    const maximum = Math.min(this.limits.chunkSize, file.size - file.offset);
    const length = request.headers["content-length"];
    if (length !== undefined && Number(length) > maximum)
      throw fail("Chunk exceeds the allowed size.", 413);
    file.busy = true;
    this.uploading++;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maximum) {
          request.resume();
          throw fail("Chunk exceeds the allowed size.", 413);
        }
        chunks.push(chunk);
      }
      if (!size || (length !== undefined && Number(length) !== size))
        throw fail("Incomplete chunk. Please retry.", 400);
      if (this.uploads.get(file.id) !== file)
        throw fail("Upload was cancelled or its room closed.", 404);
      // Commit only complete chunks. A disconnected request never advances the offset.
      file.chunks.push(Buffer.concat(chunks, size));
      file.offset += size;
      file.created = Date.now();
      if (file.offset === file.size) this.finish(file);
      return this.status(file);
    } finally {
      file.busy = false;
      this.uploading--;
    }
  }

  async upload(request, ownerId, roomName = "general") {
    this.prune();
    const { maxFileSize, maxStorageSize, maxConcurrentUploads, maxFiles } =
      this.limits;
    if (this.uploading >= maxConcurrentUploads)
      throw fail("Server is busy uploading files. Try again shortly.", 429);
    if (this.fileCount() >= maxFiles)
      throw fail("Too many stored files. Try again later.", 507);
    let name;
    try {
      name = decodeURIComponent(request.headers["x-file-name"] || "");
    } catch {
      throw fail("Invalid file name.", 400);
    }
    name = this.sanitizeName(name);
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
    this.legacyUploading++;
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
      this.legacyUploading--;
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
