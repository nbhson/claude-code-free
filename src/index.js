#!/usr/bin/env node
'use strict';

const express = require('express');
const cors = require('cors');
const { loadConfig } = require('./config');
const messagesRouter = require('./routes/messages');
const opencode = require('./translators/opencode');

// ── Bootstrap ──────────────────────────────────────────────────────────

const config = loadConfig();
const app = express();
const PORT = process.env.PORT || config.port || 4000;

// ── Middleware ──────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Routes ─────────────────────────────────────────────────────────────

// Health / info
app.get('/health', async (_req, res) => {
  const body = {
    status: 'ok',
    activeProvider: config.activeProvider,
    providers: Object.keys(config.providers),
    serverTime: new Date().toISOString(),
  };

  // Include OpenCode server status if the active provider is OpenCode
  const provider = config.providers[config.activeProvider];
  if (provider && (provider.type || 'openai') === 'opencode') {
    body.opencode = await opencode.getHealth(provider);
  }

  res.json(body);
});

// List configured providers
app.get('/providers', (_req, res) => {
  const summary = Object.entries(config.providers).map(([key, p]) => ({
    name: key,
    baseUrl: p.baseUrl,
    model: p.model,
  }));
  res.json({ providers: summary, active: config.activeProvider });
});

// Simple model listing — returns the configured model for each provider
app.get('/v1/models', (_req, res) => {
  const models = Object.entries(config.providers).map(([key, p]) => ({
    id: p.model,
    object: 'model',
    provider: key,
  }));
  res.json({ object: 'list', data: models });
});

// Main proxy endpoint
app.use(messagesRouter);

// ── 404 handler ────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({
    type: 'error',
    error: {
      type: 'not_found_error',
      message: 'Not found. Available: POST /v1/messages, GET /health, GET /providers',
    },
  });
});

// ── Error handler ──────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('❌ Server error:', err);
  const status = err.status || 500;
  res.status(status).json({
    type: 'error',
    error: {
      type: 'api_error',
      message: err.message || 'Internal server error',
    },
  });
});

// ── Start ──────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║        ✦ Claude Code Proxy Server ✦             ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Listening :    http://localhost:${PORT}               ║`);
  console.log(`║  Provider  :    ${config.activeProvider.padEnd(34)}║`);
  console.log(`║  Models    :    ${Object.keys(config.providers).length} configured                ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Usage:                                         ║');
  console.log(`║  ANTHROPIC_BASE_URL=http://localhost:${PORT} claude   ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});

// ── Graceful shutdown ──────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down...`);

  // Clean up OpenCode session if active
  const provider = config.providers[config.activeProvider];
  if (provider && (provider.type || 'openai') === 'opencode') {
    opencode.destroySession(provider).catch(() => {});
  }

  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
