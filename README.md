# LocalChatAndTransferFiles

A minimal, terminal-style web chat with file attachments for a local network. One Node.js process serves the interface and a shared `#general` channel. No frameworks, build step, external assets, or runtime dependencies.

Text messages and files are shared in a single channel. All data stays in server memory; nothing is saved to disk.

## Requirements

- Node.js **20 or newer** on the host computer.
- A modern browser on each device.
- Devices connected to the same local network.

No internet connection is needed to run the app.

## Run

From the project directory:

```sh
node server.mjs
```

Or use `npm start`. There are no packages to install.

The server binds to `0.0.0.0:3000` and prints its addresses:

```text
This computer:  http://localhost:3000
Local network:  http://192.168.1.10:3000
```

1. Open `http://localhost:3000` on the host computer.
2. On other devices, open the **Local network** address printed by your server. The address above is an example; use your actual LAN IP.
3. Enter a nickname and press Enter or select `[connect]`.
4. Keep the server running. Press `Ctrl+C` in its terminal to stop it.

`localhost` always refers to the device opening the page, so it will **not** connect a phone to your computer. Share the host computer's LAN address instead.

### Different port or interface

Linux / macOS:

```sh
PORT=8080 node server.mjs
```

PowerShell:

```powershell
$env:PORT = "8080"
node server.mjs
```

The optional `HOST` environment variable controls the listening interface. It defaults to `0.0.0.0` for network access. Use `127.0.0.1` to allow connections only from the host computer.

### Connection troubleshooting

- Check that both devices are on the same network and that the LAN IP is correct.
- Allow incoming connections for Node.js / TCP port 3000 in the host firewall, **on private networks only**.
- Guest Wi-Fi and router AP/client isolation may block connections between devices.
- If several addresses are printed, choose the Wi-Fi/Ethernet address rather than a VPN or virtual adapter address.
- Run the server on just one computer. Other devices only need a browser.

## Interface

The interface is deliberately small: a status line, message log, online user list, and a shell-like input prompt. Monospace text, dark colors, no avatars, cards, marketing sections, decorative animations, or placeholder features.

- **Enter** sends a message. **Shift+Enter** inserts a newline.
- `[send]` also sends a message, including on touch devices.
- `[attach]` selects a file. Send it on its own or add a text caption.
- Click your nickname in the input prompt to change it. Press Escape to cancel a nickname change.
- The log uses `HH:MM:SS <nickname> message` formatting. Your nickname is highlighted in green.
- The user list updates as people connect and disconnect. It moves above the log on small screens.
- `[new messages ↓]` appears only when a message arrives while you are reading earlier messages.
- Connection status and errors are shown inline. Reconnection is automatic after temporary interruptions.

## Chat behavior

- A single shared `#general` channel, with messages delivered in real time.
- Names can contain 1–24 Unicode characters; messages can contain up to 2,000.
- Multiline messages and emoji are supported. Message content is rendered as text, never HTML.
- The latest **100 messages** are kept in server memory and delivered on join or reconnect.
- Restarting the server clears the history, files, and sessions. Open tabs then ask you to log in again with your previous nickname filled in.
- A session survives a page refresh in the same tab using `sessionStorage`, when available. Inactive sessions expire after 24 hours.
- Unsent text survives a temporary disconnection, but not a page refresh.
- Changing your nickname creates a new temporary identity. Existing messages keep the old name.
- Requests are size-limited. Message sending, file uploading, and session creation are rate-limited.

## File attachments

1. Select `[attach]` and choose **one file**.
2. Optionally type a caption. Use `[remove]` to discard the selection before sending.
3. Press Enter or `[send]`. The selected-file line shows upload progress; `[cancel]` aborts an active upload without erasing your caption.
4. Other participants receive a `[file] name (size) ↓` link. Select it to download the original bytes.

File names can contain Unicode, including Cyrillic. Path components and control characters are sanitized. There are no inline file previews: files are always served as downloads, including HTML and SVG.

### Limits and lifetime

- **25 MiB per file**, **100 MiB total file storage** per server process.
- Up to **2 simultaneous uploads** server-wide, **6 upload attempts per minute per session**, and **200 stored files** including unpublished uploads.
- Uploaded bytes are held in memory, not written to an uploads folder. The byte budget includes reservations for in-flight uploads; transient buffers and downloads can use additional RAM.
- Published files remain available only while their messages are in the **latest 100 messages**. Leaving that history deletes the corresponding server-side file.
- An upload that was never published expires after **10 minutes**. Cleanup runs periodically and before subsequent uploads/messages.
- A server restart clears all uploaded files. This is temporary sharing, not durable storage.
- A full buffer rejects new uploads. Capacity returns when old attachment messages leave history, abandoned uploads expire, or the server restarts.
- Uploads have a 2-minute browser timeout. If a send fails after the upload succeeded, the selection is retained and a retry reuses that upload while it is still valid.
- Refreshing the page discards a selected file and any unsent caption. A temporary disconnection does not discard the selection; after a new login, it is uploaded again if needed.

Both uploading and downloading require a valid chat session. Unpublished files cannot be downloaded or attached by another participant. Any participant can download a file once it is published in the channel. Download links contain your temporary session token; share the server's home-page address instead of copying a download link.

## Storage and security

This is an initial version for a **trusted local network**, not a secure public messenger.

- Messages, files, and sessions exist only in process memory. There is no database or chat logging to disk.
- There are no accounts, passwords, private rooms, or identity verification. Anyone who can reach the server can join, choose any nickname, read the last 100 messages, and download their attachments.
- Files are not scanned for malware. Download-only delivery prevents inline execution in the chat, but does not make a file safe to open on your device. Only open files from people you trust.
- Plain HTTP **does not encrypt traffic**. There is no end-to-end encryption. Do not use this version to exchange secrets.
- Do not forward the port to the internet. The server does not enforce LAN membership: access is controlled by your network and firewall. A hosted preview is accessible according to its preview URL's access rules, not your Wi-Fi membership.
- Internet-facing deployment would require HTTPS, authentication, and appropriate network restrictions.
- There are no external fonts, CDNs, analytics, or cloud services.

## Project layout

```text
server.mjs            HTTP server, sessions, history, SSE, presence, downloads
attachments.mjs       Bounded in-memory uploads, metadata, expiry, safe filenames
public/index.html     Terminal-style English interface
public/styles.css     Desktop and mobile styles
public/app.js         Login, SSE client, rendering, reconnection
test/server.test.mjs  HTTP/SSE integration tests using node:test
test/attachments.test.mjs  File storage, expiry and concurrency tests
```

The browser receives updates through **Server-Sent Events (SSE)** and sends messages with HTTP POST. No WebSocket library is required. All browser requests use relative URLs. When using a reverse proxy, preserve Host/Origin, disable SSE buffering, allow long-lived HTTP connections, and permit upload bodies of at least 25 MiB.

### API

| Method     | Route                 | Purpose                                                                                                                                                                            |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST       | `/api/session`        | Join with `{ "name": "Alex" }`; returns a temporary token                                                                                                                          |
| GET        | `/api/session`        | Check a session using `Authorization: Bearer <token>`                                                                                                                              |
| GET        | `/api/events?token=…` | SSE stream: initial history, messages, online users, file limits                                                                                                                   |
| POST       | `/api/files`          | Upload raw file bytes with Bearer auth, `Content-Type: application/octet-stream`, and a percent-encoded `X-File-Name` header; returns `{ "attachment": { "id", "name", "size" } }` |
| POST       | `/api/messages`       | Publish `{ "text": "Hello!", "attachmentId": "…" }` with Bearer auth; either text or an owned, unpublished attachment is required                                                  |
| GET / HEAD | `/api/files/:id`      | Download a published attachment with Bearer auth or a `?token=…` session token                                                                                                     |
| GET        | `/api/info`           | Server name, maximum message length, and file limits                                                                                                                               |

File bytes never travel through SSE or message JSON. Only attachment metadata is included. An attachment can be published only once and only by the session that uploaded it.

## Tests

```sh
npm test
```

Tests start isolated servers on available ports. They cover static file access, security headers, input validation, session authorization, cross-origin rejection, live SSE messaging, online presence, reconnection history, flood protection, the 100-message limit, oversized requests, UTF-8 characters split across network packets, byte-exact file downloads, attachment ownership, download headers, file-only/empty uploads, size/storage/concurrency limits, aborted uploads, and attachment cleanup.

To check the UI manually, open two browsers or devices, join with different nicknames, send messages both ways, refresh a page, and disconnect/reconnect the network. Also send a captioned file and a file-only message, download them from the other browser, refresh to check attachment history, and cancel an upload. Restarting the server should clear history/files and prompt both clients to log in again.
