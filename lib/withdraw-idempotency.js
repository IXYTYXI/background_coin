export class WithdrawCompletionRegistry {
  constructor({ ttlMs = 24 * 60 * 60 * 1000, maxEntries = 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.pending = new Map();
    this.completed = new Map();
  }

  start(serial) {
    const key = normalizeSerial(serial);
    if (!key) return { status: 'started', key: '' };
    this.cleanup();

    const completed = this.completed.get(key);
    if (completed) return { status: 'completed', key, value: completed.value };
    if (this.pending.has(key)) return { status: 'pending', key };

    this.pending.set(key, Date.now());
    return { status: 'started', key };
  }

  finish(serial, value) {
    const key = normalizeSerial(serial);
    if (!key) return;
    this.pending.delete(key);
    this.completed.set(key, {
      value,
      createdAt: Date.now()
    });
    this.trim();
  }

  fail(serial) {
    const key = normalizeSerial(serial);
    if (key) this.pending.delete(key);
  }

  cleanup(now = Date.now()) {
    for (const [key, startedAt] of this.pending.entries()) {
      if (now - startedAt > this.ttlMs) this.pending.delete(key);
    }
    for (const [key, entry] of this.completed.entries()) {
      if (now - entry.createdAt > this.ttlMs) this.completed.delete(key);
    }
  }

  trim() {
    while (this.completed.size > this.maxEntries) {
      const oldestKey = this.completed.keys().next().value;
      this.completed.delete(oldestKey);
    }
  }
}

function normalizeSerial(serial) {
  return String(serial || '').trim();
}
