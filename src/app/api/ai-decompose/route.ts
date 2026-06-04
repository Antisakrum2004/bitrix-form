import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return NextResponse.json({ error: "Текст запроса обязателен" }, { status: 400 });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "API ключ OpenRouter не настроен" },
        { status: 500 }
      );
    }

    const systemPrompt = `Ты — ассистент для декомпозиции запросов в задачи проекта.
На входе — текст запроса из чата (обычно от менеджера или клиента).
На выходе — строго JSON без markdown-обёрток:

{
  "title": "Краткое название задачи",
  "body": "Описание что нужно сделать",
  "original": "Оригинальный текст без изменений",
  "keywords": ["фраза1", "слово2"]
}

Правила:
1. title — конкретное название задачи (до 100 символов, без точки в конце)
2. body — структурированное описание с ПУСТЫМИ СТРОКАМИ между блоками:
   - Каждый логический блок отделяй пустой строкой (\\n\\n)
   - Формат: краткая суть → что нужно сделать → детали
   - Пример: "Необходимо доработать обработку.\\n\\nРеализовать поиск контрагента только по ИНН.\\n\\nЕсли ИНН отсутствует — оставить стандартный поиск."
   - НЕ добавляй оригинал запроса внутрь body — он пойдёт отдельным полем
3. original — оригинальный текст запроса без изменений
4. keywords — 3-5 ключевых слов И фраз для поиска аналогичных задач в Bitrix24.
   Обязательно включи 2-3 КОРОТКИЕ ФРАЗЫ (2-3 слова) из оригинального текста — по ним будет идти полнотекстовый поиск.
   Фразы должны быть в том же падеже и форме, что в тексте — это важно для поиска!
   Остальные — одиночные существительные.
   ПРАВИЛЬНО: ["Клиент банк", "поиск контрагента", "ИНН", "контрагент"]
   ПРАВИЛЬНО: ["серийный номер", "пробитие", "счётчик"]
   НЕПРАВИЛЬНО: ["поиск контрагента только по ИНН"] (слишком длинная фраза)
   НЕПРАВИЛЬНО: ["обработка", "бухгалтерия"] (только одиночные слова без фраз)
5. Всё на русском языке
6. Верни ТОЛЬКО JSON без \`\`\`json и без пояснений`;

    const models = [
      "deepseek/deepseek-chat",
      "google/gemini-2.5-flash",
      "openai/gpt-4o-mini",
      "anthropic/claude-3.5-haiku",
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
                { role: "user", content: text },
              ],
              temperature: 0.3,
              max_tokens: 1024,
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
          console.log(`ai-decompose success with model: ${model}`);
          break;
        }
      } catch (err) {
        lastError = `${model}: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`OpenRouter ${model} error:`, err);
      }
    }

    if (!content) {
      return NextResponse.json(
        { error: "ИИ недоступен. Попробуй позже.", details: lastError },
        { status: 502 }
      );
    }

    // Strip markdown code blocks
    let cleaned = content.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    try {
      const parsed = JSON.parse(cleaned);

      // Сформировать тело задачи: описание + отдельный блок оригинала как цитата
      const bodyText = parsed.body || "";
      const originalText = parsed.original || text;
      // BBCode-цитата для Bitrix24 (отобразится как блок-цитата в описании задачи)
      const fullBody = `${bodyText}\n\n[QUOTE]оригинал запроса:\n${originalText}[/QUOTE]`;

      const result = {
        title: typeof parsed.title === "string" ? parsed.title.slice(0, 255) : "",
        body: typeof parsed.body === "string" ? parsed.body : "",
        fullBody, // body + оригинал в BBCode-цитате — для заполнения в форму
        original: originalText,
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 5) : [],
      };
      return NextResponse.json(result);
    } catch {
      console.error("Failed to parse AI response:", cleaned);
      return NextResponse.json(
        { error: "ИИ вернул неверный формат. Попробуй переформулировать.", raw: cleaned },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("AI decompose error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
