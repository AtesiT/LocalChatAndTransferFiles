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

Nicknames are **unique across the entire server**, including people still selecting a room. Matching ignores case and Unicode compatibility differences (`Alex`, `alex`, and full-width equivalents cannot be claimed by different participants). Reservations are atomic and checked again on all entry/creation/rename APIs. Your own identity credential permits refreshes, room switches, and renames without conflicting with yourself. Nicknames are released immediately by `[logout]`, or after **2 minutes without activity** so an abandoned login does not hold a name forever. Changing a nickname releases its old name immediately. This is temporary ownership, not a permanent account or identity verification.

- Each entry shows `#room (count)` and `[locked]` when protected. Counts update live, including before login; names and counts are public metadata. Multiple open streams or room grants for the same nickname owner count as one participant per room. A different participant must choose a different nickname.
- **Join:** select a room. Only a protected room asks for a password (unless your current session already grants access to that exact room). Select `[join #room]` or press Enter in its password field.
- **Create:** use the separate `[create room]` button. Its own screen asks for a new room name and optional password. A blank password creates a public room. Creating from the login screen does not require first joining `#general`.
- **Return to public chat:** select `#general` in the list and join; it has no password.
- **Names:** 1–32 lowercase ASCII letters, digits, underscores, or hyphens; the first character must be a letter or digit. Names are unique; uppercase names are rejected.
- **Passwords:** up to 128 Unicode characters. Spaces are significant. Passwords are not trimmed, saved in browser storage, sent through SSE, or returned in API responses. The server stores a random salt and an asynchronous **scrypt** hash, verified with a timing-safe comparison.
- Password inputs stay masked but are outside HTML login forms, have `autocomplete="off"`, and include common password-manager ignore hints. Fields are cleared when leaving a dialog or after a failed attempt. The app never asks to save a password. Browsers/extensions control their own password-save prompts and may ignore those hints; no website can universally disable them.
- The room picker does not expose private messages, files, or participant identities. These are access-controlled rooms, not hidden rooms or end-to-end encrypted conversations.
- Sessions are scoped to a particular **room generation**, not just a name. Switching creates a session for the destination room. Refreshing within an active session reconnects without another password prompt. Renaming within your current room reuses its access grant.
- Room tokens are bearer credentials and remain valid until explicit logout, session expiry, nickname-ownership expiry, removal from the room, password rotation by its creator, room deletion, or server restart; switching rooms alone does not revoke copies. A separate identity token preserves nickname ownership across room deletion/switching, but cannot read messages, upload/download files, or open a chat stream without a room grant. Do not share either token.
- Unsent text and selected files are kept separately for each room generation **in tab memory only**. Switching never carries a private draft into another room. Refreshing clears drafts, and a recreated room does not inherit an older room's draft.

### Room creator controls

The creator of a custom room sees a compact **`[manage]`** button. These actions are enforced by the server, not by hiding buttons. A valid grant for that exact room generation **and the creator's identity** is required; guests, grants from another room, and forged client-side owner flags cannot manage it. Authorized session/ready responses include `room.isOwner`; the public catalog does not expose owner identities or management permissions.

- **Change password:** enter a new password and select `[change password]`. Blank removes the password and makes the room public. On success, **all other participants' grants for that room are revoked**, including offline grants and duplicate tabs. Their active streams close, unpublished uploads/drafts for that room are discarded, and they must explicitly rejoin with the current password. Creator grants remain valid. Published history/files remain available after rejoining; other rooms and nickname identities are unaffected. Passwords remain salted scrypt hashes; in-flight old-password checks cannot issue a fresh grant after the change. Password inputs are masked, outside forms, and cleared on submission/close.
- **Remove participant:** select `[remove]` beside an online participant in the management dialog. All of that identity's grants/streams in this room are revoked, not just one tab. Pending uploads are discarded and counts update immediately. Their nickname and access to other rooms remain valid; published messages/files are retained. **Removal is a kick, not a ban**: the participant can explicitly rejoin a public room, or a protected room if they know its current password. Change the password if it must no longer grant access to someone removed. The creator cannot kick themselves.
- **Delete room:** type its exact name and select `[delete room]`. The room disappears immediately, everyone is disconnected, its grants are revoked, and its history and pending/published server files are deleted. Nicknames remain reserved so participants can choose another room without logging in again. Recreating the same name creates a new generation and a new creator; old tokens and owner rights do not carry over. Files already downloaded or messages copied to a device cannot be remotely erased.

Creator rights belong to the **temporary identity UUID**, not the nickname spelling. They survive refreshes, renames, and room switches while that identity is valid. The same identity can recover its own room grant without re-entering the password. **Logout, nickname-ownership expiry, and server restart do not provide an ownership-recovery mechanism**: someone reclaiming the old nickname is not the creator. If other participants keep an ownerless room active, they may continue chatting, but nobody inherits its controls; the usual empty-room cleanup still removes it when everyone leaves. There is no role transfer, permanent account, or moderator delegation in this version.

Management is limited to **12 attempts/minute per creator identity**, shared across their room grants. Destructive changes during in-flight joins/uploads are rechecked, so a kicked grant or deleted room cannot be restored by finishing an older request. These controls do not add transport encryption: the HTTP/HTTPS and trusted-LAN security notes below still apply. Treat creator room/identity tokens as administrator credentials. Download URLs currently carry a room Bearer token: sharing a creator's download URL can also expose their management access. Do not share download links or use unencrypted HTTP for sensitive administration on an untrusted network.

### Search, replies, and mentions

- Select **`[search]`** or press **Ctrl+F / Cmd+F** while connected to search the current room's **latest 100 messages**. The compact search row filters messages by text, author, attachment filename, or quoted reply context. Matching is literal, case-insensitive, and Unicode-normalized, not a regular expression. Results/counts update as messages arrive. Enter scrolls to the first match; Escape or `[close]` clears the filter. Room changes and logout close/reset search. No server-wide search or older archive is exposed.
- Use a message's **`[reply]`** action (visible on hover/keyboard focus, or directly on touch devices), write text and/or attach files, then send. A small composer line shows the target; **`[cancel reply]`** removes it without erasing your text/files. Reply drafts stay with their original room. A reply by itself is not an otherwise empty message.
- Published replies contain a server-created quote with the original author and up to **240 Unicode characters** of text (or filenames for a file-only original). Select the quote to jump to the original and briefly highlight it; a notice explains if the original has left history. The quote remains readable after the original leaves history, but a new reply must target a message still retained in the **same room generation**. A target expiring during an upload produces an error; cancel the reply or choose another message, without re-uploading valid files. Nested reply trees are not stored.
- Type **`@nickname`**, or click a nickname in the participant list/message author column to insert it at the cursor. The server resolves mentions only against **currently online participants in that room**, ignoring case and Unicode compatibility differences. Nicknames with spaces/punctuation work literally (for example `@Alex Smith`); the longest matching nickname wins. Emails, unknown names, and partial nicknames are not treated as mentions. Mentioned text is highlighted, with stronger emphasis when it addresses you. The recorded identity remains stable after a rename, while the published spelling stays unchanged. Mentions use the existing incoming-message sound and unread counter, without another panel or special alert.

### Unread messages and logout

The browser tab title shows `(N) localchat / #room` for incoming messages received while the tab is hidden or unfocused. Returning to a visible, focused tab clears the count. Your own messages, duplicate events, and the first history snapshot do not count. On reconnection, newly recovered messages in the retained history count once if the tab is still inactive. The counter is for the current room only, resets on room changes/logout/refresh, and adds no badge or panel to the chat.

Select **`[logout]`** in the header to leave explicitly. The server immediately releases your nickname, revokes **all room and identity tokens for that identity**, closes its chat streams (including other tabs sharing those tokens), and updates presence/room counts. Someone else can claim the nickname as soon as logout succeeds; simply closing a tab still uses the normal inactivity timeout. Other independent nicknames are unaffected.

Logout cancels active/queued uploads, deletes unpublished server buffers, and clears local drafts, selected files, unread counts, and stored chat credentials. Published messages/files remain available to authorized participants until normal history/room cleanup. Audio preferences are retained. The client returns to the nickname screen, including in other connected tabs sharing the identity. A disconnected tab's credentials are still revoked, even if it cannot receive the live logout event. Logout requires a reachable server: if confirmation fails, the UI reports that the nickname may still be reserved and lets you retry; it does not promise offline revocation.

### Empty-room cleanup

Custom rooms are automatically deleted **15 seconds after the last participant disconnects**. This short grace period lets normal refreshes, nickname changes, and temporary disconnects reconnect without destroying the room. New rooms that nobody connects to are also cleaned up. A reconnect cancels deletion.

Deleting a room removes its history, password hash, published/pending files, and session grants. Recreating the same name produces a different room ID: old tokens cannot access it or publish into it. An in-flight request cannot publish/upload into a room that expired while it was being read. The live picker removes deleted rooms and asks you to choose again; it never silently redirects a private draft into public chat.

`#general` is the permanent public lobby and is not deleted when empty. It has no creator/management controls. Custom rooms have the creator controls described above, but no permanent accounts or ownership/password recovery. Restarting the server clears custom rooms and all chat data.

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

1. Select `[attach]` and choose **up to 10 files** for one message. You can also **drop files into the chat window**, or **paste an image/screenshot** from the clipboard while composing. These append to the same queue rather than replacing existing files. You can add more files again before sending.
2. Optionally type a caption. Each file has its own `[cancel]` control.
3. Press Enter or `[send]`. The queue shows each file's progress and a combined byte-based progress bar. Cancelling a queued, active, or completed-but-unpublished file removes only that file, preserving your caption and the remaining uploads. Cancellation is briefly disabled while the message is being published.
4. All remaining files and the caption appear together in one message after the uploads finish. Other participants receive a `[file] name (size) ↓` link for each attachment. Select a link to download the original bytes.

Files upload sequentially in **1 MiB chunks**. On a timeout or connection error, the client checks the server's confirmed byte offset and automatically retries up to three times with a short backoff. If the connection remains unavailable, the queue is retained: reconnect and press `[send]` to resume. Only an incomplete chunk must be retransmitted; confirmed chunks are not sent again. Completed files are reused on retry, and a lost message-publication response does not create a duplicate when retrying the unchanged draft while it remains in history. Upload state and file selections stay with their original room drafts.

Dropping folders is not supported. Dropping files never navigates away from the page; a visible drop hint appears only when files can be accepted. Drops/pasted images are not accepted during login, dialogs, or an active send. All input methods share the same size/name/count checks, individual cancellation, resumable upload, and room isolation. Plain-text paste behaves normally; image clipboard data is handled through the browser's paste event without requesting clipboard-read permission. Pasted images are attachments/downloads, not inline previews. Clipboard image support depends on the browser and on the source application exposing an image item.

File names can contain Unicode, including Cyrillic. Path components and control characters are sanitized. There are no inline file previews: files are always served as downloads, including HTML and SVG.

### Limits and lifetime

- **25 MiB per file**, **100 MiB total file storage** per server process.
- Up to **10 attachments per message**, **2 simultaneous chunk transfers** server-wide, and **200 stored or reserved files**, including unpublished uploads.
- Up to **30 new resumable uploads per minute per identity**. Retrying an existing upload or transferring its chunks does not spend another creation attempt. The legacy single-request endpoint retains its 6-attempts/minute/session limit.
- Uploaded bytes are held in memory, not written to an uploads folder. The byte budget includes reservations for in-flight uploads; transient buffers and downloads can use additional RAM.
- Published files remain available only while their messages are in their room's **latest 100 messages**. Leaving that history deletes the corresponding server-side file.
- An unpublished upload expires after **10 minutes of inactivity**. Status checks and accepted chunks refresh this window. Cleanup runs periodically and before subsequent uploads/messages. Cancelling releases its server reservation immediately when reachable; otherwise it expires.
- A server restart clears all uploaded files. This is temporary sharing, not durable storage.
- A full buffer rejects new uploads. Capacity returns when old attachment messages leave history, rooms are deleted, abandoned uploads expire, or the server restarts.
- Chunk transfers time out after **45 seconds**; control requests time out after **15 seconds**. Upload IDs are bound to the nickname identity and room generation, so a renewed same-identity room grant or nickname rename can resume them.
- **Refresh/tab closure discards the local queue and unsent caption.** This version resumes network interruptions in the same open page, not across browser restarts. A server restart, expired upload, expired nickname identity, or deleted room prevents reuse of the old buffer; expired buffers restart from byte zero. No file content is stored in browser storage.

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
public/app.js         Entry, room moderation, SSE, rendering, drafts, settings, reconnection
public/notifications.js  Five synthesized sounds, volume, safe local preferences
public/uploads.js     Room-draft queues, chunk retries, progress and cancellation
public/unread.js      Bounded message deduplication and unread tab-title counter
public/chat-text.js   Shared literal search, mention matching and reply excerpts
test/server.test.mjs  HTTP/SSE integration tests using node:test
test/attachments.test.mjs  File storage, expiry and concurrency tests
test/uploads.test.mjs  Browser queue state, cancellation and resume logic tests
test/unread.test.mjs   Unread counts, focus reset, reconnect history and room reset
test/chat-text.test.mjs  Unicode search/mentions and bounded reply excerpts
test/rooms.test.mjs    Password hashing, room validation and registry limits
test/notifications.test.mjs  Sound presets, mute, volume, persistence, audio fallback
```

The browser receives updates through **Server-Sent Events (SSE)** and sends messages with HTTP POST. No WebSocket library is required. All browser requests use relative URLs. When using a reverse proxy, preserve Host/Origin, disable SSE buffering, allow long-lived HTTP connections, and permit upload bodies of at least 25 MiB.

### API

| Method     | Route                     | Purpose                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST       | `/api/logout`             | Revoke the Bearer identity and all its room grants, release its nickname, close streams, and discard unpublished files; accepts `{}` with identity or room Bearer auth                                                                                                                                                                                      |
| POST       | `/api/nickname`           | Reserve/change `{ "name": "Alex" }` before showing rooms; returns an identity token and user. Bearer identity/room credentials permit the owner to reuse or rename their nickname. A collision returns HTTP 409 with `code: "NICKNAME_TAKEN"`.                                                                                                              |
| GET        | `/api/nickname`           | Validate a Bearer identity or room credential and restore nickname ownership after refresh; does not grant room access                                                                                                                                                                                                                                      |
| POST       | `/api/session`            | Join with `{ "name": "Alex", "room": "general", "roomId": "…", "password": "…" }`. Room defaults to `general`; optional `roomId` rejects stale picker selections. Returns room token, identity token, user, and room metadata. Same-room Bearer auth permits renaming.                                                                                      |
| GET        | `/api/session`            | Check a Bearer session and its current room generation                                                                                                                                                                                                                                                                                                      |
| GET        | `/api/rooms`              | Public list of `{ id, name, protected, count }`; no history, participant identities, or hashes                                                                                                                                                                                                                                                              |
| GET        | `/api/rooms/events`       | Public SSE `rooms` snapshots on creation, connection, disconnection, and deletion; catalog viewers do not count as participants                                                                                                                                                                                                                             |
| POST       | `/api/rooms`              | Create with `{ "name": "team", "password": "…", "nickname": "Alex" }`. Password optional; nickname required without an existing valid Bearer session. Returns a session in the new room.                                                                                                                                                                    |
| POST       | `/api/rooms/:id/password` | Creator-only `{ "password": "…" }`; blank makes public. Revokes other room grants/pending uploads and returns updated authorized room metadata. Requires a room Bearer token; not an identity-only grant.                                                                                                                                                   |
| POST       | `/api/rooms/:id/kick`     | Creator-only `{ "userId": "…" }` revokes that identity's grants for the room; does not release its nickname or ban re-entry.                                                                                                                                                                                                                                |
| POST       | `/api/rooms/:id/delete`   | Creator-only `{ "confirmName": "room-name" }` immediately deletes that generation, grants, history, and files. General is never manageable.                                                                                                                                                                                                                 |
| GET        | `/api/events?token=…`     | SSE stream: authorized room (`isOwner`), history, messages, users, file limits; `room-updated` refreshes creator metadata and `room-left` reports `{ roomId, reason }` for kick/password change/deletion/expiry. Identity tokens remain valid; choose another room or explicitly rejoin.                                                                    |
| POST       | `/api/files`              | Upload raw bytes in the session's room with Bearer auth, `Content-Type: application/octet-stream`, and percent-encoded `X-File-Name`; returns metadata                                                                                                                                                                                                      |
| POST       | `/api/uploads`            | Start/recover `{ "name": "file.bin", "size": 123, "clientId": "…" }` with room Bearer auth. `clientId` is an owner/room-scoped idempotency key (16–80 ASCII letters, digits, `_`, `-`). Returns `{ upload: { id, name, size, offset, complete, attached, chunkSize } }`.                                                                                    |
| GET        | `/api/uploads/:id`        | Owner-only confirmed offset/status; requires a grant in the original room generation                                                                                                                                                                                                                                                                        |
| PATCH      | `/api/uploads/:id`        | Append binary bytes with `Content-Type: application/octet-stream` and decimal `Upload-Offset`; at most `chunkSize` bytes. Offsets commit only after an entire request is received. Conflicts return 409; query status before retrying.                                                                                                                      |
| DELETE     | `/api/uploads/:id`        | Cancel an owner's unpublished upload, including an active or completed one; releases reserved/stored bytes                                                                                                                                                                                                                                                  |
| POST       | `/api/messages`           | Publish `{ "text": "Hello!", "attachmentIds": ["…"], "clientMessageId": "…", "replyToId": "…" }` atomically with Bearer room auth. Optional request ID deduplicates unchanged retries within retained history; text or owned complete unpublished attachments required. Legacy `attachmentId` still supported, but cannot be combined with `attachmentIds`. |
| GET / HEAD | `/api/files/:id`          | Download a published attachment with a same-room Bearer token or `?token=…`                                                                                                                                                                                                                                                                                 |
| GET        | `/api/info`               | Server name, maximum message length, file limits                                                                                                                                                                                                                                                                                                            |

File bytes never travel through SSE or message JSON. Only attachment metadata is included. An attachment can be published only once. Resumable uploads belong to the uploading nickname identity and room generation; legacy uploads belong to the uploading session. New messages expose an `attachments` array, while legacy `attachmentId` requests retain the singular `attachment` response shape. All attachments and reply targets are validated before any file is published; invalid batches/replies consume none. Optional `replyToId` selects a retained message in that room; the server returns a bounded `replyTo: { id, userId, name, preview }` snapshot. Missing/foreign/expired targets return 400 (`REPLY_UNAVAILABLE` for a well-formed unavailable ID). Reply targets are part of the message-idempotency signature. Clients cannot supply trusted quote text or mention metadata: the server computes `mentions: [{ start, end, id, name }]` from trimmed text and current online participants. Mention offsets use JavaScript UTF-16 string indices. Both fields travel through live SSE and retained history. Rooms are determined by server-side session grants, not by a room field on a message, upload, download, or event request.

## Tests

```sh
npm test
```

Tests start isolated servers on available ports. They cover static file access, security headers, input validation, session authorization, cross-origin rejection, live SSE messaging, online presence, reconnection history, flood protection, the 100-message limit, oversized requests, UTF-8 characters split across network packets, byte-exact file downloads, attachment ownership, download headers, file-only/empty uploads, size/storage/concurrency limits, aborted uploads, confirmed-offset resumption, lost final responses, idempotent creation/publication, individual cancellation, atomic multi-file batches, shared reservations, attachment cleanup, password hashing/validation, room-entry grants, room isolation for live messages/history/presence/files, room creation limits, creator-only management/general protection, multi-grant kicks, password rotation and public/private transitions, moderation throttling, identity-safe ownership, atomic password-change/verification races, in-flight upload/entry revocation, password-guessing throttling, public live room counts, empty-room expiry/reconnection, generation-safe session revocation, atomic global nickname ownership/expiry, explicit multi-grant logout/revocation, immediate nickname reuse, unpublished-file cleanup on exit, unread titles/focus reset/reconnection deduplication, same-room reply validation/snapshots/eviction/idempotency, Unicode/space-containing mentions, email/partial-name exclusion, literal room-search matching, protected lobby credentials, five audio presets, volume/mute, preference validation, and unavailable-audio fallback.

To check the UI manually, open two browsers or devices, join with different nicknames, send messages both ways, refresh a page, and disconnect/reconnect the network. Also send a captioned batch and a file-only message, download them from the other browser, refresh to check attachment history, and cancel one active file while others continue. Interrupt the network partway through a larger file, restore it, and verify progress resumes from the confirmed chunk (or press `[send]` after retries are exhausted). Create a protected room and verify that an incorrect password is rejected, clients in `#general` cannot see its messages/files, and drafts stay with their original rooms. Check live room counts before login, leave a custom room empty for 15 seconds, and confirm it disappears. Preview all five sounds and verify that only incoming messages in the current room play audio, with mute/volume remembered after refresh. Drop multiple files into chat, paste a screenshot, and verify both append to the queue without losing the caption. Search text/author/filenames, check live result counts, and switch rooms to confirm search/reply-draft isolation. Reply to a message, click its quote, refresh to check quoted history, and mention a participant with a Unicode or space-containing nickname. Switch away from a tab, send it messages, and check its title counter; return to clear it. Select `[logout]`, verify the nickname can be claimed immediately in another browser, and check that no old tab can send with revoked credentials. Try exiting during a file upload and verify unpublished files/drafts are cleared. Create a room and check `[manage]` is visible only to its creator; remove a participant with multiple tabs during an upload, rotate the password, reject the old password, and rejoin with the new one. Rename/refresh/switch the creator to confirm rights persist. Delete the room with exact-name confirmation, recreate its name under another identity, and verify no old history or owner rights return. Restarting the server should clear rooms/history/files and prompt both clients to log in again.
