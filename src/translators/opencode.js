'use strict';

/**
 * OpenCode Provider Integration
 * ==============================
 *
 * Translates Anthropic Messages API ↔ OpenCode Server API format.
 * Manages OpenCode session lifecycle (create, reuse, delete).
 *
 * OpenCode Server API:
 *   Base URL:  http://127.0.0.1:4096 (default)
 *   POST /session                    → create session, returns { id }
 *   POST /session/:id/message        → send message, returns { info, parts }
 *   GET  /session/:id                → get session info
 *   DELETE /session/:id              → delete session
 *   GET  /global/health              → health check
 *   GET  /config/providers           → list available providers
 *
 * Auth: HTTP Basic (user: "opencode", pass: OPENCODE_SERVER_PASSWORD)
 */

const crypto = require('crypto');

// ── Constants ────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 300_000; // 5 minutes
const AUTH_USER = 'opencode';

// ── In-memory session state ──────────────────────────────────────────────

/**
 * Active OpenCode session (singleton per proxy lifecycle).
 * @type {{ sessionId: string, toolCallCache: Map<string, {name: string, input: any}> }|null}
 */
let activeSession = null;

// ── OpenCode HTTP Client ─────────────────────────────────────────────────

/**
 * Make an HTTP request to the OpenCode server.
 *
 * @param {'GET'|'POST'|'DELETE'} method
 * @param {string} path - URL path (e.g. "/session")
 * @param {object} [body] - JSON body for POST
 * @param {{ baseUrl: string, password: string }} opts
 * @returns {Promise<any>} Parsed JSON response
 */
async function opencodeRequest(method, path, body, opts) {
  const baseUrl = (opts.baseUrl || 'http://127.0.0.1:4096').replace(/\/+$/, '');
  const url = `${baseUrl}${path}`;
  const headers = { 'Content-Type': 'application/json' };

  if (opts.password) {
    const encoded = Buffer.from(`${AUTH_USER}:${opts.password}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`OpenCode API ${res.status}: ${text || res.statusText}`);
      err.statusCode = res.status;
      err.body = text;
      throw err;
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      const timeout = new Error('OpenCode server request timed out');
      timeout.name = 'TimeoutError';
      throw timeout;
    }
    throw err;
  }
}

// ── Session Management ───────────────────────────────────────────────────

/**
 * Ensure an OpenCode session exists. Creates one if needed.
 *
 * @param {{ baseUrl: string, password: string }} opts
 * @returns {Promise<string>} Session ID
 */
async function ensureSession(opts) {
  // Verify existing session is still alive
  if (activeSession) {
    try {
      await opencodeRequest('GET', `/session/${activeSession.sessionId}`, null, opts);
      return activeSession.sessionId;
    } catch {
      // Session expired or server restarted — reset
      activeSession = null;
    }
  }

  // Create new session
  const sess = await opencodeRequest('POST', '/session', {
    title: 'Claude Code Proxy',
  }, opts);

  activeSession = {
    sessionId: sess.id,
    toolCallCache: new Map(),
  };

  console.log(`[✦] OpenCode session created: ${sess.id}`);
  return sess.id;
}

/**
 * Delete the active OpenCode session (on shutdown).
 *
 * @param {{ baseUrl: string, password: string }} opts
 */
async function destroySession(opts) {
  if (!activeSession) return;
  try {
    await opencodeRequest('DELETE', `/session/${activeSession.sessionId}`, null, opts);
    console.log(`[✦] OpenCode session deleted: ${activeSession.sessionId}`);
  } catch (err) {
    console.warn(`[✦] Failed to delete OpenCode session: ${err.message}`);
  }
  activeSession = null;
}

/**
 * Get OpenCode server health status.
 *
 * @param {{ baseUrl: string, password: string }} opts
 * @returns {Promise<{ connected: boolean, healthy?: boolean, version?: string, error?: string }>}
 */
async function getHealth(opts) {
  try {
    const h = await opencodeRequest('GET', '/global/health', null, opts);
    return { connected: true, healthy: h.healthy, version: h.version };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

// ── Request Translation: Anthropic → OpenCode ────────────────────────────

/**
 * Translate the LAST user message from an Anthropic request → OpenCode parts.
 *
 * The Anthropic /v1/messages endpoint includes the FULL conversation history
 * each turn. OpenCode maintains history in its session, so we only need
 * to send the NEW content: the last user message (text, tool results, etc.).
 *
 * @param {object} anthropicReq - The full Anthropic request body
 * @param {object} provider - Resolved provider config
 * @returns {object} OpenCode message body for POST /session/:id/message
 */
function translateRequest(anthropicReq, provider) {
  const parts = [];
  let system = '';

  // ── 1. Extract system prompt ──────────────────────────────────────
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      system = anthropicReq.system;
    } else if (Array.isArray(anthropicReq.system)) {
      system = anthropicReq.system
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
  }

  // ── 2. Look for tool results in the last user message ──────────────
  const messages = anthropicReq.messages || [];
  const lastMsg = messages[messages.length - 1];

  if (lastMsg && lastMsg.role === 'user') {
    const userParts = translateUserContent(lastMsg.content);
    parts.push(...userParts);
  }

  // ── 3. Build OpenCode body ────────────────────────────────────────
  /** @type {object} */
  const opencodeBody = {
    parts,
    noReply: false,
  };

  // Model config (providerID + modelID from OpenCode's config)
  opencodeBody.model = {};
  opencodeBody.model.providerID = provider.providerID || provider.name || 'openai';
  opencodeBody.model.modelID = provider.modelID || provider.model || 'gpt-4o';

  if (system) opencodeBody.system = system;
  if (provider.agent) opencodeBody.agent = provider.agent;

  // Translate Anthropic tools to OpenCode-compatible tools
  if (anthropicReq.tools?.length) {
    opencodeBody.tools = anthropicReq.tools.map(translateTool);
  }

  return opencodeBody;
}

/**
 * Translate Anthropic user message content → array of OpenCode parts.
 * Handles: text, tool_result, image content blocks.
 *
 * @param {string|object[]} content
 * @returns {object[]} Array of OpenCode parts
 */
function translateUserContent(content) {
  // Simple string content
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: 'text', text: String(content) }];
  }

  const parts = [];

  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text) parts.push({ type: 'text', text: block.text });
        break;

      case 'tool_result':
        parts.push(translateToolResult(block));
        break;

      case 'image':
        parts.push({
          type: 'text',
          text: block.source?.type === 'base64'
            ? `[Image: ${block.source.media_type || 'image/png'} (base64, ${(block.source.data || '').length} chars)]`
            : '[Image omitted]',
        });
        break;

      default:
        parts.push({ type: 'text', text: JSON.stringify(block) });
    }
  }

  return parts;
}

/**
 * Translate Anthropic tool_result → OpenCode tool part (completed).
 * Looks up tool call info from the session's cache.
 *
 * @param {object} block - Anthropic tool_result content block
 * @returns {object} OpenCode tool part
 */
function translateToolResult(block) {
  const toolUseId = block.tool_use_id;
  const result = extractContentText(block.content);
  const isError = block.is_error === true;

  const toolPart = {
    type: 'tool',
    id: toolUseId,
    state: isError ? 'error' : 'completed',
  };

  if (result) toolPart.result = result;

  // Restore tool name + input from cache so OpenCode can match the call
  if (activeSession) {
    const cached = activeSession.toolCallCache.get(toolUseId);
    if (cached) {
      toolPart.name = cached.name;
      if (cached.input !== undefined) toolPart.input = cached.input;
    }
  }

  return toolPart;
}

/**
 * Extract plain text from a tool_result content field.
 *
 * @param {string|object[]} content
 * @returns {string}
 */
function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
  }
  return String(content || '');
}

/**
 * Translate Anthropic tool definition → OpenCode-compatible format.
 *
 * @param {object} tool - Anthropic tool definition
 * @returns {object} OpenCode tool format
 */
function translateTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || {},
    },
  };
}

// ── Response Translation: OpenCode → Anthropic ───────────────────────────

/**
 * Translate an OpenCode session message response → Anthropic Messages API format.
 *
 * @param {object} opencodeResp - OpenCode response { info, parts }
 * @param {object} anthropicReq - Original Anthropic request (for model name)
 * @returns {object} Anthropic-formatted response
 */
function translateResponse(opencodeResp, anthropicReq) {
  const { info, parts } = opencodeResp;
  const content = [];

  if (!parts || !Array.isArray(parts)) {
    return buildErrorResponse('api_error', 'Empty response from OpenCode provider');
  }

  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text) {
          content.push({ type: 'text', text: part.text });
        }
        break;

      case 'tool': {
        // Map OpenCode tool parts to Anthropic tool_use content blocks
        // Only map pending/completed tool calls (not errors)
        if (part.state === 'pending' || part.state === 'running') {
          const toolCallId = part.id || generateId('toolu_');
          const toolName = part.name || 'unknown_function';
          const toolInput = part.input || {};

          // Cache tool call info for future tool result resolution
          if (activeSession && toolCallId) {
            activeSession.toolCallCache.set(toolCallId, {
              name: toolName,
              input: toolInput,
            });
          }

          content.push({
            type: 'tool_use',
            id: toolCallId,
            name: toolName,
            input: toolInput,
          });
        } else if (part.state === 'completed' && part.result !== undefined) {
          // A completed tool with result — embed as text
          const resultText = typeof part.result === 'string'
            ? part.result
            : JSON.stringify(part.result);
          if (resultText) {
            content.push({
              type: 'text',
              text: `[Tool result: ${part.name || 'tool'}]\n${resultText}`,
            });
          }
        }
        break;
      }

      case 'reasoning':
        // Skip reasoning/thinking blocks — not in Anthropic's public API
        break;

      case 'compaction':
        // Skip compaction markers — internal to OpenCode
        break;
    }
  }

  // Determine stop_reason
  const hasToolUse = content.some(c => c.type === 'tool_use');
  let stopReason = 'end_turn';

  if (info && info.finish) {
    stopReason = mapFinishReason(info.finish);
  } else if (hasToolUse) {
    stopReason = 'tool_use';
  }

  return {
    id: (info && info.id) || generateId('msg_'),
    type: 'message',
    role: 'assistant',
    content,
    model: anthropicReq.model || 'unknown',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: (info && info.tokens && info.tokens.input) || 0,
      output_tokens: (info && info.tokens && info.tokens.output) || 0,
    },
  };
}

/**
 * Map OpenCode finish reason → Anthropic stop_reason.
 *
 * @param {string} reason
 * @returns {string}
 */
function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':           return 'end_turn';
    case 'tool_calls':     return 'tool_use';
    case 'length':         return 'max_tokens';
    case 'content_filter': return 'end_turn';
    default:               return 'end_turn';
  }
}

// ── Error Handling ───────────────────────────────────────────────────────

/**
 * Build an Anthropic-style error response.
 *
 * @param {string} type - Error type
 * @param {string} message - Error message
 * @returns {object}
 */
function buildErrorResponse(type, message) {
  return {
    type: 'error',
    error: { type, message },
  };
}

/**
 * Translate an OpenCode connection/request error → Anthropic error response.
 *
 * @param {Error} err
 * @returns {{ statusCode: number, body: object }}
 */
function translateError(err) {
  // Timeout
  if (err.name === 'TimeoutError') {
    return {
      statusCode: 504,
      body: buildErrorResponse('api_error', 'OpenCode server request timed out'),
    };
  }

  // Fetch-level errors (connection refused, DNS failure, etc.)
  if (err.name === 'TypeError' && err.message.includes('fetch')) {
    const cause = err.cause;
    if (cause && cause.code === 'ECONNREFUSED') {
      return {
        statusCode: 502,
        body: buildErrorResponse('api_error',
          'Connection refused — is the OpenCode server running? Try: opencode serve'),
      };
    }
    if (cause && cause.code === 'ENOTFOUND') {
      return {
        statusCode: 502,
        body: buildErrorResponse('api_error',
          'DNS lookup failed — check OpenCode server hostname'),
      };
    }
    return {
      statusCode: 502,
      body: buildErrorResponse('api_error', 'Cannot reach OpenCode server: ' + err.message),
    };
  }

  // HTTP error from OpenCode server
  if (err.statusCode) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      return {
        statusCode: 401,
        body: buildErrorResponse('authentication_error',
          'OpenCode authentication failed — check OPENCODE_SERVER_PASSWORD'),
      };
    }
    if (err.statusCode === 404) {
      return {
        statusCode: 502,
        body: buildErrorResponse('api_error',
          'OpenCode resource not found — server may have restarted'),
      };
    }
    return {
      statusCode: err.statusCode,
      body: buildErrorResponse('api_error', err.message),
    };
  }

  // Generic fallback
  return {
    statusCode: 502,
    body: buildErrorResponse('api_error', err.message || 'OpenCode server error'),
  };
}

// ── Main Handler ─────────────────────────────────────────────────────────

/**
 * Build Anthropic SSE events from a non-streaming response.
 * Generates the full event sequence: message_start → content blocks → message_stop.
 * This allows the proxy to return proper SSE even when OpenCode's blocking API was used.
 *
 * @param {object} anthropicResp - The translated Anthropic response
 * @returns {Array<{event: string, data: object}>} SSE events
 */
function buildStreamingEvents(anthropicResp) {
  const events = [];
  const msg = anthropicResp;

  // message_start
  events.push({
    event: 'message_start',
    data: { type: 'message_start', message: msg },
  });

  // For each content block: start → delta (text only) → stop
  const content = msg.content || [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];

    // content_block_start
    events.push({
      event: 'content_block_start',
      data: { type: 'content_block_start', index: i, content_block: block },
    });

    // Text blocks get a delta event
    if (block.type === 'text' && block.text) {
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } },
      });
    }

    // Tool_use blocks don't get a delta (input is already complete)

    // content_block_stop
    events.push({
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: i },
    });
  }

  // message_delta
  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: {
        stop_reason: msg.stop_reason || 'end_turn',
        stop_sequence: msg.stop_sequence || null,
      },
      usage: msg.usage || { input_tokens: 0, output_tokens: 0 },
    },
  });

  // message_stop
  events.push({
    event: 'message_stop',
    data: { type: 'message_stop' },
  });

  return events;
}

/**
 * Handle a complete request through OpenCode.
 *
 * @param {object} anthropicReq - Anthropic request body
 * @param {object} provider - Resolved provider config (with type: "opencode")
 * @returns {Promise<{ statusCode?: number, body: object }>}
 */
async function handleRequest(anthropicReq, provider) {
  const baseUrl = provider.baseUrl || 'http://127.0.0.1:4096';
  const password = provider.password || '';
  const opts = { baseUrl, password };

  try {
    // 1. Ensure session exists
    const sessionId = await ensureSession(opts);

    // 2. Translate request
    const opencodeBody = translateRequest(anthropicReq, provider);

    // 3. Send to OpenCode
    const opencodeResp = await opencodeRequest(
      'POST',
      `/session/${sessionId}/message`,
      opencodeBody,
      opts
    );

    // 4. Translate response back
    const anthropicResp = translateResponse(opencodeResp, anthropicReq);

    return { body: anthropicResp };
  } catch (err) {
    return translateError(err);
  }
}

// ── Utility ──────────────────────────────────────────────────────────────

/**
 * Generate an ID matching Anthropic's format (msg_... / toolu_...).
 *
 * @param {'msg_'|'toolu_'} prefix
 * @returns {string}
 */
function generateId(prefix) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = prefix + '01';
  for (let i = 0; i < 22; i++) {
    id += chars[crypto.randomInt(chars.length)];
  }
  return id;
}

// ── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  // Client
  ensureSession,
  destroySession,
  getHealth,
  handleRequest,
  buildStreamingEvents,
  // Translation (exposed for testing)
  translateRequest,
  translateResponse,
  translateError,
  // Module state
  getActiveSession: () => activeSession,
  resetSession: () => { activeSession = null; },
};
