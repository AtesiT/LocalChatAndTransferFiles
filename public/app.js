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
let noticeTimer;
let seen = new Set();
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
    sending ||
    roomBusy ||
    (!length && !queue.entries.length) ||
    length > 2000;
  $("#attach-button").disabled = !connected || sending;
  $("#identity").disabled = !connected || sending || roomBusy;
  $("#rooms-button").disabled = !connected || sending || roomBusy;
  $("#character-count").textContent =
    length > 1600 ? `${length.toLocaleString()} / 2,000` : "";
  $("#character-count").classList.toggle("over", length > 2000);
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}
function renderPeople(users) {
  $("#people-count").textContent = users.length;
  updateRoomTitle(users.length);
  $("#no-people").hidden = users.length > 0;
  $("#people-list").replaceChildren();
  for (const person of users) {
    const li = document.createElement("li");
    li.classList.toggle("self", person.id === user?.id);
    const name = document.createElement("span");
    name.className = "person-name";
    name.textContent = person.name;
    const status = document.createElement("span");
    status.className = "you";
    if (person.id === user?.id) status.textContent = "(you)";
    li.append(name, status);
    $("#people-list").append(li);
  }
}
function renderMessage(message, history = false) {
  if (seen.has(message.id)) return;
  if (!history && message.userId !== user?.id) audio.play();
  seen.add(message.id);
  const shouldScroll = nearBottom() || message.userId === user?.id;
  $("#empty-state").hidden = true;
  const own = message.userId === user?.id;
  const article = document.createElement("article");
  article.className = `message${own ? " own" : ""}`;
  const name = document.createElement("strong");
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
  text.textContent = message.text;
  for (const attachment of message.attachments ||
    (message.attachment ? [message.attachment] : [])) {
    const link = document.createElement("a");
    link.className = "attachment";
    link.href = `/api/files/${encodeURIComponent(attachment.id)}?token=${encodeURIComponent(token)}`;
    link.download = attachment.name;
    link.textContent = `[file] ${attachment.name} (${formatSize(attachment.size)}) ↓`;
    text.append(link);
  }
  article.append(time, name, text);
  messages.append(article);
  // Bound both the DOM and deduplication state during long conversations.
  if (seen.size > 100) {
    seen.delete(seen.values().next().value);
    messages.querySelector(".message")?.remove();
  }
  if (!history && shouldScroll) scrollBottom();
  else if (!history) $("#new-messages").hidden = false;
}
async function api(path, data, auth = false) {
  const credential =
    path === "/api/session" && connected
      ? token
      : ["/api/nickname", "/api/session", "/api/rooms"].includes(path)
        ? identityToken || token
        : token;
  const response = await fetch(path, {
    ...(path === "/api/messages" ? { signal: AbortSignal.timeout(15000) } : {}),
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
  if (!response.ok)
    throw Object.assign(new Error(result.error || "Please try again."), {
      status: response.status,
      code: result.code,
    });
  return result;
}
function setRoom(room) {
  if (currentRoom.id !== room.id) {
    // A private-room draft must never silently become a public-room message.
    drafts.set(currentRoom.id, { text: input.value, queue, pendingMessage });
    const draft = drafts.get(room.id);
    input.value = draft?.text || "";
    queue = draft?.queue || makeQueue();
    queue.limit = maxFilesPerMessage;
    pendingMessage = draft?.pendingMessage || null;
    fileInput.value = "";
    updateFile();
    messages.querySelectorAll(".message").forEach((node) => node.remove());
    seen = new Set();
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
  document.title = `localchat / #${room.name}`;
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
      `Attach up to ${maxFilesPerMessage} files (max ${formatSize(maxFileSize)} each)`;
    $("#my-name").textContent = user.name;
    storage.set("commonroom-name", user.name);
    const wasNearBottom = nearBottom();
    const previousScroll = messages.scrollTop;
    messages.querySelectorAll(".message").forEach((node) => node.remove());
    seen = new Set();
    $("#empty-state").hidden = data.messages.length > 0;
    for (const message of data.messages) renderMessage(message, true);
    renderPeople(data.users);
    setConnection(true, "connected");
    if (wasNearBottom) scrollBottom();
    else messages.scrollTop = previousScroll;
    if (dialog.open) dialog.close();
    input.focus();
  });
  stream.addEventListener("message", (event) => {
    if (stream === source) renderMessage(JSON.parse(event.data));
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
  const sendingQueue = queue;
  const sendingRoom = currentRoom.id;
  const sendingToken = token;
  sending = true;
  updateComposer();
  try {
    const attachmentIds = await sendingQueue.uploadAll();
    if (
      currentRoom.id !== sendingRoom ||
      queue !== sendingQueue ||
      token !== sendingToken
    )
      throw new Error(
        "Room session changed. Your original-room draft has been kept; send it again there.",
      );
    if (!text && !attachmentIds.length) return;
    const signature = JSON.stringify({ text, attachmentIds });
    if (pendingMessage?.signature !== signature)
      pendingMessage = { signature, clientMessageId: requestId() };
    // Publishing is atomic. Cancellation is only offered before the commit request.
    queue.locked = true;
    updateFile();
    const result = await api(
      "/api/messages",
      { text, attachmentIds, clientMessageId: pendingMessage.clientMessageId },
      true,
    );
    sendingQueue.entries = [];
    if (currentRoom.id !== sendingRoom || queue !== sendingQueue) return;
    pendingMessage = null;
    clearFile();
    clearTimeout(noticeTimer);
    $("#notice").hidden = true;
    renderMessage(result.message);
    // Don't erase text typed while the send request was in flight.
    if (input.value === draft) input.value = "";
    scrollBottom();
  } catch (error) {
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
    sending = false;
    sendingQueue.locked = false;
    updateFile();
    updateComposer();
    input.focus();
  }
});
$("#attach-button").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  for (const file of fileInput.files) {
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
  fileInput.value = "";
  updateFile();
  updateComposer();
  input.focus();
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
