import { test } from "node:test";
import assert from "node:assert/strict";
import { NotificationAudio, SOUNDS } from "../public/notifications.js";

function fixture() {
  const values = new Map();
  const starts = [],
    levels = [];
  const context = {
    state: "suspended",
    currentTime: 1,
    destination: {},
    async resume() {
      this.state = "running";
    },
    createOscillator() {
      return {
        frequency: {},
        connect() {},
        disconnect() {},
        start(time) {
          starts.push(time);
        },
        stop() {},
      };
    },
    createGain() {
      return {
        connect() {},
        disconnect() {},
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime(level) {
            levels.push(level);
          },
          exponentialRampToValueAtTime() {},
        },
      };
    },
  };
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  return {
    context,
    starts,
    levels,
    storage,
    audio: new NotificationAudio({ storage, contextFactory: () => context }),
  };
}

test("five distinct gentle presets can be previewed after an audio gesture", async () => {
  assert.equal(SOUNDS.length, 5);
  assert.equal(
    new Set(SOUNDS.map((sound) => JSON.stringify(sound.notes))).size,
    5,
  );
  const { audio, starts } = fixture();
  assert.equal(
    audio.play(),
    false,
    "do not bypass browser autoplay restrictions",
  );
  assert.equal(await audio.unlock(), true);
  for (const sound of SOUNDS) {
    audio.set(sound.id, 40);
    assert.equal(audio.play(true), true);
  }
  assert.ok(starts.length >= 5);
});

test("volume, mute, bounded burst playback, persistence and invalid settings", async () => {
  const { audio, storage, context, starts, levels } = fixture();
  await audio.unlock();
  audio.set("ping", 50);
  assert.equal(audio.play(), true);
  assert.equal(audio.play(), false, "coalesce bursts");
  assert.equal(levels[0], 0.175);
  context.currentTime += 1;
  audio.set("ping", 0);
  assert.equal(audio.play(), false);
  audio.set("off", 50);
  assert.equal(audio.play(true), false);
  assert.equal(starts.length, 1);
  const restored = new NotificationAudio({ storage });
  assert.equal(restored.sound, "off");
  assert.equal(restored.volume, 50);
  restored.set("bad", 300);
  assert.equal(restored.sound, "ping");
  assert.equal(restored.volume, 100);
  restored.set("ping", NaN);
  assert.equal(restored.volume, 35);
});

test("unavailable audio and storage never interrupt chat", async () => {
  const audio = new NotificationAudio({
    storage: {
      getItem() {
        throw new Error();
      },
      setItem() {
        throw new Error();
      },
    },
    contextFactory() {
      throw new Error();
    },
  });
  audio.set("ping", 40);
  assert.equal(await audio.unlock(), false);
  assert.equal(audio.play(), false);
});
