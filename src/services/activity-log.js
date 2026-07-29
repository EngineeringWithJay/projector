'use strict';

const fs = require('fs');
const path = require('path');

/**
 * ActivityLog — Local audit trail.
 * Stores activity entries as a JSON file on disk.
 * Activity is audit. Messages are coordination. Contracts are permissions.
 */

const MAX_ENTRIES = 1000;

class ActivityLog {
  constructor(storagePath) {
    this._storagePath = storagePath;
    this._logPath = path.join(storagePath, 'activity.json');
    this._entries = null;
  }

  _load() {
    if (this._entries) return this._entries;
    try {
      if (fs.existsSync(this._logPath)) {
        this._entries = JSON.parse(fs.readFileSync(this._logPath, 'utf8'));
        if (!Array.isArray(this._entries)) this._entries = [];
      } else {
        this._entries = [];
      }
    } catch (_) { this._entries = []; }
    return this._entries;
  }

  _save() {
    fs.mkdirSync(path.dirname(this._logPath), { recursive: true });
    fs.writeFileSync(this._logPath, JSON.stringify(this._entries || [], null, 2));
  }

  /**
   * Log an activity entry.
   * @param {Object} entry
   * @param {string} entry.type - e.g. 'file-added', 'file-removed', 'session-joined'
   * @param {string} [entry.entryPath]
   * @param {string} [entry.actorDeviceId]
   * @param {string} [entry.actorLabel]
   * @param {Object} [entry.metadata]
   */
  log(entry) {
    const entries = this._load();
    entries.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: entry.type || 'unknown',
      entryPath: entry.entryPath || null,
      actorDeviceId: entry.actorDeviceId || null,
      actorLabel: entry.actorLabel || null,
      metadata: entry.metadata || {},
      timestamp: Date.now(),
    });
    // Cap at MAX_ENTRIES
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    this._entries = entries;
    this._save();
    return entries[0];
  }

  /** Get all entries (newest first). */
  getEntries() {
    return this._load();
  }

  /** Reset the log. */
  reset() {
    this._entries = [];
    this._save();
  }
}

module.exports = ActivityLog;
