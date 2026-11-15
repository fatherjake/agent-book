import type { ModelProvider } from '../types.js';
import { AnthropicProvider, type AnthropicProviderOptions } from './anthropic.js';
import { MockProvider, type MockScript } from './mock.js';

export { AnthropicProvider, hasAnthropicCredentials } from './anthropic.js';
export { MockProvider, createMockProvider, type MockScript, type MockStep } from './mock.js';

export interface CreateProviderOptions {
  anthropic?: AnthropicProviderOptions;
  /** Script for the mock provider (default: write a trivial file and finish). */
  mockScript?: MockScript;
}

/** createProvider('anthropic' | 'mock'). Throws on unknown names. */
export function createProvider(name: string, opts: CreateProviderOptions = {}): ModelProvider {
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider(opts.anthropic);
    case 'mock':
      return new MockProvider(opts.mockScript);
    default:
      throw new Error(`Unknown model provider '${name}' (supported: anthropic, mock)`);
  }
}
