/**
 * Fake CheckpointStore for integration tests.
 * Holds state in memory — no filesystem access.
 */
export class FakeCheckpointStore {
  /**
   * @param {object|null} initialCheckpoint - Returned by load(). Pass non-null to simulate a saved checkpoint.
   */
  constructor(initialCheckpoint = null) {
    this._checkpoint = initialCheckpoint;
    this.saved  = []; // records every save() call
    this.cleared = false;
  }

  filePath(provider, accountId = 'default') {
    const suffix = accountId && accountId !== 'default' ? `_${accountId}` : '';
    return `runtime/checkpoints/${provider}${suffix}.json`;
  }

  async load(provider, accountId = 'default') {
    return this._checkpoint;
  }

  async save(provider, accountId = 'default', checkpoint) {
    this.saved.push({ provider, accountId, checkpoint });
    this._checkpoint = checkpoint;
  }

  async clear(provider, accountId = 'default') {
    this.cleared = true;
    this._checkpoint = null;
  }
}
