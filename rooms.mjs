import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const deriveKey = promisify(scrypt);
const fail = (message, status) => Object.assign(new Error(message), { status });
export const roomInfo = (room) => ({
  id: room.id,
  name: room.name,
  protected: !!room.hash,
});

export class RoomStore {
  constructor() {
    this.rooms = new Map([
      ["general", { id: randomUUID(), name: "general", messages: [] }],
    ]);
    this.pending = new Set();
    this.hashing = 0;
  }

  get(name) {
    return this.rooms.get(name);
  }
  list() {
    return [...this.rooms.values()].map(roomInfo);
  }

  validateName(name) {
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name))
      throw fail("Room names use 1–32 lowercase letters, digits, _ or -.", 400);
  }

  validatePassword(password) {
    if (typeof password !== "string" || [...password].length > 128)
      throw fail("Passwords must contain at most 128 characters.", 400);
  }

  async hash(password, salt) {
    if (this.hashing >= 4)
      throw fail("Room authentication is busy. Try again shortly.", 429);
    this.hashing++;
    try {
      return await deriveKey(password, salt, 64);
    } finally {
      this.hashing--;
    }
  }

  async create(name, password = "") {
    this.validateName(name);
    this.validatePassword(password);
    if (this.rooms.has(name) || this.pending.has(name))
      throw fail("That room already exists. Join it instead.", 409);
    if (this.rooms.size + this.pending.size >= 50)
      throw fail(
        "Room limit reached (50). Wait for empty rooms to close.",
        409,
      );
    this.pending.add(name);
    try {
      const salt = password ? randomBytes(16) : null;
      const hash = password ? await this.hash(password, salt) : null;
      const room = { id: randomUUID(), name, salt, hash, messages: [] };
      this.rooms.set(name, room);
      return room;
    } finally {
      this.pending.delete(name);
    }
  }

  async verify(room, password = "") {
    this.validatePassword(password);
    if (!room.hash) return true;
    const candidate = await this.hash(password, room.salt);
    return timingSafeEqual(candidate, room.hash);
  }
}
