# Claude Code Proxy ✦

Dùng **Claude Code CLI** với **bất kỳ LLM provider nào** (OpenAI, Ollama, OmniRoute, DeepSeek, Azure, ...) thay vì Anthropic API.

## Cách hoạt động

```mermaid
---
title: Kiến trúc tổng thể
---
flowchart LR
    subgraph CLI["🧑‍💻 Claude Code CLI"]
        direction LR
        A1[Gửi request\nAnthropic format]
        A2[Nhận response\nAnthropic format]
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
title: Luồng Streaming (chi tiết)
---
sequenceDiagram
    participant CLI as Claude Code CLI
    participant Proxy as Proxy Server
    participant Provider as Provider API

    Note over CLI,Provider: 1. Claude Code gửi request dạng Anthropic Messages API

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
        Note over Provider: Provider xử lý
        Provider-->>Proxy: SSE: data: {"choices":[{"delta":{"role":"assistant"}}]}
    end

    rect rgb(240, 220, 200)
        Note over Proxy: Stream Translator
        Note over Proxy: message_start<br/>Emit sự kiện khởi tạo message

        Provider-->>Proxy: SSE: data: {"choices":[{"delta":{"content":"Hello"}}]}
        Proxy-->>CLI: event: content_block_start<br/>data: { type:"text", text:"" }
        Proxy-->>CLI: event: content_block_delta<br/>data: { type:"text_delta", text:"Hello" }

        Provider-->>Proxy: SSE: data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"file\":"}}]}}]}
        Note over Proxy: Tool call arguments được buffer<br/>theo index, không emit ngay

        Provider-->>Proxy: SSE: data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\"cmd\":\"ls"}}]}}]}
        Note over Proxy: Multiple tool calls có thể<br/>interleave giữa các index

        Provider-->>Proxy: SSE: data: {"choices":[{"delta":{}},"finish_reason":"tool_calls"}]}
        Note over Proxy: Khi finish_reason đến:
        Note over Proxy: 1. content_block_stop (text)<br/>2. content_block_start (tool_use)<br/>3. content_block_stop (tool_use)<br/>4. message_delta<br/>5. message_stop

        Proxy-->>CLI: event: content_block_stop data: { index:0 }
        Proxy-->>CLI: event: content_block_start data: { type:"tool_use", name:"read_file" }
        Proxy-->>CLI: event: content_block_stop data: { index:1 }
        Proxy-->>CLI: event: message_delta data: { stop_reason:"tool_use" }
        Proxy-->>CLI: event: message_stop data: {}
    end

    Note over CLI,Provider: 2. Claude Code gửi kết quả tool

    CLI->>Proxy: POST /v1/messages (stream: true)
    Note right of CLI: { messages: [..., {role:"assistant",content:[tool_use]},<br/>{role:"user",content:[tool_result]}] }

    rect rgb(200, 220, 240)
        Note over Proxy: Request Translator
        Proxy->>Proxy: tool_result → tool message (role: tool)
    end

    Proxy->>Provider: POST /v1/chat/completions
    Note right of Proxy: { messages: [..., {role:"tool",content:"..."}] }
    Provider-->>Proxy: SSE stream response (tiếp tục vòng lặp)
```

```mermaid
---
title: Luồng Non-Streaming
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
    Note over Provider: Xử lý & response
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

```mermaid
---
title: Data Translation Map
---
block-beta
    columns 2
        block:Anthro["Anthropic Format\n(Messages API)"]:1
            columns 1
                A1["system: string | array"]
                A2["messages: [{role, content}]"]
                A3["  text | image | tool_use | tool_result"]
                A4["tools: [{name, input_schema}]"]
                A5["tool_choice: {type, name}"]
                A6["model, max_tokens, temperature,\nstop_sequences, top_p, stream"]
        end
        block:OpenAI["OpenAI Format\n(Chat Completions API)"]:1
            columns 1
                B1["messages: [{role:'system', content}]"]
                B2["messages: [{role, content}]"]
                B3["  text → text | image → image_url |\n  tool_use → tool_calls | tool_result → role:'tool'"]
                B4["tools: [{type:'function', function}]"]
                B5["tool_choice: 'auto'|'none'|'required'|{type:'function'}"]
                B6["model, messages, max_tokens,\ntemperature, stop, top_p, stream"]
        end
    Anthro -->|"Request"| OpenAI
    OpenAI -->|"Response ↓"| Anthro
    block:RespOAI["OpenAI Response"]:1
        C1["choices[0].message.content"]
        C2["choices[0].message.tool_calls"]
        C3["choices[0].finish_reason"]
        C4["usage: prompt_tokens,\ncompletion_tokens"]
    end
    block:RespAnth["Anthropic Response"]:1
        D1["content: [{type:'text', text}]"]
        D2["content: [{type:'tool_use', id, name, input}]"]
        D3["stop_reason:\n'end_turn'|'tool_use'|'max_tokens'"]
        D4["usage: input_tokens,\noutput_tokens"]
    end
    RespOAI -->|"← Translate"| RespAnth
```

Proxy **translate** định dạng API:
- **Anthropic Messages API** → **OpenAI Chat Completions API**
- Xử lý: system prompts, tool calls, streaming SSE, images, tool results
- **Tool calls** được buffer và translate chính xác giữa 2 format

## Quick Start

### 1. Cài đặt

```bash
git clone https://github.com/YOUR_USER/claude-code-proxy.git
cd claude-code-proxy
npm install
```

### 2. Cấu hình

Copy và edit `config.json`:

```bash
cp config.json.example config.json
```

Nội dung cấu hình mẫu:

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

### 3. Chạy proxy

```bash
npm start
# hoặc
npm run dev  # auto-restart khi code thay đổi
```

### 4. Dùng với Claude Code CLI

```bash
ANTHROPIC_BASE_URL=http://localhost:4000 claude
```

> **Tất cả tính năng của Claude Code đều hoạt động** — file editing, bash commands, MCP tools, session management, v.v.

## Chuyển đổi Provider

### Cách 1: Config `activeProvider`

Sửa `activeProvider` trong `config.json`:

```json
{ "activeProvider": "ollama" }
```

### Cách 2: Biến môi trường

```bash
ACTIVE_PROVIDER=ollama npm start
```

### Cách 3: Env override (không cần sửa config)

```bash
PROVIDER_BASE_URL=http://localhost:11434/v1 \
PROVIDER_MODEL=llama3.1:8b \
PROVIDER_API_KEY= \
ACTIVE_PROVIDER=ollama \
ANTHROPIC_BASE_URL=http://localhost:4000 claude
```

### Cách 4: Header `X-Provider` (cho HTTP client)

```bash
curl http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-Provider: deepseek" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

## Cấu hình chi tiết

```jsonc
{
  "port": 4000,                   // Cổng proxy
  "activeProvider": "openai",     // Provider mặc định
  "providers": {
    "ten-provider": {
      "name": "Tên hiển thị",      // (tùy chọn)
      "baseUrl": "https://...",    // Base URL (OpenAI-compatible)
      "apiKey": "sk-...",          // API key (để trống nếu không cần)
      "model": "gpt-4o"           // Model name
    }
  }
}
```

## Providers tương thích

| Provider | Base URL | Tool Calling | Ghi chú |
|---|---|---|---|
| **OpenAI** | `https://api.openai.com/v1` | ✅ | Cần API key |
| **Ollama** | `http://localhost:11434/v1` | ⚠️ Model-dependent | Chạy local, free |
| **OmniRoute** | `http://localhost:8080/v1` | ✅ | Local AI Gateway |
| **DeepSeek** | `https://api.deepseek.com/v1` | ✅ | Rẻ |
| **Azure OpenAI** | `https://{res}.openai.azure.com/openai/deployments/{dep}` | ✅ | |
| **vLLM** | `http://localhost:8000/v1` | ✅ | Self-hosted |
| **Anyscale** | `https://api.endpoints.anyscale.com/v1` | ✅ | |
| **Together** | `https://api.together.xyz/v1` | ✅ | |
| **Mistral** | `https://api.mistral.ai/v1` | ✅ | |
| **Google Gemini (OpenAI proxy)** | `https://generativelanguage.googleapis.com/v1beta/openai` | ✅ | via Gemini OpenAI compatibility |

## API

### `POST /v1/messages`

Anthropic Messages API → forward đến provider.

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
- `X-Provider` — (optional) chọn provider (override `activeProvider`)
- `Content-Type: application/json`

### `GET /health`

Health check + provider info.

### `GET /providers`

Danh sách providers đã cấu hình.

## Hạn chế

1. **Extended Thinking**: Không hỗ trợ — Claude Code sẽ không dùng thinking với non-Claude models.
2. **Prompt Caching**: Không hỗ trợ — provider khác không có cache_control.
3. **Token counting**: Các provider báo số token khác nhau, số liệu có thể không chính xác tuyệt đối.
4. **Tool quality**: Tool calling phụ thuộc vào model đích. Model mạnh (GPT-4o, DeepSeek) hoạt động tốt; model nhỏ có thể gọi tool sai format.

## License

MIT
