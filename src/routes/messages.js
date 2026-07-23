'use strict';

const express = require('express');
const { getActiveProvider } = require('../config');
const { translateRequest } = require('../translators/request');
const { translateResponse, translateError } = require('../translators/response');
const { AnthropicStreamTranslator } = require('../translators/stream');

const router = express.Router();

const PROXY_TIMEOUT_MS = 300_000; // 5 minutes
const LOG_PREFIX = '✦';

/**
 * POST /v1/messages
 *
 * Accepts Anthropic Messages API format, translates to OpenAI Chat Completions,
 * forwards to the configured provider, and translates the response back.
 *
 * Headers accepted:
 *   X-Provider   - Select a specific provider from config (optional)
 *   X-Api-Key    - Override API key for this request (optional)
 */
router.post('/v1/messages', async (req, res) => {
  const startTime = Date.now();
  let upstreamUrl = '';

  try {
    // ── 1. Resolve provider ──────────────────────────────────────
    const providerName = req.headers['x-provider'];
    let provider;
    try {
      provider = getActiveProvider(providerName);
    } catch (err) {
      return res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: err.message },
      });
    }

    const anthropicReq = req.body;

    // ── 2. Stream vs non-stream ──────────────────────────────────
    const isStreaming = anthropicReq.stream === true;

    // ── 3. Translate request to OpenAI format ────────────────────
    const openaiReq = translateRequest(anthropicReq, provider);

    // ── 4. Build upstream request ────────────────────────────────
    upstreamUrl = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

    /** @type {Response} */
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
          ...(req.headers['x-api-key'] ? { Authorization: `Bearer ${req.headers['x-api-key']}` } : {}),
        },
        body: JSON.stringify(openaiReq),
        signal: controller.signal,
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        if (!res.headersSent) {
          return res.status(504).json({
            type: 'error',
            error: {
              type: 'api_error',
              message: 'Upstream provider request timed out',
            },
          });
        }
        return;
      }
      throw fetchError;
    }

    clearTimeout(timeoutId);

    // ── 5. Handle upstream errors ────────────────────────────────
    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text().catch(() => '');
      let errorJson;
      try { errorJson = JSON.parse(errorBody); } catch { errorJson = { message: errorBody || upstreamResponse.statusText }; }
      const anthropicError = translateError(errorJson, upstreamResponse.status);
      return res.status(upstreamResponse.status).json(anthropicError);
    }

    // ── 6a. Streaming response ───────────────────────────────────
    if (isStreaming) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const translator = new AnthropicStreamTranslator(anthropicReq);
      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();
      const errorHandler = createStreamErrorHandler(res);

      try {
        await processOpenAIStream(reader, decoder, translator, res);
      } catch (streamError) {
        errorHandler(streamError);
      } finally {
        try { res.end(); } catch { /* ignore if already ended */ }
      }

      logRequest(anthropicReq, provider, true, startTime);
      return;
    }

    // ── 6b. Non-streaming response ───────────────────────────────
    const responseBody = await upstreamResponse.json();
    const anthropicResponse = translateResponse(responseBody, anthropicReq);
    res.json(anthropicResponse);

    logRequest(anthropicReq, provider, false, startTime);

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error:`, error.cause?.code
      ? `${error.message}: ${error.cause.code}`
      : error.message);

    if (!res.headersSent) {
      const message = error.cause?.code === 'ECONNREFUSED'
        ? `Connection refused — is the upstream provider running? ${upstreamUrl}`
        : error.cause?.code === 'ENOTFOUND'
          ? `DNS lookup failed for upstream provider: ${upstreamUrl}`
          : error.cause?.code === 'ECONNRESET'
            ? 'Connection reset by upstream provider'
            : error.message || 'Internal proxy error';

      res.status(502).json({
        type: 'error',
        error: {
          type: 'api_error',
          message,
        },
      });
    }
  }
});

// ─── Streaming helpers ─────────────────────────────────────────────────

/**
 * Process an OpenAI SSE stream, translating to Anthropic SSE events.
 *
 * OpenAI sends:
 *   data: {...}\n\n
 *   data: [DONE]\n\n
 *
 * Anthropic expects:
 *   event: message_start\ndata: {...}\n\n
 *   event: content_block_delta\ndata: {...}\n\n
 */
async function processOpenAIStream(reader, decoder, translator, res) {
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Split on newlines; keep the last partial line in the buffer
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();

      // Only process "data: ..." lines
      if (!trimmed.startsWith('data: ')) continue;

      let content = trimmed.slice(6).trim();

      // OpenAI stream end marker
      if (content === '[DONE]') continue;

      // Some providers send "data: [DONE]" with trailing whitespace
      if (content.startsWith('[DONE]')) continue;

      let openaiChunk;
      try {
        openaiChunk = JSON.parse(content);
      } catch (parseErr) {
        // Non-JSON data line — might be a keep-alive or provider-specific
        continue;
      }

      const events = translator.processChunk(openaiChunk);
      for (const evt of events) {
        try {
          res.write(`event: ${evt.event}\n`);
          res.write(`data: ${evt.data}\n\n`);
        } catch (writeErr) {
          // Client disconnected
          return;
        }
      }
    }
  }
}

/**
 * Create a handler that writes an error event to the SSE stream
 * and then ends it, or writes a JSON error if headers not yet sent.
 */
function createStreamErrorHandler(res) {
  return (error) => {
    if (error.name === 'AbortError') return; // Client disconnect, ignore

    console.error(`[${LOG_PREFIX}] Stream error:`, error.message);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: error.message || 'Stream error',
        },
      })}\n\n`);
      res.end();
    } catch { /* ignore write errors on ended stream */ }
  };
}

// ─── Logging ───────────────────────────────────────────────────────────

function logRequest(anthropicReq, provider, wasStreaming, startTime) {
  const duration = Date.now() - startTime;
  const fromModel = anthropicReq.model || 'unknown';
  const toModel = provider.model;
  const mode = wasStreaming ? 'stream' : 'non-stream';

  console.log(
    `[${LOG_PREFIX}] ${fromModel} → ${toModel} (${mode}) ${duration}ms`
  );
}

module.exports = router;
