import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { AttachmentStore, downloadDisposition } from "./attachments.mjs";
import { RoomStore, roomInfo } from "./rooms.mjs";

const MAX_MESSAGES = 100;
const MAX_LENGTH = 2000;
const SESSION_TTL = 24 * 60 * 60 * 1000;
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/notifications.js", ["notifications.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

export function createChatServer(
  fileLimits = {},
  { roomGraceMs = 15000, nicknameGraceMs = 120000 } = {},
) {
  const attachments = new AttachmentStore(fileLimits);
  const sessions = new Map();
  const identities = new Map();
  const nicknameAttempts = new Map();
  const clients = new Set();
  const rooms = new RoomStore();
  const roomAttempts = new Map();
  const roomCreations = new Map();
  const joins = new Map();
  const roomWatchers = new Set();
  const emptyTimers = new Map();
  let stopping = false;
  const send = (response, event, data) => {
    if (!response.destroyed && !response.writableEnded)
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const online = (roomName) => [
    ...new Map(
      [...sessions.values()]
        .filter(
          (session) => session.connections > 0 && session.roomName === roomName,
        )
        .map((session) => [
          session.identity.id,
          { id: session.identity.id, name: session.identity.name },
        ]),
    ).values(),
  ];
  const broadcast = (roomName, event, data) => {
    for (const client of clients)
      if (client.session.roomName === roomName)
        send(client.response, event, data);
  };
  const roomList = () =>
    rooms.list().map((room) => ({ ...room, count: online(room.name).length }));
  const publishRooms = () => {
    const snapshot = { rooms: roomList() };
    for (const response of roomWatchers) send(response, "rooms", snapshot);
  };
  const scheduleEmpty = (room) => {
    clearTimeout(emptyTimers.get(room.name));
    emptyTimers.delete(room.name);
    if (stopping || room.name === "general" || online(room.name).length) return;
    const timer = setTimeout(() => {
      emptyTimers.delete(room.name);
      if (rooms.get(room.name) !== room || online(room.name).length) return;
      rooms.rooms.delete(room.name);
      attachments.removeRoom(room.name);
      for (const [token, session] of sessions)
        if (session.room === room && session.roomName !== null)
          sessions.delete(token);
      publishRooms();
    }, roomGraceMs);
    timer.unref();
    emptyTimers.set(room.name, timer);
  };
  const validateNickname = (value) => {
    const name =
      typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
    if (!name || [...name].length > 24 || /[\p{Cc}\p{Cf}]/u.test(name))
      throw Object.assign(
        new Error("Choose a name between 1 and 24 characters."),
        { status: 400 },
      );
    return name;
  };
  const identityOnline = (identity) =>
    [...clients].some(
      (client) =>
        client.session.identity === identity && !client.response.destroyed,
    );
  const nicknameKey = (name) => name.normalize("NFKC").toLowerCase();
  const expireIdentity = (identity) => {
    if (identities.get(identity.key) === identity)
      identities.delete(identity.key);
    for (const [token, session] of sessions)
      if (session.identity === identity) sessions.delete(token);
  };
  const resolveIdentity = (name, existing) => {
    const key = nicknameKey(name);
    const occupied = identities.get(key);
    if (occupied && Date.now() > occupied.expires && !identityOnline(occupied))
      expireIdentity(occupied);
    if (identities.has(key) && identities.get(key) !== existing?.identity)
      throw Object.assign(
        new Error("That nickname is already in use. Choose another."),
        { status: 409, code: "NICKNAME_TAKEN" },
      );
    let identity = existing?.identity;
    if (!identity) {
      identity = {
        id: randomUUID(),
        name,
        key,
        expires: Date.now() + nicknameGraceMs,
        token: randomBytes(32).toString("hex"),
      };
      sessions.set(identity.token, {
        id: randomUUID(),
        identity,
        name,
        room: null,
        roomName: null,
        connections: 0,
        touched: Date.now(),
        sent: [],
      });
    } else if (identity.name !== name) {
      if (identities.get(identity.key) === identity)
        identities.delete(identity.key);
      identity.name = name;
      identity.key = key;
      for (const session of sessions.values())
        if (session.identity === identity) session.name = name;
      for (const client of clients)
        if (client.session.identity === identity)
          send(client.response, "profile", { id: identity.id, name });
      for (const room of rooms.rooms.values())
        broadcast(room.name, "presence", online(room.name));
    }
    identities.set(key, identity);
    identity.expires = Date.now() + nicknameGraceMs;
    return identity;
  };
  const issueSession = (name, roomName, existing) => {
    const identity = resolveIdentity(name, existing);
    const token = randomBytes(32).toString("hex");
    const session = {
      id: randomUUID(),
      identity,
      name: identity.name,
      roomName,
      room: rooms.get(roomName),
      connections: 0,
      touched: Date.now(),
      sent: [],
    };
    sessions.set(token, session);
    scheduleEmpty(session.room);
    return {
      token,
      identityToken: identity.token,
      user: { id: identity.id, name: identity.name },
      room: roomInfo(session.room),
    };
  };
  const authenticate = (request, token, roomRequired = true) => {
    token ||= request.headers.authorization?.replace(/^Bearer /, "");
    const session = sessions.get(token);
    if (
      !session ||
      (session.identity.expires < Date.now() &&
        !identityOnline(session.identity)) ||
      identities.get(session.identity.key) !== session.identity
    )
      return null;
    if (roomRequired && !session.room) return null;
    if (session.room && rooms.get(session.roomName) !== session.room)
      return null;
    if (session.room && Date.now() - session.touched > SESSION_TTL) return null;
    session.identity.expires = Date.now() + nicknameGraceMs;
    session.touched = Date.now();
    return session;
  };
  const throttle = (map, address, limit) => {
    const attempts = (map.get(address) || []).filter(
      (time) => Date.now() - time < 60000,
    );
    if (attempts.length >= limit)
      throw Object.assign(
        new Error("Too many room attempts. Try again in a minute."),
        { status: 429 },
      );
    attempts.push(Date.now());
    map.set(address, attempts);
  };
  const json = (response, status, data) => {
    if (status >= 400 && !response.req.complete) response.req.resume();
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
        if (url.pathname === "/api/files") {
          const token = request.headers.authorization?.replace(/^Bearer /, "");
          const session = authenticate(request, token);
          if (!session)
            return json(response, 401, {
              error: "Please join the chat again.",
            });
          if (request.headers["content-type"] !== "application/octet-stream")
            return json(response, 415, {
              error: "Use application/octet-stream for files.",
            });
          session.uploads = (session.uploads || []).filter(
            (time) => Date.now() - time < 60000,
          );
          if (session.uploads.length >= 6)
            return json(response, 429, {
              error: "Too many uploads. Try again in a minute.",
            });
          session.uploads.push(Date.now());
          session.touched = Date.now();
          const attachment = await attachments.upload(
            request,
            session.id,
            session.roomName,
          );
          if (authenticate(request) !== session) {
            attachments.remove(attachment.id);
            return json(response, 401, {
              error: "Room expired. Please join again.",
            });
          }
          return json(response, 201, { attachment });
        }
        if (!request.headers["content-type"]?.startsWith("application/json"))
          return json(response, 415, { error: "Use application/json." });
        if (url.pathname === "/api/nickname") {
          throttle(nicknameAttempts, request.socket.remoteAddress, 30);
          const input = await body(request);
          const name = validateNickname(input?.name);
          const identity = resolveIdentity(
            name,
            authenticate(request, undefined, false),
          );
          return json(response, 201, {
            identityToken: identity.token,
            user: { id: identity.id, name: identity.name },
          });
        }
        if (url.pathname === "/api/rooms") {
          throttle(roomCreations, request.socket.remoteAddress, 5);
          const input = await body(request);
          const session = authenticate(request, undefined, false);
          const name = session?.name || validateNickname(input?.nickname);
          const room = await rooms.create(input?.name, input?.password);
          let result;
          try {
            result = issueSession(name, room.name, session);
          } catch (error) {
            rooms.rooms.delete(room.name);
            throw error;
          }
          publishRooms();
          return json(response, 201, result);
        }
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
          const name = validateNickname(input?.name);
          const roomName = input?.room ?? "general";
          rooms.validateName(roomName);
          const room = rooms.get(roomName);
          if (!room)
            return json(response, 404, {
              error: "Room not found. Create it or use #general.",
            });
          if (input?.roomId !== undefined && input.roomId !== room.id)
            return json(response, 404, {
              error: "That room closed. Choose it again from the list.",
            });
          const existing = authenticate(request, undefined, false);
          // Renaming within the same room may reuse its existing session grant.
          if (room.hash && existing?.roomName !== roomName) {
            throttle(roomAttempts, request.socket.remoteAddress, 10);
            if (!(await rooms.verify(room, input?.password)))
              return json(response, 403, { error: "Incorrect room password." });
          }
          if (rooms.get(roomName) !== room)
            return json(response, 404, {
              error: "Room expired. Choose another room.",
            });
          return json(response, 201, issueSession(name, roomName, existing));
        }
        if (url.pathname === "/api/messages") {
          const token = request.headers.authorization?.replace(/^Bearer /, "");
          const session = authenticate(request, token);
          if (!session)
            return json(response, 401, {
              error: "Please join the chat again.",
            });
          const input = await body(request);
          if (authenticate(request) !== session)
            return json(response, 401, {
              error: "Room expired. Please join again.",
            });
          const text = typeof input?.text === "string" ? input.text.trim() : "";
          const attachmentId = input?.attachmentId;
          if (attachmentId !== undefined && typeof attachmentId !== "string")
            return json(response, 400, { error: "Invalid attachment." });
          attachments.prune();
          const file = attachmentId ? attachments.get(attachmentId) : null;
          if (
            attachmentId &&
            (!file ||
              file.attached ||
              file.ownerId !== session.id ||
              file.roomName !== session.roomName)
          )
            return json(response, 400, {
              error: "Attachment is unavailable. Please upload it again.",
            });
          if ((!text && !file) || [...text].length > MAX_LENGTH)
            return json(response, 400, {
              error:
                "Write a message or attach a file. Text is limited to 2,000 characters.",
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
            userId: session.identity.id,
            name: session.name,
            text,
            time: new Date().toISOString(),
          };
          if (file) {
            file.attached = true;
            message.attachment = attachments.metadata(file);
          }
          const messages = rooms.get(session.roomName).messages;
          messages.push(message);
          if (messages.length > MAX_MESSAGES) {
            const removed = messages.shift();
            if (removed.attachment) attachments.remove(removed.attachment.id);
          }
          broadcast(session.roomName, "message", message);
          return json(response, 201, { message });
        }
      }
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        url.pathname.startsWith("/api/files/")
      ) {
        const token =
          request.headers.authorization?.replace(/^Bearer /, "") ||
          url.searchParams.get("token");
        const session = authenticate(request, token);
        if (!session)
          return json(response, 401, { error: "Please join the chat again." });
        const file = attachments.get(url.pathname.slice("/api/files/".length));
        // Pending uploads stay private, even to other logged-in participants.
        if (!file?.attached || file.roomName !== session.roomName)
          return json(response, 404, { error: "File is no longer available." });
        session.touched = Date.now();
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": file.data.length,
          "Content-Disposition": downloadDisposition(file.name),
          "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        return response.end(request.method === "HEAD" ? undefined : file.data);
      }
      if (request.method === "GET" && url.pathname === "/api/rooms/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.write("retry: 2000\n\n");
        roomWatchers.add(response);
        send(response, "rooms", { rooms: roomList() });
        response.on("close", () => roomWatchers.delete(response));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/rooms") {
        return json(response, 200, { rooms: roomList() });
      }
      if (request.method === "GET" && url.pathname === "/api/nickname") {
        const session = authenticate(request, undefined, false);
        if (!session)
          return json(response, 401, { error: "Choose your nickname again." });
        return json(response, 200, {
          identityToken: session.identity.token,
          user: { id: session.identity.id, name: session.identity.name },
        });
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        const token = request.headers.authorization?.replace(/^Bearer /, "");
        const session = authenticate(request, token);
        if (!session)
          return json(response, 401, { error: "Please join the chat again." });
        return json(response, 200, {
          user: { id: session.identity.id, name: session.identity.name },
          room: roomInfo(rooms.get(session.roomName)),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        const session = authenticate(request, url.searchParams.get("token"));
        if (!session)
          return json(response, 401, { error: "Please join the chat again." });
        session.connections++;
        clearTimeout(emptyTimers.get(session.roomName));
        emptyTimers.delete(session.roomName);
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
          user: { id: session.identity.id, name: session.identity.name },
          messages: rooms.get(session.roomName).messages,
          room: roomInfo(rooms.get(session.roomName)),
          users: online(session.roomName),
          fileLimits: attachments.limits,
        });
        broadcast(session.roomName, "presence", online(session.roomName));
        publishRooms();
        response.on("close", () => {
          clients.delete(client);
          session.connections--;
          session.touched = Date.now();
          session.identity.expires = Date.now() + nicknameGraceMs;
          broadcast(session.roomName, "presence", online(session.roomName));
          publishRooms();
          scheduleEmpty(session.room);
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/info") {
        return json(response, 200, {
          name: "localchat",
          maxMessageLength: MAX_LENGTH,
          fileLimits: attachments.limits,
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
          ...(error.code === "NICKNAME_TAKEN" ? { code: error.code } : {}),
        });
    }
  });
  const heartbeat = setInterval(() => {
    attachments.prune();
    for (const response of roomWatchers) response.write(": heartbeat\n\n");
    for (const { response, session } of clients) {
      session.touched = Date.now();
      session.identity.expires = Date.now() + nicknameGraceMs;
      response.write(": heartbeat\n\n");
    }
    for (const [token, session] of sessions)
      if (
        session.room &&
        !session.connections &&
        Date.now() - session.touched > SESSION_TTL
      )
        sessions.delete(token);
    for (const identity of identities.values())
      if (Date.now() > identity.expires && !identityOnline(identity))
        expireIdentity(identity);
    for (const map of [joins, roomAttempts, roomCreations, nicknameAttempts]) {
      for (const [address, times] of map)
        if (Date.now() - times.at(-1) > 60000) map.delete(address);
    }
  }, 15000);
  heartbeat.unref();
  server.on("close", () => {
    clearInterval(heartbeat);
    for (const timer of emptyTimers.values()) clearTimeout(timer);
    attachments.clear();
  });
  server.stop = () => {
    stopping = true;
    for (const timer of emptyTimers.values()) clearTimeout(timer);
    for (const response of roomWatchers) response.end();
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
