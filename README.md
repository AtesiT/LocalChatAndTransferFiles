# LocalChatAndTransferFiles

A minimal, terminal-style web chat with file attachments for a local network. One Node.js process serves the interface, public `#general`, and optional password-protected rooms. No frameworks, build step, external assets, or runtime dependencies.

Text messages and files are shared within the selected room. Chat data stays in server memory; nothing is saved to disk by the server. Notification preferences are saved locally in the browser.

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
3. Enter an available nickname and select `[continue]` (or press Enter). Only then does the room picker appear. Select a room, enter its password if requested, and join. Or select `[create room]` on that second screen.
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

The interface is deliberately small: a channel header, message log, online user list, and a shell-like input prompt. There is no visible connected badge; connection status remains available to screen readers. Monospace text, dark colors, no avatars, cards, marketing sections, decorative animations, or placeholder features.

- **Enter** sends a message. **Shift+Enter** inserts a newline.
- `[send]` also sends a message, including on touch devices.
- `[attach]` selects a file. Send it on its own or add a text caption.
- `[rooms]` opens the same room picker used at login, with live participant counts and a separate `[create room]` button.
- `[settings]` selects a notification sound and volume.
- Click your nickname in the input prompt to change it. Press Escape to cancel a nickname change.
- The log uses `HH:MM:SS <nickname> message` formatting. Your nickname is highlighted in green.
- The user list updates as people connect and disconnect. It moves above the log on small screens.
- `[new messages ↓]` appears only when a message arrives while you are reading earlier messages.
- Connection status and errors are shown inline. Reconnection is automatic after temporary interruptions.

## Chat behavior

- A public `#general` room plus custom public or password-protected rooms, with messages delivered in real time.
- Message history, live updates, online users, and downloads are isolated by room.
- Names can contain 1–24 Unicode characters; messages can contain up to 2,000.
- Multiline messages and emoji are supported. Message content is rendered as text, never HTML.
- The latest **100 messages per room** are kept in server memory and delivered on join or reconnect.
- Restarting the server clears custom rooms, their passwords, history, files, and sessions. Open tabs then ask you to log in again with your previous nickname filled in.
- A session survives a page refresh in the same tab using `sessionStorage`, when available. Nickname ownership has a 2-minute inactivity/reconnect grace period; active chat heartbeats keep it alive. Individual inactive room grants also expire after 24 hours.
- Unsent text survives a temporary disconnection, but not a page refresh.
- Changing your nickname preserves your temporary identity, releases the previous name, and updates your presence in other open tabs. Existing messages keep their original display name.
- Requests are size-limited. Message sending, file uploading, and session creation are rate-limited.

## Rooms and passwords

Login has two separate screens: first enter your nickname and confirm it with `[continue]`; the room picker stays hidden until the server accepts the nickname. Once connected, `[rooms]` opens the room picker directly, without asking for your nickname again. There is no need to type an existing room name.

Nicknames are **unique across the entire server**, including people still selecting a room. Matching ignores case and Unicode compatibility differences (`Alex`, `alex`, and full-width equivalents cannot be claimed by different participants). Reservations are atomic and checked again on all entry/creation/rename APIs. Your own identity credential permits refreshes, room switches, and renames without conflicting with yourself. Nicknames are released after **2 minutes without activity** so an abandoned login does not hold a name forever. Changing a nickname releases its old name immediately. This is temporary ownership, not a permanent account or identity verification.

- Each entry shows `#room (count)` and `[locked]` when protected. Counts update live, including before login; names and counts are public metadata. Multiple open streams or room grants for the same nickname owner count as one participant per room. A different participant must choose a different nickname.
- **Join:** select a room. Only a protected room asks for a password (unless your current session already grants access to that exact room). Select `[join #room]` or press Enter in its password field.
- **Create:** use the separate `[create room]` button. Its own screen asks for a new room name and optional password. A blank password creates a public room. Creating from the login screen does not require first joining `#general`.
- **Return to public chat:** select `#general` in the list and join; it has no password.
- **Names:** 1–32 lowercase ASCII letters, digits, underscores, or hyphens; the first character must be a letter or digit. Names are unique; uppercase names are rejected.
- **Passwords:** up to 128 Unicode characters. Spaces are significant. Passwords are not trimmed, saved in browser storage, sent through SSE, or returned in API responses. The server stores a random salt and an asynchronous **scrypt** hash, verified with a timing-safe comparison.
- Password inputs stay masked but are outside HTML login forms, have `autocomplete="off"`, and include common password-manager ignore hints. Fields are cleared when leaving a dialog or after a failed attempt. The app never asks to save a password. Browsers/extensions control their own password-save prompts and may ignore those hints; no website can universally disable them.
- The room picker does not expose private messages, files, or participant identities. These are access-controlled rooms, not hidden rooms or end-to-end encrypted conversations.
- Sessions are scoped to a particular **room generation**, not just a name. Switching creates a session for the destination room. Refreshing within an active session reconnects without another password prompt. Renaming within your current room reuses its access grant.
- Room tokens are bearer credentials and remain valid until session expiry, nickname-ownership expiry, room deletion, or server restart; switching rooms alone does not revoke copies. A separate identity token preserves nickname ownership across room deletion/switching, but cannot read messages, upload/download files, or open a chat stream without a room grant. Do not share either token.
- Unsent text and selected files are kept separately for each room generation **in tab memory only**. Switching never carries a private draft into another room. Refreshing clears drafts, and a recreated room does not inherit an older room's draft.

### Empty-room cleanup

Custom rooms are automatically deleted **15 seconds after the last participant disconnects**. This short grace period lets normal refreshes, nickname changes, and temporary disconnects reconnect without destroying the room. New rooms that nobody connects to are also cleaned up. A reconnect cancels deletion.

Deleting a room removes its history, password hash, published/pending files, and session grants. Recreating the same name produces a different room ID: old tokens cannot access it or publish into it. An in-flight request cannot publish/upload into a room that expired while it was being read. The live picker removes deleted rooms and asks you to choose again; it never silently redirects a private draft into public chat.

`#general` is the permanent public lobby and is not deleted when empty. There are no owner/moderator roles, password changes, or password recovery. Restarting the server clears custom rooms and all chat data.

The server allows **50 rooms total**, including `general`, and limits room creation attempts to **5 per minute per source IP** and protected-room authentication attempts to **10 per minute per source IP**. There are at most 4 concurrent password-hashing operations. Existing session-creation throttling still applies. Clients behind a proxy/NAT can share these limits.

## Notification sounds

Open `[settings]` to choose one of five locally synthesized, short notification sounds:

1. **Soft ping** (default)
2. **Little bell**
3. **Warm chime**
4. **Raindrop**
5. **Gentle pluck**

Selecting a sound previews it. `[test sound]` plays it again. The **0–100% volume slider** defaults to 35%; select **Off (muted)** or set volume to zero to silence notifications. Sound and volume are saved in this browser's `localStorage`, when allowed, and applied immediately without a Save button.

Only new live messages from **other participants in your current room** trigger sound, including attachment-only messages. Your own messages, replayed history, duplicate events, presence/count changes, and other rooms are silent. Closely spaced messages within 150 ms share one notification to avoid a pile-up of sounds.

Audio uses the built-in **Web Audio API**: no audio files, CDN, microphone permissions, or network services. Browsers require a user interaction before sound can start; logging in or clicking a control unlocks it. OS mute, background-tab restrictions, browser autoplay settings, or unavailable audio hardware can still prevent playback. The settings dialog reports blocked/unavailable preview audio without interrupting chat.

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
- Published files remain available only while their messages are in their room's **latest 100 messages**. Leaving that history deletes the corresponding server-side file.
- An upload that was never published expires after **10 minutes**. Cleanup runs periodically and before subsequent uploads/messages.
- A server restart clears all uploaded files. This is temporary sharing, not durable storage.
- A full buffer rejects new uploads. Capacity returns when old attachment messages leave history, rooms are deleted, abandoned uploads expire, or the server restarts.
- Uploads have a 2-minute browser timeout. If a send fails after the upload succeeded, the selection is retained and a retry reuses that upload while it is still valid.
- Refreshing the page discards a selected file and any unsent caption. A temporary disconnection does not discard the selection; after a new login, it is uploaded again if needed.

Both uploading and downloading require a valid chat session. Unpublished files cannot be downloaded or attached by another participant. Only sessions authorized for the same room can download a published file; guessing its ID or using another room's token does not grant access. Download links contain your temporary session token; share the server's home-page address instead of copying a download link.

## Storage and security

This is an initial version for a **trusted local network**, not a secure public messenger.

- Rooms, password hashes, messages, files, and sessions exist only in process memory. There is no database or chat logging to disk.
- There are no accounts or identity verification. Anyone who can reach the server can choose any available nickname and read/download content in public rooms. Protected rooms require their shared password or an already-authorized session token. A shared password does not prove a participant's identity.
- Files are not scanned for malware. Download-only delivery prevents inline execution in the chat, but does not make a file safe to open on your device. Only open files from people you trust.
- Plain HTTP **does not encrypt traffic**, including room passwords, messages, files, and session tokens. There is no end-to-end encryption. Password-protected rooms do not protect against network interception or the server operator. Use HTTPS on any untrusted network and do not treat this version as a secure messenger.
- Do not forward the port to the internet. The server does not enforce LAN membership: access is controlled by your network and firewall. A hosted preview is accessible according to its preview URL's access rules, not your Wi-Fi membership.
- Internet-facing deployment would require HTTPS, authentication, and appropriate network restrictions.
- There are no external fonts, CDNs, analytics, or cloud services.

## Project layout

```text
server.mjs            HTTP server, sessions, history, SSE, presence, downloads
attachments.mjs       Bounded in-memory uploads, metadata, expiry, safe filenames
rooms.mjs             Room generations, registry, salted scrypt passwords
public/index.html     Terminal-style English interface
public/styles.css     Desktop and mobile styles
public/app.js         Two-step nickname/room entry, SSE, rendering, settings, reconnection
public/notifications.js  Five synthesized sounds, volume, safe local preferences
test/server.test.mjs  HTTP/SSE integration tests using node:test
test/attachments.test.mjs  File storage, expiry and concurrency tests
test/rooms.test.mjs    Password hashing, room validation and registry limits
test/notifications.test.mjs  Sound presets, mute, volume, persistence, audio fallback
```

The browser receives updates through **Server-Sent Events (SSE)** and sends messages with HTTP POST. No WebSocket library is required. All browser requests use relative URLs. When using a reverse proxy, preserve Host/Origin, disable SSE buffering, allow long-lived HTTP connections, and permit upload bodies of at least 25 MiB.

### API

| Method     | Route                 | Purpose                                                                                                                                                                                                                                                                |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST       | `/api/nickname`       | Reserve/change `{ "name": "Alex" }` before showing rooms; returns an identity token and user. Bearer identity/room credentials permit the owner to reuse or rename their nickname. A collision returns HTTP 409 with `code: "NICKNAME_TAKEN"`.                         |
| GET        | `/api/nickname`       | Validate a Bearer identity or room credential and restore nickname ownership after refresh; does not grant room access                                                                                                                                                 |
| POST       | `/api/session`        | Join with `{ "name": "Alex", "room": "general", "roomId": "…", "password": "…" }`. Room defaults to `general`; optional `roomId` rejects stale picker selections. Returns room token, identity token, user, and room metadata. Same-room Bearer auth permits renaming. |
| GET        | `/api/session`        | Check a Bearer session and its current room generation                                                                                                                                                                                                                 |
| GET        | `/api/rooms`          | Public list of `{ id, name, protected, count }`; no history, participant identities, or hashes                                                                                                                                                                         |
| GET        | `/api/rooms/events`   | Public SSE `rooms` snapshots on creation, connection, disconnection, and deletion; catalog viewers do not count as participants                                                                                                                                        |
| POST       | `/api/rooms`          | Create with `{ "name": "team", "password": "…", "nickname": "Alex" }`. Password optional; nickname required without an existing valid Bearer session. Returns a session in the new room.                                                                               |
| GET        | `/api/events?token=…` | SSE stream: authorized room, history, messages, users, file limits                                                                                                                                                                                                     |
| POST       | `/api/files`          | Upload raw bytes in the session's room with Bearer auth, `Content-Type: application/octet-stream`, and percent-encoded `X-File-Name`; returns metadata                                                                                                                 |
| POST       | `/api/messages`       | Publish `{ "text": "Hello!", "attachmentId": "…" }` in the session's room with Bearer auth; text or an owned unpublished attachment is required                                                                                                                        |
| GET / HEAD | `/api/files/:id`      | Download a published attachment with a same-room Bearer token or `?token=…`                                                                                                                                                                                            |
| GET        | `/api/info`           | Server name, maximum message length, file limits                                                                                                                                                                                                                       |

File bytes never travel through SSE or message JSON. Only attachment metadata is included. An attachment can be published only once and only by the session that uploaded it. Rooms are determined by server-side session grants, not by a room field on a message, upload, download, or event request.

## Tests

```sh
npm test
```

Tests start isolated servers on available ports. They cover static file access, security headers, input validation, session authorization, cross-origin rejection, live SSE messaging, online presence, reconnection history, flood protection, the 100-message limit, oversized requests, UTF-8 characters split across network packets, byte-exact file downloads, attachment ownership, download headers, file-only/empty uploads, size/storage/concurrency limits, aborted uploads, attachment cleanup, password hashing/validation, room-entry grants, room isolation for live messages/history/presence/files, room creation limits, password-guessing throttling, public live room counts, empty-room expiry/reconnection, generation-safe session revocation, atomic global nickname ownership/expiry, protected lobby credentials, five audio presets, volume/mute, preference validation, and unavailable-audio fallback.

To check the UI manually, open two browsers or devices, join with different nicknames, send messages both ways, refresh a page, and disconnect/reconnect the network. Also send a captioned file and a file-only message, download them from the other browser, refresh to check attachment history, and cancel an upload. Create a protected room and verify that an incorrect password is rejected, clients in `#general` cannot see its messages/files, and drafts stay with their original rooms. Check live room counts before login, leave a custom room empty for 15 seconds, and confirm it disappears. Preview all five sounds and verify that only incoming messages in the current room play audio, with mute/volume remembered after refresh. Restarting the server should clear rooms/history/files and prompt both clients to log in again.
