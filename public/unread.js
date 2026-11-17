// No badge or panel: the only presentation is the browser tab's title.
export class TabUnread {
  constructor(change = () => {}) {
    this.change = change;
    this.reset("general");
  }

  reset(room) {
    this.room = room;
    this.count = 0;
    this.known = new Set();
    this.initialized = false;
    this.change(this.title);
  }

  get title() {
    return `${this.count ? `(${this.count}) ` : ""}localchat / #${this.room}`;
  }

  remember(id) {
    this.known.add(id);
    if (this.known.size > 200)
      this.known.delete(this.known.values().next().value);
  }

  receive(message, ownId, active) {
    if (this.known.has(message.id)) return;
    this.remember(message.id);
    if (!active && message.userId !== ownId) {
      this.count++;
      this.change(this.title);
    }
  }

  snapshot(messages, ownId, active) {
    for (const message of messages) {
      if (this.initialized) this.receive(message, ownId, active);
      else this.remember(message.id);
    }
    this.initialized = true;
  }

  read(active) {
    if (active && this.count) {
      this.count = 0;
      this.change(this.title);
    }
  }
}
