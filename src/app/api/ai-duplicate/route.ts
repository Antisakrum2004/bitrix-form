import { NextRequest, NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://antisakrum2004.github.io",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  try {
    const { title, body, similarTasks } = await req.json();

    if (!title || !similarTasks || !similarTasks.length) {
      return NextResponse.json(
        { hasDuplicates: false, duplicates: [] },
        { headers: CORS_HEADERS }
      );
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "API ключ OpenRouter не настроен" },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const tasksSummary = similarTasks
      .map(
        (t: { id: string; title: string; responsible: string; status: string }) =>
          `#${t.id}: "${t.title}" (${t.responsible}, ${t.status})`
      )
      .join("\n");

    const systemPrompt = `Ты — ассистент для определения дублей задач в Bitrix24.
На входе — название новой задачи, её описание и список похожих существующих задач.
На выходе — строго JSON без markdown-обёрток:

{
  "hasDuplicates": true/false,
  "duplicates": [
    {
      "id": "ID задачи",
      "reason": "Краткая причина почему это дубль",
      "similarity": 0.9
    }
  ]
}

Правила:
1. hasDuplicates=true ТОЛЬКО если есть задача, которая является РЕАЛЬНЫМ дублем (та же работа, не просто похожая)
2. similarity — от 0.0 до 1.0, насколько уверены что это дубль
3. Включай только задачи с similarity >= 0.7
4. reason — коротко, почему считаешь дублем
5. Если нет реальных дублей — hasDuplicates=false, duplicates=[]
6. Всё на русском языке
7. Верни ТОЛЬКО JSON без \`\`\`json и без пояснений`;

    const models = [
      "deepseek/deepseek-chat",
      "google/gemini-2.5-flash",
      "openai/gpt-4o-mini",
    ];

    let content: string | null = null;
    let lastError = "";

    for (const model of models) {
      try {
        const response = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: systemPrompt },
                {
                  role: "user",
                  content: `Новая задача: "${title}"\nОписание: ${body || "нет"}\n\nПохожие задачи:\n${tasksSummary}`,
                },
              ],
              temperature: 0.2,
              max_tokens: 512,
            }),
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          lastError = `${model}: ${response.status} — ${errorText}`;
          console.warn(`OpenRouter ${model} failed:`, response.status);
          continue;
        }

        const data = await response.json();
        content = data.choices?.[0]?.message?.content;

        if (content) {
          console.log(`ai-duplicate success with model: ${model}`);
          break;
        }
      } catch (err) {
        lastError = `${model}: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`OpenRouter ${model} error:`, err);
      }
    }

    if (!content) {
      return NextResponse.json(
        { hasDuplicates: false, duplicates: [] },
        { headers: CORS_HEADERS }
      );
    }

    // Strip markdown code blocks
    let cleaned = content.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned
        .replace(/^```(?:json)?\s*\n?/, "")
        .replace(/\n?```\s*$/, "");
    }

    try {
      const parsed = JSON.parse(cleaned);

      // Enrich duplicates with original task data (url, title etc.)
      const duplicates = (parsed.duplicates || []).map(
        (dup: { id: string; reason: string; similarity: number }) => {
          const original = similarTasks.find(
            (t: { id: string }) => String(t.id) === String(dup.id)
          );
          return {
            id: dup.id,
            title: original?.title || `Задача #${dup.id}`,
            url: original?.url || "",
            responsible: original?.responsible || "",
            status: original?.status || "",
            reason: dup.reason || "",
            similarity: dup.similarity || 0,
          };
        }
      );

      return NextResponse.json(
        {
          hasDuplicates: !!parsed.hasDuplicates && duplicates.length > 0,
          duplicates,
        },
        { headers: CORS_HEADERS }
      );
    } catch {
      console.error("Failed to parse duplicate AI response:", cleaned);
      return NextResponse.json(
        { hasDuplicates: false, duplicates: [] },
        { headers: CORS_HEADERS }
      );
    }
  } catch (error) {
    console.error("AI duplicate error:", error);
    return NextResponse.json(
      { error: "Внутренняя ошибка сервера" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
