# Claude Code Proxy ✦

Use **Claude Code CLI** with **any LLM provider** (OpenAI, Ollama, OmniRoute, DeepSeek, Azure, ...) instead of the Anthropic API.

## How it works

```mermaid
---
title: Architecture Overview
---
flowchart LR
    subgraph CLI["🧑‍💻 Claude Code CLI"]
        direction LR
        A1[Send request\nAnthropic format]
        A2[Receive response\nAnthropic format]
    end

    subgraph Proxy["⚡ Proxy Server (localhost:4000)"]
        direction TB
        B0[POST /v1/messages]
        B1["Translator Request\nAnthropic → OpenAI"]
        B2["Translator Response\nOpenAI → Anthropic"]
        B3["Stream Translator\nSSE chunk-by-chunk"]
        B4[Error Handler\nConnection, Timeout, Auth]
        B0 --> B1 --> B2
        B0 --> B1 --> B3
        B1 --> B4
        B2 --> B4
    end

    subgraph Provider["🌐 Provider API\n(OpenAI, Ollama, DeepSeek, ...)"]
        C["POST /v1/chat/completions\nOpenAI format"]
    end

    A1 -- "ANTHROPIC_BASE_URL=http://localhost:4000" --> B0
    B1 -- "translate & forward" --> C
    C -- "response / SSE stream" --> B2
    C -- "SSE stream" --> B3
    B2 -- "translated response" --> A2
    B3 -- "translated SSE events" --> A2
```

```mermaid
---
title: Streaming Flow (detailed)
---
sequenceDiagram
    participant CLI as Claude Code CLI
    participant Proxy as Proxy Server
    participant Provider as Provider API

    Note over CLI,Provider: 1. Claude Code sends Anthropic Messages API request

    CLI->>Proxy: POST /v1/messages (stream: true)
    Note right of CLI: { model, system, messages, tools, tool_choice, max_tokens }

    rect rgb(200, 220, 240)
        Note over Proxy: Request Translator
        Proxy->>Proxy: system → system prompt
        Proxy->>Proxy: user messages → user (text/image/tool_result)
        Proxy->>Proxy: assistant messages → assistant (text/tool_calls)
        Proxy->>Proxy: tools → functions
        Proxy->>Proxy: tool_choice → auto/none/required
    end

    Proxy->>Provider: POST /v1/chat/completions (stream: true)
    Note right of Proxy: { model: "gpt-4o", messages: [...], tools: [...], stream: true }

    rect rgb(200, 240, 200)
        Note over Provider: Provider processes
        Provider-->>Proxy: SSE: data: {"choices":[{"delta":{"role":"assistant"}}]}
    end

    rect rgb(240, 220, 200)
        Note over Proxy: Stream Translator
        Note over Proxy: message_start<br/>Emit message initialization event

        Provider-->>Proxy: SSE: data: {"choices":[{"delta":{"content":"Hello"}}]}
        Proxy-->>CLI: event: content_block_start<br/>data: { type:"text", text:"" }
        Proxy-->>CLI: event: content_block_delta<br/>data: { type:"text_delta", text:"Hello" }

        Provider-->>Proxy: SSE: data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"file\":"}}]}}]}
        Note over Proxy: Tool call arguments are buffered<br/>by index, not emitted immediately

        Provider-->>Proxy: SSE: data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\"cmd\":\"ls"}}]}}]}
        Note over Proxy: Multiple tool calls can<br/>interleave across indices

        Provider-->>Proxy: SSE: data: {"choices":[{"delta":{}},"finish_reason":"tool_calls"}]}
        Note over Proxy: When finish_reason arrives:
        Note over Proxy: 1. content_block_stop (text)<br/>2. content_block_start (tool_use)<br/>3. content_block_stop (tool_use)<br/>4. message_delta<br/>5. message_stop

        Proxy-->>CLI: event: content_block_stop data: { index:0 }
        Proxy-->>CLI: event: content_block_start data: { type:"tool_use", name:"read_file" }
        Proxy-->>CLI: event: content_block_stop data: { index:1 }
        Proxy-->>CLI: event: message_delta data: { stop_reason:"tool_use" }
        Proxy-->>CLI: event: message_stop data: {}
    end

    Note over CLI,Provider: 2. Claude Code sends tool results

    CLI->>Proxy: POST /v1/messages (stream: true)
    Note right of CLI: { messages: [..., {role:"assistant",content:[tool_use]},<br/>{role:"user",content:[tool_result]}] }

    rect rgb(200, 220, 240)
        Note over Proxy: Request Translator
        Proxy->>Proxy: tool_result → tool message (role: tool)
    end

    Proxy->>Provider: POST /v1/chat/completions
    Note right of Proxy: { messages: [..., {role:"tool",content:"..."}] }
    Provider-->>Proxy: SSE stream response (continues the loop)
```

```mermaid
---
title: Non-Streaming Flow
---
sequenceDiagram
    participant CLI as Claude Code CLI
    participant Proxy as Proxy Server
    participant Provider as Provider API

    CLI->>Proxy: POST /v1/messages (stream: false)
    rect rgb(200, 220, 240)
        Note over Proxy: Translate request
    end
    Proxy->>Provider: POST /v1/chat/completions (stream: false)
    Note over Provider: Process & respond
    Provider-->>Proxy: { choices: [{ message: { content, tool_calls } }] }
    rect rgb(240, 220, 200)
        Note over Proxy: Translate response
        Proxy->>Proxy: content → [{ type:"text", text }]
        Proxy->>Proxy: tool_calls → [{ type:"tool_use", id, name, input }]
        Proxy->>Proxy: finish_reason → stop_reason
        Proxy->>Proxy: usage → input_tokens / output_tokens
    end
    Proxy-->>CLI: Anthropic Messages API Response
```

The proxy **translates** between API formats:
- **Anthropic Messages API** → **OpenAI Chat Completions API**
- Handles: system prompts, tool calls, streaming SSE, images, tool results
- **Tool calls** are buffered and accurately translated between the two formats

## Quick Start

### 1. Install

```bash
git clone https://github.com/nbhson/claude-code-free.git
cd claude-code-proxy
npm install
```

### 2. Configure

Copy and edit `config.json`:

```bash
cp config.json.example config.json
```

Example configuration:

```json
{
  "port": 4000,
  "activeProvider": "openai",
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-your-key-here",
      "model": "gpt-4o"
    },
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "",
      "model": "llama3.1:8b"
    }
  }
}
```

### 3. Start the proxy

```bash
npm start
# or
npm run dev  # auto-restart on code changes
```

### 4. Use with Claude Code CLI

```bash
ANTHROPIC_BASE_URL=http://localhost:4000 claude
```

> **All Claude Code features work** — file editing, bash commands, MCP tools, session management, etc.

> ⚠️ Newer Claude Code CLI versions require login. Run `/login` once, then use `ANTHROPIC_BASE_URL=http://localhost:4000 claude` — the proxy handles all requests without hitting the real Anthropic API.

### 5. Set up OpenCode Zen API (free)

Use **DeepSeek V4 Flash Free** or other free models via [OpenCode Zen](https://opencode.ai/zen):

1. Create an account at [opencode.ai/auth](https://opencode.ai/auth)
2. Copy your API key
3. Edit `config.json`:

```json
{
  "activeProvider": "opencode-zen",
  "providers": {
    "opencode-zen": {
      "name": "OpenCode Zen",
      "baseUrl": "https://opencode.ai/zen/v1",
      "apiKey": "sk-your-key-here",
      "model": "deepseek-v4-flash-free"
    }
  }
}
```

> Model IDs are just the name e.g. `deepseek-v4-flash-free`, no `opencode/` prefix.

Available free models:

| Model ID | Notes |
|---|---|
| `deepseek-v4-flash-free` | DeepSeek V4 Flash |
| `mimo-v2.5-free` | MiMo V2.5 |
| `big-pickle` | Big Pickle |
| `laguna-s-2.1-free` | Laguna S 2.1 |
| Other `*-free` models | See [Zen docs](https://opencode.ai/docs/zen/) |

Or use env overrides:

```bash
ACTIVE_PROVIDER=opencode-zen \
PROVIDER_BASE_URL=https://opencode.ai/zen/v1 \
PROVIDER_API_KEY=sk-your-key-here \
PROVIDER_MODEL=deepseek-v4-flash-free \
npm start
```

## Switching Providers

### Method 1: Config `activeProvider`

Edit `activeProvider` in `config.json`:

```json
{ "activeProvider": "ollama" }
```

### Method 2: Environment variable

```bash
ACTIVE_PROVIDER=ollama npm start
```

### Method 3: Env override (no config edit)

```bash
PROVIDER_BASE_URL=http://localhost:11434/v1 \
PROVIDER_MODEL=llama3.1:8b \
PROVIDER_API_KEY= \
ACTIVE_PROVIDER=ollama \
ANTHROPIC_BASE_URL=http://localhost:4000 claude
```

### Method 4: `X-Provider` header (for HTTP clients)

```bash
curl http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-Provider: deepseek" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

## Configuration details

```jsonc
{
  "port": 4000,                   // Proxy port
  "activeProvider": "openai",     // Default provider
  "providers": {
    "provider-name": {
      "name": "Display name",      // (optional)
      "baseUrl": "https://...",    // Base URL (OpenAI-compatible)
      "apiKey": "sk-...",          // API key (leave empty if not needed)
      "model": "gpt-4o"           // Model name
    }
  }
}
```

## Compatible Providers

| Provider | Base URL | Tool Calling | Notes |
|---|---|---|---|
| **OpenAI** | `https://api.openai.com/v1` | ✅ | API key required |
| **Ollama** | `http://localhost:11434/v1` | ⚠️ Model-dependent | Local, free |
| **OmniRoute** | `http://localhost:8080/v1` | ✅ | Local AI Gateway |
| **DeepSeek** | `https://api.deepseek.com/v1` | ✅ | Cheap |
| **Azure OpenAI** | `https://{res}.openai.azure.com/openai/deployments/{dep}` | ✅ | |
| **vLLM** | `http://localhost:8000/v1` | ✅ | Self-hosted |
| **Anyscale** | `https://api.endpoints.anyscale.com/v1` | ✅ | |
| **Together** | `https://api.together.xyz/v1` | ✅ | |
| **Mistral** | `https://api.mistral.ai/v1` | ✅ | |
| **Google Gemini (OpenAI proxy)** | `https://generativelanguage.googleapis.com/v1beta/openai` | ✅ | via Gemini OpenAI compatibility |
| **OpenCode Zen** 🆕 | `https://opencode.ai/zen/v1` | ✅ | Free models available (DeepSeek, MiMo, ...) |

## API

### `POST /v1/messages`

Anthropic Messages API → forward to provider.

**Request** (Anthropic format):
```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 1024,
  "system": "You are a helpful assistant.",
  "messages": [
    {"role": "user", "content": "List files in current directory"}
  ]
}
```

**Headers:**
- `X-Provider` — (optional) select provider (overrides `activeProvider`)
- `Content-Type: application/json`

### `GET /health`

Health check + provider info.

### `GET /providers`

List configured providers.

## Limitations

1. **Extended Thinking**: Not supported — Claude Code won't use thinking with non-Claude models.
2. **Prompt Caching**: Not supported — other providers don't have cache_control.
3. **Token counting**: Different providers report different token counts, numbers may not be accurate.
4. **Tool quality**: Tool calling depends on the target model. Strong models (GPT-4o, DeepSeek) work well; smaller models may produce incorrect tool call formats.

## License

MIT
