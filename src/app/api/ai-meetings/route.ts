import { NextRequest, NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://antisakrum2004.github.io",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * POST /api/ai-meetings
 * Body: { text: string, threshold?: number, limit?: number }
 *
 * Семантический поиск по meetings (встречам из NotebookLM).
 */
export async function POST(req: NextRequest) {
  try {
    const { text, threshold = 0.3, limit = 5 } = await req.json();

    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json(
        { meetings: [], total: 0, reason: "empty_query" },
        { headers: CORS_HEADERS }
      );
    }

    const openaiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
    const supaUrl = process.env.SUPABASE_URL || "https://nopccnooivztriqdkbie.supabase.co";
    const supaKey = process.env.SUPABASE_SERVICE_KEY;

    if (!openaiKey || !supaKey) {
      return NextResponse.json(
        { meetings: [], total: 0, reason: "missing_env" },
        { headers: CORS_HEADERS }
      );
    }

    const embRes = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text.slice(0, 8000),
      }),
    });

    if (!embRes.ok) {
      return NextResponse.json(
        { meetings: [], total: 0, reason: "embedding_failed" },
        { headers: CORS_HEADERS }
      );
    }

    const embData = await embRes.json();
    const embedding = embData?.data?.[0]?.embedding;

    if (!embedding || !Array.isArray(embedding) || embedding.length !== 1536) {
      return NextResponse.json(
        { meetings: [], total: 0, reason: "bad_embedding" },
        { headers: CORS_HEADERS }
      );
    }

    const rpcRes = await fetch(`${supaUrl}/rest/v1/rpc/search_meetings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
      },
      body: JSON.stringify({
        query_embedding: embedding,
        match_threshold: threshold,
        match_count: limit,
      }),
    });

    if (!rpcRes.ok) {
      const txt = await rpcRes.text();
      console.warn("ai-meetings: RPC failed:", rpcRes.status, txt.slice(0, 200));
      return NextResponse.json(
        { meetings: [], total: 0, reason: "supabase_error" },
        { headers: CORS_HEADERS }
      );
    }

    const rows: any[] = await rpcRes.json();

    const meetings = (Array.isArray(rows) ? rows : []).map((row: any) => ({
      id: String(row.id),
      title: row.title || `Встреча #${row.id}`,
      decision_text: (row.decision_text || "").slice(0, 500),
      excerpt: (row.excerpt || "").slice(0, 300),
      meeting_date: row.meeting_date || null,
      participants: row.participants || [],
      duration_min: row.duration_min || null,
      action_items: row.action_items || [],
      related_task_ids: row.related_task_ids || [],
      tags: row.tags || [],
      audio_url: row.audio_url || null,
      source_url: row.source_url || null,
      external_id: row.external_id || null,
      similarity: row.similarity || 0,
    }));

    return NextResponse.json(
      {
        meetings,
        total: meetings.length,
        source: "meetings",
        query_text: text.slice(0, 200),
      },
      { headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error("AI meetings error:", error);
    return NextResponse.json(
      {
        meetings: [],
        total: 0,
        reason: "exception",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
