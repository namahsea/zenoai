import type { Provider } from '../config.js';

export const ZENO_MODELS: Record<Provider, string> = {
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-pro',
  openrouter: 'anthropic/claude-sonnet-4.6',
  openai: 'gpt-5.5',
};
