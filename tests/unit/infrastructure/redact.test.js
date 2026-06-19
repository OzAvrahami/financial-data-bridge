/**
 * Unit tests for the secret redaction helpers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, safeUrl, truncate } from '../../../packages/bridge-core/src/infrastructure/redact.js';

describe('redactSecrets', () => {
  it('replaces every occurrence of each secret', () => {
    const out = redactSecrets('key=ABC123 again ABC123', ['ABC123']);
    assert.equal(out, 'key=[REDACTED] again [REDACTED]');
  });
  it('ignores empty/nullish secrets and non-strings', () => {
    assert.equal(redactSecrets('hello', ['', null, undefined]), 'hello');
    assert.equal(redactSecrets(undefined, ['x']), '');
  });
  it('handles multiple distinct secrets', () => {
    assert.equal(redactSecrets('u tok', ['u', 'tok']), '[REDACTED] [REDACTED]');
  });
});

describe('safeUrl', () => {
  it('drops query, fragment, and userinfo (possible token carriers)', () => {
    assert.equal(safeUrl('https://api.example.com/v1/tx?token=SECRET#frag'), 'https://api.example.com/v1/tx');
    assert.equal(safeUrl('https://user:pass@api.example.com/x'), 'https://api.example.com/x');
  });
  it('returns a placeholder for unparseable input', () => {
    assert.equal(safeUrl('not a url'), '[invalid-url]');
  });
});

describe('truncate', () => {
  it('truncates beyond the max and marks it', () => {
    assert.equal(truncate('abcdef', 3), 'abc…[truncated]');
  });
  it('leaves short text untouched', () => {
    assert.equal(truncate('abc', 10), 'abc');
  });
});
