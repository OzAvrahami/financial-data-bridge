/**
 * Central provider registry.
 *
 * To add a new provider (e.g. MAX):
 *   1. Create src/providers/max/index.js extending BaseProvider
 *   2. Add one line in src/providers/index.js:
 *        providerRegistry.register('max', MaxProvider);
 *   That is the only change required outside the provider folder.
 */

const registry = new Map();

export const providerRegistry = {
  /** Register a provider class under a lowercase name key. */
  register(name, ProviderClass) {
    registry.set(name.toLowerCase(), ProviderClass);
  },

  /** Instantiate a registered provider. Throws if name is unknown. */
  create(name, config) {
    const ProviderClass = registry.get(name.toLowerCase());
    if (!ProviderClass) {
      const available = [...registry.keys()].join(', ') || 'none';
      throw new Error(`Unknown provider: "${name}". Registered: ${available}`);
    }
    return new ProviderClass(config);
  },

  has(name) {
    return registry.has(name.toLowerCase());
  },

  list() {
    return [...registry.keys()];
  },
};
