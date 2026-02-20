/**
 * Claude Session Explorer - Express + Agent SDK server
 *
 * - Serves public/ static files
 * - POST /api/ask  -- SSE endpoint streaming Agent SDK responses
 * - GET /api/stats -- Quick JSON stats from session-meta (no agent)
 * - GET /api/sessions -- Paginated session list from session-meta
 */

// Agent SDK spawns Claude Code subprocess -- these env vars prevent nested sessions
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDECODE;
delete process.env.CLAUDE_CODE_ENTRYPOINT;

// Build a clean env for the agent subprocess (in case static imports capture process.env early)
const cleanEnv: Record<string, string | undefined> = { ...process.env };
delete cleanEnv.CLAUDECODE;
delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
delete cleanEnv.ANTHROPIC_API_KEY;

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
    let totalToolErrors = 0;
    const toolDist: Record<string, number> = {};
    const projectDist: Record<string, number> = {};
    const languageDist: Record<string, number> = {};
    const dailyActivity: Record<string, number> = {};
    const hourlyActivity: Record<number, number> = {};
    const dowActivity: Record<number, number> = {};
    const errorCategoryDist: Record<string, number> = {};

    for (const m of metas) {
      totalTokensIn += m.input_tokens || 0;
      totalTokensOut += m.output_tokens || 0;
      totalDuration += m.duration_minutes || 0;
      totalLinesAdded += m.lines_added || 0;
      totalLinesRemoved += m.lines_removed || 0;
      totalToolErrors += m.tool_errors || 0;

      for (const [tool, count] of Object.entries(m.tool_counts || {})) {
        toolDist[tool] = (toolDist[tool] || 0) + count;
      }

      for (const [lang, count] of Object.entries(m.languages || {})) {
        languageDist[lang] = (languageDist[lang] || 0) + count;
      }

      for (const [cat, count] of Object.entries(m.tool_error_categories || {})) {
        errorCategoryDist[cat] = (errorCategoryDist[cat] || 0) + count;
      }

      const parts = (m.project_path || "").split("/").filter(Boolean);
      const project = parts.slice(-2).join("/");
      projectDist[project] = (projectDist[project] || 0) + 1;

      const day = m.start_time?.slice(0, 10);
      if (day) dailyActivity[day] = (dailyActivity[day] || 0) + 1;

      // Day of week from start_time
      if (m.start_time) {
        const dow = new Date(m.start_time).getDay();
        dowActivity[dow] = (dowActivity[dow] || 0) + 1;
      }

      for (const h of m.message_hours || []) {
        hourlyActivity[h] = (hourlyActivity[h] || 0) + 1;
      }
    }

    const sortedTools = Object.entries(toolDist).sort((a, b) => b[1] - a[1]).slice(0, 15);
    const sortedProjects = Object.entries(projectDist).sort((a, b) => b[1] - a[1]).slice(0, 15);
    const sortedLanguages = Object.entries(languageDist).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const sortedErrorCategories = Object.entries(errorCategoryDist).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const sessionsWithErrors = metas.filter(m => (m.tool_errors || 0) > 0).length;
    const errorRate = metas.length > 0 ? sessionsWithErrors / metas.length : 0;

    // Estimated cost (default Sonnet pricing)
    const SONNET_INPUT = 3 / 1_000_000;
    const SONNET_OUTPUT = 15 / 1_000_000;
    const estimatedCost = totalTokensIn * SONNET_INPUT + totalTokensOut * SONNET_OUTPUT;

    // --- Well-being metrics ---
    // Per-day aggregation for calendar + well-being
    const dayDetails: Record<string, {
      sessions: number; duration: number; projects: Set<string>;
      tokens: number; cost: number; linesAdded: number;
      firstStart: string; lastEnd: string; lateNight: boolean; weekend: boolean;
    }> = {};

    const sortedMetas = [...metas].sort((a, b) =>
      new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
    );

    for (const m of sortedMetas) {
      const day = m.start_time?.slice(0, 10);
      if (!day) continue;
      if (!dayDetails[day]) {
        const d = new Date(m.start_time);
        dayDetails[day] = {
          sessions: 0, duration: 0, projects: new Set(), tokens: 0,
          cost: 0, linesAdded: 0, firstStart: m.start_time, lastEnd: m.start_time,
          lateNight: false, weekend: d.getDay() === 0 || d.getDay() === 6,
        };
      }
      const dd = dayDetails[day];
      dd.sessions++;
      dd.duration += m.duration_minutes || 0;
      const proj = (m.project_path || "").split("/").filter(Boolean).slice(-2).join("/");
      if (proj) dd.projects.add(proj);
      dd.tokens += (m.input_tokens || 0) + (m.output_tokens || 0);
      dd.cost += (m.input_tokens || 0) * SONNET_INPUT + (m.output_tokens || 0) * SONNET_OUTPUT;
      dd.linesAdded += m.lines_added || 0;
      if (m.start_time > dd.lastEnd) dd.lastEnd = m.start_time;
      if (m.start_time < dd.firstStart) dd.firstStart = m.start_time;
      // Late night: any message hour >= 22 or <= 5
      for (const h of m.message_hours || []) {
        if (h >= 22 || h <= 5) dd.lateNight = true;
      }
    }

    // Compute breaks between consecutive sessions
    const breaks: number[] = [];
    for (let i = 1; i < sortedMetas.length; i++) {
      const prev = sortedMetas[i - 1];
      const curr = sortedMetas[i];
      if (!prev.start_time || !curr.start_time) continue;
      const prevEnd = new Date(prev.start_time).getTime() + (prev.duration_minutes || 0) * 60000;
      const currStart = new Date(curr.start_time).getTime();
      // Only count breaks within same day or < 8 hours
      const gapMin = (currStart - prevEnd) / 60000;
      if (gapMin > 0 && gapMin < 480) breaks.push(gapMin);
    }

    const avgBreak = breaks.length > 0 ? Math.round(breaks.reduce((s, b) => s + b, 0) / breaks.length) : 0;
    const shortBreaks = breaks.filter(b => b < 5).length;

    // Build calendar_days: last 90 days
    const calendarDays: Array<{
      date: string; sessions: number; duration: number; projects: number;
      tokens: number; cost: number; linesAdded: number;
      lateNight: boolean; weekend: boolean; danger: boolean;
    }> = [];

    const dangerDays: string[] = [];
    const now = new Date();
    for (let i = 89; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const dd = dayDetails[key];
      const entry = {
        date: key,
        sessions: dd?.sessions || 0,
        duration: dd?.duration || 0,
        projects: dd?.projects.size || 0,
        tokens: dd?.tokens || 0,
        cost: Math.round((dd?.cost || 0) * 100) / 100,
        linesAdded: dd?.linesAdded || 0,
        lateNight: dd?.lateNight || false,
        weekend: dd?.weekend || false,
        danger: false,
      };
      // Danger: >6h work, or >10 sessions, or late night + weekend
      if (entry.duration > 360 || entry.sessions > 10 || (entry.lateNight && entry.weekend)) {
        entry.danger = true;
        dangerDays.push(key);
      }
      calendarDays.push(entry);
    }

    // Longest streak without a day off (0-session day)
    let currentStreak = 0, longestStreak = 0;
    for (const cd of calendarDays) {
      if (cd.sessions > 0) {
        currentStreak++;
        longestStreak = Math.max(longestStreak, currentStreak);
      } else {
        currentStreak = 0;
      }
    }

    res.json({
      total_sessions: metas.length,
      total_tokens: totalTokensIn + totalTokensOut,
      total_tokens_in: totalTokensIn,
      total_tokens_out: totalTokensOut,
      total_duration_hours: Math.round((totalDuration / 60) * 10) / 10,
      total_lines: { added: totalLinesAdded, removed: totalLinesRemoved },
      avg_duration_min: metas.length > 0 ? Math.round((totalDuration / metas.length) * 10) / 10 : 0,
      top_tools: sortedTools,
      top_projects: sortedProjects,
      top_languages: sortedLanguages,
      daily_activity: Object.entries(dailyActivity).sort((a, b) => a[0].localeCompare(b[0])),
      hourly_activity: hourlyActivity,
      dow_activity: dowActivity,
      total_tool_errors: totalToolErrors,
      error_rate: Math.round(errorRate * 100),
      top_error_categories: sortedErrorCategories,
      estimated_cost: Math.round(estimatedCost * 100) / 100,
      // Well-being
      wellbeing: {
        avg_break_minutes: avgBreak,
        short_breaks_count: shortBreaks,
        total_breaks: breaks.length,
        longest_streak_days: longestStreak,
        current_streak_days: currentStreak,
        danger_days: dangerDays,
        late_night_days: calendarDays.filter(d => d.lateNight).length,
        weekend_work_days: calendarDays.filter(d => d.weekend && d.sessions > 0).length,
      },
      calendar_days: calendarDays,
      // Project activity for swimlane (last 30 days, all sessions)
      project_activity: (() => {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        const projDayCounts: Record<string, Record<string, number>> = {};
        const projTotals: Record<string, number> = {};
        for (const m of metas) {
          const day = m.start_time?.slice(0, 10);
          if (!day || day < cutoffStr) continue;
          const parts = (m.project_path || "").split("/").filter(Boolean);
          const proj = parts.slice(-1).join("/") || "unknown";
          if (!projDayCounts[proj]) projDayCounts[proj] = {};
          projDayCounts[proj][day] = (projDayCounts[proj][day] || 0) + 1;
          projTotals[proj] = (projTotals[proj] || 0) + 1;
        }
        const topProjects = Object.entries(projTotals)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([p]) => p);
        return { projects: topProjects, data: Object.fromEntries(topProjects.map(p => [p, projDayCounts[p] || {}])) };
      })(),
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

    // Sonnet pricing for per-session cost estimation
    const S_IN = 3 / 1_000_000;
    const S_OUT = 15 / 1_000_000;

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
      tool_errors: m.tool_errors || 0,
      tool_error_categories: m.tool_error_categories || {},
      git_commits: m.git_commits || 0,
      uses_task_agent: m.uses_task_agent || false,
      uses_mcp: m.uses_mcp || false,
      uses_web_search: m.uses_web_search || false,
      files_modified: m.files_modified || 0,
      estimated_cost: Math.round(((m.input_tokens || 0) * S_IN + (m.output_tokens || 0) * S_OUT) * 100) / 100,
    }));

    res.json({ sessions, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Price Estimation Endpoint ---

const PRICING = {
  haiku:  { input: 0.25 / 1_000_000, output: 1.25 / 1_000_000 },
  sonnet: { input: 3 / 1_000_000,    output: 15 / 1_000_000 },
  opus:   { input: 15 / 1_000_000,   output: 75 / 1_000_000 },
};

app.get("/api/price", async (req, res) => {
  try {
    const model = (req.query.model as string) || "sonnet";
    const pricing = PRICING[model as keyof typeof PRICING] || PRICING.sonnet;
    const metas = await loadSessionMetas();

    let totalIn = 0, totalOut = 0;
    const perSession = metas.map((m) => {
      const inTok = m.input_tokens || 0;
      const outTok = m.output_tokens || 0;
      totalIn += inTok;
      totalOut += outTok;
      return {
        session_id: m.session_id,
        input_tokens: inTok,
        output_tokens: outTok,
        cost: Math.round((inTok * pricing.input + outTok * pricing.output) * 100) / 100,
      };
    });

    res.json({
      model,
      pricing,
      total_cost: Math.round((totalIn * pricing.input + totalOut * pricing.output) * 100) / 100,
      total_input_tokens: totalIn,
      total_output_tokens: totalOut,
      sessions: perSession,
    });
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
- Keep responses well-structured as a document, not conversational text
- IMPORTANT: Start your response with the analysis directly. Do NOT include preamble like "I've retrieved the data" or "Let me search for..." -- skip straight to findings and insights. No narration of your tool-calling process.`;

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

  const abortController = new AbortController();
  let agentTimeout: ReturnType<typeof setTimeout>;
  const resetTimeout = () => {
    clearTimeout(agentTimeout);
    agentTimeout = setTimeout(() => {
      console.error("[Agent] Timeout after 60s of inactivity, aborting");
      abortController.abort();
    }, 60000);
  };
  resetTimeout();

  let agentQuery: ReturnType<typeof query> | null = null;

  try {
    agentQuery = query({
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
        abortController,
        persistSession: false,
        env: cleanEnv,
      },
    });

    for await (const message of agentQuery) {
      // Reset timeout on each message (agent is alive)
      resetTimeout();

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && !res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "text", content: block.text })}\n\n`);
          }
          if (block.type === "tool_use" && !res.writableEnded) {
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
        if (!res.writableEnded) {
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
    }
  } catch (err) {
    clearTimeout(agentTimeout);
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Agent Error] ${errorMsg}`);
    // Provide user-friendly error messages
    let userMsg = errorMsg;
    if (errorMsg.includes("network error") || errorMsg.includes("ECONNREFUSED")) {
      userMsg = "Agent unavailable — too many concurrent Claude sessions or rate limit reached. Try again in a moment.";
    } else if (errorMsg.includes("exited with code 1")) {
      userMsg = "Agent process failed to start. Check that Claude CLI is available and not blocked by another session.";
    }
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: "error", message: userMsg })}\n\n`);
    }
    // Force-close the query if still running
    try { agentQuery?.close(); } catch {}
  } finally {
    clearTimeout(agentTimeout);
  }

  if (!res.writableEnded) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
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
