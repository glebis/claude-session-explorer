/**
 * Custom MCP tools for the Claude Session Explorer agent.
 * Provides session search, detail, stats, insights, and resume capabilities.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import pg from "pg";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

// --- Constants ---

const SESSION_META_DIR = path.join(os.homedir(), ".claude", "usage-data", "session-meta");
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const INSIGHTS_DIR = path.join(os.homedir(), ".claude", "insights");
const OLLAMA_EMBED_URL = "http://localhost:11434/api/embeddings";
const EMBED_MODEL = "embeddinggemma";
const DB_CONNECTION = "postgresql://glebkalinin@localhost:5432/obsidian";

// --- Helpers ---

interface SessionMeta {
  session_id: string;
  project_path: string;
  start_time: string;
  duration_minutes: number;
  user_message_count: number;
  assistant_message_count: number;
  tool_counts: Record<string, number>;
  languages: Record<string, number>;
  git_commits: number;
  input_tokens: number;
  output_tokens: number;
  first_prompt: string;
  summary: string;
  tool_errors: number;
  tool_error_categories: Record<string, number>;
  uses_task_agent: boolean;
  uses_mcp: boolean;
  uses_web_search: boolean;
  lines_added: number;
  lines_removed: number;
  files_modified: number;
  message_hours: number[];
}

async function loadSessionMetas(dateRange?: string): Promise<SessionMeta[]> {
  const files = await fs.readdir(SESSION_META_DIR);
  const metas: SessionMeta[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(SESSION_META_DIR, file), "utf-8");
      const meta: SessionMeta = JSON.parse(raw);
      if (dateRange) {
        const [start, end] = dateRange.split(",");
        const t = new Date(meta.start_time);
        if (start && t < new Date(start)) continue;
        if (end && t > new Date(end)) continue;
      }
      metas.push(meta);
    } catch {
      continue;
    }
  }

  metas.sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
  return metas;
}

function parseProjectName(projectPath: string): string {
  if (!projectPath) return "unknown";
  const parts = projectPath.split("/");
  // Take last 2 meaningful parts
  const filtered = parts.filter(Boolean);
  return filtered.slice(-2).join("/");
}

async function embedText(text: string): Promise<number[]> {
  const response = await fetch(OLLAMA_EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!response.ok) throw new Error(`Ollama embed error: ${response.status}`);
  const data = await response.json();
  return data.embedding;
}

async function findSessionJsonl(sessionId: string): Promise<string | null> {
  // Search all project dirs for matching JSONL
  try {
    const projectDirs = await fs.readdir(PROJECTS_DIR);
    for (const dir of projectDirs) {
      const jsonlPath = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      try {
        await fs.access(jsonlPath);
        return jsonlPath;
      } catch {
        continue;
      }
    }
  } catch {
    // projects dir might not exist
  }
  return null;
}

interface ParsedMessage {
  role: string;
  content: string;
  timestamp: string;
  toolCalls: { name: string; input: Record<string, unknown>; result: string; isError: boolean }[];
  tokens: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  model: string;
}

function parseSessionJsonl(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  const pendingToolCalls: Map<string, { name: string; input: Record<string, unknown>; result: string; isError: boolean }> = new Map();

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const entryType = entry.type;
    if (entryType !== "user" && entryType !== "assistant") continue;

    const msgData = entry.message || {};
    const role = msgData.role;
    if (!role) continue;

    const timestamp = entry.timestamp || "";

    if (role === "user") {
      const contentData = msgData.content;
      let text = "";

      if (Array.isArray(contentData)) {
        // Process tool results
        for (const item of contentData) {
          if (item.type === "tool_result") {
            const toolId = item.tool_use_id || "";
            const pending = pendingToolCalls.get(toolId);
            if (pending) {
              pending.result = String(item.content || "").slice(0, 500);
              pending.isError = item.is_error || false;
              pendingToolCalls.delete(toolId);
            }
          }
        }
        text = contentData
          .filter((item: any) => item.type === "text")
          .map((item: any) => item.text || "")
          .join(" ");
      } else {
        text = String(contentData || "");
      }

      messages.push({ role: "user", content: text, timestamp, toolCalls: [], tokens: {}, model: "" });
    } else if (role === "assistant") {
      const contentItems = msgData.content || [];
      const textParts: string[] = [];
      const toolCalls: ParsedMessage["toolCalls"] = [];

      if (Array.isArray(contentItems)) {
        for (const item of contentItems) {
          if (item.type === "text") {
            textParts.push(item.text || "");
          } else if (item.type === "tool_use") {
            const tc = { name: item.name || "", input: item.input || {}, result: "", isError: false };
            toolCalls.push(tc);
            pendingToolCalls.set(item.id || "", tc);
          }
        }
      }

      messages.push({
        role: "assistant",
        content: textParts.join(" "),
        timestamp,
        toolCalls,
        tokens: msgData.usage || {},
        model: msgData.model || "",
      });
    }
  }

  return messages;
}

// --- Tool Definitions ---

const searchSessions = tool(
  "search_sessions",
  "Semantic search across Claude Code sessions using pgvector. Returns matching session chunks with similarity scores.",
  {
    query: z.string().describe("Search query text"),
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async ({ query, limit }) => {
    const maxResults = limit || 10;

    let embedding: number[];
    try {
      embedding = await embedText(query);
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Ollama not available for embedding. Is it running?", detail: String(e) }) }],
      };
    }

    const embeddingStr = "[" + embedding.join(",") + "]";
    const pool = new pg.Pool({ connectionString: DB_CONNECTION });

    try {
      const result = await pool.query(
        `SELECT session_id, chunk_index, summary, raw_excerpt, tools_used, project, classification,
                1 - (embedding_vec <=> $1::vector(768)) as similarity
         FROM session_chunks
         WHERE embedding_vec IS NOT NULL
         ORDER BY embedding_vec <=> $1::vector(768)
         LIMIT $2`,
        [embeddingStr, maxResults]
      );

      const matches = result.rows.map((row) => ({
        session_id: row.session_id,
        chunk_index: row.chunk_index,
        summary: row.summary,
        excerpt: row.raw_excerpt?.slice(0, 300),
        tools_used: row.tools_used,
        project: row.project,
        classification: row.classification,
        similarity: parseFloat(row.similarity).toFixed(3),
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results: matches, count: matches.length }) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "pgvector query failed", detail: String(e) }) }],
      };
    } finally {
      await pool.end();
    }
  }
);

const getSessionDetail = tool(
  "get_session_detail",
  "Get detailed information about a specific Claude Code session including messages, tools used, and token counts.",
  {
    session_id: z.string().describe("Session UUID"),
  },
  async ({ session_id }) => {
    // First try session-meta
    let meta: SessionMeta | null = null;
    try {
      const metaPath = path.join(SESSION_META_DIR, `${session_id}.json`);
      const raw = await fs.readFile(metaPath, "utf-8");
      meta = JSON.parse(raw);
    } catch {
      // No meta file
    }

    // Try to find and parse JSONL
    const jsonlPath = await findSessionJsonl(session_id);
    let messages: ParsedMessage[] = [];
    if (jsonlPath) {
      const content = await fs.readFile(jsonlPath, "utf-8");
      messages = parseSessionJsonl(content);
    }

    // Build detail response
    const toolCounts: Record<string, number> = {};
    let totalTokens = { input: 0, output: 0 };
    for (const msg of messages) {
      for (const tc of msg.toolCalls) {
        toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1;
      }
      totalTokens.input += msg.tokens.input_tokens || 0;
      totalTokens.output += msg.tokens.output_tokens || 0;
    }

    // Get key message excerpts (first user message + last few)
    const userMessages = messages.filter((m) => m.role === "user");
    const excerpts = [
      ...(userMessages.length > 0 ? [{ role: "user", content: userMessages[0].content.slice(0, 500), timestamp: userMessages[0].timestamp }] : []),
      ...userMessages.slice(-3).map((m) => ({ role: "user", content: m.content.slice(0, 300), timestamp: m.timestamp })),
    ];

    const detail = {
      session_id,
      meta: meta
        ? {
            project: meta.project_path,
            start_time: meta.start_time,
            duration_minutes: meta.duration_minutes,
            summary: meta.summary,
            first_prompt: meta.first_prompt?.slice(0, 500),
            user_messages: meta.user_message_count,
            assistant_messages: meta.assistant_message_count,
            tool_counts: meta.tool_counts,
            languages: meta.languages,
            lines_added: meta.lines_added,
            lines_removed: meta.lines_removed,
            input_tokens: meta.input_tokens,
            output_tokens: meta.output_tokens,
          }
        : null,
      parsed: {
        message_count: messages.length,
        tool_counts: toolCounts,
        tokens: totalTokens,
        excerpts,
      },
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(detail) }],
    };
  }
);

const getDashboardStats = tool(
  "get_dashboard_stats",
  "Get aggregate dashboard statistics from all Claude Code sessions. Returns totals, distributions, and daily activity.",
  {
    date_range: z.string().optional().describe("Optional date range as 'start,end' ISO dates"),
  },
  async ({ date_range }) => {
    const metas = await loadSessionMetas(date_range);

    // Aggregations
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalDuration = 0;
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    const toolDist: Record<string, number> = {};
    const projectDist: Record<string, number> = {};
    const languageDist: Record<string, number> = {};
    const dailyActivity: Record<string, number> = {};
    const hourlyActivity: Record<number, number> = {};

    for (const m of metas) {
      totalTokensIn += m.input_tokens || 0;
      totalTokensOut += m.output_tokens || 0;
      totalDuration += m.duration_minutes || 0;
      totalLinesAdded += m.lines_added || 0;
      totalLinesRemoved += m.lines_removed || 0;

      for (const [tool, count] of Object.entries(m.tool_counts || {})) {
        toolDist[tool] = (toolDist[tool] || 0) + count;
      }

      const project = parseProjectName(m.project_path);
      projectDist[project] = (projectDist[project] || 0) + 1;

      for (const [lang, count] of Object.entries(m.languages || {})) {
        languageDist[lang] = (languageDist[lang] || 0) + count;
      }

      const day = m.start_time?.slice(0, 10);
      if (day) dailyActivity[day] = (dailyActivity[day] || 0) + 1;

      for (const h of m.message_hours || []) {
        hourlyActivity[h] = (hourlyActivity[h] || 0) + 1;
      }
    }

    // Sort tool distribution by count
    const sortedTools = Object.entries(toolDist)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    const sortedProjects = Object.entries(projectDist)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    const sortedLanguages = Object.entries(languageDist)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    const stats = {
      total_sessions: metas.length,
      total_tokens: { input: totalTokensIn, output: totalTokensOut, total: totalTokensIn + totalTokensOut },
      total_duration_hours: Math.round(totalDuration / 60 * 10) / 10,
      total_lines: { added: totalLinesAdded, removed: totalLinesRemoved },
      top_tools: sortedTools,
      top_projects: sortedProjects,
      top_languages: sortedLanguages,
      daily_activity: Object.entries(dailyActivity).sort((a, b) => a[0].localeCompare(b[0])),
      hourly_activity: hourlyActivity,
      avg_session_duration: metas.length > 0 ? Math.round(totalDuration / metas.length * 10) / 10 : 0,
      sessions_with_mcp: metas.filter((m) => m.uses_mcp).length,
      sessions_with_web_search: metas.filter((m) => m.uses_web_search).length,
      sessions_with_task_agent: metas.filter((m) => m.uses_task_agent).length,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(stats) }],
    };
  }
);

const getInsightsReport = tool(
  "get_insights_report",
  "Read the latest /insights HTML report with improvement suggestions for Claude Code usage.",
  {},
  async () => {
    try {
      const files = await fs.readdir(INSIGHTS_DIR);
      const htmlFiles = files.filter((f) => f.endsWith(".html")).sort().reverse();

      if (htmlFiles.length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No insights reports found" }) }] };
      }

      const latest = htmlFiles[0];
      const content = await fs.readFile(path.join(INSIGHTS_DIR, latest), "utf-8");

      // Extract text content from HTML (strip tags)
      const textContent = content
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              report_file: latest,
              report_date: latest.replace("insights-", "").replace(".html", ""),
              content: textContent.slice(0, 5000),
            }),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(e) }) }] };
    }
  }
);

const resumeSession = tool(
  "resume_session",
  "Get the command to resume a specific Claude Code session in the terminal.",
  {
    session_id: z.string().describe("Session UUID to resume"),
  },
  async ({ session_id }) => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            command: `claude --resume ${session_id}`,
            note: "Run this command in your terminal to resume the session",
          }),
        },
      ],
    };
  }
);

// --- Export MCP Server ---

export const sessionTools = [searchSessions, getSessionDetail, getDashboardStats, getInsightsReport, resumeSession];

export const sessionServer = createSdkMcpServer({
  name: "sessions",
  tools: sessionTools,
});

export const SESSION_TOOL_NAMES = [
  "mcp__sessions__search_sessions",
  "mcp__sessions__get_session_detail",
  "mcp__sessions__get_dashboard_stats",
  "mcp__sessions__get_insights_report",
  "mcp__sessions__resume_session",
];

// Also export helpers for direct use by REST endpoints
export { loadSessionMetas, parseSessionJsonl, findSessionJsonl, SESSION_META_DIR, DB_CONNECTION };
export type { SessionMeta, ParsedMessage };
