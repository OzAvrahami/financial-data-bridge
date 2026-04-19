import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { providerRegistry } from '../../../src/core/providerRegistry.js';

// Use test-scoped provider names to avoid collision with real providers
// that may have been registered via the side-effect import in other modules.

class ProviderA {}
class ProviderB {}

describe('providerRegistry', () => {
  it('register and create work together', () => {
    providerRegistry.register('test_a', ProviderA);
    const instance = providerRegistry.create('test_a', {});
    assert.ok(instance instanceof ProviderA);
  });

  it('has() returns true for registered provider', () => {
    providerRegistry.register('test_b', ProviderB);
    assert.equal(providerRegistry.has('test_b'), true);
  });

  it('has() returns false for unknown provider', () => {
    assert.equal(providerRegistry.has('does_not_exist_xyz'), false);
  });

  it('list() includes all registered providers', () => {
    providerRegistry.register('test_list_a', ProviderA);
    providerRegistry.register('test_list_b', ProviderB);
    const list = providerRegistry.list();
    assert.ok(list.includes('test_list_a'));
    assert.ok(list.includes('test_list_b'));
  });

  it('create throws a descriptive error for unknown provider', () => {
    assert.throws(
      () => providerRegistry.create('no_such_provider', {}),
      err => {
        assert.ok(err.message.includes('no_such_provider'));
        return true;
      }
    );
  });

  it('is case-insensitive for register and create', () => {
    providerRegistry.register('TestCase', ProviderA);
    const instance = providerRegistry.create('testcase', {});
    assert.ok(instance instanceof ProviderA);
  });

  it('has() is case-insensitive', () => {
    providerRegistry.register('CaseSensTest', ProviderA);
    assert.equal(providerRegistry.has('casesenstest'), true);
    assert.equal(providerRegistry.has('CASESENSTEST'), true);
  });

  it('later registration overwrites the same key', () => {
    providerRegistry.register('overwrite_test', ProviderA);
    providerRegistry.register('overwrite_test', ProviderB);
    const instance = providerRegistry.create('overwrite_test', {});
    assert.ok(instance instanceof ProviderB);
  });

  it('create passes config to the constructor', () => {
    class ConfigCapture { constructor(cfg) { this.cfg = cfg; } }
    providerRegistry.register('config_test', ConfigCapture);
    const cfg = { foo: 'bar' };
    const instance = providerRegistry.create('config_test', cfg);
    assert.deepEqual(instance.cfg, cfg);
  });
});
