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
 * POST /api/ai-search-all
 * Body: { text: string, threshold?: number, limit?: number }
 *
 * v7.28.9 — ОДИН endpoint для всего поиска:
 *   1. /ai-similar (семантика по tasks)
 *   2. /ai-lexical (точные слова в tasks)
 *   3. /ai-meetings (семантика по meetings)
 *
 * Один cold start вместо 3, embedding переиспользуется (один запрос к OpenRouter
 * для /ai-similar и /ai-meetings).
 */
export async function POST(req: NextRequest) {
  try {
    const { text, threshold = 0.4, limit = 20 } = await req.json();

    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json(
        { similar: [], lexical: [], meetings: [], reason: "empty_query" },
        { headers: CORS_HEADERS }
      );
    }

    const openaiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
    const supaUrl = process.env.SUPABASE_URL || "https://nopccnooivztriqdkbie.supabase.co";
    const supaKey = process.env.SUPABASE_SERVICE_KEY;

    if (!openaiKey || !supaKey) {
      return NextResponse.json(
        { similar: [], lexical: [], meetings: [], reason: "missing_env" },
        { headers: CORS_HEADERS }
      );
    }

    const headers = {
      "Content-Type": "application/json",
      apikey: supaKey,
      Authorization: `Bearer ${supaKey}`,
    };

    // ── 1. Embedding (один запрос к OpenRouter, переиспользуется для tasks и meetings)
    let embedding: number[] | null = null;
    try {
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
      if (embRes.ok) {
        const embData = await embRes.json();
        const emb = embData?.data?.[0]?.embedding;
        if (Array.isArray(emb) && emb.length === 1536) embedding = emb;
      }
    } catch (e) {
      console.warn("embedding failed:", e);
    }

    // ── 2. Параллельные запросы к Supabase (3 разных RPC)
    const [semRes, lexRes, meetRes] = await Promise.allSettled([
      // 2a. Семантический поиск tasks (через search_similar_tasks RPC)
      embedding
        ? fetch(`${supaUrl}/rest/v1/rpc/search_similar_tasks`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              query_embedding: embedding,
              match_threshold: threshold,
              match_count: limit,
              query_text: text.slice(0, 1000),
            }),
          }).then((r) => r.json())
        : Promise.resolve([]),

      // 2b. Лексический поиск tasks (через PostgREST ilike фильтр)
      (async () => {
        const encodedText = encodeURIComponent(text);
        const words = text.toLowerCase().split(/\s+/).filter((w: string) => w.length >= 4);
        const roots = [...new Set(words.map((w: string) => w.slice(0, 6)))];
        const rootFilters = roots.map(
          (r) => `title.ilike.*${encodeURIComponent(r)}*,description.ilike.*${encodeURIComponent(r)}*`
        );
        const allConditions = [
          `title.ilike.*${encodedText}*`,
          `description.ilike.*${encodedText}*`,
          ...rootFilters,
        ].join(",");
        const filter = `or=(${allConditions})&project_id=neq.48&limit=${
          limit * 3
        }&order=id.desc&select=id,title,description,project_id,project_name,responsible_id,responsible_name,status,status_label,created_at`;
        const r = await fetch(`${supaUrl}/rest/v1/tasks?${filter}`, { headers });
        return r.json();
      })(),

      // 2c. Семантический поиск meetings (через search_meetings RPC)
      embedding
        ? fetch(`${supaUrl}/rest/v1/rpc/search_meetings`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              query_embedding: embedding,
              match_threshold: 0.3,
              match_count: 5,
            }),
          }).then((r) => r.json())
        : Promise.resolve([]),
    ]);

    // ── 3. Обработка tasks (семантика)
    const semRows = semRes.status === "fulfilled" ? semRes.value : [];
    const similar = (Array.isArray(semRows) ? semRows : []).map((row: any) => ({
      id: String(row.id),
      title: row.title || `Задача #${row.id}`,
      url: `https://1c-cms.bitrix24.ru/company/personal/user/${
        row.responsible_id || 116
      }/tasks/task/view/${row.id}/`,
      responsible: row.responsible_name || "",
      status: row.status_label || row.status || "",
      project_name: row.project_name || "",
      similarity: row.similarity || 0,
      description: (row.description || "").slice(0, 500),
      created_at: row.created_at || null,
      match_type: "semantic" as const,
      match_kind: "semantic",
    }));

    // ── 4. Обработка tasks (лексика) — с word-root matching
    const lexRows = lexRes.status === "fulfilled" ? lexRes.value : [];
    const lowerText = text.toLowerCase();
    const words = lowerText.split(/\s+/).filter((w: string) => w.length >= 4);
    const roots = [...new Set(words.map((w: string) => w.slice(0, 6)))];

    const lexical = (Array.isArray(lexRows) ? lexRows : [])
      .map((row: any) => {
        const titleLower = (row.title || "").toLowerCase();
        const descLower = (row.description || "").toLowerCase();
        const inTitle = titleLower.includes(lowerText);
        const inDesc = descLower.includes(lowerText);

        let similarity = 0;
        let match_kind = "trgm";
        if (inTitle) {
          similarity = 1.0;
          match_kind = "phrase_title";
        } else if (inDesc) {
          similarity = 0.85;
          match_kind = "phrase_desc";
        } else {
          const rootHits = roots.filter(
            (r) => titleLower.includes(r) || descLower.includes(r)
          ).length;
          if (roots.length > 0 && rootHits === roots.length) {
            similarity = 0.7;
            match_kind = "all_words";
          } else if (rootHits >= Math.ceil(roots.length / 2)) {
            similarity = 0.5;
            match_kind = "half_words";
          } else if (rootHits > 0) {
            similarity = 0.3;
            match_kind = "single_word";
          } else {
            similarity = 0.2;
            match_kind = "trgm";
          }
        }
        return {
          id: String(row.id),
          title: row.title || `Задача #${row.id}`,
          url: `https://1c-cms.bitrix24.ru/company/personal/user/${
            row.responsible_id || 116
          }/tasks/task/view/${row.id}/`,
          responsible: row.responsible_name || "",
          status: row.status_label || row.status || "",
          project_name: row.project_name || "",
          similarity,
          description: (row.description || "").slice(0, 500),
          created_at: row.created_at || null,
          match_type: "lexical" as const,
          match_kind,
        };
      })
      .sort((a: any, b: any) => (b.similarity || 0) - (a.similarity || 0))
      .slice(0, limit);

    // ── 5. Обработка meetings
    const meetRows = meetRes.status === "fulfilled" ? meetRes.value : [];
    const meetings = (Array.isArray(meetRows) ? meetRows : []).map((row: any) => ({
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
        similar,
        lexical,
        meetings,
        total_tasks: similar.length + lexical.length,
        total_meetings: meetings.length,
        source: "combined",
        query_text: text.slice(0, 200),
        threshold,
      },
      { headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error("ai-search-all error:", error);
    return NextResponse.json(
      {
        similar: [],
        lexical: [],
        meetings: [],
        reason: "exception",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
