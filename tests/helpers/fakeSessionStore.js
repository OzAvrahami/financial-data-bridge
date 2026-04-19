/**
 * Fake SessionStore for integration tests.
 * Does not touch the filesystem. Holds state in memory.
 */
export class FakeSessionStore {
  /**
   * @param {object|null} initialState - Returned by load(). Pass non-null to simulate a saved session.
   */
  constructor(initialState = null) {
    this._state = initialState;
    this.saved = [];    // Records every save() call: [{ provider, accountId, state }]
    this.cleared = false;
  }

  async load(provider, accountId) {
    return this._state;
  }

  async save(provider, accountId, state) {
    this.saved.push({ provider, accountId, state });
    this._state = state; // update in-memory so subsequent loads reflect new state
  }

  async clear(provider, accountId) {
    this.cleared = true;
    this._state = null;
  }
}
