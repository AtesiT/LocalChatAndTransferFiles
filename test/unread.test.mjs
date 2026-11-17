import { test } from "node:test";
import assert from "node:assert/strict";
import { TabUnread } from "../public/unread.js";
const incoming = (id) => ({ id, userId: "other" });

test("unread title counts only new incoming messages while the tab is inactive", () => {
  const titles = [];
  const unread = new TabUnread((title) => titles.push(title));
  unread.snapshot([incoming("history")], "me", false);
  assert.equal(unread.count, 0);
  unread.receive(incoming("active"), "me", true);
  unread.receive({ id: "own", userId: "me" }, "me", false);
  unread.receive(incoming("one"), "me", false);
  unread.receive(incoming("one"), "me", false);
  unread.receive(incoming("two"), "me", false);
  assert.equal(unread.title, "(2) localchat / #general");
  unread.read(false);
  assert.equal(unread.count, 2);
  unread.read(true);
  assert.equal(unread.title, "localchat / #general");
  assert.deepEqual(titles, [
    "localchat / #general",
    "(1) localchat / #general",
    "(2) localchat / #general",
    "localchat / #general",
  ]);
});

test("reconnection counts missed messages once, without counting initial or replayed history", () => {
  const unread = new TabUnread();
  unread.snapshot([incoming("old")], "me", false);
  unread.receive(incoming("live"), "me", false);
  unread.snapshot(
    [incoming("old"), incoming("live"), incoming("missed")],
    "me",
    false,
  );
  assert.equal(unread.count, 2);
  unread.snapshot(
    [incoming("old"), incoming("live"), incoming("missed")],
    "me",
    false,
  );
  assert.equal(unread.count, 2);
  unread.reset("private");
  assert.equal(unread.title, "localchat / #private");
  unread.snapshot([incoming("private-history")], "me", false);
  assert.equal(unread.count, 0);
});

test("deduplication state is bounded independently from the unread count", () => {
  const unread = new TabUnread();
  for (let i = 0; i < 500; i++)
    unread.receive(incoming(String(i)), "me", false);
  assert.equal(unread.known.size, 200);
  assert.equal(unread.count, 500);
});
