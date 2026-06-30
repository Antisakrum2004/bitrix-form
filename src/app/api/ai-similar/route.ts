import { NextRequest, NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://antisakrum2004.github.io",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

interface SimilarTask {
  id: string;
  title: string;
  url: string;
  responsible: string;
  status: string;
  similarity: number;
  project_name?: string;
  description?: string;       // AI-CHANGE: NEW v7.28 — для search.html (превью 2 строки)
  created_at?: string | null; // AI-CHANGE: NEW v7.28 — для search.html (дата создания)
}

/**
 * POST /api/ai-similar
 * Body: { text: string, keywords?: string[], threshold?: number, limit?: number }
 *
 * Pipeline:
 *   1. Build query text from `text` or joined `keywords`
 *   2. Get OpenAI embedding (text-embedding-3-small, 1536 dims)
 *   3. Call Supabase RPC search_similar_tasks(embedding, threshold, limit)
 *   4. Enrich with Bitrix24 task URLs
 *
 * Falls back to [] on any error — frontend can retry with /ai-search if needed.
 */
export async function POST(req: NextRequest) {
  try {
    const { text, keywords, threshold = 0.4, limit = 10 } = await req.json();

    // Build query text: prefer keywords if provided (user-controlled), else text
    let queryText = "";
    if (keywords && Array.isArray(keywords) && keywords.length > 0) {
      queryText = keywords.join(" ");
    } else if (text) {
      queryText = text;
    }

    if (!queryText.trim()) {
      return NextResponse.json(
        { similar: [], total: 0, source: "supabase", reason: "empty_query" },
        { headers: CORS_HEADERS }
      );
    }

    const openaiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
    const supaUrl = process.env.SUPABASE_URL || "https://nopccnooivztriqdkbie.supabase.co";
    const supaKey = process.env.SUPABASE_SERVICE_KEY;

    // AI-CHANGE: MODIFIED v7.26 — using OpenRouter as proxy for OpenAI embeddings.
    // ПРИЧИНА: у пользователя OpenRouter ключ, прямого OpenAI нет. OpenRouter проксирует.
    // ОТКАТ: вернуть URL https://api.openai.com/v1/embeddings и env var OPENAI_API_KEY.
    const embeddingsUrl = process.env.OPENROUTER_API_KEY
      ? "https://openrouter.ai/api/v1/embeddings"
      : "https://api.openai.com/v1/embeddings";

    if (!openaiKey || !supaKey) {
      console.warn("ai-similar: missing env (OPENROUTER_API_KEY or SUPABASE_SERVICE_KEY)");
      return NextResponse.json(
        { similar: [], total: 0, source: "supabase", reason: "missing_env" },
        { headers: CORS_HEADERS }
      );
    }

    // 1. Get embedding from OpenAI (via OpenRouter proxy)
    const isOpenRouter = embeddingsUrl.includes("openrouter.ai");
    const embRes = await fetch(embeddingsUrl, {
      method: "POST",
      headers: isOpenRouter
        ? {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openaiKey}`,
            "HTTP-Referer": "https://antisakrum2004.github.io",
            "X-Title": "bitrix-form EOD",
          }
        : {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openaiKey}`,
          },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: queryText.slice(0, 8000),
      }),
    });

    if (!embRes.ok) {
      const txt = await embRes.text();
      console.warn("ai-similar: OpenAI embedding failed:", embRes.status, txt.slice(0, 200));
      return NextResponse.json(
        { similar: [], total: 0, source: "supabase", reason: "openai_error" },
        { headers: CORS_HEADERS }
      );
    }

    const embData = await embRes.json();
    const embedding = embData?.data?.[0]?.embedding;

    if (!embedding || !Array.isArray(embedding) || embedding.length !== 1536) {
      console.warn("ai-similar: bad embedding response");
      return NextResponse.json(
        { similar: [], total: 0, source: "supabase", reason: "bad_embedding" },
        { headers: CORS_HEADERS }
      );
    }

    // 2. Call Supabase RPC: search_similar_tasks (v7.27 hybrid: vector + pg_trgm)
    // Pass query_text so RPC can compute trgm_score; if not provided, RPC falls back to pure vector mode.
    const rpcRes = await fetch(`${supaUrl}/rest/v1/rpc/search_similar_tasks`, {
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
        query_text: queryText.slice(0, 1000),  // cap at 1000 chars for trgm
      }),
    });

    if (!rpcRes.ok) {
      const txt = await rpcRes.text();
      console.warn("ai-similar: Supabase RPC failed:", rpcRes.status, txt.slice(0, 300));
      return NextResponse.json(
        { similar: [], total: 0, source: "supabase", reason: "supabase_error" },
        { headers: CORS_HEADERS }
      );
    }

    const rows: SimilarTask[] = await rpcRes.json();

    if (!Array.isArray(rows)) {
      console.warn("ai-similar: Supabase returned non-array");
      return NextResponse.json(
        { similar: [], total: 0, source: "supabase", reason: "bad_response" },
        { headers: CORS_HEADERS }
      );
    }

    // 3. Enrich with Bitrix24 URLs + format matching /ai-search response shape
    const similar = rows.map((row: any) => ({
      id: String(row.id),
      title: row.title || `Задача #${row.id}`,
      url: `https://1c-cms.bitrix24.ru/company/personal/user/${row.responsible_id || 116}/tasks/task/view/${row.id}/`,
      responsible: row.responsible_name || "",
      status: row.status_label || row.status || "",
      project_name: row.project_name || "",
      similarity: row.similarity || 0,
      // AI-CHANGE: NEW v7.28 — пробрасываем description и created_at для search.html.
      // description обрезаем до 500 символов, чтобы не раздувать ответ (достаточно для превью).
      description: (row.description || "").slice(0, 500),
      created_at: row.created_at || null,
    }));

    return NextResponse.json(
      {
        similar,
        total: similar.length,
        source: "supabase",
        query_text: queryText.slice(0, 200),
        threshold,
      },
      { headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error("AI similar error:", error);
    return NextResponse.json(
      {
        similar: [],
        total: 0,
        source: "supabase",
        reason: "exception",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
