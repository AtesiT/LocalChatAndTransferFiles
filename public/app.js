const $ = (selector) => document.querySelector(selector);
const dialog = $("#join-dialog");
const input = $("#message-input");
const messages = $("#messages");
let user = null;
let token = null;
let stream = null;
let connected = false;
let sending = false;
let noticeTimer;
let seen = new Set();
let changingName = false;
let currentRoom = { name: "general", protected: false };
let roomBusy = false;
const drafts = new Map();
const roomDialog = $("#rooms-dialog");
let selectedFile = null;
let uploadedAttachment = null;
let uploadRequest = null;
let maxFileSize = 25 * 1024 * 1024;
const fileInput = $("#file-input");
const formatSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};
function updateFile() {
  $("#selected-file").hidden = !selectedFile;
  $("#file-status").textContent = selectedFile
    ? `[file] ${selectedFile.name} (${formatSize(selectedFile.size)})`
    : "";
}
function clearFile() {
  selectedFile = null;
  uploadedAttachment = null;
  fileInput.value = "";
  updateFile();
}
function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    uploadRequest = xhr;
    xhr.open("POST", "/api/files");
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.responseType = "json";
    xhr.timeout = 120000;
    const progress = (label) => {
      $("#file-status").textContent =
        `[file] ${file.name} (${formatSize(file.size)}) / ${label}`;
    };
    progress("uploading 0%");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        progress(
          `uploading ${Math.round((event.loaded / event.total) * 100)}%`,
        );
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response?.attachment?.id)
        resolve(xhr.response.attachment);
      else
        reject(
          Object.assign(
            new Error(
              xhr.response?.error || "Upload failed. Please try again.",
            ),
            { status: xhr.status },
          ),
        );
    };
    xhr.onerror = () =>
      reject(new Error("Upload failed. Check your connection and try again."));
    xhr.ontimeout = () =>
      reject(new Error("Upload timed out. Please try again."));
    xhr.onabort = () =>
      reject(new DOMException("Upload cancelled.", "AbortError"));
    xhr.send(file);
  }).finally(() => {
    uploadRequest = null;
    $("#remove-file").textContent = "[remove]";
    updateFile();
    updateComposer();
  });
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
    (!length && !selectedFile) ||
    length > 2000;
  $("#attach-button").disabled = !connected || sending;
  $("#identity").disabled = sending || roomBusy;
  $("#rooms-button").disabled = !connected || sending || roomBusy;
  $("#remove-file").disabled = sending && !uploadRequest;
  $("#character-count").textContent =
    length > 1600 ? `${length.toLocaleString()} / 2,000` : "";
  $("#character-count").classList.toggle("over", length > 2000);
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}
function renderPeople(users) {
  $("#people-count").textContent = users.length;
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
  if (message.attachment) {
    const link = document.createElement("a");
    link.className = "attachment";
    link.href = `/api/files/${encodeURIComponent(message.attachment.id)}?token=${encodeURIComponent(token)}`;
    link.download = message.attachment.name;
    link.textContent = `[file] ${message.attachment.name} (${formatSize(message.attachment.size)}) ↓`;
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
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error || "Please try again."), {
      status: response.status,
    });
  return result;
}
function setRoom(room) {
  if (currentRoom.name !== room.name) {
    // A private-room draft must never silently become a public-room message.
    drafts.set(currentRoom.name, { text: input.value, file: selectedFile });
    const draft = drafts.get(room.name);
    input.value = draft?.text || "";
    selectedFile = draft?.file || null;
    uploadedAttachment = null;
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
  $("#room-title").textContent =
    ` / #${room.name}${room.protected ? " [locked]" : ""}`;
  $("#prompt-room").textContent = `@${room.name}`;
  $("#empty-room").textContent = `#${room.name}`;
  $("#message-input").labels[0].textContent = `Message #${room.name}`;
  document.title = `localchat / #${room.name}`;
  updateComposer();
}
function acceptSession(result) {
  setRoom(result.room);
  token = result.token;
  user = result.user;
  uploadedAttachment = null;
  storage.set("commonroom-token", token);
  storage.set("commonroom-name", user.name);
  $("#join-password").value = "";
  $("#room-password").value = "";
  changingName = false;
  connect();
}
function openJoin() {
  $("#name-input").value = user?.name || storage.get("commonroom-name") || "";
  $("#join-error").textContent = "";
  $("#join-description").textContent =
    `Choose a nickname for #${currentRoom.name}.`;
  const needsPassword = currentRoom.protected && !connected;
  $("#join-password-field").hidden = !needsPassword;
  $("#join-password").required = needsPassword;
  $("#join-general").hidden = connected || currentRoom.name === "general";
  if (!dialog.open) dialog.showModal();
  $("#name-input").focus();
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
    $("#attach-button").title =
      `Attach a file (max ${formatSize(maxFileSize)})`;
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
        roomDialog.close();
        openJoin();
      }
    } catch {
      /* The server is offline; let EventSource retry. */
    }
  };
}
$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#name-input").value.trim();
  if (!name || [...name].length > 24) {
    $("#join-error").textContent = "Use a name between 1 and 24 characters.";
    return;
  }
  $("#join-button").disabled = true;
  $("#join-error").textContent = "";
  try {
    const result = await api(
      "/api/session",
      { name, room: currentRoom.name, password: $("#join-password").value },
      !!token,
    );
    acceptSession(result);
  } catch (error) {
    $("#join-error").textContent =
      error instanceof TypeError
        ? "Cannot reach the server. Check your connection."
        : error.message;
  } finally {
    $("#join-button").disabled = false;
  }
});
dialog.addEventListener("cancel", (event) => {
  if (!changingName || !connected) event.preventDefault();
});
$("#identity").addEventListener("click", () => {
  changingName = connected;
  openJoin();
});
$("#join-general").addEventListener("click", () => {
  token = null;
  storage.remove("commonroom-token");
  setRoom({ name: "general", protected: false });
  openJoin();
});
dialog.addEventListener("close", () => {
  $("#join-password").value = "";
});
roomDialog.addEventListener("close", () => {
  $("#room-password").value = "";
});
roomDialog.addEventListener("cancel", (event) => {
  if (roomBusy) event.preventDefault();
});
$("#room-close").addEventListener("click", () => roomDialog.close());
$("#rooms-button").addEventListener("click", async () => {
  $("#room-error").textContent = "";
  $("#room-name").value = currentRoom.name;
  $("#room-password").value = "";
  $("#room-list").textContent = "loading…";
  roomDialog.showModal();
  $("#room-name").focus();
  try {
    const response = await fetch("/api/rooms", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    $("#room-list").replaceChildren();
    for (const room of data.rooms) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `#${room.name}${room.protected ? " [locked]" : ""}${room.name === currentRoom.name ? " *" : ""}`;
      button.addEventListener("click", () => {
        $("#room-name").value = room.name;
        $("#room-password").value = "";
        (room.protected ? $("#room-password") : $("#room-join")).focus();
      });
      li.append(button);
      $("#room-list").append(li);
    }
  } catch (error) {
    $("#room-list").replaceChildren();
    $("#room-error").textContent = error.message;
  }
});
$("#rooms-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (roomBusy || sending) return;
  const name = $("#room-name").value;
  const password = $("#room-password").value;
  roomBusy = true;
  for (const button of roomDialog.querySelectorAll("button"))
    button.disabled = true;
  $("#room-error").textContent = "";
  updateComposer();
  try {
    const result =
      event.submitter?.id === "room-create"
        ? await api("/api/rooms", { name, password }, true)
        : await api(
            "/api/session",
            { name: user.name, room: name, password },
            true,
          );
    roomDialog.close();
    acceptSession(result);
  } catch (error) {
    $("#room-error").textContent =
      error instanceof TypeError ? "Cannot reach the server." : error.message;
    if (error.status === 401) {
      roomDialog.close();
      setConnection(false, "login required");
      openJoin();
    }
  } finally {
    roomBusy = false;
    for (const button of roomDialog.querySelectorAll("button"))
      button.disabled = false;
    updateComposer();
  }
});
$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("#send-button").disabled) return;
  const draft = input.value;
  const text = draft.trim();
  sending = true;
  updateComposer();
  try {
    if (selectedFile && !uploadedAttachment) {
      $("#remove-file").textContent = "[cancel]";
      $("#remove-file").disabled = false;
      uploadedAttachment = await uploadFile(selectedFile);
    }
    const payload = { text };
    if (uploadedAttachment) payload.attachmentId = uploadedAttachment.id;
    const result = await api("/api/messages", payload, true);
    clearFile();
    clearTimeout(noticeTimer);
    $("#notice").hidden = true;
    renderMessage(result.message);
    // Don't erase text typed while the send request was in flight.
    if (input.value === draft) input.value = "";
    scrollBottom();
  } catch (error) {
    if (error.status === 400) uploadedAttachment = null;
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
    updateComposer();
    input.focus();
  }
});
$("#attach-button").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  if (file.size > maxFileSize) {
    notice(`File is too large. Maximum size: ${formatSize(maxFileSize)}.`);
    fileInput.value = "";
    return;
  }
  if ([...file.name].length > 180) {
    notice("File name is too long. Use up to 180 characters.");
    fileInput.value = "";
    return;
  }
  selectedFile = file;
  uploadedAttachment = null;
  updateFile();
  updateComposer();
  input.focus();
});
$("#remove-file").addEventListener("click", () => {
  uploadRequest?.abort();
  clearFile();
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
window.addEventListener("pagehide", () => stream?.close());
window.addEventListener("pageshow", (event) => {
  if (event.persisted && token) connect();
});
try {
  const savedRoom = JSON.parse(storage.get("localchat-room"));
  if (
    savedRoom &&
    typeof savedRoom.name === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,31}$/.test(savedRoom.name)
  )
    setRoom({ name: savedRoom.name, protected: !!savedRoom.protected });
} catch {
  /* Ignore invalid optional storage. */
}
token = storage.get("commonroom-token");
if (token) connect();
else openJoin();
