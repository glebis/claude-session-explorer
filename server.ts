/**
 * Claude Session Explorer - Express + Agent SDK server
 *
 * - Serves public/ static files
 * - POST /api/ask  -- SSE endpoint streaming Agent SDK responses
 * - GET /api/stats -- Quick JSON stats from session-meta (no agent)
 * - GET /api/sessions -- Paginated session list from session-meta
 */

// Agent SDK spawns Claude Code subprocess -- these env vars conflict
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDECODE;

import express from "express";
import cors from "cors";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { sessionServer, SESSION_TOOL_NAMES, loadSessionMetas, SESSION_META_DIR } from "./tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- REST Endpoints (fast, no agent) ---

app.get("/api/stats", async (_req, res) => {
  try {
    const metas = await loadSessionMetas();

    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalDuration = 0;
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    const toolDist: Record<string, number> = {};
    const projectDist: Record<string, number> = {};
    const dailyActivity: Record<string, number> = {};

    for (const m of metas) {
      totalTokensIn += m.input_tokens || 0;
      totalTokensOut += m.output_tokens || 0;
      totalDuration += m.duration_minutes || 0;
      totalLinesAdded += m.lines_added || 0;
      totalLinesRemoved += m.lines_removed || 0;

      for (const [tool, count] of Object.entries(m.tool_counts || {})) {
        toolDist[tool] = (toolDist[tool] || 0) + count;
      }

      const parts = (m.project_path || "").split("/").filter(Boolean);
      const project = parts.slice(-2).join("/");
      projectDist[project] = (projectDist[project] || 0) + 1;

      const day = m.start_time?.slice(0, 10);
      if (day) dailyActivity[day] = (dailyActivity[day] || 0) + 1;
    }

    const sortedTools = Object.entries(toolDist).sort((a, b) => b[1] - a[1]).slice(0, 15);
    const sortedProjects = Object.entries(projectDist).sort((a, b) => b[1] - a[1]).slice(0, 15);

    res.json({
      total_sessions: metas.length,
      total_tokens: totalTokensIn + totalTokensOut,
      total_duration_hours: Math.round((totalDuration / 60) * 10) / 10,
      total_lines: { added: totalLinesAdded, removed: totalLinesRemoved },
      avg_duration_min: metas.length > 0 ? Math.round((totalDuration / metas.length) * 10) / 10 : 0,
      top_tools: sortedTools,
      top_projects: sortedProjects,
      daily_activity: Object.entries(dailyActivity).sort((a, b) => a[0].localeCompare(b[0])),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/sessions", async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const search = (req.query.search as string)?.toLowerCase() || "";
    const project = (req.query.project as string) || "";
    const dateFilter = (req.query.date as string) || "";

    let metas = await loadSessionMetas();

    // Filter by date
    if (dateFilter) {
      metas = metas.filter((m) => m.start_time?.slice(0, 10) === dateFilter);
    }
    // Filter by search
    if (search) {
      metas = metas.filter(
        (m) =>
          m.summary?.toLowerCase().includes(search) ||
          m.first_prompt?.toLowerCase().includes(search) ||
          m.session_id.includes(search)
      );
    }
    if (project) {
      metas = metas.filter((m) => m.project_path?.includes(project));
    }

    const total = metas.length;
    const offset = (page - 1) * limit;
    const paginated = metas.slice(offset, offset + limit);

    const sessions = paginated.map((m) => ({
      session_id: m.session_id,
      project: m.project_path,
      start_time: m.start_time,
      duration_minutes: m.duration_minutes,
      summary: m.summary,
      first_prompt: m.first_prompt?.slice(0, 200),
      user_messages: m.user_message_count,
      assistant_messages: m.assistant_message_count,
      tool_counts: m.tool_counts,
      languages: m.languages,
      input_tokens: m.input_tokens,
      output_tokens: m.output_tokens,
      lines_added: m.lines_added,
      lines_removed: m.lines_removed,
    }));

    res.json({ sessions, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- SSE Agent Endpoint ---

const SYSTEM_PROMPT = `You are a Claude Code Session Explorer assistant. You have access to tools that let you search, analyze, and report on Claude Code sessions.

Available capabilities:
- search_sessions: Semantic search across session chunks using pgvector embeddings
- get_session_detail: Get detailed info about a specific session (messages, tools, tokens)
- get_dashboard_stats: Get aggregate statistics across all sessions
- get_insights_report: Read the latest improvement insights report
- resume_session: Get the command to resume a session

Output formatting rules:
- ALWAYS use markdown tables for metrics and structured data (they will be rendered as HTML tables)
- Use ## and ### headers to structure your response into clear sections
- Use numbered lists for timelines and step-by-step workflows
- Use bullet lists for brief items
- Put actionable prompts in backtick code spans so users can copy them
- Never dump raw JSON — summarize data into readable prose and tables
- Keep responses well-structured as a document, not conversational text`;

app.post("/api/ask", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: 'Missing "prompt" field' });
    return;
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  console.log(`[Agent] ${prompt.slice(0, 100)}...`);

  try {
    for await (const message of query({
      prompt: `${SYSTEM_PROMPT}\n\nUser query: ${prompt}`,
      options: {
        tools: [
          "Read",
          "Glob",
          "Grep",
          "Bash",
          ...SESSION_TOOL_NAMES,
        ],
        mcpServers: { sessions: sessionServer },
        permissionMode: "bypassPermissions",
        maxTurns: 15,
        model: "haiku",
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            res.write(`data: ${JSON.stringify({ type: "text", content: block.text })}\n\n`);
          }
          if (block.type === "tool_use") {
            res.write(
              `data: ${JSON.stringify({
                type: "tool_use",
                tool: block.name,
                input: typeof block.input === "object" ? block.input : {},
              })}\n\n`
            );
          }
        }
      }

      if (message.type === "result") {
        res.write(
          `data: ${JSON.stringify({
            type: "result",
            result: message.subtype === "success" ? message.result : message.errors.join(", "),
            turns: message.num_turns,
            cost: message.total_cost_usd,
          })}\n\n`
        );
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Agent Error] ${errorMsg}`);
    res.write(`data: ${JSON.stringify({ type: "error", message: errorMsg })}\n\n`);
  }

  res.write("data: [DONE]\n\n");
  res.end();
});

// --- Session Transcript ---

app.get("/api/transcript/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  try {
    const { findSessionJsonl, parseSessionJsonl } = await import("./tools.js");
    const jsonlPath = await findSessionJsonl(sessionId);
    if (!jsonlPath) {
      res.status(404).json({ error: "Session JSONL not found" });
      return;
    }
    const content = await fs.readFile(jsonlPath, "utf-8");
    const messages = parseSessionJsonl(content);

    // Return parsed messages as transcript
    const transcript = messages
      .filter((m: any) => m.content || m.toolCalls.length > 0)
      .map((m: any) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        tools: m.toolCalls.map((tc: any) => ({
          name: tc.name,
          isError: tc.isError,
        })),
      }));

    res.json({ session_id: sessionId, messages: transcript });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Actionable Insights ---

const ACTIONS_SYSTEM_PROMPT = `You are an expert Claude Code workflow optimizer. You analyze usage patterns and produce ACTIONABLE insights -- concrete changes the user can apply immediately.

You have tools to inspect session data. Use get_dashboard_stats and get_insights_report to understand usage patterns.

After analyzing, you MUST return a JSON array wrapped in XML tags <actions_json>...</actions_json>. Each item is an action card with this schema:

{
  "id": "unique-slug",
  "observation": "What pattern you detected (1 sentence)",
  "category": "hook | claude-md | automation | workflow",
  "title": "Short action title (under 8 words)",
  "description": "Why this matters and what it changes (2-3 sentences)",
  "effort": "low | medium | high",
  "artifact": {
    "type": "file | append | info",
    "path": "/absolute/path/to/file (for file/append types)",
    "content": "The actual code/config content to write",
    "language": "bash | markdown | json | yaml"
  }
}

IMPORTANT: Use <actions_json>[...]</actions_json> tags, NOT fenced code blocks. The JSON must be valid. Artifact content must NOT contain triple backticks.
For file paths, use absolute paths starting with the user home directory.

Categories:
- "hook": Claude Code hooks (.claude/hooks/) -- event-driven shell scripts
- "claude-md": Changes to CLAUDE.md instructions
- "automation": Standalone scripts or cron jobs
- "workflow": Process suggestions (no artifact, type="info")

Artifact types:
- "file": Create a new file at path
- "append": Append content to existing file at path
- "info": No file change, just a recommendation

Generate 3-8 high-quality actions. Prioritize by impact. Be specific -- use actual project paths, tool names, and patterns from the data.`;

app.post("/api/actions", async (req, res) => {
  const { focus } = req.body || {};
  const focusPrompt = focus
    ? `Focus specifically on: ${focus}`
    : "Analyze all recent sessions and suggest the highest-impact improvements.";

  console.log(`[Actions] Generating actionable insights...`);

  try {
    let fullText = "";

    for await (const message of query({
      prompt: `${ACTIONS_SYSTEM_PROMPT}\n\n${focusPrompt}`,
      options: {
        tools: [...SESSION_TOOL_NAMES],
        mcpServers: { sessions: sessionServer },
        permissionMode: "bypassPermissions",
        maxTurns: 10,
        model: "haiku",
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            fullText += block.text;
          }
        }
      }
      if (message.type === "result") {
        // Extract JSON from <actions_json> tags (or fenced block as fallback)
        const jsonMatch = fullText.match(/<actions_json>\s*([\s\S]*?)<\/actions_json>/)
          || fullText.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
          try {
            const actions = JSON.parse(jsonMatch[1].trim());
            res.json({ actions, raw: fullText });
            return;
          } catch (parseErr) {
            res.status(500).json({ error: "Failed to parse action JSON", raw: fullText });
            return;
          }
        }
        res.status(500).json({ error: "No JSON block found in response", raw: fullText });
        return;
      }
    }

    res.status(500).json({ error: "Agent did not produce a result" });
  } catch (err) {
    console.error(`[Actions Error] ${err}`);
    res.status(500).json({ error: String(err) });
  }
});

// --- Apply Action ---

app.post("/api/apply-action", async (req, res) => {
  const { artifact } = req.body;

  if (!artifact || !artifact.type || !artifact.content) {
    res.status(400).json({ error: "Missing artifact data" });
    return;
  }

  // Safety: only allow writes under ~/.claude/
  const homeDir = os.homedir();
  const claudeDir = path.join(homeDir, ".claude");
  const resolvedPath = path.resolve(artifact.path || "");

  if (!resolvedPath.startsWith(claudeDir)) {
    res.status(403).json({ error: "Can only write files under ~/.claude/" });
    return;
  }

  try {
    if (artifact.type === "file") {
      // Ensure directory exists
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, artifact.content, "utf-8");
      // Make hooks executable
      if (resolvedPath.includes("/hooks/")) {
        await fs.chmod(resolvedPath, 0o755);
      }
      res.json({ success: true, path: resolvedPath, action: "created" });
    } else if (artifact.type === "append") {
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      let existing = "";
      try {
        existing = await fs.readFile(resolvedPath, "utf-8");
      } catch {
        // File doesn't exist yet
      }
      const separator = existing && !existing.endsWith("\n") ? "\n" : "";
      await fs.writeFile(resolvedPath, existing + separator + artifact.content, "utf-8");
      res.json({ success: true, path: resolvedPath, action: "appended" });
    } else {
      res.status(400).json({ error: `Unknown artifact type: ${artifact.type}` });
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Start ---

app.listen(PORT, () => {
  console.log(`Session Explorer running at http://localhost:${PORT}`);
  console.log(`Session metas: ${SESSION_META_DIR}`);
});
