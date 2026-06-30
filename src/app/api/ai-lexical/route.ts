import { NextRequest, NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://antisakrum2004.github.io",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

interface LexicalTask {
  id: string;
  title: string;
  url: string;
  responsible: string;
  status: string;
  similarity: number;
  project_name?: string;
  description?: string;
  created_at?: string | null;
  match_type: "lexical";
  match_kind?: string;  // v7.28.2: phrase_title | phrase_desc | all_words | half_words | trgm
}

/**
 * POST /api/ai-lexical
 * Body: { text: string, limit?: number, min_score?: number }
 *
 * Лексический поиск через pg_trgm — находит задачи с точным совпадением
 * слов в title или description. Используется как fallback к /ai-similar
 * когда семантика не находит короткие аббревиатуры (FTP) или специфичные термины.
 *
 * Cost: 0 (нет вызова OpenAI, чистый SQL).
 */
export async function POST(req: NextRequest) {
  try {
    const { text, limit = 20, min_score = 0.05 } = await req.json();

    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json(
        { similar: [], total: 0, source: "lexical", reason: "empty_query" },
        { headers: CORS_HEADERS }
      );
    }

    const supaUrl = process.env.SUPABASE_URL || "https://nopccnooivztriqdkbie.supabase.co";
    const supaKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supaKey) {
      console.warn("ai-lexical: missing SUPABASE_SERVICE_KEY");
      return NextResponse.json(
        { similar: [], total: 0, source: "lexical", reason: "missing_env" },
        { headers: CORS_HEADERS }
      );
    }

    const rpcRes = await fetch(`${supaUrl}/rest/v1/rpc/search_tasks_lexical`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
      },
      body: JSON.stringify({
        query_text: text.slice(0, 1000),
        match_count: limit,
        min_trgm_score: min_score,
      }),
    });

    if (!rpcRes.ok) {
      const txt = await rpcRes.text();
      console.warn("ai-lexical: Supabase RPC failed:", rpcRes.status, txt.slice(0, 300));
      return NextResponse.json(
        { similar: [], total: 0, source: "lexical", reason: "supabase_error" },
        { headers: CORS_HEADERS }
      );
    }

    const rows: LexicalTask[] = await rpcRes.json();

    if (!Array.isArray(rows)) {
      return NextResponse.json(
        { similar: [], total: 0, source: "lexical", reason: "bad_response" },
        { headers: CORS_HEADERS }
      );
    }

    const similar = rows.map((row: any) => ({
      id: String(row.id),
      title: row.title || `Задача #${row.id}`,
      url: `https://1c-cms.bitrix24.ru/company/personal/user/${row.responsible_id || 116}/tasks/task/view/${row.id}/`,
      responsible: row.responsible_name || "",
      status: row.status_label || row.status || "",
      project_name: row.project_name || "",
      similarity: row.similarity || 0,
      description: (row.description || "").slice(0, 500),
      created_at: row.created_at || null,
      match_type: "lexical" as const,
      match_kind: row.match_kind || "trgm",
    }));

    return NextResponse.json(
      {
        similar,
        total: similar.length,
        source: "lexical",
        query_text: text.slice(0, 200),
      },
      { headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error("AI lexical error:", error);
    return NextResponse.json(
      {
        similar: [],
        total: 0,
        source: "lexical",
        reason: "exception",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
