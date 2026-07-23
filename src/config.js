'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  port: 4000,
  activeProvider: 'openai',
  providers: {},
};

/**
 * Load config from config.json, fall back to defaults.
 * Supports env-var overrides for the active provider.
 */
function loadConfig() {
  let config = { ...DEFAULT_CONFIG };

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      config = { ...config, ...parsed };
    }
  } catch (err) {
    console.warn(`⚠️  Could not load config.json: ${err.message}`);
  }

  // Env override for active provider
  if (process.env.ACTIVE_PROVIDER) {
    config.activeProvider = process.env.ACTIVE_PROVIDER;
  }

  return config;
}

/**
 * Get the active provider configuration.
 * Merges env-var overrides (PROVIDER_BASE_URL, PROVIDER_API_KEY, PROVIDER_MODEL).
 *
 * @param {string} [overrideName] - Optional provider name from X-Provider header
 * @returns {{ name: string, baseUrl: string, apiKey: string, model: string }}
 */
function getActiveProvider(overrideName) {
  const config = loadConfig();
  const providerName = overrideName || config.activeProvider;
  const provider = config.providers[providerName];

  if (!provider) {
    throw new Error(
      `Provider "${providerName}" not found in config. ` +
      `Available: ${Object.keys(config.providers).join(', ') || '(none)'}`
    );
  }

  return {
    name: providerName,
    baseUrl: process.env.PROVIDER_BASE_URL || provider.baseUrl,
    apiKey: process.env.PROVIDER_API_KEY || provider.apiKey || '',
    model: process.env.PROVIDER_MODEL || provider.model,
    // Pass through OpenCode-specific fields (undefined for regular providers)
    type: provider.type,
    password: provider.password,
    providerID: provider.providerID,
    modelID: provider.modelID,
    agent: provider.agent,
  };
}

module.exports = { loadConfig, getActiveProvider };
