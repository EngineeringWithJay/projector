'use strict';

/**
 * Software Plane — Stub until Phase 5.
 * Peer-distributed app updates: staging, restart, apply.
 * Interface exists now to prevent architecture surgery later.
 */
class SoftwarePlane {
  constructor() {
    this.drive = null;
    this._key = null;
  }

  get key() { return this._key; }
  get writable() { return false; }

  async open(/* { store, key, namespace } */) {
    // Stub: no-op in Phase 0–4
    return { drive: null, softwareKey: null, writable: false };
  }

  async checkForUpdate() { return null; }
  async stageUpdate(/* version */) { throw new Error('SoftwarePlane not implemented until Phase 5'); }
  async applyUpdate() { throw new Error('SoftwarePlane not implemented until Phase 5'); }
  async close() { this.drive = null; this._key = null; }
}

module.exports = SoftwarePlane;
