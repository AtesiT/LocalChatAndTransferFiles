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
  ["/unread.js", ["unread.js", "text/javascript; charset=utf-8"]],
  ["/uploads.js", ["uploads.js", "text/javascript; charset=utf-8"]],
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
  const disconnect = (client) => {
    if (!clients.delete(client)) return;
    const { session } = client;
    session.connections--;
    session.touched = Date.now();
    session.identity.expires = Date.now() + nicknameGraceMs;
    broadcast(session.roomName, "presence", online(session.roomName));
    publishRooms();
    scheduleEmpty(session.room);
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
    identity.revoked = true;
    if (identities.get(identity.key) === identity)
      identities.delete(identity.key);
    for (const [token, session] of sessions)
      if (session.identity === identity) sessions.delete(token);
  };
  const resolveIdentity = (name, existing) => {
    if (existing?.identity.revoked)
      throw Object.assign(
        new Error("Session ended. Please choose a nickname again."),
        { status: 401 },
      );
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
      if (["POST", "PATCH", "DELETE"].includes(request.method)) {
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
        const uploadMatch = /^\/api\/uploads\/([a-f0-9-]+)$/.exec(url.pathname);
        if (uploadMatch && ["PATCH", "DELETE"].includes(request.method)) {
          const session = authenticate(request);
          if (!session)
            return json(response, 401, {
              error: "Please join the chat again.",
            });
          const file = attachments.ownedUpload(
            uploadMatch[1],
            session.identity.id,
            session.room.id,
          );
          if (file.attached)
            return json(response, 409, {
              error: "Published attachments cannot be cancelled.",
            });
          if (request.method === "DELETE") {
            attachments.remove(file.id);
            return json(response, 200, { cancelled: true });
          }
          if (request.headers["content-type"] !== "application/octet-stream")
            return json(response, 415, {
              error: "Use application/octet-stream for chunks.",
            });
          const status = await attachments.append(request, file);
          if (authenticate(request) !== session) {
            attachments.remove(file.id);
            return json(response, 401, {
              error: "Room expired. Please join again.",
            });
          }
          return json(response, 200, { upload: status });
        }
        if (request.method !== "POST")
          return json(response, 404, { error: "Not found." });
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
        if (url.pathname === "/api/uploads") {
          const session = authenticate(request);
          if (!session)
            return json(response, 401, {
              error: "Please join the chat again.",
            });
          const input = await body(request);
          if (authenticate(request) !== session)
            return json(response, 401, {
              error: "Room expired. Please join again.",
            });
          attachments.prune();
          if (
            !attachments.findUpload(
              input?.clientId,
              session.identity.id,
              session.room.id,
            )
          ) {
            session.identity.uploadStarts = (
              session.identity.uploadStarts || []
            ).filter((time) => Date.now() - time < 60000);
            if (session.identity.uploadStarts.length >= 30)
              return json(response, 429, {
                error: "Too many new uploads. Try again in a minute.",
              });
            session.identity.uploadStarts.push(Date.now());
          }
          const file = attachments.start(
            input || {},
            session.identity.id,
            session.room,
          );
          return json(response, 201, { upload: attachments.status(file) });
        }
        if (url.pathname === "/api/logout") {
          const session = authenticate(request, undefined, false);
          if (!session)
            return json(response, 401, {
              error: "Already logged out or session expired.",
            });
          await body(request);
          if (authenticate(request, undefined, false) !== session)
            return json(response, 401, {
              error: "Already logged out or session expired.",
            });
          const ownerSessions = new Set(
            [...sessions.values()]
              .filter((entry) => entry.identity === session.identity)
              .map((entry) => entry.id),
          );
          expireIdentity(session.identity);
          attachments.removeOwner(session.identity.id, ownerSessions);
          // Detach synchronously: counts and nickname availability change before replying.
          for (const client of [...clients]) {
            if (client.session.identity !== session.identity) continue;
            send(client.response, "logged-out", {});
            disconnect(client);
            client.response.end();
          }
          return json(response, 200, { loggedOut: true });
        }
        if (url.pathname === "/api/nickname") {
          const original = authenticate(request, undefined, false);
          throttle(nicknameAttempts, request.socket.remoteAddress, 30);
          const input = await body(request);
          if (original?.identity.revoked)
            return json(response, 401, {
              error: "Session ended. Please join again.",
            });
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
          const original = authenticate(request, undefined, false);
          throttle(roomCreations, request.socket.remoteAddress, 5);
          const input = await body(request);
          if (original?.identity.revoked)
            return json(response, 401, {
              error: "Session ended. Please join again.",
            });
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
          const original = authenticate(request, undefined, false);
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
          if (original?.identity.revoked)
            return json(response, 401, {
              error: "Session ended. Please join again.",
            });
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
          if (
            input?.attachmentId !== undefined &&
            input?.attachmentIds !== undefined
          )
            return json(response, 400, {
              error: "Use attachmentIds or attachmentId, not both.",
            });
          const legacy = input?.attachmentId !== undefined;
          const ids =
            input?.attachmentIds !== undefined
              ? input.attachmentIds
              : legacy
                ? [input.attachmentId]
                : [];
          if (
            !Array.isArray(ids) ||
            ids.length > attachments.limits.maxFilesPerMessage ||
            ids.some((id) => typeof id !== "string" || !id) ||
            new Set(ids).size !== ids.length
          )
            return json(response, 400, {
              error: `Attach up to ${attachments.limits.maxFilesPerMessage} different files.`,
            });
          const clientMessageId = input?.clientMessageId;
          if (
            clientMessageId !== undefined &&
            (typeof clientMessageId !== "string" ||
              !/^[a-zA-Z0-9_-]{16,80}$/.test(clientMessageId))
          )
            return json(response, 400, {
              error: "Invalid message request ID.",
            });
          const room = session.room;
          room.messageRequests ||= new Map();
          const requestKey = clientMessageId
            ? `${session.identity.id}:${clientMessageId}`
            : null;
          const signature = JSON.stringify({ text, ids });
          const prior = requestKey && room.messageRequests.get(requestKey);
          if (prior) {
            if (prior.signature !== signature)
              return json(response, 409, {
                error: "Message request ID already belongs to another message.",
              });
            return json(response, 201, { message: prior.message });
          }
          attachments.prune();
          const attachedFiles = ids.map((id) => attachments.get(id));
          if (
            attachedFiles.some(
              (file) =>
                !file ||
                file.attached ||
                file.roomName !== session.roomName ||
                (file.ownerIdentityId
                  ? file.ownerIdentityId !== session.identity.id ||
                    file.roomId !== room.id
                  : file.ownerId !== session.id),
            )
          )
            return json(response, 400, {
              error: "Attachment is unavailable. Please upload it again.",
            });
          if ((!text && !attachedFiles.length) || [...text].length > MAX_LENGTH)
            return json(response, 400, {
              error:
                "Write a message or attach files. Text is limited to 2,000 characters.",
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
          for (const file of attachedFiles) file.attached = true;
          if (legacy)
            message.attachment = attachments.metadata(attachedFiles[0]);
          else if (attachedFiles.length)
            message.attachments = attachedFiles.map((file) =>
              attachments.metadata(file),
            );
          const messages = room.messages;
          messages.push(message);
          if (requestKey)
            room.messageRequests.set(requestKey, { signature, message });
          if (messages.length > MAX_MESSAGES) {
            const removed = messages.shift();
            for (const file of removed.attachments ||
              (removed.attachment ? [removed.attachment] : []))
              attachments.remove(file.id);
            for (const [key, entry] of room.messageRequests)
              if (entry.message.id === removed.id)
                room.messageRequests.delete(key);
          }
          broadcast(session.roomName, "message", message);
          return json(response, 201, { message });
        }
      }
      if (
        request.method === "GET" &&
        /^\/api\/uploads\/([a-f0-9-]+)$/.test(url.pathname)
      ) {
        const session = authenticate(request);
        if (!session)
          return json(response, 401, { error: "Please join the chat again." });
        const file = attachments.ownedUpload(
          url.pathname.split("/").at(-1),
          session.identity.id,
          session.room.id,
        );
        return json(response, 200, { upload: attachments.status(file) });
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
        response.on("close", () => disconnect(client));
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
