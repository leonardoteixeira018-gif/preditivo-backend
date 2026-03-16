class SimpleCache {
  constructor(defaultTtlMs = 30_000) {
    this._store = {};
    this._defaultTtl = defaultTtlMs;
  }

  set(key, value, ttlMs) {
    this._store[key] = {
      value,
      expiresAt: Date.now() + (ttlMs ?? this._defaultTtl)
    };
  }

  get(key) {
    const item = this._store[key];
    if (!item) return null;
    if (item.expiresAt < Date.now()) {
      delete this._store[key];
      return null;
    }
    return item.value;
  }

  del(key) {
    delete this._store[key];
  }

  flush() {
    this._store = {};
  }
}

module.exports = new SimpleCache();
