import { messageMatches, messagePreview } from "/chat-text.js";
import { TabUnread } from "/unread.js";
import { UploadQueue, requestId } from "/uploads.js";
import { NotificationAudio, SOUNDS } from "/notifications.js";
const $ = (selector) => document.querySelector(selector);
const dialog = $("#join-dialog");
const input = $("#message-input");
const messages = $("#messages");
let user = null;
let token = null;
let identityToken = null;
let stream = null;
let connected = false;
let sending = false;
let loggingOut = false;
let authEpoch = 0;
const tabActive = () => !document.hidden && document.hasFocus();
const unread = new TabUnread((title) => {
  document.title = title;
});
let noticeTimer;
let seen = new Set();
const roomMessages = new Map();
let replyTarget = null;
let dragDepth = 0;
const audio = new NotificationAudio();
let roomCatalog = null;
let catalogStream = null;
let selectedEntryRoom = null;
let currentRoom = { name: "general", protected: false };
let roomBusy = false;
const drafts = new Map();
const createDialog = $("#create-dialog");
const settingsDialog = $("#settings-dialog");
const renameDialog = $("#rename-dialog");
let maxFileSize = 25 * 1024 * 1024;
let maxFilesPerMessage = 10;
let queue = makeQueue();
let pendingMessage = null;
const fileInput = $("#file-input");
const formatSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};
function makeQueue() {
  return new UploadQueue({
    credential: () => token,
    change: () => {
      updateFile();
      updateComposer();
    },
  });
}
function updateFile() {
  $("#selected-file").hidden = !queue.entries.length;
  const total = queue.entries.reduce((sum, entry) => sum + entry.file.size, 0);
  const loaded = queue.entries.reduce((sum, entry) => sum + entry.loaded, 0);
  const percent = total
    ? Math.floor((loaded / total) * 100)
    : queue.entries.every((entry) => entry.state === "ready")
      ? 100
      : 0;
  $("#file-status").textContent =
    `[files] ${queue.entries.length}/${maxFilesPerMessage} / ${percent}% / ${formatSize(loaded)} of ${formatSize(total)}`;
  $("#upload-progress").value = percent;
  const list = $("#file-list");
  // Keep cancel buttons stable while progress changes, including keyboard focus.
  for (const node of [...list.children])
    if (!queue.entries.some((entry) => entry.clientId === node.dataset.id))
      node.remove();
  for (const entry of queue.entries) {
    let row = [...list.children].find(
      (node) => node.dataset.id === entry.clientId,
    );
    if (!row) {
      row = document.createElement("li");
      row.dataset.id = entry.clientId;
      row.append(document.createElement("span"));
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "[cancel]";
      cancel.setAttribute("aria-label", `Cancel ${entry.file.name}`);
      cancel.addEventListener("click", () => queue.cancel(entry));
      row.append(cancel);
      list.append(row);
    }
    const progress = entry.file.size
      ? Math.floor((entry.loaded / entry.file.size) * 100)
      : entry.state === "ready"
        ? 100
        : 0;
    row.firstChild.textContent = `${entry.file.name} (${formatSize(entry.file.size)}) / ${progress}% / ${entry.state}`;
    row.lastChild.disabled = queue.locked;
  }
}
function clearFile() {
  queue.entries = [];
  fileInput.value = "";
  updateFile();
}
const storage = {
  get(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* Storage is optional. */
    }
  },
  remove(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Storage is optional. */
    }
  },
};
const nearBottom = () =>
  messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
function scrollBottom() {
  messages.scrollTop = messages.scrollHeight;
  $("#new-messages").hidden = true;
}
function notice(text) {
  clearTimeout(noticeTimer);
  $("#notice").textContent = text;
  $("#notice").hidden = false;
  noticeTimer = setTimeout(() => {
    $("#notice").hidden = true;
  }, 6000);
}
function setConnection(value, label) {
  connected = value;
  $("#connection-text").classList.toggle("online", value);
  $("#connection-text").textContent = `[${label}]`;
  input.disabled = !value;
  updateComposer();
}
function updateComposer() {
  const length = [...input.value.trim()].length;
  $("#send-button").disabled =
    !connected ||
    loggingOut ||
    sending ||
    roomBusy ||
    (!length && !queue.entries.length) ||
    length > 2000;
  $("#logout-button").hidden = !user;
  $("#logout-button").disabled = loggingOut || roomBusy;
  $("#attach-button").disabled = !connected || sending || loggingOut;
  $("#identity").disabled = !connected || sending || roomBusy || loggingOut;
  $("#rooms-button").disabled = !connected || sending || roomBusy || loggingOut;
  $("#character-count").textContent =
    length > 1600 ? `${length.toLocaleString()} / 2,000` : "";
  $("#character-count").classList.toggle("over", length > 2000);
  $("#search-button").disabled = !connected || loggingOut;
  updateReply();
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}
function updateReply() {
  $("#reply-draft").hidden = !replyTarget;
  $("#reply-preview").textContent = replyTarget
    ? `reply to <${replyTarget.name}>: ${replyTarget.preview}`
    : "";
  $("#reply-cancel").disabled = sending || loggingOut;
}
function chooseReply(message) {
  if (!connected || sending || loggingOut || roomBusy) return;
  replyTarget = {
    id: message.id,
    name: message.name,
    preview: messagePreview(message),
  };
  updateReply();
  input.focus();
}
function mention(name) {
  if (!connected || sending || loggingOut || roomBusy) return;
  const start = input.selectionStart;
  const prefix = start && !/\s/u.test(input.value[start - 1]) ? " " : "";
  const value = `${prefix}@${name} `;
  if (
    input.value.length - (input.selectionEnd - start) + value.length >
    input.maxLength
  )
    return;
  input.setRangeText(value, start, input.selectionEnd, "end");
  input.focus();
  updateComposer();
}
function updateSearch() {
  const query = $("#search-input").value;
  let matches = 0;
  for (const article of messages.querySelectorAll(".message")) {
    const found = messageMatches(roomMessages.get(article.dataset.id), query);
    article.hidden = !found;
    if (found) matches++;
  }
  $("#search-count").textContent = query.trim()
    ? `${matches}/${roomMessages.size} messages`
    : `${roomMessages.size} messages (latest 100)`;
}
function closeSearch() {
  $("#search-bar").hidden = true;
  $("#search-input").value = "";
  updateSearch();
}
function jumpToMessage(id) {
  const article = [...messages.querySelectorAll(".message")].find(
    (node) => node.dataset.id === id,
  );
  if (!article) {
    notice("Original message is no longer in the retained history.");
    return;
  }
  closeSearch();
  article.scrollIntoView({ block: "center" });
  article.classList.add("reply-highlight");
  setTimeout(() => article.classList.remove("reply-highlight"), 1800);
}
function appendMessageText(container, message) {
  let offset = 0;
  for (const span of message.mentions || []) {
    // Treat all content as text; even nicknames and filenames may contain HTML.
    if (
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < offset ||
      span.end > message.text.length ||
      span.end <= span.start
    )
      continue;
    container.append(
      document.createTextNode(message.text.slice(offset, span.start)),
    );
    const mark = document.createElement("mark");
    mark.className = `mention${span.id === user?.id ? " mention-self" : ""}`;
    mark.textContent = message.text.slice(span.start, span.end);
    container.append(mark);
    offset = span.end;
  }
  container.append(document.createTextNode(message.text.slice(offset)));
}
function renderPeople(users) {
  $("#people-count").textContent = users.length;
  updateRoomTitle(users.length);
  $("#no-people").hidden = users.length > 0;
  $("#people-list").replaceChildren();
  for (const person of users) {
    const li = document.createElement("li");
    li.classList.toggle("self", person.id === user?.id);
    const name = document.createElement("button");
    name.type = "button";
    name.className = "person-name";
    name.textContent = person.name;
    name.title = `Mention @${person.name}`;
    name.addEventListener("click", () => mention(person.name));
    const status = document.createElement("span");
    status.className = "you";
    if (person.id === user?.id) status.textContent = "(you)";
    li.append(name, status);
    $("#people-list").append(li);
  }
}
function renderMessage(message, history = false) {
  if (seen.has(message.id)) return;
  if (!history) unread.receive(message, user?.id, tabActive());
  if (!history && message.userId !== user?.id) audio.play();
  seen.add(message.id);
  const shouldScroll = nearBottom() || message.userId === user?.id;
  $("#empty-state").hidden = true;
  const own = message.userId === user?.id;
  const article = document.createElement("article");
  article.className = `message${own ? " own" : ""}`;
  article.dataset.id = message.id;
  roomMessages.set(message.id, message);
  const name = document.createElement("button");
  name.type = "button";
  name.title = `Mention @${message.name}`;
  name.addEventListener("click", () => mention(message.name));
  name.className = "message-name";
  name.textContent = message.name;
  const time = document.createElement("time");
  const date = new Date(message.time);
  time.dateTime = message.time;
  time.textContent = date.toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  time.title = date.toLocaleString("en");
  const text = document.createElement("div");
  text.className = "message-text";
  if (message.replyTo) {
    const quote = document.createElement("button");
    quote.type = "button";
    quote.className = "reply-quote";
    quote.textContent = `↪ <${message.replyTo.name}> ${message.replyTo.preview}`;
    quote.title = "Jump to original message";
    quote.addEventListener("click", () => jumpToMessage(message.replyTo.id));
    text.append(quote);
  }
  appendMessageText(text, message);
  for (const attachment of message.attachments ||
    (message.attachment ? [message.attachment] : [])) {
    const link = document.createElement("a");
    link.className = "attachment";
    link.href = `/api/files/${encodeURIComponent(attachment.id)}?token=${encodeURIComponent(token)}`;
    link.download = attachment.name;
    link.textContent = `[file] ${attachment.name} (${formatSize(attachment.size)}) ↓`;
    text.append(link);
  }
  const reply = document.createElement("button");
  reply.type = "button";
  reply.className = "reply-action";
  reply.textContent = "[reply]";
  reply.setAttribute(
    "aria-label",
    `Reply to ${message.name}: ${messagePreview(message)}`,
  );
  reply.addEventListener("click", () => chooseReply(message));
  article.append(time, name, text, reply);
  messages.append(article);
  // Bound both the DOM and deduplication state during long conversations.
  if (seen.size > 100) {
    const oldest = seen.values().next().value;
    seen.delete(oldest);
    roomMessages.delete(oldest);
    messages.querySelector(".message")?.remove();
  }
  updateSearch();
  if (!history && shouldScroll) scrollBottom();
  else if (!history) $("#new-messages").hidden = false;
}
async function api(path, data, auth = false) {
  const epoch = authEpoch;
  const credential =
    path === "/api/session" && connected
      ? token
      : ["/api/nickname", "/api/session", "/api/rooms"].includes(path)
        ? identityToken || token
        : token || identityToken;
  const response = await fetch(path, {
    ...(["/api/messages", "/api/logout"].includes(path)
      ? { signal: AbortSignal.timeout(15000) }
      : {}),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth
        ? {
            Authorization: `Bearer ${credential}`,
          }
        : {}),
    },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (epoch !== authEpoch)
    throw new DOMException("Session changed.", "AbortError");
  if (!response.ok)
    throw Object.assign(new Error(result.error || "Please try again."), {
      status: response.status,
      code: result.code,
    });
  return result;
}
function setRoom(room) {
  if (currentRoom.id !== room.id) {
    unread.reset(room.name);
    closeSearch();
    resetDrag();
    // A private-room draft must never silently become a public-room message.
    drafts.set(currentRoom.id, {
      text: input.value,
      queue,
      pendingMessage,
      replyTarget,
    });
    const draft = drafts.get(room.id);
    input.value = draft?.text || "";
    queue = draft?.queue || makeQueue();
    queue.limit = maxFilesPerMessage;
    pendingMessage = draft?.pendingMessage || null;
    replyTarget = draft?.replyTarget || null;
    fileInput.value = "";
    updateFile();
    messages.querySelectorAll(".message").forEach((node) => node.remove());
    seen = new Set();
    roomMessages.clear();
    $("#empty-state").hidden = false;
    $("#new-messages").hidden = true;
    renderPeople([]);
    $("#notice").hidden = true;
  }
  currentRoom = room;
  storage.set("localchat-room", JSON.stringify(room));
  updateRoomTitle();
  $("#prompt-room").textContent = `@${room.name}`;
  $("#empty-room").textContent = `#${room.name}`;
  $("#message-input").labels[0].textContent = `Message #${room.name}`;
  document.title = unread.title;
  updateComposer();
}
function acceptSession(result) {
  setRoom(result.room);
  token = result.token;
  identityToken = result.identityToken;
  user = result.user;
  storage.set("localchat-identity", identityToken);
  storage.set("commonroom-token", token);
  storage.set("commonroom-name", user.name);
  $("#join-password").value = "";
  $("#create-password").value = "";
  connect();
}
function connect() {
  stream?.close();
  setConnection(false, "connecting");
  const sessionToken = token;
  const source = new EventSource(
    `/api/events?token=${encodeURIComponent(sessionToken)}`,
  );
  stream = source;
  stream.addEventListener("ready", (event) => {
    if (stream !== source) return;
    const data = JSON.parse(event.data);
    user = data.user;
    setRoom(data.room);
    maxFileSize = data.fileLimits.maxFileSize;
    maxFilesPerMessage = data.fileLimits.maxFilesPerMessage || 10;
    queue.limit = maxFilesPerMessage;
    updateFile();
    $("#attach-button").title =
      `Attach/drop up to ${maxFilesPerMessage} files or paste an image (max ${formatSize(maxFileSize)} each)`;
    $("#my-name").textContent = user.name;
    storage.set("commonroom-name", user.name);
    const wasNearBottom = nearBottom();
    const previousScroll = messages.scrollTop;
    messages.querySelectorAll(".message").forEach((node) => node.remove());
    seen = new Set();
    roomMessages.clear();
    $("#empty-state").hidden = data.messages.length > 0;
    unread.snapshot(data.messages, user.id, tabActive());
    for (const message of data.messages) renderMessage(message, true);
    renderPeople(data.users);
    setConnection(true, "connected");
    if (wasNearBottom) scrollBottom();
    else messages.scrollTop = previousScroll;
    if (dialog.open) dialog.close();
    ($("#search-bar").hidden ? input : $("#search-input")).focus();
  });
  stream.addEventListener("message", (event) => {
    if (stream === source) renderMessage(JSON.parse(event.data));
  });
  stream.addEventListener("logged-out", () => {
    if (stream === source) resetLogin();
  });
  stream.addEventListener("profile", (event) => {
    if (stream !== source) return;
    user = JSON.parse(event.data);
    $("#my-name").textContent = user.name;
    storage.set("commonroom-name", user.name);
  });
  stream.addEventListener("presence", (event) => {
    if (stream === source) renderPeople(JSON.parse(event.data));
  });
  stream.onerror = async () => {
    if (stream !== source) return;
    setConnection(false, "reconnecting");
    // SSE retries automatically. Check for a restarted server / expired session.
    try {
      const response = await fetch("/api/session", {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      // Ignore a late check belonging to a connection already replaced.
      if (stream !== source) return;
      if (response.status === 401) {
        stream.close();
        storage.remove("commonroom-token");
        setConnection(false, "login required");
        createDialog.close();
        renameDialog.close();
        openJoin();
      }
    } catch {
      /* The server is offline; let EventSource retry. */
    }
  };
}
function nickname() {
  if (!user) throw new Error("Choose your nickname first.");
  return user.name;
}
function entrySelection(room) {
  selectedEntryRoom = room;
  $("#join-password").value = "";
  $("#join-error").textContent = "";
  const locked = room?.protected && !(connected && currentRoom.id === room.id);
  $("#join-password-field").hidden = !locked;
  $("#join-password-label").textContent = room
    ? `password for #${room.name}:`
    : "room password:";
  $("#join-button").hidden = !room;
  $("#join-button").textContent = room ? `[join #${room.name}]` : "[join]";
  renderRoomList();
}
function renderRoomList() {
  const list = $("#entry-room-list");
  if (!roomCatalog) {
    list.textContent = "loading rooms…";
    return;
  }
  const existing = new Map(
    [...list.querySelectorAll("button")].map((button) => [
      button.dataset.roomId,
      button.parentElement,
    ]),
  );
  if (!existing.size) list.replaceChildren();
  for (const room of roomCatalog) {
    let li = existing.get(room.id);
    if (!li) {
      li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.roomId = room.id;
      button.addEventListener("click", () => {
        if (roomBusy) return;
        const latest = roomCatalog.find(
          (item) => item.id === button.dataset.roomId,
        );
        if (!latest) return;
        entrySelection(latest);
        try {
          nickname();
        } catch (error) {
          $("#join-error").textContent = error.message;
          $("#name-input").focus();
          return;
        }
        ($("#join-password-field").hidden
          ? $("#join-button")
          : $("#join-password")
        ).focus();
      });
      li.append(button);
      list.append(li);
    }
    const button = li.firstElementChild;
    button.textContent = `#${room.name} (${room.count})${room.protected ? " [locked]" : ""}`;
    button.setAttribute(
      "aria-pressed",
      String(selectedEntryRoom?.id === room.id),
    );
    button.disabled = roomBusy;
    existing.delete(room.id);
  }
  for (const li of existing.values()) li.remove();
}
function updateRoomTitle(
  count = roomCatalog?.find((room) => room.id === currentRoom.id)?.count || 0,
) {
  $("#room-title").textContent =
    ` / #${currentRoom.name} (${count})${currentRoom.protected ? " [locked]" : ""}`;
}
function startCatalog() {
  catalogStream?.close();
  const source = new EventSource("/api/rooms/events");
  catalogStream = source;
  source.addEventListener("rooms", (event) => {
    if (catalogStream !== source) return;
    roomCatalog = JSON.parse(event.data).rooms;
    const roomIds = new Set(roomCatalog.map((room) => room.id));
    for (const id of drafts.keys()) if (!roomIds.has(id)) drafts.delete(id);
    if (selectedEntryRoom && !roomIds.has(selectedEntryRoom.id)) {
      entrySelection(null);
      $("#join-error").textContent =
        "That room closed. Choose another room or create one.";
    }
    renderRoomList();
    updateRoomTitle();
  });
}
function entryBusy(value) {
  roomBusy = value;
  for (const root of [dialog, createDialog, renameDialog]) {
    for (const control of root.querySelectorAll("button, input"))
      control.disabled = value;
  }
  updateComposer();
}
function showEntryStep(roomsOnly) {
  $("#nickname-step").hidden = roomsOnly;
  $("#room-step").hidden = !roomsOnly;
  $("#join-title").textContent = roomsOnly
    ? "localchat / rooms"
    : "localchat / nickname";
  $("#entry-back").hidden = connected;
  $("#entry-close").hidden = !connected;
}
function openJoin(roomsOnly = false) {
  $("#name-input").value = user?.name || storage.get("commonroom-name") || "";
  entrySelection(null);
  showEntryStep(roomsOnly && !!user);
  if (!dialog.open) dialog.showModal();
  if (!$("#room-step").hidden) $("#entry-room-list button")?.focus();
  else $("#name-input").focus();
}
function abandonDrafts() {
  for (const uploads of new Set([
    queue,
    ...[...drafts.values()].map((draft) => draft.queue),
  ]))
    uploads.abandon();
}
function resetLogin() {
  authEpoch++;
  stream?.close();
  stream = null;
  abandonDrafts();
  drafts.clear();
  token = identityToken = user = null;
  loggingOut = sending = false;
  for (const key of [
    "commonroom-token",
    "localchat-identity",
    "commonroom-name",
    "localchat-room",
  ])
    storage.remove(key);
  input.value = "";
  fileInput.value = "";
  queue = makeQueue();
  pendingMessage = null;
  replyTarget = null;
  roomMessages.clear();
  closeSearch();
  resetDrag();
  currentRoom = { name: "general", protected: false };
  unread.reset("general");
  setRoom(currentRoom);
  messages.querySelectorAll(".message").forEach((node) => node.remove());
  seen = new Set();
  $("#empty-state").hidden = false;
  $("#new-messages").hidden = true;
  $("#my-name").textContent = "guest";
  $("#notice").hidden = true;
  clearTimeout(noticeTimer);
  renderPeople([]);
  for (const modal of [createDialog, renameDialog, settingsDialog])
    modal.close();
  entryBusy(false);
  setConnection(false, "logged out");
  updateFile();
  openJoin();
  if (!catalogStream) startCatalog();
}
$("#logout-button").addEventListener("click", async () => {
  if (loggingOut || roomBusy || !user) return;
  const epoch = authEpoch;
  loggingOut = true;
  // Free HTTP/1 connection slots before POST, even with several chat tabs open.
  stream?.close();
  stream = null;
  catalogStream?.close();
  catalogStream = null;
  abandonDrafts();
  updateComposer();
  try {
    await api("/api/logout", {}, true);
    resetLogin();
  } catch (error) {
    if (authEpoch !== epoch) return; // SSE may confirm logout before the HTTP reply.
    if (error.status === 401) resetLogin();
    else
      notice(
        "Could not confirm logout. Reconnect and try again; your nickname may still be reserved.",
      );
  } finally {
    if (authEpoch === epoch) {
      loggingOut = false;
      if (!catalogStream) startCatalog();
      if (token && !stream) connect();
      updateComposer();
    }
  }
});
for (const event of ["visibilitychange", "focus"]) {
  (event === "focus" ? window : document).addEventListener(event, () =>
    unread.read(tabActive()),
  );
}
$("#rooms-button").addEventListener("click", () => openJoin(true));
$("#entry-close").addEventListener("click", () => dialog.close());
$("#entry-back").addEventListener("click", () => {
  entrySelection(null);
  showEntryStep(false);
  $("#name-input").value = user?.name || "";
  $("#name-input").focus();
});
dialog.addEventListener("cancel", (event) => {
  if (!connected || roomBusy) event.preventDefault();
});
dialog.addEventListener("close", () => {
  $("#join-password").value = "";
});
$("#name-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    $("#nickname-next").click();
  }
});
$("#nickname-next").addEventListener("click", async () => {
  if (roomBusy) return;
  try {
    const name = $("#name-input").value.trim();
    if (!name || [...name].length > 24)
      throw new Error("Use a nickname between 1 and 24 characters.");
    entryBusy(true);
    $("#join-error").textContent = "";
    const result = await api(
      "/api/nickname",
      { name },
      !!(identityToken || token),
    );
    user = result.user;
    identityToken = result.identityToken;
    storage.set("localchat-identity", identityToken);
    storage.set("commonroom-name", user.name);
    showEntryStep(true);
    $("#entry-room-list button")?.focus();
  } catch (error) {
    $("#join-error").textContent = error.message;
  } finally {
    entryBusy(false);
  }
});
$("#join-password").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    $("#join-button").click();
  }
});
$("#join-button").addEventListener("click", async () => {
  if (roomBusy || !selectedEntryRoom) return;
  const room = selectedEntryRoom;
  try {
    const name = nickname();
    const password = $("#join-password").value;
    if (
      room.protected &&
      !(connected && currentRoom.id === room.id) &&
      !password
    )
      throw new Error("Enter the room password.");
    entryBusy(true);
    $("#join-error").textContent = "";
    const result = await api(
      "/api/session",
      { name, room: room.name, roomId: room.id, password },
      !!(identityToken || token),
    );
    // The server verifies the live room generation as well as the password.
    dialog.close();
    acceptSession(result);
  } catch (error) {
    $("#join-error").textContent =
      error instanceof TypeError ? "Cannot reach the server." : error.message;
    $("#join-password").value = "";
    if (error.code === "NICKNAME_TAKEN") showEntryStep(false);
  } finally {
    entryBusy(false);
  }
});
$("#open-create").addEventListener("click", () => {
  try {
    nickname();
  } catch (error) {
    $("#join-error").textContent = error.message;
    $("#name-input").focus();
    return;
  }
  $("#create-name").value = "";
  $("#create-password").value = "";
  $("#create-error").textContent = "";
  createDialog.showModal();
  $("#create-name").focus();
});
createDialog.addEventListener("cancel", (event) => {
  if (roomBusy) event.preventDefault();
});
createDialog.addEventListener("close", () => {
  $("#create-password").value = "";
});
$("#create-back").addEventListener("click", () => createDialog.close());
for (const selector of ["#create-name", "#create-password"]) {
  $(selector).addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      $("#create-button").click();
    }
  });
}
$("#create-button").addEventListener("click", async () => {
  if (roomBusy) return;
  try {
    const name = $("#create-name").value;
    const password = $("#create-password").value;
    const nick = nickname();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name))
      throw new Error("Room names use 1–32 lowercase letters, digits, _ or -.");
    if ([...password].length > 128)
      throw new Error("Password is limited to 128 characters.");
    entryBusy(true);
    $("#create-error").textContent = "";
    const result = await api(
      "/api/rooms",
      { name, password, nickname: nick },
      !!(identityToken || token),
    );
    createDialog.close();
    dialog.close();
    acceptSession(result);
  } catch (error) {
    $("#create-error").textContent =
      error instanceof TypeError ? "Cannot reach the server." : error.message;
    $("#create-password").value = "";
    if (error.code === "NICKNAME_TAKEN") {
      createDialog.close();
      showEntryStep(false);
      $("#join-error").textContent = error.message;
    }
  } finally {
    entryBusy(false);
  }
});
$("#identity").addEventListener("click", () => {
  $("#rename-name").value = user.name;
  $("#rename-error").textContent = "";
  renameDialog.showModal();
  $("#rename-name").focus();
});
$("#rename-close").addEventListener("click", () => renameDialog.close());
renameDialog.addEventListener("cancel", (event) => {
  if (roomBusy) event.preventDefault();
});
$("#rename-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (roomBusy) return;
  try {
    const name = $("#rename-name").value.trim();
    if (!name || [...name].length > 24)
      throw new Error("Use a nickname between 1 and 24 characters.");
    entryBusy(true);
    const result = await api(
      "/api/session",
      { name, room: currentRoom.name },
      true,
    );
    renameDialog.close();
    acceptSession(result);
  } catch (error) {
    $("#rename-error").textContent = error.message;
  } finally {
    entryBusy(false);
  }
});

for (const preset of [{ id: "off", name: "Off (muted)" }, ...SOUNDS]) {
  const option = document.createElement("option");
  option.value = preset.id;
  option.textContent = preset.name;
  $("#notification-sound").append(option);
}
function showAudioSettings() {
  $("#notification-sound").value = audio.sound;
  $("#notification-volume").value = audio.volume;
  $("#volume-value").textContent = `${audio.volume}%`;
}
async function previewSound() {
  const ready = await audio.unlock();
  $("#audio-status").textContent =
    audio.sound === "off" || !audio.volume
      ? "Muted."
      : ready && audio.play(true)
        ? ""
        : "Audio unavailable or blocked by the browser.";
}
$("#settings-button").addEventListener("click", () => {
  showAudioSettings();
  $("#audio-status").textContent = "";
  settingsDialog.showModal();
});
$("#settings-close").addEventListener("click", () => settingsDialog.close());
$("#notification-sound").addEventListener("change", () => {
  audio.set(
    $("#notification-sound").value,
    Number($("#notification-volume").value),
  );
  previewSound();
});
$("#notification-volume").addEventListener("input", () => {
  audio.set(
    $("#notification-sound").value,
    Number($("#notification-volume").value),
  );
  $("#volume-value").textContent = `${audio.volume}%`;
});
$("#notification-volume").addEventListener("change", previewSound);
$("#test-sound").addEventListener("click", previewSound);
for (const gesture of ["pointerdown", "keydown"])
  document.addEventListener(
    gesture,
    () => {
      audio.unlock();
    },
    { capture: true },
  );

$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("#send-button").disabled) return;
  const draft = input.value;
  const text = draft.trim();
  const replyToId = replyTarget?.id || null;
  const sendingEpoch = authEpoch;
  const sendingQueue = queue;
  const sendingRoom = currentRoom.id;
  const sendingToken = token;
  sending = true;
  updateComposer();
  try {
    const attachmentIds = await sendingQueue.uploadAll();
    if (sendingEpoch !== authEpoch || loggingOut) return;
    if (
      currentRoom.id !== sendingRoom ||
      queue !== sendingQueue ||
      token !== sendingToken
    )
      throw new Error(
        "Room session changed. Your original-room draft has been kept; send it again there.",
      );
    if (!text && !attachmentIds.length) return;
    const signature = JSON.stringify({ text, attachmentIds, replyToId });
    if (pendingMessage?.signature !== signature)
      pendingMessage = { signature, clientMessageId: requestId() };
    // Publishing is atomic. Cancellation is only offered before the commit request.
    queue.locked = true;
    updateFile();
    const result = await api(
      "/api/messages",
      {
        text,
        attachmentIds,
        replyToId,
        clientMessageId: pendingMessage.clientMessageId,
      },
      true,
    );
    sendingQueue.entries = [];
    if (currentRoom.id !== sendingRoom || queue !== sendingQueue) return;
    pendingMessage = null;
    replyTarget = null;
    updateReply();
    clearFile();
    clearTimeout(noticeTimer);
    $("#notice").hidden = true;
    renderMessage(result.message);
    // Don't erase text typed while the send request was in flight.
    if (input.value === draft) input.value = "";
    scrollBottom();
  } catch (error) {
    if (sendingEpoch !== authEpoch || loggingOut) return;
    notice(
      error.name === "AbortError"
        ? "Upload cancelled."
        : error instanceof TypeError
          ? "Message not sent. Check your connection and try again."
          : error.message,
    );
    if (error.status === 401) {
      stream?.close();
      setConnection(false, "login required");
      openJoin();
    }
  } finally {
    sendingQueue.locked = false;
    if (sendingEpoch === authEpoch) {
      sending = false;
      updateFile();
      updateComposer();
      if (!loggingOut) input.focus();
    }
  }
});
$("#attach-button").addEventListener("click", () => fileInput.click());
function addFiles(files) {
  if (
    !connected ||
    sending ||
    loggingOut ||
    roomBusy ||
    document.querySelector("dialog[open]")
  ) {
    notice("Join a room and finish the current send before attaching files.");
    return;
  }
  for (const file of files) {
    if (file.size > maxFileSize) {
      notice(`File is too large. Maximum size: ${formatSize(maxFileSize)}.`);
      continue;
    }
    if ([...file.name].length > 180) {
      notice("File name is too long. Use up to 180 characters.");
      continue;
    }
    try {
      queue.add(file);
    } catch (error) {
      notice(error.message);
      break;
    }
  }
  updateFile();
  updateComposer();
  input.focus();
}
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});
const fileDrag = (event) =>
  Array.from(event.dataTransfer?.types || []).includes("Files");
function resetDrag() {
  dragDepth = 0;
  $("#drop-hint").hidden = true;
  $(".terminal").classList.remove("drag-active");
}
document.addEventListener("dragenter", (event) => {
  if (!fileDrag(event)) return;
  event.preventDefault();
  dragDepth++;
  if (
    connected &&
    !sending &&
    !loggingOut &&
    !roomBusy &&
    !document.querySelector("dialog[open]")
  ) {
    $("#drop-hint").hidden = false;
    $(".terminal").classList.add("drag-active");
  }
});
document.addEventListener("dragover", (event) => {
  if (!fileDrag(event)) return;
  event.preventDefault(); // Never navigate away from chat when a file is dropped.
  event.dataTransfer.dropEffect =
    connected &&
    !sending &&
    !loggingOut &&
    !roomBusy &&
    !document.querySelector("dialog[open]")
      ? "copy"
      : "none";
});
document.addEventListener("dragleave", (event) => {
  if (!fileDrag(event)) return;
  if (--dragDepth <= 0) resetDrag();
});
document.addEventListener("dragend", resetDrag);
window.addEventListener("blur", resetDrag);
document.addEventListener("drop", (event) => {
  if (!fileDrag(event)) return;
  event.preventDefault();
  resetDrag();
  const items = [...(event.dataTransfer.items || [])];
  const files = items.length
    ? items
        .filter(
          (item) =>
            item.kind === "file" && !item.webkitGetAsEntry?.()?.isDirectory,
        )
        .map((item) => item.getAsFile())
        .filter(Boolean)
    : [...event.dataTransfer.files];
  if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory))
    notice("Drop files, not folders.");
  if (files.length) addFiles(files);
});
document.addEventListener("paste", (event) => {
  if (
    document.querySelector("dialog[open]") ||
    !connected ||
    sending ||
    loggingOut ||
    roomBusy
  )
    return;
  if (
    event.target !== input &&
    event.target.closest?.("input, textarea, [contenteditable]")
  )
    return;
  const images = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!images.length) return; // Ordinary text paste keeps the browser's normal behavior.
  event.preventDefault();
  const text = event.clipboardData.getData("text/plain");
  if (text) {
    const available =
      input.maxLength -
      input.value.length +
      input.selectionEnd -
      input.selectionStart;
    input.setRangeText(
      text.slice(0, Math.max(0, available)),
      input.selectionStart,
      input.selectionEnd,
      "end",
    );
  }
  addFiles(
    images.map((file, index) => {
      if (file.name) return file;
      const extension =
        {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/webp": "webp",
          "image/gif": "gif",
          "image/avif": "avif",
          "image/bmp": "bmp",
          "image/svg+xml": "svg",
        }[file.type] || "bin";
      return new File(
        [file],
        `pasted-image-${Date.now()}-${index}.${extension}`,
        { type: file.type },
      );
    }),
  );
});
$("#reply-cancel").addEventListener("click", () => {
  replyTarget = null;
  updateReply();
  input.focus();
});
$("#search-button").addEventListener("click", () => {
  $("#search-bar").hidden = false;
  updateSearch();
  $("#search-input").focus();
  $("#search-input").select();
});
$("#search-close").addEventListener("click", () => {
  closeSearch();
  input.focus();
});
$("#search-input").addEventListener("input", updateSearch);
$("#search-input").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
    input.focus();
  } else if (event.key === "Enter") {
    event.preventDefault();
    messages
      .querySelector(".message:not([hidden])")
      ?.scrollIntoView({ block: "center" });
  }
});
document.addEventListener("keydown", (event) => {
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "f" &&
    connected &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    $("#search-button").click();
  }
});
input.addEventListener("input", updateComposer);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("#message-form").requestSubmit();
  }
});
messages.addEventListener("scroll", () => {
  if (nearBottom()) $("#new-messages").hidden = true;
});
$("#new-messages").addEventListener("click", scrollBottom);
window.addEventListener("pagehide", () => {
  stream?.close();
  catalogStream?.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    startCatalog();
    if (token) connect();
  }
});
try {
  const savedRoom = JSON.parse(storage.get("localchat-room"));
  if (
    savedRoom &&
    typeof savedRoom.name === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,31}$/.test(savedRoom.name)
  )
    setRoom({
      id: typeof savedRoom.id === "string" ? savedRoom.id : "",
      name: savedRoom.name,
      protected: !!savedRoom.protected,
    });
} catch {
  /* Ignore invalid optional storage. */
}
startCatalog();
token = storage.get("commonroom-token");
identityToken = storage.get("localchat-identity");
async function restoreEntry() {
  if (identityToken || token) {
    try {
      const response = await fetch("/api/nickname", {
        headers: { Authorization: `Bearer ${identityToken || token}` },
      });
      if (response.ok) {
        const result = await response.json();
        identityToken = result.identityToken;
        user = result.user;
        storage.set("localchat-identity", identityToken);
        if (token) connect();
        else openJoin(true);
        return;
      }
    } catch {
      /* Keep the initial nickname screen available while offline. */
    }
  }
  openJoin();
}
restoreEntry();
