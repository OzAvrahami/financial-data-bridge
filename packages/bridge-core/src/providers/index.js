/**
 * Provider registration hub.
 * Import this module once at startup to populate the providerRegistry.
 *
 * Adding a new provider only requires two steps here:
 *   1. import { MaxProvider } from './max/index.js';
 *   2. providerRegistry.register('max', MaxProvider);
 */
import { providerRegistry } from '../core/providerRegistry.js';
import { CalProvider } from './cal/index.js';

providerRegistry.register('cal', CalProvider);

// Future providers:
// import { MaxProvider } from './max/index.js';
// providerRegistry.register('max', MaxProvider);
