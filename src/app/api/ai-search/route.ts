import { NextRequest, NextResponse } from "next/server";

const BITRIX24_WEBHOOK = process.env.BITRIX24_WEBHOOK || "";

// Маппинг статусов задач
const STATUS_MAP: Record<string, string> = {
  "-1": "Просрочена",
  "-2": "Отклонена",
  "-3": "Ждёт контроля",
  "1": "Новая",
  "2": "В работе",
  "3": "Ожидает",
  "4": "Завершена",
  "5": "Отложена",
  "6": "Принята",
  "7": "На проверке",
};

// Паттерны для исключения системных/автоматических задач
const EXCLUDE_PATTERNS = [
  /^Просроченные задачи на/i,
  /^Автоматические продления/i,
];

interface BitrixTask {
  id: string;
  title: string;
  status: string;
  responsibleId: string;
  responsibleName: string;
  changedDate: string;
}

export async function POST(req: NextRequest) {
  try {
    const { keywords, text } = await req.json();

    if (!keywords && !text) {
      return NextResponse.json({ error: "Нужны keywords или text" }, { status: 400 });
    }

    if (!BITRIX24_WEBHOOK) {
      return NextResponse.json({ error: "Bitrix24 webhook не настроен" }, { status: 500 });
    }

    // Извлечь ключевые слова если передан только текст
    let searchTerms: string[] = keywords || [];
    if (!searchTerms.length && text) {
      searchTerms = text
        .split(/[\s,.;:!?()]+/)
        .filter((w: string) => w.length > 3)
        .slice(0, 5);
    }

    if (searchTerms.length === 0) {
      return NextResponse.json({ similar: [], total: 0, usedKeywords: [] });
    }

    // Стратегия: SEARCH_INDEX — полнотекстовый поиск Bitrix24
    // Сначала по мульти-словным фразам (точнее), потом по одиночным словам (шире)
    const phraseTerms = searchTerms.filter((t: string) => t.includes(" ")).slice(0, 3);
    const singleWords = searchTerms
      .filter((t: string) => !t.includes(" "))
      .slice(0, 4);

    // Фразы первыми — они дают более точные результаты
    const allSearchTerms = [...phraseTerms, ...singleWords].slice(0, 7);

    const allTasks = new Map<string, BitrixTask & { matchCount: number }>();
    const usedKeywords: string[] = [];

    for (const term of allSearchTerms) {
      try {
        const url = `${BITRIX24_WEBHOOK}tasks.task.list`;
        const body = {
          order: { CHANGED_DATE: "desc" },
          filter: {
            // SEARCH_INDEX — полнотекстовый поиск по заголовку + описанию
            SEARCH_INDEX: term,
          },
          select: [
            "ID", "TITLE", "STATUS",
            "RESPONSIBLE_ID", "CHANGED_DATE",
          ],
          params: { NAV_PARAMS: { nPageSize: 20 } },
        };

        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          console.warn(`Bitrix24 SEARCH_INDEX failed for "${term}":`, response.status);
          continue;
        }

        const data = await response.json();
        const tasks = data?.result?.tasks || [];

        if (tasks.length > 0) {
          usedKeywords.push(term);
        }

        for (const task of tasks) {
          const taskId = String(task.id || task.ID);
          if (!taskId) continue;

          // Пропускать системные/автоматические задачи
          const taskTitle = task.title || task.TITLE || "";
          if (EXCLUDE_PATTERNS.some((p) => p.test(taskTitle))) continue;

          if (allTasks.has(taskId)) {
            const existing = allTasks.get(taskId)!;
            existing.matchCount += 1;
            continue;
          }

          // Использовать responsible.name из API, fallback на ID
          const respObj = task.responsible || {};
          const respName =
            respObj.name ||
            (respObj.lastName && respObj.firstName
              ? `${respObj.lastName} ${respObj.firstName}`
              : "");

          allTasks.set(taskId, {
            id: taskId,
            title: taskTitle || "Без названия",
            status: String(task.status || task.STATUS || ""),
            responsibleId: String(task.responsibleId || task.RESPONSIBLE_ID || ""),
            responsibleName: respName || `User #${task.responsibleId || task.RESPONSIBLE_ID || "?"}`,
            changedDate: task.changedDate || task.CHANGED_DATE || "",
            matchCount: 1,
          });
        }
      } catch (err) {
        console.warn(`Bitrix24 search error for SEARCH_INDEX "${term}":`, err);
      }
    }

    // Сортировать: сначала по релевантности (matchCount desc), потом по дате
    const similar = Array.from(allTasks.values())
      .sort((a, b) => {
        if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
        return (b.changedDate || "").localeCompare(a.changedDate || "");
      })
      .slice(0, 10)
      .map((task) => ({
        id: task.id,
        title: task.title,
        url: `https://1c-cms.bitrix24.ru/company/personal/user/${task.responsibleId || "116"}/tasks/task/view/${task.id}/`,
        responsible: task.responsibleName,
        status: STATUS_MAP[task.status] || `Статус ${task.status}`,
        changedDate: task.changedDate,
      }));

    return NextResponse.json({ similar, total: similar.length, usedKeywords });
  } catch (error) {
    console.error("AI search error:", error);
    return NextResponse.json({ error: "Ошибка поиска задач" }, { status: 500 });
  }
}
