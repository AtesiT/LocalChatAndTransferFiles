import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const MAX_MESSAGES = 100;
const MAX_LENGTH = 2000;
const SESSION_TTL = 24 * 60 * 60 * 1000;
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

export function createChatServer() {
  const sessions = new Map();
  const clients = new Set();
  const messages = [];
  const joins = new Map();
  const send = (response, event, data) => {
    if (!response.destroyed)
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const online = () =>
    [...sessions.values()]
      .filter((session) => session.connections > 0)
      .map(({ id, name }) => ({ id, name }));
  const broadcast = (event, data) => {
    for (const client of clients) send(client.response, event, data);
  };
  const json = (response, status, data) => {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(data));
  };
  const body = async (request) => {
    const chunks = [];
    let size = 0;
    // Decode once so a UTF-8 character split across packets stays intact.
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 16384) {
        request.resume();
        throw Object.assign(new Error("Request is too large."), {
          status: 413,
        });
      }
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("Invalid JSON."), { status: 400 });
    }
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
    );
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "POST") {
        if (request.headers.origin) {
          let origin;
          try {
            origin = new URL(request.headers.origin);
          } catch {
            return json(response, 403, { error: "Invalid origin." });
          }
          if (origin.host !== request.headers.host)
            return json(response, 403, {
              error: "Cross-origin requests are not allowed.",
            });
        }
        if (!request.headers["content-type"]?.startsWith("application/json"))
          return json(response, 415, { error: "Use application/json." });
        if (url.pathname === "/api/session") {
          const address = request.socket.remoteAddress;
          const attempts = (joins.get(address) || []).filter(
            (time) => Date.now() - time < 60000,
          );
          if (attempts.length >= 30)
            return json(response, 429, {
              error: "Too many join attempts. Try again in a minute.",
            });
          attempts.push(Date.now());
          joins.set(address, attempts);
          const input = await body(request);
          const name =
            typeof input?.name === "string"
              ? input.name.trim().replace(/\s+/g, " ")
              : "";
          if (!name || [...name].length > 24 || /[\p{Cc}\p{Cf}]/u.test(name))
            return json(response, 400, {
              error: "Choose a name between 1 and 24 characters.",
            });
          const token = randomBytes(32).toString("hex");
          const session = {
            id: randomUUID(),
            name,
            connections: 0,
            touched: Date.now(),
            sent: [],
          };
          sessions.set(token, session);
          return json(response, 201, { token, user: { id: session.id, name } });
        }
        if (url.pathname === "/api/messages") {
          const token = request.headers.authorization?.replace(/^Bearer /, "");
          const session = sessions.get(token);
          if (!session || Date.now() - session.touched > SESSION_TTL)
            return json(response, 401, {
              error: "Please join the chat again.",
            });
          const input = await body(request);
          const text = typeof input?.text === "string" ? input.text.trim() : "";
          if (!text || [...text].length > MAX_LENGTH)
            return json(response, 400, {
              error: "Messages must contain 1–2,000 characters.",
            });
          session.sent = session.sent.filter(
            (time) => Date.now() - time < 10000,
          );
          if (session.sent.length >= 12)
            return json(response, 429, {
              error: "A little too fast! Wait a few seconds.",
            });
          session.sent.push(Date.now());
          session.touched = Date.now();
          const message = {
            id: randomUUID(),
            userId: session.id,
            name: session.name,
            text,
            time: new Date().toISOString(),
          };
          messages.push(message);
          if (messages.length > MAX_MESSAGES) messages.shift();
          broadcast("message", message);
          return json(response, 201, { message });
        }
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        const token = request.headers.authorization?.replace(/^Bearer /, "");
        const session = sessions.get(token);
        if (!session || Date.now() - session.touched > SESSION_TTL)
          return json(response, 401, { error: "Please join the chat again." });
        return json(response, 200, {
          user: { id: session.id, name: session.name },
        });
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        const session = sessions.get(url.searchParams.get("token"));
        if (!session || Date.now() - session.touched > SESSION_TTL)
          return json(response, 401, { error: "Please join the chat again." });
        session.connections++;
        session.touched = Date.now();
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.write("retry: 2000\n\n");
        const client = { response, session };
        clients.add(client);
        send(response, "ready", {
          user: { id: session.id, name: session.name },
          messages,
          users: online(),
        });
        broadcast("presence", online());
        response.on("close", () => {
          clients.delete(client);
          session.connections--;
          session.touched = Date.now();
          broadcast("presence", online());
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/info") {
        return json(response, 200, {
          name: "localchat",
          maxMessageLength: MAX_LENGTH,
        });
      }
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        files.has(url.pathname)
      ) {
        const [file, contentType] = files.get(url.pathname);
        const content = await readFile(
          new URL(`./public/${file}`, import.meta.url),
        );
        response.writeHead(200, { "Content-Type": contentType });
        return response.end(request.method === "HEAD" ? undefined : content);
      }
      json(response, 404, { error: "Not found." });
    } catch (error) {
      if (!response.headersSent && !response.destroyed)
        json(response, error.status || 500, {
          error: error.status
            ? error.message
            : "Something went wrong. Please try again.",
        });
    }
  });
  const heartbeat = setInterval(() => {
    for (const { response, session } of clients) {
      session.touched = Date.now();
      response.write(": heartbeat\n\n");
    }
    for (const [token, session] of sessions)
      if (!session.connections && Date.now() - session.touched > SESSION_TTL)
        sessions.delete(token);
    for (const [address, times] of joins)
      if (Date.now() - times.at(-1) > 60000) joins.delete(address);
  }, 15000);
  heartbeat.unref();
  server.on("close", () => clearInterval(heartbeat));
  server.stop = () => {
    for (const { response } of clients) response.end();
    server.close();
    server.closeIdleConnections();
  };
  return server;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";
  const server = createChatServer();
  server.on("error", (error) => {
    console.error(`Unable to start: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const actualPort = server.address().port;
    console.log(
      `\n  localchat — local network chat\n\n  This computer:  http://localhost:${actualPort}`,
    );
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries || [])
        if (entry.family === "IPv4" && !entry.internal)
          console.log(
            `  Local network:  http://${entry.address}:${actualPort}`,
          );
    }
    console.log(
      "\n  Open a local network address on devices connected to the same network.\n  Press Ctrl+C to stop.\n",
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.stop());
}
