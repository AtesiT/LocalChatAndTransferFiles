import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../rooms.mjs";

test("stores salted password hashes, never exposes them in room listings", async () => {
  const store = new RoomStore();
  const first = await store.create("first", "пароль 🔐");
  const second = await store.create("second", "пароль 🔐");
  assert.notDeepEqual(first.hash, second.hash);
  assert.notDeepEqual(first.salt, second.salt);
  assert.equal("password" in first, false);
  assert.equal(await store.verify(first, "пароль 🔐"), true);
  assert.equal(await store.verify(first, "wrong"), false);
  assert.equal(await store.verify(first, ""), false);
  assert.deepEqual(
    store.list().map(({ id, ...info }) => info),
    [
      { name: "general", protected: false },
      { name: "first", protected: true },
      { name: "second", protected: true },
    ],
  );
});

test("prevents concurrent duplicate creation and bounds rooms and password work", async () => {
  const store = new RoomStore();
  const creation = store.create("reserved", "test-password");
  await assert.rejects(
    store.create("reserved", "another"),
    (error) => error.status === 409,
  );
  await creation;
  await assert.rejects(
    store.create("general"),
    (error) => error.status === 409,
  );
  for (let i = 0; i < 48; i++) await store.create(`room-${i}`);
  await assert.rejects(
    store.create("overflow"),
    (error) => error.status === 409,
  );
  assert.equal(store.list().length, 50);
  const busy = new RoomStore();
  busy.hashing = 4;
  await assert.rejects(
    busy.create("busy", "password"),
    (error) => error.status === 429,
  );
  assert.equal(busy.pending.size, 0);
});

test("validates names and passwords without silently trimming passwords", async () => {
  const store = new RoomStore();
  for (const name of [
    "",
    "General",
    "../etc",
    "two words",
    "a".repeat(33),
    null,
    "<script>",
  ])
    await assert.rejects(store.create(name), (error) => error.status === 400);
  await assert.rejects(
    store.create("invalid", null),
    (error) => error.status === 400,
  );
  await assert.rejects(
    store.create("too-long", "x".repeat(129)),
    (error) => error.status === 400,
  );
  const room = await store.create("spaces", " password ");
  assert.equal(await store.verify(room, "password"), false);
  assert.equal(await store.verify(room, " password "), true);
});
