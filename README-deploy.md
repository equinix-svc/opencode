# OpenCode A2A Deployment Guide

Deploy OpenCode as an [A2A (Agent-to-Agent)](https://a2a-protocol.org/) compliant agent server and integrate it with LiteLLM.

---

## Project Structure

```
opencode/
├── packages/
│   └── opencode/                    # Core CLI + server
│       └── src/
│           ├── server/
│           │   ├── server.ts        # Hono HTTP server (port 4096)
│           │   └── routes/
│           │       ├── a2a.ts       # ← A2A protocol adapter (new)
│           │       ├── session.ts   # Session/message REST API
│           │       └── ...          # Other route groups
│           ├── session/
│           │   ├── index.ts         # Session CRUD (SQLite via Drizzle)
│           │   ├── prompt.ts        # Agentic prompt loop
│           │   ├── llm.ts           # LLM streaming (Vercel AI SDK v5)
│           │   ├── message-v2.ts    # Message/part data model
│           │   └── processor.ts     # Stream processing + tool execution
│           ├── agent/agent.ts       # Agent definitions (build, plan, explore...)
│           ├── provider/provider.ts # LLM provider management (50+ providers)
│           ├── tool/                # Built-in tools (bash, read, write, edit, glob, grep...)
│           ├── bus/                 # Pub/sub event bus (SSE backbone)
│           └── config/config.ts     # Config loading (opencode.json)
├── Dockerfile                       # Docker build
├── app.py                           # Legacy Python wrapper (pre-A2A)
└── README-deploy.md                 # ← This file
```

### Key Architecture

```
┌─────────────────────────────────────────────────────┐
│              Hono HTTP Server (:4096)                │
│                                                     │
│  /.well-known/agent.json   → Agent Card (discovery) │
│  /a2a/message              → Send message (sync)    │
│  /a2a/message/stream       → Send message (SSE)     │
│  /a2a/tasks/:id            → Get task status         │
│  /a2a/tasks/:id/cancel     → Cancel task             │
│                                                     │
│  /session/*                → Native OpenCode API    │
│  /event                    → SSE event stream       │
│  /provider/*               → Model management       │
└────────────────┬────────────────────────────────────┘
                 │
    ┌────────────▼────────────┐
    │   Session + Prompt Loop │
    │   (SQLite, Bus events)  │
    └────────────┬────────────┘
                 │
    ┌────────────▼────────────┐
    │   Vercel AI SDK v5      │
    │   (50+ LLM providers)   │
    └─────────────────────────┘
```

### A2A Concept Mapping

| A2A Concept       | OpenCode Equivalent   | Notes                                                                    |
| ----------------- | --------------------- | ------------------------------------------------------------------------ |
| Task              | Session               | 1 session = 1 A2A task. Session ID = Task ID.                            |
| Message (user)    | Prompt input          | Text parts extracted and sent via `SessionPrompt.prompt()`               |
| Message (agent)   | Assistant response    | Text parts from assistant messages                                       |
| Artifact          | Assistant text output | Non-synthetic text parts from completed assistant messages               |
| TaskState         | Session status        | `busy` → `working`, `idle` + finish=stop → `completed`, error → `failed` |
| Agent Card skills | Registered agents     | build, plan, explore, etc.                                               |
| contextId         | Project ID            | Groups sessions by project                                               |

---

## Prerequisites

- [Bun](https://bun.sh/) v1.3.10+ (for building from source)
- An LLM API key (Anthropic, OpenAI, etc.)
- Docker (optional, for container deployment)

---

## Option 1: Run from Source

```bash
# Clone and install
git clone https://github.com/anomalyco/opencode.git
cd opencode
bun install

# Build the CLI
cd packages/opencode
bun run build

# Start headless server
ANTHROPIC_API_KEY=sk-ant-... ./bin/opencode serve --hostname 0.0.0.0 --port 4096
```

For development (hot reload):

```bash
cd packages/opencode
ANTHROPIC_API_KEY=sk-ant-... bun run dev
```

## Option 2: Install from npm

```bash
npm install -g opencode-ai

# Start headless server
ANTHROPIC_API_KEY=sk-ant-... opencode serve --hostname 0.0.0.0 --port 4096
```

## Option 3: Docker

```dockerfile
FROM oven/bun:1.3-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN bun install -g opencode-ai

WORKDIR /workspace
EXPOSE 4096

CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
```

```bash
docker build -t opencode-a2a .
docker run -d \
  -p 4096:4096 \
  -v /path/to/project:/workspace \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  opencode-a2a
```

---

## Verify A2A Endpoints

### 1. Agent Card Discovery

```bash
curl http://localhost:4096/.well-known/agent.json | jq .
```

Expected response:

```json
{
  "name": "opencode",
  "description": "OpenCode AI coding agent...",
  "url": "http://localhost:4096",
  "version": "1.2.15",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false
  },
  "skills": [
    { "id": "build", "name": "build", "description": "..." },
    { "id": "plan", "name": "plan", "description": "..." }
  ],
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text"],
  "interfaces": [{ "protocol": "REST", "url": "http://localhost:4096/a2a" }]
}
```

### 2. Send Message (Synchronous)

```bash
curl -X POST http://localhost:4096/a2a/message \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "role": "user",
      "parts": [{"type": "text", "text": "List the files in this directory"}]
    }
  }' | jq .
```

Response is an A2A Task object:

```json
{
  "id": "session_01J...",
  "contextId": "project_...",
  "status": {
    "state": "completed",
    "message": {
      "role": "agent",
      "parts": [{"type": "text", "text": "Here are the files..."}]
    },
    "timestamp": "2026-02-26T..."
  },
  "artifacts": [
    {
      "artifactId": "message_01J...",
      "name": "response",
      "parts": [{"type": "text", "text": "Here are the files..."}]
    }
  ],
  "history": [...]
}
```

### 3. Send Message (Streaming)

```bash
curl -N -X POST http://localhost:4096/a2a/message/stream \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "role": "user",
      "parts": [{"type": "text", "text": "Read the README.md"}]
    }
  }'
```

Returns SSE events:

```
event: task
data: {"id":"session_...","status":{"state":"submitted",...}}

event: status
data: {"type":"TaskStatusUpdateEvent","taskId":"session_...","status":{"state":"working",...}}

event: artifact
data: {"type":"TaskArtifactUpdateEvent","taskId":"session_...","artifact":{"artifactId":"message_...","parts":[{"type":"text","text":"..."}]}}

event: status
data: {"type":"TaskStatusUpdateEvent","taskId":"session_...","status":{"state":"completed",...},"final":true}
```

### 4. Multi-Turn (Reuse Task)

```bash
# First message creates a task
TASK_ID=$(curl -s -X POST http://localhost:4096/a2a/message \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "role": "user",
      "parts": [{"type": "text", "text": "What does src/index.ts do?"}]
    }
  }' | jq -r '.id')

# Second message continues the conversation
curl -X POST http://localhost:4096/a2a/message \
  -H "Content-Type: application/json" \
  -d "{
    \"taskId\": \"$TASK_ID\",
    \"message\": {
      \"role\": \"user\",
      \"parts\": [{\"type\": \"text\", \"text\": \"Now refactor it to use async/await\"}]
    }
  }" | jq .
```

### 5. Get Task / Cancel Task

```bash
# Get task status
curl http://localhost:4096/a2a/tasks/$TASK_ID | jq .

# Get task with history
curl "http://localhost:4096/a2a/tasks/$TASK_ID?historyLength=10" | jq .

# Cancel a running task
curl -X POST http://localhost:4096/a2a/tasks/$TASK_ID/cancel | jq .
```

---

## LiteLLM Integration

### Via LiteLLM UI

1. Navigate to **Agents** in the LiteLLM sidebar
2. Click **+ Add New Agent** → **A2A Standard**
3. Configure:
   - **Agent Name**: `opencode`
   - **Agent URL**: `http://your-vm:4096`
4. Click **Create Agent**
5. Go to **Playground** → select endpoint `/v1/a2a/message/send` → select your agent → send messages

### Via LiteLLM Config

```yaml
# litellm_config.yaml
a2a_agents:
  - agent_name: opencode
    agent_url: http://your-vm:4096
    agent_type: a2a_standard
```

### Via LiteLLM Python SDK

```python
import litellm

response = litellm.a2a_message_send(
    agent="opencode",
    message={
        "role": "user",
        "parts": [{"type": "text", "text": "Fix the failing tests"}]
    }
)
print(response["status"]["state"])  # "completed"
for artifact in response.get("artifacts", []):
    for part in artifact["parts"]:
        if part["type"] == "text":
            print(part["text"])
```

---

## Configuration

### LLM Provider

Set your provider API key as an environment variable:

```bash
# Pick one (or multiple)
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GOOGLE_GENERATIVE_AI_API_KEY=...
```

Or use `opencode.json` in your project directory:

```json
{
  "provider": {
    "anthropic": {}
  },
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

### Server Authentication

```bash
# Protect the server with basic auth
export OPENCODE_SERVER_PASSWORD=your-secret
export OPENCODE_SERVER_USERNAME=opencode  # optional, defaults to "opencode"

opencode serve --hostname 0.0.0.0 --port 4096
```

Clients must then send `Authorization: Basic <base64(username:password)>` headers.

### Default Agent and Model

The A2A adapter uses the configured default agent and model. Override in `opencode.json`:

```json
{
  "model": "anthropic/claude-sonnet-4-20250514",
  "default_agent": "build"
}
```

### Working Directory

The A2A server operates in the directory where `opencode serve` is launched. The agent reads/writes files relative to this directory. Mount your project accordingly in Docker.

---

## Endpoints Reference

| Method | Path                                 | Description                                    |
| ------ | ------------------------------------ | ---------------------------------------------- |
| `GET`  | `/.well-known/agent.json`            | A2A Agent Card (standard discovery)            |
| `GET`  | `/a2a/agent-card`                    | A2A Agent Card (alternative)                   |
| `POST` | `/a2a/message`                       | Send message, wait for completion, return Task |
| `POST` | `/a2a/message/stream`                | Send message, stream SSE updates               |
| `GET`  | `/a2a/tasks/:taskId`                 | Get task status and artifacts                  |
| `GET`  | `/a2a/tasks/:taskId?historyLength=N` | Get task with message history                  |
| `POST` | `/a2a/tasks/:taskId/cancel`          | Cancel a running task                          |

All A2A endpoints sit behind the instance middleware, which means the server needs a valid project context (working directory with a git repo or any directory).

---

## Files Changed

The A2A support is implemented in two files:

### `packages/opencode/src/server/routes/a2a.ts` (new)

The A2A protocol adapter. Contains:

- A2A type definitions (Task, Message, Part, Artifact, TaskStatus)
- Conversion functions: OpenCode sessions/messages → A2A objects
- Route handlers: agent-card, message, message/stream, tasks/get, tasks/cancel
- SSE streaming that bridges OpenCode's internal Bus events to A2A `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`

### `packages/opencode/src/server/server.ts` (modified)

Two additions:

- Import `A2ARoutes` and `agentCard` from `./routes/a2a`
- Mount `.route("/a2a", A2ARoutes())` and `.get("/.well-known/agent.json", ...)` in the Hono app chain

---

## Troubleshooting

### `GET /.well-known/agent.json` returns HTML

The server hasn't been rebuilt after the A2A changes. Run `bun run build` in `packages/opencode/` and restart.

### "No providers found" error

No LLM API key is configured. Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or another provider key.

### Session errors on message send

The server needs a valid working directory. Make sure you launch `opencode serve` from a directory (or mount one in Docker).

### CORS errors from browser clients

The server allows CORS from `localhost`, `127.0.0.1`, `*.opencode.ai`, and Tauri origins. For custom domains, the A2A gateway (LiteLLM) should make server-to-server calls where CORS doesn't apply.

### Streaming closes immediately

Check that no reverse proxy (nginx, Cloudflare) is buffering SSE responses. The server sets `X-Accel-Buffering: no` but your proxy may need additional configuration.
