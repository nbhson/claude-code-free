'use strict';

const crypto = require('crypto');

/**
 * Generate an ID matching Anthropic's format.
 * Anthropic IDs look like: msg_01ABCDefgh..., toolu_01AbCd...
 *
 * @param {'msg_'|'toolu_'} prefix
 * @returns {string}
 */
function generateId(prefix) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = prefix + '01';
  for (let i = 0; i < 22; i++) {
    id += chars[crypto.randomInt(chars.length)];
  }
  return id;
}

/**
 * Translate OpenAI streaming SSE chunks → Anthropic SSE events.
 *
 * ## How it works
 *
 * Anthropic sends content blocks sequentially (text, then tool_use, then tool_use…).
 * OpenAI can interleave tool call arguments across chunks (index 0, then index 1, then index 0 again).
 * To handle this, we:
 *   1. Stream text content in real-time (good UX).
 *   2. Buffer tool call arguments per OpenAI tool_call index.
 *   3. When finish_reason arrives, emit all tool call blocks sequentially.
 *
 * ## Event sequence produced
 *
 *   message_start
 *   content_block_start (text, index=0) — only if text is present
 *   content_block_delta (text_delta) × N  — streamed in real-time
 *   content_block_stop (index=0)
 *   … tool_use blocks emitted sequentially from buffer …
 *   message_delta
 *   message_stop
 */
class AnthropicStreamTranslator {
  /**
   * @param {Object} anthropicReq - The original Anthropic request (for model name & metadata)
   */
  constructor(anthropicReq) {
    this.messageId = generateId('msg_');
    this.model = anthropicReq.model || 'unknown';
    this.started = false;
    this.ended = false;

    // Current text block state
    this.currentBlockIdx = -1;
    this.currentBlockType = null; // 'text' | 'tool_use'
    this.hadText = false;

    // Tool call buffer: { [openaiIndex]: { id, name, args } }
    /** @type {Object<string, {id: string|null, name: string|null, args: string}>} */
    this.toolCallBuffer = {};
  }

  /**
   * Process one OpenAI streaming chunk and return Anthropic SSE events.
   *
   * @param {Object} openaiChunk - Parsed OpenAI chat.completion.chunk
   * @returns {Array<{event: string, data: string}>}
   */
  processChunk(openaiChunk) {
    if (this.ended) return [];

    const choice = openaiChunk.choices?.[0];
    if (!choice) return [];

    const delta = choice.delta || {};
    const finishReason = choice.finish_reason;
    const usage = choice.usage || openaiChunk.usage;
    const events = [];

    // ── 1. Message start (first chunk with role) ────────────────
    if (!this.started && delta.role === 'assistant') {
      this.started = true;
      events.push(createEvent('message_start', {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
    }

    if (!this.started) return []; // Wait for the first real chunk

    // ── 2. Text content — stream in real-time ───────────────────
    // Use != null to catch both undefined and null, but NOT empty string ""
    // because the first OpenAI chunk often has content: "" to signal text.
    if (delta.content !== undefined && delta.content !== null) {
      this._ensureTextBlock(events);
      if (delta.content) {
        events.push(createEvent('content_block_delta', {
          type: 'content_block_delta',
          index: this.currentBlockIdx,
          delta: { type: 'text_delta', text: delta.content },
        }));
        this.hadText = true;
      }
    }

    // ── 3. Tool calls — buffer by index ─────────────────────────
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = String(tc.index);

        if (!this.toolCallBuffer[idx]) {
          this.toolCallBuffer[idx] = { id: null, name: null, args: '' };
        }

        if (tc.id) this.toolCallBuffer[idx].id = tc.id;
        if (tc.function?.name) this.toolCallBuffer[idx].name = tc.function.name;
        if (tc.function?.arguments) this.toolCallBuffer[idx].args += tc.function.arguments;
      }
    }

    // ── 4. Finish reason — emit remaining tool blocks ───────────
    if (finishReason) {
      this.ended = true;

      // Close open text block if it exists
      if (this.currentBlockType === 'text') {
        events.push(createEvent('content_block_stop', {
          type: 'content_block_stop',
          index: this.currentBlockIdx,
        }));
        this.currentBlockType = null;
      }

      // Emit buffered tool call blocks sequentially
      const indices = Object.keys(this.toolCallBuffer)
        .map(Number)
        .sort((a, b) => a - b);

      for (const idx of indices) {
        const tc = this.toolCallBuffer[idx];
        const toolUseId = generateId('toolu_');
        const input = this._parseToolArgs(tc.args);

        // If we have any tool call that hasn't started streaming yet,
        // and we haven't called it, ensure we close whatever's open
        if (this.currentBlockType) {
          events.push(createEvent('content_block_stop', {
            type: 'content_block_stop',
            index: this.currentBlockIdx,
          }));
          this.currentBlockType = null;
        }

        this.currentBlockIdx++;
        this.currentBlockType = 'tool_use';

        events.push(createEvent('content_block_start', {
          type: 'content_block_start',
          index: this.currentBlockIdx,
          content_block: {
            type: 'tool_use',
            id: toolUseId,
            name: tc.name || 'unknown_function',
            input: input,
          },
        }));

        events.push(createEvent('content_block_stop', {
          type: 'content_block_stop',
          index: this.currentBlockIdx,
        }));
      }

      this.currentBlockType = null;

      // message_delta with stop reason
      events.push(createEvent('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: this._mapFinishReason(finishReason),
          stop_sequence: null,
        },
        usage: {
          input_tokens: 0,
          output_tokens: usage?.completion_tokens ?? 0,
        },
      }));

      // message_stop
      events.push(createEvent('message_stop', {
        type: 'message_stop',
      }));
    }

    return events;
  }

  // ─── Internal helpers ──────────────────────────────────────────

  /** Ensure a text content block is open, starting one if needed. */
  _ensureTextBlock(events) {
    if (this.currentBlockType === 'text') return;

    // Close any existing non-text block (shouldn't happen in practice)
    if (this.currentBlockType) {
      events.push(createEvent('content_block_stop', {
        type: 'content_block_stop',
        index: this.currentBlockIdx,
      }));
    }

    this.currentBlockIdx++;
    this.currentBlockType = 'text';

    events.push(createEvent('content_block_start', {
      type: 'content_block_start',
      index: this.currentBlockIdx,
      content_block: { type: 'text', text: '' },
    }));
  }

  /** Attempt to parse tool call arguments JSON, fall back to raw string. */
  _parseToolArgs(raw) {
    if (!raw || raw.trim() === '') return {};
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }

  /**
   * Map OpenAI finish_reason → Anthropic stop_reason.
   *
   * OpenAI: "stop" | "tool_calls" | "length" | "content_filter"
   * Anthropic: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence"
   */
  _mapFinishReason(reason) {
    switch (reason) {
      case 'stop':           return 'end_turn';
      case 'tool_calls':     return 'tool_use';
      case 'length':         return 'max_tokens';
      case 'content_filter': return 'end_turn';
      default:               return 'end_turn';
    }
  }
}

/**
 * Create an Anthropic SSE event object.
 *
 * @param {string} eventName - SSE event name (message_start, content_block_delta, …)
 * @param {Object} data - JSON-serializable data payload
 * @returns {{ event: string, data: string }}
 */
function createEvent(eventName, data) {
  return {
    event: eventName,
    data: JSON.stringify(data),
  };
}

module.exports = { AnthropicStreamTranslator, generateId };
