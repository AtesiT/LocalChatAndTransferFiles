// getRandomValues also works on plain HTTP LAN origins, unlike randomUUID.
export const requestId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

// Queue state stays with its room draft. Only server-confirmed offsets survive retries.
export class UploadQueue {
  constructor({ credential, change, limit = 10 }) {
    this.credential = credential;
    this.change = change;
    this.limit = limit;
    this.entries = [];
    this.locked = false;
  }

  add(file) {
    if (this.entries.length >= this.limit)
      throw new Error(`Attach up to ${this.limit} files per message.`);
    this.entries.push({
      file,
      clientId: requestId(),
      id: null,
      offset: 0,
      loaded: 0,
      state: "queued",
      cancelled: false,
    });
    this.change();
  }

  async request(path, options = {}, credential = this.credential()) {
    const response = await fetch(path, {
      signal: AbortSignal.timeout(15000),
      ...options,
      headers: { Authorization: `Bearer ${credential}`, ...options.headers },
    });
    const result = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(result.error || "Upload failed."), {
        status: response.status,
      });
    return result;
  }

  async discard(entry, credential) {
    if (!entry.id) return;
    try {
      await this.request(
        `/api/uploads/${entry.id}`,
        { method: "DELETE" },
        credential,
      );
    } catch {
      /* Unreachable pending uploads expire automatically. */
    }
  }

  cancel(entry) {
    if (this.locked) return;
    entry.cancelled = true;
    entry.xhr?.abort();
    this.entries = this.entries.filter((item) => item !== entry);
    this.discard(entry, this.credential());
    this.change();
  }

  chunk(entry, status, credential) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      entry.xhr = xhr;
      xhr.open("PATCH", `/api/uploads/${entry.id}`);
      xhr.setRequestHeader("Authorization", `Bearer ${credential}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("Upload-Offset", String(status.offset));
      xhr.responseType = "json";
      xhr.timeout = 45000;
      xhr.upload.onprogress = (event) => {
        entry.loaded = Math.min(entry.file.size, status.offset + event.loaded);
        this.change();
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.response?.upload)
          resolve(xhr.response.upload);
        else
          reject(
            Object.assign(new Error(xhr.response?.error || "Upload failed."), {
              status: xhr.status,
            }),
          );
      };
      xhr.onerror = xhr.ontimeout = () =>
        reject(new Error("Connection interrupted."));
      xhr.onabort = () =>
        reject(new DOMException("Upload cancelled.", "AbortError"));
      xhr.send(
        entry.file.slice(status.offset, status.offset + status.chunkSize),
      );
    }).finally(() => {
      entry.xhr = null;
    });
  }

  async upload(entry, credential = this.credential()) {
    let failures = 0;
    while (!entry.cancelled) {
      try {
        entry.state = failures ? "resuming" : "uploading";
        this.change();
        let status;
        if (entry.id) {
          try {
            ({ upload: status } = await this.request(
              `/api/uploads/${entry.id}`,
              {},
              credential,
            ));
          } catch (error) {
            if (error.status !== 404) throw error;
            entry.id = null; // Expired server buffer: explicitly restart this file.
            entry.offset = entry.loaded = 0;
          }
        }
        if (!entry.id) {
          ({ upload: status } = await this.request(
            "/api/uploads",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: entry.file.name,
                size: entry.file.size,
                clientId: entry.clientId,
              }),
            },
            credential,
          ));
          entry.id = status.id;
        }
        if (entry.cancelled) {
          await this.discard(entry, credential);
          return;
        }
        entry.offset = entry.loaded = status.offset;
        this.change();
        while (!status.complete && !entry.cancelled) {
          status = await this.chunk(entry, status, credential);
          entry.offset = entry.loaded = status.offset;
          failures = 0;
          this.change();
        }
        if (entry.cancelled) {
          await this.discard(entry, credential);
          return;
        }
        entry.state = "ready";
        this.change();
        return;
      } catch (error) {
        if (entry.cancelled) {
          await this.discard(entry, credential);
          return;
        }
        entry.loaded = entry.offset;
        // Every retry asks the server for its offset, including lost final responses.
        if (
          (!error.status ||
            [409, 429, 500, 502, 503, 504].includes(error.status)) &&
          ++failures <= 3
        ) {
          entry.state = "reconnecting";
          this.change();
          await new Promise((resolve) => setTimeout(resolve, 1000 * failures));
          continue;
        }
        entry.state = "paused — send to resume";
        this.change();
        throw error;
      }
    }
  }

  async uploadAll() {
    // Cancellation removes only that file; remaining queued files keep uploading.
    const credential = this.credential();
    for (const entry of [...this.entries])
      if (!entry.cancelled) await this.upload(entry, credential);
    return this.entries
      .filter((entry) => !entry.cancelled)
      .map((entry) => entry.id);
  }
}
