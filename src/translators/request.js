'use strict';

/**
 * Translate Anthropic Messages API request body → OpenAI Chat Completions request body.
 *
 * Handles:
 *  - system prompt (string or array of content blocks)
 *  - user/assistant messages with text, image, tool_result, tool_use content blocks
 *  - tool definitions
 *  - tool_choice mapping
 *  - thinking / cache_control stripping (not supported by most providers)
 */

/**
 * @param {Object} anthropicReq - Parsed Anthropic API request body
 * @param {{ model: string }} provider - Provider config with model name
 * @returns {Object} OpenAI Chat Completions request body
 */
function translateRequest(anthropicReq, provider) {
  const openaiMessages = [];

  // ── 1. System prompt ──────────────────────────────────────────────
  if (anthropicReq.system) {
    const text = extractSystemText(anthropicReq.system);
    if (text) {
      openaiMessages.push({ role: 'system', content: text });
    }
  }

  // ── 2. Messages ───────────────────────────────────────────────────
  for (const msg of anthropicReq.messages) {
    const translated = translateMessage(msg);
    if (translated) {
      // Flatten array results (anthropic user message with content blocks
      // can expand to multiple OpenAI messages — tool_results become separate)
      if (Array.isArray(translated)) {
        openaiMessages.push(...translated);
      } else {
        openaiMessages.push(translated);
      }
    }
  }

  // ── 3. Build request ──────────────────────────────────────────────
  /** @type {Object} */
  const openaiReq = {
    model: provider.model,
    messages: openaiMessages,
    stream: anthropicReq.stream === true,
    max_tokens: anthropicReq.max_tokens ?? 4096,
  };

  // Optional params
  if (anthropicReq.temperature !== undefined) {
    openaiReq.temperature = anthropicReq.temperature;
  }
  if (anthropicReq.top_p !== undefined) {
    openaiReq.top_p = anthropicReq.top_p;
  }
  if (anthropicReq.stop_sequences?.length) {
    openaiReq.stop = anthropicReq.stop_sequences;
  }

  // ── 4. Tools ──────────────────────────────────────────────────────
  if (anthropicReq.tools?.length) {
    openaiReq.tools = anthropicReq.tools.map(translateTool);
  }

  // ── 5. Tool choice ────────────────────────────────────────────────
  if (anthropicReq.tool_choice) {
    openaiReq.tool_choice = translateToolChoice(anthropicReq.tool_choice);
  }

  return openaiReq;
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Extract plain text from an Anthropic system parameter.
 */
function extractSystemText(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

/**
 * Translate a single Anthropic message to one or more OpenAI messages.
 *
 * @param {Object} msg
 * @returns {Object|Object[]|null}
 */
function translateMessage(msg) {
  switch (msg.role) {
    case 'user':
      return translateUserMessage(msg);
    case 'assistant':
      return translateAssistantMessage(msg);
    default:
      return null;
  }
}

/**
 * Translate an Anthropic user message.
 * Content can be a string or an array of content blocks (text, image, tool_result).
 */
function translateUserMessage(msg) {
  // Simple text content
  if (typeof msg.content === 'string') {
    return { role: 'user', content: msg.content };
  }

  if (!Array.isArray(msg.content)) {
    return { role: 'user', content: String(msg.content) };
  }

  // Split into: plain content blocks vs tool_result blocks.
  // tool_result → separate message with role 'tool'
  const contentParts = [];
  const toolResults = [];

  for (const block of msg.content) {
    switch (block.type) {
      case 'text':
        contentParts.push({ type: 'text', text: block.text });
        break;

      case 'image': {
        const translated = translateImageBlock(block);
        if (translated) contentParts.push(translated);
        break;
      }

      case 'tool_result':
        toolResults.push(translateToolResult(block));
        break;

      default:
        contentParts.push({ type: 'text', text: JSON.stringify(block) });
    }
  }

  const result = [];

  // User message with content parts
  if (contentParts.length > 0) {
    result.push({ role: 'user', content: contentParts });
  }

  // Tool result messages (must come after user message in OpenAI format)
  for (const tr of toolResults) {
    result.push(tr);
  }

  return result.length > 0 ? result : null;
}

/**
 * Translate an Anthropic assistant message.
 * Content can be a string or an array (text + tool_use blocks).
 */
function translateAssistantMessage(msg) {
  if (typeof msg.content === 'string') {
    return { role: 'assistant', content: msg.content };
  }

  if (!Array.isArray(msg.content)) {
    return { role: 'assistant', content: '' };
  }

  let textContent = '';
  const toolCalls = [];

  for (const block of msg.content) {
    if (block.type === 'text') {
      textContent += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: typeof block.input === 'string'
            ? block.input
            : JSON.stringify(block.input),
        },
      });
    }
  }

  const assistantMsg = {
    role: 'assistant',
    content: textContent || null,
  };

  if (toolCalls.length > 0) {
    assistantMsg.tool_calls = toolCalls;
  }

  return assistantMsg;
}

/**
 * Translate an Anthropic image content block → OpenAI image_url part.
 */
function translateImageBlock(block) {
  const source = block.source;
  if (!source || source.type !== 'base64') return null;

  return {
    type: 'image_url',
    image_url: {
      url: `data:${source.media_type || 'image/png'};base64,${source.data}`,
    },
  };
}

/**
 * Translate an Anthropic tool_result block → OpenAI tool message.
 */
function translateToolResult(block) {
  const content = extractToolResultContent(block.content);
  return {
    role: 'tool',
    tool_call_id: block.tool_use_id,
    content,
  };
}

/**
 * Extract string content from a tool_result content field
 * (can be string or array of content blocks).
 */
function extractToolResultContent(content) {
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
 * Translate an Anthropic tool definition → OpenAI function tool.
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

/**
 * Translate Anthropic tool_choice → OpenAI tool_choice.
 *
 * Anthropic: { type: "auto" | "any" | "tool", name: "..." }
 * OpenAI:   "auto" | "none" | "required" | { type: "function", function: { name } }
 */
function translateToolChoice(toolChoice) {
  switch (toolChoice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'tool':
      return {
        type: 'function',
        function: { name: toolChoice.name },
      };
    default:
      return 'auto';
  }
}

module.exports = { translateRequest };
