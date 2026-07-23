'use strict';

const { generateId } = require('./stream');

/**
 * Translate a non-streaming OpenAI Chat Completions response
 * → Anthropic Messages API response format.
 *
 * @param {Object} openaiResp  - Parsed OpenAI response body
 * @param {Object} anthropicReq - Original Anthropic request (for model name)
 * @returns {Object} Anthropic Messages API response body
 */
function translateResponse(openaiResp, anthropicReq) {
  const choice = openaiResp.choices?.[0];
  if (!choice) {
    return errorResponse('api_error', 'Empty response from upstream provider');
  }

  const message = choice.message || {};
  const content = [];

  // Text content
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  // Tool calls
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      const input = parseJsonSafe(tc.function?.arguments);
      content.push({
        type: 'tool_use',
        id: generateId('toolu_'),
        name: tc.function?.name || 'unknown',
        input,
      });
    }
  }

  return {
    id: generateId('msg_'),
    type: 'message',
    role: 'assistant',
    content,
    model: anthropicReq.model,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens ?? 0,
      output_tokens: openaiResp.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Translate an upstream provider error to Anthropic error format.
 *
 * @param {Object} upstreamError - Parsed error body from the upstream
 * @param {number} statusCode - HTTP status code
 * @returns {Object} Anthropic-style error response
 */
function translateError(upstreamError, statusCode) {
  const message = upstreamError?.error?.message
    || upstreamError?.message
    || `Upstream provider returned ${statusCode}`;

  const errorType = mapErrorType(statusCode, upstreamError?.error?.type);

  return {
    type: 'error',
    error: {
      type: errorType,
      message,
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Map OpenAI finish_reason → Anthropic stop_reason.
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

/**
 * Map HTTP status + upstream error type to Anthropic error type.
 */
function mapErrorType(statusCode, upstreamType) {
  if (statusCode === 401 || statusCode === 403) return 'authentication_error';
  if (statusCode === 429) return 'rate_limit_error';
  if (statusCode === 400 || upstreamType === 'invalid_request_error') return 'invalid_request_error';
  if (statusCode === 404) return 'not_found_error';
  if (statusCode >= 500) return 'api_error';
  return 'api_error';
}

/**
 * Create a minimal error response.
 */
function errorResponse(type, message) {
  return {
    type: 'error',
    error: { type, message },
  };
}

/**
 * Parse JSON safely, return object on success or raw string on failure.
 */
function parseJsonSafe(str) {
  if (!str) return {};
  try {
    return JSON.parse(str);
  } catch {
    return { arguments: str };
  }
}

module.exports = { translateResponse, translateError };
