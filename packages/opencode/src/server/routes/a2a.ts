import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { Session } from "../../session"
import { SessionPrompt } from "../../session/prompt"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "../../session/message-v2"
import { Agent } from "../../agent/agent"
import { Installation } from "../../installation"
import { Bus } from "../../bus"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"

/**
 * A2A (Agent-to-Agent) Protocol HTTP+REST binding for OpenCode.
 *
 * This adapter exposes OpenCode as an A2A-compliant agent server, enabling
 * integration with LiteLLM's A2A gateway and other A2A clients.
 *
 * Mapping:
 *   A2A Task       <-> OpenCode Session
 *   A2A Message     <-> OpenCode user prompt / assistant response
 *   A2A Part        <-> OpenCode MessageV2 parts (text, file)
 *   A2A Artifact    <-> Final assistant text output
 *   A2A TaskState   <-> Session status + message finish reason
 *
 * Spec reference: https://a2a-protocol.org/latest/specification/
 *   Section 11: HTTP+JSON/REST Protocol Binding
 */

const log = Log.create({ service: "a2a" })

// ──────────────────────────────────────────────────────────────
// A2A data types (subset needed for HTTP+REST binding)
// ──────────────────────────────────────────────────────────────

type A2ATaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled"

interface A2APart {
  type: "text" | "file" | "data"
  text?: string
  file?: { name?: string; mimeType?: string; uri?: string; bytes?: string }
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

interface A2AMessage {
  role: "user" | "agent"
  parts: A2APart[]
  metadata?: Record<string, unknown>
}

interface A2ATaskStatus {
  state: A2ATaskState
  message?: A2AMessage
  timestamp?: string
}

interface A2AArtifact {
  artifactId: string
  name?: string
  description?: string
  parts: A2APart[]
  metadata?: Record<string, unknown>
}

interface A2ATask {
  id: string
  contextId?: string
  status: A2ATaskStatus
  artifacts?: A2AArtifact[]
  history?: A2AMessage[]
  metadata?: Record<string, unknown>
}

// ──────────────────────────────────────────────────────────────
// Conversion helpers: OpenCode -> A2A
// ──────────────────────────────────────────────────────────────

function toA2AState(sessionID: string, assistant?: MessageV2.Assistant): A2ATaskState {
  const status = SessionStatus.get(sessionID)
  if (status.type === "busy") return "working"
  if (!assistant) return "submitted"
  if (assistant.error) return "failed"
  if (assistant.finish === "stop" || assistant.finish === "end_turn" || assistant.finish === "length")
    return "completed"
  if (assistant.finish === "tool-calls") return "working"
  return "completed"
}

function partsToA2A(parts: MessageV2.Part[]): A2APart[] {
  const result: A2APart[] = []
  for (const part of parts) {
    if (part.type === "text" && !part.synthetic) {
      result.push({ type: "text", text: part.text })
    }
    if (part.type === "file") {
      result.push({
        type: "file",
        file: {
          name: part.filename,
          mimeType: part.mime,
          uri: part.url,
        },
      })
    }
  }
  return result
}

function messagesWithPartsToA2A(msgs: MessageV2.WithParts[]): A2AMessage[] {
  return msgs
    .map((m) => {
      const role: "user" | "agent" = m.info.role === "user" ? "user" : "agent"
      const parts = partsToA2A(m.parts)
      if (parts.length === 0) return undefined
      return { role, parts }
    })
    .filter((m): m is A2AMessage => m !== undefined)
}

function toA2AArtifacts(msgs: MessageV2.WithParts[]): A2AArtifact[] {
  const artifacts: A2AArtifact[] = []
  for (const m of msgs) {
    if (m.info.role !== "assistant") continue
    const parts: A2APart[] = []
    for (const part of m.parts) {
      if (part.type === "text" && !part.synthetic) {
        parts.push({ type: "text", text: part.text })
      }
    }
    if (parts.length > 0) {
      artifacts.push({
        artifactId: m.info.id,
        name: "response",
        parts,
      })
    }
  }
  return artifacts
}

async function sessionToTask(session: Session.Info, includeHistory = false): Promise<A2ATask> {
  const msgs = await Session.messages({ sessionID: session.id })
  const lastAssistant = msgs
    .slice()
    .reverse()
    .find((m) => m.info.role === "assistant")
  const assistant = lastAssistant?.info.role === "assistant" ? (lastAssistant.info as MessageV2.Assistant) : undefined

  const state = toA2AState(session.id, assistant)

  const statusMessage: A2AMessage | undefined = lastAssistant
    ? (() => {
        const parts = partsToA2A(lastAssistant.parts)
        return parts.length > 0 ? { role: "agent" as const, parts } : undefined
      })()
    : undefined

  const task: A2ATask = {
    id: session.id,
    contextId: session.projectID,
    status: {
      state,
      message: statusMessage,
      timestamp: new Date(session.time.updated).toISOString(),
    },
    metadata: {
      title: session.title,
      directory: session.directory,
    },
  }

  if (state === "completed" || state === "failed") {
    task.artifacts = toA2AArtifacts(msgs)
  }

  if (includeHistory) {
    task.history = messagesWithPartsToA2A(msgs)
  }

  return task
}

// ──────────────────────────────────────────────────────────────
// Agent Card
// ──────────────────────────────────────────────────────────────

export async function agentCard(url: string) {
  const agents = await Agent.list()
  const skills = agents.map((a) => ({
    id: a.name,
    name: a.name,
    description: a.description,
  }))

  return {
    name: "opencode",
    description:
      "OpenCode AI coding agent - an open source AI coding agent that can read, write, and edit code, run shell commands, search codebases, and manage files.",
    url,
    version: Installation.VERSION,
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    skills,
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    interfaces: [
      {
        protocol: "REST",
        url: `${url}/a2a`,
      },
    ],
  }
}

// ──────────────────────────────────────────────────────────────
// SSE streaming helpers
// ──────────────────────────────────────────────────────────────

interface StreamEvent {
  type: "TaskStatusUpdateEvent" | "TaskArtifactUpdateEvent"
  taskId: string
  contextId?: string
  status?: A2ATaskStatus
  artifact?: A2AArtifact
  final?: boolean
}

// ──────────────────────────────────────────────────────────────
// Routes (HTTP+REST binding, Section 11 of A2A spec)
// ──────────────────────────────────────────────────────────────

export const A2ARoutes = lazy(() =>
  new Hono()
    // ── Agent Card ──────────────────────────────────────────
    .get("/agent-card", async (c) => {
      const origin = new URL(c.req.url).origin
      const card = await agentCard(origin)
      return c.json(card)
    })

    // ── POST /message - Send Message ────────────────────────
    // Creates a session, sends the user message, waits for completion
    .post("/message", async (c) => {
      const body = await c.req.json<{
        message: A2AMessage
        configuration?: { acceptedOutputModes?: string[]; historyLength?: number; blocking?: boolean }
        metadata?: Record<string, unknown>
        taskId?: string
        contextId?: string
      }>()

      log.info("message/send", { taskId: body.taskId })

      const textParts = body.message.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text!)
      const text = textParts.join("\n")

      if (!text) {
        return c.json({ error: { code: -32602, message: "No text content in message" } }, 400)
      }

      // Reuse existing session (task) or create new one
      let session: Session.Info
      if (body.taskId) {
        session = await Session.get(body.taskId)
      } else {
        session = await Session.create()
      }

      const agent = await Agent.defaultAgent()
      const { Provider } = await import("../../provider/provider")
      const model = await Provider.defaultModel()

      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text }],
        agent,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
        },
      })

      const refreshed = await Session.get(session.id)
      const task = await sessionToTask(refreshed, true)
      return c.json(task)
    })

    // ── POST /message/stream - Send Streaming Message ───────
    .post("/message/stream", async (c) => {
      const body = await c.req.json<{
        message: A2AMessage
        configuration?: { acceptedOutputModes?: string[]; historyLength?: number }
        metadata?: Record<string, unknown>
        taskId?: string
        contextId?: string
      }>()

      log.info("message/stream", { taskId: body.taskId })

      const textParts = body.message.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text!)
      const text = textParts.join("\n")

      if (!text) {
        return c.json({ error: { code: -32602, message: "No text content in message" } }, 400)
      }

      let session: Session.Info
      if (body.taskId) {
        session = await Session.get(body.taskId)
      } else {
        session = await Session.create()
      }

      const sessionID = session.id

      c.header("Content-Type", "text/event-stream")
      c.header("Cache-Control", "no-cache")
      c.header("Connection", "keep-alive")
      c.header("X-Accel-Buffering", "no")

      return streamSSE(c, async (stream) => {
        // Send initial task with "submitted" state
        const initial: A2ATask = {
          id: sessionID,
          contextId: session.projectID,
          status: {
            state: "submitted",
            timestamp: new Date().toISOString(),
          },
        }
        await stream.writeSSE({ data: JSON.stringify(initial), event: "task" })

        // Subscribe to bus events for this session
        let lastText = ""
        const unsub = Bus.subscribeAll(async (event) => {
          if (event.properties?.sessionID !== sessionID && event.properties?.info?.sessionID !== sessionID) return

          if (event.type === "session.status") {
            const status = event.properties.status
            const taskState: A2ATaskState = status.type === "busy" ? "working" : "completed"
            const update: StreamEvent = {
              type: "TaskStatusUpdateEvent",
              taskId: sessionID,
              contextId: session.projectID,
              status: {
                state: taskState,
                timestamp: new Date().toISOString(),
              },
              final: taskState !== "working",
            }
            await stream.writeSSE({ data: JSON.stringify(update), event: "status" })
          }

          if (event.type === "message.part.updated") {
            const part = event.properties.part
            if (part.type === "text" && !part.synthetic && part.sessionID === sessionID) {
              const update: StreamEvent = {
                type: "TaskArtifactUpdateEvent",
                taskId: sessionID,
                contextId: session.projectID,
                artifact: {
                  artifactId: part.messageID,
                  name: "response",
                  parts: [{ type: "text", text: part.text }],
                },
              }
              await stream.writeSSE({ data: JSON.stringify(update), event: "artifact" })
            }
          }

          if (event.type === "message.part.delta") {
            const delta = event.properties
            if (delta.sessionID === sessionID && delta.field === "text") {
              lastText += delta.delta
              const update: StreamEvent = {
                type: "TaskArtifactUpdateEvent",
                taskId: sessionID,
                contextId: session.projectID,
                artifact: {
                  artifactId: delta.messageID,
                  name: "response",
                  parts: [{ type: "text", text: lastText }],
                },
              }
              await stream.writeSSE({ data: JSON.stringify(update), event: "artifact" })
            }
          }
        })

        // Start prompt (fire and forget, results come via events)
        const agent = await Agent.defaultAgent()
        const { Provider } = await import("../../provider/provider")
        const model = await Provider.defaultModel()

        try {
          await SessionPrompt.prompt({
            sessionID,
            parts: [{ type: "text", text }],
            agent,
            model: {
              providerID: model.providerID,
              modelID: model.modelID,
            },
          })

          // Send final status
          const refreshed = await Session.get(sessionID)
          const task = await sessionToTask(refreshed)
          const final: StreamEvent = {
            type: "TaskStatusUpdateEvent",
            taskId: sessionID,
            contextId: session.projectID,
            status: task.status,
            final: true,
          }
          await stream.writeSSE({ data: JSON.stringify(final), event: "status" })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const errEvent: StreamEvent = {
            type: "TaskStatusUpdateEvent",
            taskId: sessionID,
            contextId: session.projectID,
            status: {
              state: "failed",
              message: {
                role: "agent",
                parts: [{ type: "text", text: `Error: ${message}` }],
              },
              timestamp: new Date().toISOString(),
            },
            final: true,
          }
          await stream.writeSSE({ data: JSON.stringify(errEvent), event: "status" })
        } finally {
          unsub()
        }
      })
    })

    // ── GET /tasks/:taskId - Get Task ───────────────────────
    .get("/tasks/:taskId", async (c) => {
      const taskId = c.req.param("taskId")
      const historyLength = parseInt(c.req.query("historyLength") ?? "0")
      const session = await Session.get(taskId)
      const task = await sessionToTask(session, historyLength > 0)
      return c.json(task)
    })

    // ── POST /tasks/:taskId/cancel - Cancel Task ────────────
    .post("/tasks/:taskId/cancel", async (c) => {
      const taskId = c.req.param("taskId")
      SessionPrompt.cancel(taskId)
      const session = await Session.get(taskId)
      const task: A2ATask = {
        id: session.id,
        contextId: session.projectID,
        status: {
          state: "canceled",
          timestamp: new Date().toISOString(),
        },
      }
      return c.json(task)
    }),
)
