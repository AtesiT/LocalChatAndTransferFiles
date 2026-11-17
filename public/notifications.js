// Synthesized locally: no audio downloads, microphone access, or external services.
export const SOUNDS = [
  { id: "ping", name: "Soft ping", notes: [[660, 0, 0.28, "sine", 0.35]] },
  {
    id: "bell",
    name: "Little bell",
    notes: [
      [880, 0, 0.4, "sine", 0.25],
      [1320, 0, 0.3, "sine", 0.08],
    ],
  },
  {
    id: "chime",
    name: "Warm chime",
    notes: [
      [523.25, 0, 0.24, "sine", 0.25],
      [659.25, 0.12, 0.3, "sine", 0.25],
    ],
  },
  {
    id: "drop",
    name: "Raindrop",
    notes: [
      [1046.5, 0, 0.12, "sine", 0.25],
      [784, 0.08, 0.22, "sine", 0.2],
    ],
  },
  {
    id: "pluck",
    name: "Gentle pluck",
    notes: [
      [440, 0, 0.2, "triangle", 0.2],
      [660, 0.06, 0.22, "sine", 0.14],
    ],
  },
];

export class NotificationAudio {
  constructor({ storage, contextFactory } = {}) {
    try {
      this.storage = storage ?? globalThis.localStorage;
    } catch {
      /* Storage is optional. */
    }
    this.contextFactory =
      contextFactory ??
      (() => {
        const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
        return Audio ? new Audio() : null;
      });
    this.sound = "ping";
    this.volume = 35;
    this.context = null;
    this.lastPlayed = -Infinity;
    try {
      const saved = JSON.parse(
        this.storage?.getItem("localchat-notifications"),
      );
      if (saved) this.set(saved.sound, saved.volume, false);
    } catch {
      /* Ignore invalid settings. */
    }
  }

  set(sound, volume, persist = true) {
    this.sound =
      sound === "off" || SOUNDS.some((item) => item.id === sound)
        ? sound
        : "ping";
    this.volume =
      typeof volume === "number" && Number.isFinite(volume)
        ? Math.round(Math.max(0, Math.min(100, volume)))
        : 35;
    if (persist) {
      try {
        this.storage?.setItem(
          "localchat-notifications",
          JSON.stringify({ sound: this.sound, volume: this.volume }),
        );
      } catch {
        /* Storage is optional. */
      }
    }
  }

  // Must run from a user gesture to comply with browser autoplay policies.
  async unlock() {
    try {
      this.context ||= this.contextFactory();
      if (this.context?.state === "suspended") await this.context.resume();
      return this.context?.state === "running";
    } catch {
      return false;
    }
  }

  play(preview = false) {
    const preset = SOUNDS.find((item) => item.id === this.sound);
    if (!preset || !this.volume || this.context?.state !== "running")
      return false;
    const now = this.context.currentTime;
    if (!preview && now - this.lastPlayed < 0.15) return false;
    this.lastPlayed = now;
    try {
      for (const [frequency, offset, duration, type, level] of preset.notes) {
        const oscillator = this.context.createOscillator();
        const envelope = this.context.createGain();
        oscillator.type = type;
        oscillator.frequency.value = frequency;
        const start = now + offset;
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(
          (level * this.volume) / 100,
          start + 0.012,
        );
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        oscillator.connect(envelope);
        envelope.connect(this.context.destination);
        oscillator.onended = () => {
          oscillator.disconnect();
          envelope.disconnect();
        };
        oscillator.start(start);
        oscillator.stop(start + duration + 0.01);
      }
      return true;
    } catch {
      return false;
    }
  }
}
