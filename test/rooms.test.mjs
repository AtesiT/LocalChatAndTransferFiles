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

test("changes passwords atomically, supports public rooms, and keeps secrets out of metadata", async () => {
  const store = new RoomStore();
  const room = await store.create("change", "old");
  const salt = room.salt;
  await store.changePassword(room, " new ");
  assert.notDeepEqual(room.salt, salt);
  assert.equal(room.revision, 1);
  assert.equal(await store.verify(room, "old"), false);
  assert.equal(await store.verify(room, " new "), true);
  assert.equal(await store.verify(room, "new"), false);
  await assert.rejects(
    store.changePassword(room, null),
    (error) => error.status === 400,
  );
  assert.equal(room.revision, 1);
  await store.changePassword(room, "");
  assert.equal(room.salt, null);
  assert.equal(room.hash, null);
  assert.equal(
    store.list().find((entry) => entry.name === "change").protected,
    false,
  );
  assert.equal("revision" in store.list()[1], false);
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { resolve, promise };
};

test("password verification cannot accept an old password after access changes", async () => {
  const store = new RoomStore();
  const room = await store.create("verify-race", "old");
  const hash = store.hash.bind(store);
  const gate = deferred();
  let calls = 0;
  store.hash = async (...args) => {
    if (++calls === 1) await gate.promise;
    return hash(...args);
  };
  const verifying = store.verify(room, "old");
  await store.changePassword(room, "new");
  gate.resolve();
  await assert.rejects(verifying, (error) => error.status === 409);
  assert.equal(await store.verify(room, "new"), true);
});

test("pending password changes cannot overwrite newer changes, deleted rooms or revoked ownership", async () => {
  for (const scenario of ["changed", "deleted", "revoked"]) {
    const store = new RoomStore();
    const room = await store.create(`race-${scenario}`);
    const hash = store.hash.bind(store);
    const gate = deferred();
    store.hash = async (...args) => {
      await gate.promise;
      return hash(...args);
    };
    let authorized = true;
    const changing = store.changePassword(room, "pending", () => authorized);
    if (scenario === "changed") await store.changePassword(room, "");
    if (scenario === "deleted") store.rooms.delete(room.name);
    if (scenario === "revoked") authorized = false;
    gate.resolve();
    await assert.rejects(
      changing,
      (error) =>
        error.status === { changed: 409, deleted: 404, revoked: 401 }[scenario],
    );
    assert.equal(room.hash, null);
  }
});
