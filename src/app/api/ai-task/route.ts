import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { prompt } = await req.json();

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "API ключ не настроен. Добавь OPENROUTER_API_KEY в переменные окружения Vercel." },
        { status: 500 }
      );
    }

    const today = new Date().toISOString().split("T")[0];

    const systemPrompt = `Ты — ассистент по постановке задач в проектной системе. Из описания задачи извлеки следующие поля и верни строго JSON:

{
  "title": "краткое название задачи (до 255 символов)",
  "developer": "имя разработчика из списка или null если не указан",
  "deadline": "дедлайн в формате YYYY-MM-DD или null",
  "goal": "цель задачи — зачем это делаем",
  "todo": "что нужно сделать — список шагов",
  "acceptance": "критерии приёмки — как проверяем",
  "materials": "ссылки на материалы или null",
  "project": "имя проекта из списка или null если не указан"
}

Доступные разработчики: Константин, Александр, Саша, Тимур, Елена, Ольга, Марина, Тест
Доступные проекты: Backlog, Бигап, Дакар, Иванов, Медицина КЗ, Живое пиво, ВДЛ, Белолапотко, ИТ Контроль, Нейс Юг, Самокаты, МАРКЕТДЖЕТ, Керамика, ОПТИМАПЛАСТ

Важные правила:
- Дедлайн: если указан относительный срок (например "через 3 дня"), вычисли от сегодняшней даты. Сегодня: ${today}
- Если разработчик не указан явно, но есть контекст — выбери подходящего
- Если проект не указан, используй "Backlog"
- Все текстовые поля заполни на русском языке
- Для поля "todo" сделай детальный пошаговый список
- Для "acceptance" пропиши конкретные проверяемые критерии

ВАЖНО: Верни ТОЛЬКО JSON без markdown-обёрток, без \`\`\`json и без пояснений.`;

    // Модели для fallback — deepseek работает надёжнее всего
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
                { role: "user", content: prompt },
              ],
              temperature: 0.3,
              max_tokens: 2048,
            }),
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          lastError = `${model}: ${response.status} — ${errorText}`;
          console.warn(`OpenRouter ${model} failed:`, response.status, errorText);
          continue;
        }

        const data = await response.json();
        content = data.choices?.[0]?.message?.content;

        if (content) {
          console.log(`OpenRouter success with model: ${model}`);
          break;
        }
      } catch (err) {
        lastError = `${model}: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`OpenRouter ${model} error:`, err);
      }
    }

    if (!content) {
      console.error("All OpenRouter models failed:", lastError);
      return NextResponse.json(
        { error: "ИИ недоступен. Попробуй позже.", details: lastError },
        { status: 502 }
      );
    }

    // Strip markdown code blocks if present
    let cleaned = content.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    try {
      const parsed = JSON.parse(cleaned);
      const result = {
        title: typeof parsed.title === "string" ? parsed.title.slice(0, 255) : "",
        developer: parsed.developer || null,
        deadline: parsed.deadline || null,
        goal: parsed.goal || "",
        todo: parsed.todo || "",
        acceptance: parsed.acceptance || "",
        materials: parsed.materials || null,
        project: parsed.project || "Backlog",
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
    console.error("AI task generation error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
