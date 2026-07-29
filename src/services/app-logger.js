'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

class AppLogger {
  constructor({ storagePath, fileName = 'projector.log' } = {}) {
    if (!storagePath) throw new Error('AppLogger requires storagePath.');
    this.storagePath = storagePath;
    this.logDir = path.join(storagePath, 'logs');
    this.logPath = path.join(this.logDir, fileName);
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  debug(scope, message, meta = null) {
    this._write('debug', scope, message, meta);
  }

  info(scope, message, meta = null) {
    this._write('info', scope, message, meta);
  }

  warn(scope, message, meta = null) {
    this._write('warn', scope, message, meta);
  }

  error(scope, message, meta = null) {
    this._write('error', scope, message, meta);
  }

  clear() {
    fs.mkdirSync(this.logDir, { recursive: true });
    fs.writeFileSync(this.logPath, '', 'utf8');
  }

  getLogPath() {
    return this.logPath;
  }

  getLogDir() {
    return this.logDir;
  }

  readRecent(limit = 200) {
    try {
      if (!fs.existsSync(this.logPath)) {
        return { logPath: this.logPath, entries: [] };
      }
      const raw = fs.readFileSync(this.logPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const entries = lines.slice(-Math.max(1, Number(limit) || 200)).map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return {
            timestamp: new Date().toISOString(),
            level: 'error',
            scope: 'logger',
            message: 'Failed to parse log line',
            meta: { line },
          };
        }
      });
      return { logPath: this.logPath, entries };
    } catch (err) {
      return {
        logPath: this.logPath,
        entries: [{
          timestamp: new Date().toISOString(),
          level: 'error',
          scope: 'logger',
          message: 'Failed to read logs',
          meta: this._sanitizeValue(err),
        }],
      };
    }
  }

  _write(level, scope, message, meta) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      scope: String(scope || 'app'),
      message: String(message || ''),
      meta: meta == null ? null : this._sanitizeValue(meta),
    };
    const line = `${JSON.stringify(entry)}\n`;

    try {
      fs.appendFileSync(this.logPath, line, 'utf8');
    } catch (_) {}

    const text = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}`;
    const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (entry.meta == null) {
      consoleMethod(text);
    } else {
      consoleMethod(text, util.inspect(entry.meta, { depth: 4, breakLength: 120 }));
    }
  }

  _sanitizeValue(value, seen = new WeakSet()) {
    if (value == null) return value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (Buffer.isBuffer(value)) return { type: 'Buffer', byteLength: value.length };
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
        code: value.code || null,
      };
    }
    if (Array.isArray(value)) {
      return value.map((item) => this._sanitizeValue(item, seen));
    }
    if (typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        try {
          out[key] = this._sanitizeValue(item, seen);
        } catch (_) {
          out[key] = '[Unserializable]';
        }
      }
      seen.delete(value);
      return out;
    }
    return String(value);
  }
}

module.exports = AppLogger;
