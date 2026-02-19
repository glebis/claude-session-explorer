/**
 * Session Embedding Pipeline
 *
 * Processes Claude Code session JSONL files:
 * 1. Chunks sessions into conversation turns
 * 2. Summarizes each chunk via Agent SDK (Haiku)
 * 3. Embeds summaries via Ollama embeddinggemma (768-dim)
 * 4. Stores in PostgreSQL pgvector
 *
 * Usage: npx tsx embedder.ts [--limit N] [--force]
 */

// Agent SDK spawns Claude Code subprocess -- these env vars conflict
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDECODE;

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import pg from "pg";
import { query } from "@anthropic-ai/claude-agent-sdk";

// --- Config ---
const SESSION_META_DIR = path.join(os.homedir(), ".claude", "usage-data", "session-meta");
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const OLLAMA_EMBED_URL = "http://localhost:11434/api/embeddings";
const EMBED_MODEL = "embeddinggemma";
const DB_CONNECTION = "postgresql://glebkalinin@localhost:5432/obsidian";
const CHUNK_SIZE = 5; // turns per chunk for long sessions
const MAX_CHUNK_TEXT = 3000; // max chars per chunk for summarization

// --- Parse args ---
const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const maxSessions = limitArg >= 0 ? parseInt(args[limitArg + 1]) || 10 : Infinity;
const force = args.includes("--force");

// --- Types ---
interface SessionMeta {
  session_id: string;
  project_path: string;
  start_time: string;
  duration_minutes: number;
  summary: string;
  first_prompt: string;
  tool_counts: Record<string, number>;
  languages: Record<string, number>;
  input_tokens: number;
  output_tokens: number;
}

interface ParsedMessage {
  role: string;
  content: string;
  timestamp: string;
  toolNames: string[];
}

interface Chunk {
  chunkIndex: number;
  messages: ParsedMessage[];
  text: string;
  startTime: string;
  endTime: string;
  toolsUsed: string[];
}

// --- JSONL Parser ---
function parseSessionJsonl(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "user" && entry.type !== "assistant") continue;

    const msgData = entry.message || {};
    const role = msgData.role;
    if (!role) continue;

    const timestamp = entry.timestamp || "";
    let text = "";
    const toolNames: string[] = [];

    if (role === "user") {
      const contentData = msgData.content;
      if (Array.isArray(contentData)) {
        text = contentData
          .filter((item: any) => item.type === "text")
          .map((item: any) => item.text || "")
          .join(" ");
      } else {
        text = String(contentData || "");
      }
    } else if (role === "assistant") {
      const contentItems = msgData.content || [];
      if (Array.isArray(contentItems)) {
        for (const item of contentItems) {
          if (item.type === "text") text += (item.text || "") + " ";
          if (item.type === "tool_use") toolNames.push(item.name || "");
        }
      }
    }

    messages.push({ role, content: text.trim(), timestamp, toolNames });
  }

  return messages;
}

// --- Chunking ---
function chunkSession(messages: ParsedMessage[]): Chunk[] {
  // Group into conversation turns (user + assistant = 1 turn)
  const turns: ParsedMessage[][] = [];
  let currentTurn: ParsedMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(msg);
  }
  if (currentTurn.length > 0) turns.push(currentTurn);

  // If short session (<= CHUNK_SIZE turns), single chunk
  if (turns.length <= CHUNK_SIZE) {
    const allMessages = turns.flat();
    return [
      {
        chunkIndex: 0,
        messages: allMessages,
        text: formatChunkText(allMessages),
        startTime: allMessages[0]?.timestamp || "",
        endTime: allMessages[allMessages.length - 1]?.timestamp || "",
        toolsUsed: [...new Set(allMessages.flatMap((m) => m.toolNames))],
      },
    ];
  }

  // Split into chunks of CHUNK_SIZE turns
  const chunks: Chunk[] = [];
  for (let i = 0; i < turns.length; i += CHUNK_SIZE) {
    const group = turns.slice(i, i + CHUNK_SIZE);
    const allMessages = group.flat();
    chunks.push({
      chunkIndex: chunks.length,
      messages: allMessages,
      text: formatChunkText(allMessages),
      startTime: allMessages[0]?.timestamp || "",
      endTime: allMessages[allMessages.length - 1]?.timestamp || "",
      toolsUsed: [...new Set(allMessages.flatMap((m) => m.toolNames))],
    });
  }

  return chunks;
}

function formatChunkText(messages: ParsedMessage[]): string {
  return messages
    .map((m) => {
      const prefix = m.role === "user" ? "User:" : "Assistant:";
      const tools = m.toolNames.length > 0 ? ` [Tools: ${m.toolNames.join(", ")}]` : "";
      return `${prefix} ${m.content.slice(0, 600)}${tools}`;
    })
    .join("\n")
    .slice(0, MAX_CHUNK_TEXT);
}

// --- Summarization via Agent SDK ---
async function summarizeChunk(text: string): Promise<string> {
  try {
    let summary = "";
    for await (const message of query({
      prompt: `Summarize this Claude Code conversation segment in 2-3 sentences. Focus on: what task was being done, what tools were used, what was the outcome.\n\n${text}`,
      options: {
        model: "haiku",
        maxTurns: 1,
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") summary += block.text;
        }
      }
    }
    return summary.trim();
  } catch (e) {
    console.error("  Summarization failed:", e);
    // Fallback: first 200 chars of text
    return text.slice(0, 200);
  }
}

// --- Embedding via Ollama ---
async function embedText(text: string): Promise<number[]> {
  const response = await fetch(OLLAMA_EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!response.ok) throw new Error(`Ollama error: ${response.status}`);
  const data = await response.json();
  if (!data.embedding) throw new Error("No embedding in response");
  return data.embedding;
}

// --- Find session JSONL ---
async function findSessionJsonl(sessionId: string): Promise<string | null> {
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
  } catch {}
  return null;
}

// --- Database ---
async function ensureTable(pool: pg.Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_chunks (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      chunk_index INTEGER,
      summary TEXT,
      raw_excerpt TEXT,
      embedding_vec vector(768),
      start_time TIMESTAMPTZ,
      end_time TIMESTAMPTZ,
      tools_used TEXT[],
      project TEXT,
      classification TEXT,
      token_count INTEGER
    )
  `);

  // Create index if not exists
  try {
    await pool.query(
      `CREATE INDEX IF NOT EXISTS session_chunks_embedding_idx ON session_chunks USING ivfflat (embedding_vec vector_cosine_ops)`
    );
  } catch {
    // IVFFlat index may fail if < 100 rows; will retry later
    console.log("  Note: IVFFlat index creation deferred (need more data)");
  }
}

async function getEmbeddedSessionIds(pool: pg.Pool): Promise<Set<string>> {
  const result = await pool.query("SELECT DISTINCT session_id FROM session_chunks");
  return new Set(result.rows.map((r) => r.session_id));
}

async function insertChunk(
  pool: pg.Pool,
  sessionId: string,
  chunk: Chunk,
  summary: string,
  embedding: number[],
  project: string,
  tokenCount: number
) {
  const embeddingStr = "[" + embedding.join(",") + "]";
  await pool.query(
    `INSERT INTO session_chunks (session_id, chunk_index, summary, raw_excerpt, embedding_vec, start_time, end_time, tools_used, project, token_count)
     VALUES ($1, $2, $3, $4, $5::vector(768), $6, $7, $8, $9, $10)`,
    [
      sessionId,
      chunk.chunkIndex,
      summary,
      chunk.text.slice(0, 2000),
      embeddingStr,
      chunk.startTime || null,
      chunk.endTime || null,
      chunk.toolsUsed,
      project,
      tokenCount,
    ]
  );
}

// --- Main Pipeline ---
async function main() {
  console.log("Claude Session Embedder");
  console.log("=======================\n");

  // Load session metas
  const metaFiles = await fs.readdir(SESSION_META_DIR);
  const jsonFiles = metaFiles.filter((f) => f.endsWith(".json"));
  console.log(`Found ${jsonFiles.length} session-meta files`);

  // Connect to DB
  const pool = new pg.Pool({ connectionString: DB_CONNECTION });
  await ensureTable(pool);

  // Get already-embedded sessions
  const embeddedIds = force ? new Set<string>() : await getEmbeddedSessionIds(pool);
  console.log(`Already embedded: ${embeddedIds.size} sessions`);

  // Check Ollama
  try {
    const resp = await fetch("http://localhost:11434/api/tags");
    if (!resp.ok) throw new Error("not ok");
    console.log("Ollama: running");
  } catch {
    console.error("ERROR: Ollama is not running. Start with: ollama serve");
    process.exit(1);
  }

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of jsonFiles) {
    if (processed >= maxSessions) break;

    const sessionId = file.replace(".json", "");

    // Skip already embedded
    if (embeddedIds.has(sessionId)) {
      skipped++;
      continue;
    }

    // Skip agent sub-sessions
    if (sessionId.startsWith("agent-")) {
      skipped++;
      continue;
    }

    // Load meta
    let meta: SessionMeta;
    try {
      const raw = await fs.readFile(path.join(SESSION_META_DIR, file), "utf-8");
      meta = JSON.parse(raw);
    } catch {
      errors++;
      continue;
    }

    // Find JSONL
    const jsonlPath = await findSessionJsonl(sessionId);
    if (!jsonlPath) {
      // No JSONL found - embed just the meta summary
      console.log(`[${processed + 1}] ${sessionId} (meta-only)`);
      try {
        const summaryText = `Session: ${meta.summary || meta.first_prompt?.slice(0, 200) || "Unknown"}. Project: ${meta.project_path}. Duration: ${meta.duration_minutes}min. Tools: ${Object.keys(meta.tool_counts || {}).join(", ")}`;
        const embedding = await embedText(summaryText);
        await insertChunk(
          pool,
          sessionId,
          {
            chunkIndex: 0,
            messages: [],
            text: summaryText,
            startTime: meta.start_time,
            endTime: "",
            toolsUsed: Object.keys(meta.tool_counts || {}),
          },
          summaryText,
          embedding,
          meta.project_path || "",
          (meta.input_tokens || 0) + (meta.output_tokens || 0)
        );
        processed++;
      } catch (e) {
        console.error(`  Error embedding meta: ${e}`);
        errors++;
      }
      continue;
    }

    console.log(`[${processed + 1}] ${sessionId}`);
    console.log(`  Project: ${meta.project_path}`);

    try {
      // Parse JSONL
      const jsonlContent = await fs.readFile(jsonlPath, "utf-8");
      const messages = parseSessionJsonl(jsonlContent);
      console.log(`  Messages: ${messages.length}`);

      if (messages.length === 0) {
        skipped++;
        continue;
      }

      // Chunk
      const chunks = chunkSession(messages);
      console.log(`  Chunks: ${chunks.length}`);

      // Process each chunk
      for (const chunk of chunks) {
        // Summarize
        const summary = await summarizeChunk(chunk.text);
        console.log(`  Chunk ${chunk.chunkIndex}: ${summary.slice(0, 80)}...`);

        // Embed the summary
        const embedding = await embedText(summary);

        // Store
        await insertChunk(
          pool,
          sessionId,
          chunk,
          summary,
          embedding,
          meta.project_path || "",
          (meta.input_tokens || 0) + (meta.output_tokens || 0)
        );
      }

      processed++;
    } catch (e) {
      console.error(`  Error: ${e}`);
      errors++;
    }
  }

  // Try creating IVFFlat index if we have enough data
  try {
    const countResult = await pool.query("SELECT COUNT(*) FROM session_chunks WHERE embedding_vec IS NOT NULL");
    const count = parseInt(countResult.rows[0].count);
    if (count >= 100) {
      console.log("\nCreating IVFFlat index...");
      await pool.query("DROP INDEX IF EXISTS session_chunks_embedding_idx");
      await pool.query(
        "CREATE INDEX session_chunks_embedding_idx ON session_chunks USING ivfflat (embedding_vec vector_cosine_ops)"
      );
      console.log("Index created.");
    }
  } catch (e) {
    console.log(`Index creation note: ${e}`);
  }

  console.log(`\nDone! Processed: ${processed}, Skipped: ${skipped}, Errors: ${errors}`);

  await pool.end();
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
