const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        AlignmentType, HeadingLevel, BorderStyle, ShadingType, WidthType,
        Header, Footer, PageNumber, PageBreak } = require("docx");
const fs = require("fs");

const P = { primary: "#101820", body: "#182030", secondary: "#506070", accent: "#8090A0", surface: "#F2F4F6" };
const c = (hex) => hex.replace("#", "");

const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const allNoBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };

function heading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({
    heading: level,
    spacing: { before: level === HeadingLevel.HEADING_1 ? 360 : 240, after: 120 },
    children: [new TextRun({ text, bold: true, color: c(P.primary), font: { ascii: "Calibri", eastAsia: "SimHei" } })]
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 420 },
    spacing: { line: 312, after: 80 },
    ...opts,
    children: [new TextRun({ text, size: 24, color: c(P.body), font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" } })]
  });
}

function bodyNoIndent(text) {
  return body(text, { indent: {} });
}

function boldBody(label, text) {
  return new Paragraph({
    spacing: { line: 312, after: 60 },
    children: [
      new TextRun({ text: label, bold: true, size: 24, color: c(P.primary), font: { ascii: "Calibri", eastAsia: "SimHei" } }),
      new TextRun({ text, size: 24, color: c(P.body), font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" } })
    ]
  });
}

function codeBlock(text) {
  return new Paragraph({
    spacing: { line: 280, after: 60 },
    indent: { left: 480 },
    children: [new TextRun({ text, size: 20, color: c("B04040"), font: { ascii: "JetBrains Mono", eastAsia: "Microsoft YaHei" } })]
  });
}

function makeCell(text, opts = {}) {
  const { bold = false, bg = null, headerText = null } = opts;
  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({
        text,
        bold,
        size: 20,
        color: c(headerText || P.body),
        font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" }
      })]
    })],
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
    shading: bg ? { type: ShadingType.CLEAR, fill: bg } : undefined,
  });
}

const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" }, size: 24, color: c(P.body) },
        paragraph: { spacing: { line: 312 } },
      },
      heading1: {
        run: { font: { ascii: "Calibri", eastAsia: "SimHei" }, size: 32, bold: true, color: c(P.primary) },
      },
      heading2: {
        run: { font: { ascii: "Calibri", eastAsia: "SimHei" }, size: 28, bold: true, color: c(P.primary) },
      },
    },
  },
  sections: [
    {
      properties: {
        page: { margin: { top: 1440, bottom: 1440, left: 1701, right: 1417 } },
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: "Bitrix24 Tasks \u2014 Протокол тестирования v7.14  |  Стр. ", size: 16, color: c(P.secondary) }),
              new TextRun({ children: [PageNumber.CURRENT], size: 16, color: c(P.secondary) }),
            ]
          })]
        })
      },
      children: [
        // Title
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { after: 80 },
          children: [new TextRun({ text: "ПРОТОКОЛ ТЕСТИРОВАНИЯ", size: 36, bold: true, color: c(P.primary), font: { ascii: "Calibri", eastAsia: "SimHei" } })]
        }),
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { after: 300 },
          children: [new TextRun({ text: "Bitrix24 Tasks \u2014 Форма создания задач", size: 26, color: c(P.secondary), font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" } })]
        }),

        // Meta table
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 2, color: c(P.accent) },
            bottom: { style: BorderStyle.SINGLE, size: 2, color: c(P.accent) },
            left: { style: BorderStyle.NONE },
            right: { style: BorderStyle.NONE },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "D0D0D0" },
            insideVertical: { style: BorderStyle.NONE },
          },
          rows: [
            new TableRow({ children: [makeCell("Версия", { bold: true, bg: P.surface }), makeCell("v7.14.1", {})] }),
            new TableRow({ children: [makeCell("Дата", { bold: true, bg: P.surface }), makeCell("27.05.2026", {})] }),
            new TableRow({ children: [makeCell("Компонент", { bold: true, bg: P.surface }), makeCell("Наблюдатели + EOD-комментарий", {})] }),
            new TableRow({ children: [makeCell("Тип бага", { bold: true, bg: P.surface }), makeCell("Логическая ошибка \u2014 перетирание данных API", {})] }),
            new TableRow({ children: [makeCell("Серьёзность", { bold: true, bg: P.surface }), makeCell("High \u2014 данные наблюдателя теряются", {})] }),
            new TableRow({ children: [makeCell("Статус", { bold: true, bg: P.surface }), makeCell("Исправлено (v7.14.1)", {})] }),
          ],
        }),

        new Paragraph({ spacing: { before: 400 }, children: [] }),

        // 1. Описание ошибки
        heading("1. Описание ошибки", HeadingLevel.HEADING_1),

        body("При создании задачи в Bitrix24 через форму, если пользователь выбирал наблюдателя (например, Андрея \u2014 ID 116 или Владимира \u2014 ID 1) и при этом стояла галочка EOD, в итоговой задаче наблюдателем оказывался только бот \u00ABАйти Лаб Bot\u00BB (ID 154). Человек-наблюдатель, выбранный через чип в форме, пропадал из задачи. Это критическая логическая ошибка \u2014 данные, которые пользователь явно указал в интерфейсе, терялись при отправке API-запроса, и пользователь не получал никакого уведомления о потере данных."),

        body("Ошибка затрагивала все сценарии, где EOD-галка включена одновременно с выбранным наблюдателем-человеком. Поскольку EOD включена по умолчанию, а наблюдатель \u2014 обязательный элемент для большинства задач, баг проявлялся практически при каждом создании задачи, делая выбор наблюдателя в форме бессмысленным \u2014 человек всё равно не попадал в итоговую задачу в Bitrix24."),

        // 2. Корневая причина
        heading("2. Корневая причина", HeadingLevel.HEADING_1),

        body("Функция addObserver() в файле index.html использует для добавления наблюдателя метод tasks.task.update с полем AUDITORS. Проблема в том, что AUDITORS в Bitrix24 REST API работает в режиме полной замены (replace), а не добавления (append). Когда передаётся AUDITORS: [116], API устанавливает список наблюдателей задачи ровно в [116] \u2014 затирая любых наблюдателей, которые уже были. Если затем вызвать AUDITORS: [154], API заменит весь список на [154], и предыдущий наблюдатель (116) исчезнет."),

        body("Порядок вызовов в handleSubmit() был следующим:"),

        codeBlock("\u0428\u0430\u0433 1: addObserver(hook, tid, selectedObsId)"),
        codeBlock("       \u2192 tasks.task.update { AUDITORS: [116] }  \u2714 \u0410\u043d\u0434\u0440\u0435\u0439 \u043d\u0430\u0431\u043b\u044e\u0434\u0430\u0442\u0435\u043b\u044c"),
        codeBlock(""),
        codeBlock("\u0428\u0430\u0433 2: addObserver(hook, tid, '154')  // EOD \u2014 \u0434\u043e\u0431\u0430\u0432\u043b\u044f\u0435\u043c \u0431\u043e\u0442\u0430"),
        codeBlock("       \u2192 tasks.task.update { AUDITORS: [154] }  \u274c \u041f\u0415\u0420\u0415\u0417\u0410\u041f\u0418\u0421\u042c! \u0422\u043e\u043b\u044c\u043a\u043e \u0431\u043e\u0442"),

        body("Второй вызов полностью затирал список наблюдателей, установленный первым вызовом. Это классическая ошибка при работе с API, которые используют семантику replace вместо append. Разработчик предполагал, что каждый вызов addObserver добавляет нового наблюдателя к уже существующим, но на деле каждый вызов устанавливал полный список заново."),

        // 3. Условия воспроизведения
        heading("3. Условия воспроизведения", HeadingLevel.HEADING_1),

        body("Для воспроизведения ошибки необходимо выполнение двух условий одновременно:"),

        boldBody("Условие 1: ", "Выбран наблюдатель-человек (АМ или ВМ) через чип в карточке \u00ABКоманда\u00BB. Это устанавливает selectedObsId в значение \u00AB11\u00BB или \u00AB1\u00BB."),

        boldBody("Условие 2: ", "Включена галочка EOD (по умолчанию она включена). Это приводит к вызову addObserver с userId=154 для добавления бота как наблюдателя."),

        body("Если оба условия выполнены, последовательность API-вызовов приводит к перетиранию. Если EOD выключен \u2014 баг не проявляется, потому что второй вызов addObserver не происходит. Если наблюдатель не выбран \u2014 первый вызов addObserver не происходит, и бот добавляется корректно как единственный наблюдатель."),

        // 4. Пошаговое воспроизведение
        heading("4. Пошаговое воспроизведение", HeadingLevel.HEADING_1),

        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 2, color: c(P.accent) },
            bottom: { style: BorderStyle.SINGLE, size: 2, color: c(P.accent) },
            left: { style: BorderStyle.NONE },
            right: { style: BorderStyle.NONE },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "D0D0D0" },
            insideVertical: { style: BorderStyle.NONE },
          },
          rows: [
            new TableRow({
              children: [
                makeCell("\u0428\u0430\u0433", { bold: true, bg: P.surface }),
                makeCell("\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u0435", { bold: true, bg: P.surface }),
                makeCell("\u0420\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442", { bold: true, bg: P.surface }),
              ]
            }),
            new TableRow({ children: [makeCell("1"), makeCell("\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u0444\u043e\u0440\u043c\u0443, \u0432\u0432\u0435\u0441\u0442\u0438 \u0432\u0435\u0431\u0445\u0443\u043a"), makeCell("\u0424\u043e\u0440\u043c\u0430 \u0433\u043e\u0442\u043e\u0432\u0430 \u043a \u0440\u0430\u0431\u043e\u0442\u0435")] }),
            new TableRow({ children: [makeCell("2"), makeCell("\u0417\u0430\u043f\u043e\u043b\u043d\u0438\u0442\u044c \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u0437\u0430\u0434\u0430\u0447\u0438"), makeCell("\u041e\u0431\u044f\u0437\u0430\u0442\u0435\u043b\u044c\u043d\u043e\u0435 \u043f\u043e\u043b\u0435 \u0437\u0430\u043f\u043e\u043b\u043d\u0435\u043d\u043e")] }),
            new TableRow({ children: [makeCell("3"), makeCell("\u0412\u044b\u0431\u0440\u0430\u0442\u044c \u0440\u0430\u0437\u0440\u0430\u0431\u043e\u0442\u0447\u0438\u043a\u0430"), makeCell("selectedDevId = 18")] }),
            new TableRow({ children: [makeCell("4"), makeCell("\u0412\u044b\u0431\u0440\u0430\u0442\u044c \u043f\u043e\u0441\u0442\u0430\u043d\u043e\u0432\u0449\u0438\u043a\u0430 \u0410\u041c"), makeCell("selectedMgrId = 116")] }),
            new TableRow({ children: [makeCell("5"), makeCell("\u0412\u044b\u0431\u0440\u0430\u0442\u044c \u043d\u0430\u0431\u043b\u044e\u0434\u0430\u0442\u0435\u043b\u044f \u0410\u041c"), makeCell("selectedObsId = 116")] }),
            new TableRow({ children: [makeCell("6"), makeCell("EOD \u0433\u0430\u043b\u043a\u0430 \u0432\u043a\u043b\u044e\u0447\u0435\u043d\u0430 (\u043f\u043e \u0443\u043c\u043e\u043b\u0447\u0430\u043d\u0438\u044e)"), makeCell("eodCheck = true")] }),
            new TableRow({ children: [makeCell("7"), makeCell("\u0412\u044b\u0431\u0440\u0430\u0442\u044c \u043f\u0440\u043e\u0435\u043a\u0442"), makeCell("selectedProjId = 6")] }),
            new TableRow({ children: [makeCell("8"), makeCell("\u041d\u0430\u0436\u0430\u0442\u044c \u00ab\u0421\u043e\u0437\u0434\u0430\u0442\u044c \u0437\u0430\u0434\u0430\u0447\u0443\u00bb"), makeCell("\u0417\u0430\u0434\u0430\u0447\u0430 \u0441\u043e\u0437\u0434\u0430\u043d\u0430")] }),
            new TableRow({ children: [makeCell("9"), makeCell("\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u0437\u0430\u0434\u0430\u0447\u0443 \u0432 Bitrix24"), makeCell("\u041d\u0430\u0431\u043b\u044e\u0434\u0430\u0442\u0435\u043b\u044c: \u0442\u043e\u043b\u044c\u043a\u043e \u0431\u043e\u0442! \u0410\u043d\u0434\u0440\u0435\u0439 \u043f\u0440\u043e\u043f\u0430\u043b")] }),
          ]
        }),

        // 5. Как возникла ошибка
        heading("5. Как возникла ошибка", HeadingLevel.HEADING_1),

        body("Ошибка возникла на этапе проектирования архитектуры EOD-функционала в версии v7.9. Когда было принято решение использовать отдельный вебхук бота (ID 154) для отправки EOD-комментариев, возникла дополнительная задача: бот должен быть наблюдателем задачи, иначе Bitrix24 не позволит ему оставить комментарий (возвращает \u00ABНедостаточно прав\u00BB)."),

        body("Разработчик добавил вызов addObserver(hook, tid, '154') после основного addObserver для наблюдателя-человека, не учтя, что Bitrix24 API работает в режиме replace. Это типичная ошибка при работе с API, которые не документируют явно семантику полей (append vs replace)."),

        body("Почему ошибка не была обнаружена сразу при тестировании: при ручной проверке в Bitrix24 наблюдатель отображается в задаче, но без детального сравнения списка до и после трудно заметить, что один из наблюдателей пропал. Бот как наблюдатель виден в задаче, и создатель формы не проверял, что выбранный им человек-наблюдатель также присутствует. Только при систематическом тестировании \u2014 сравнении ожидаемого списка наблюдателей с фактическим \u2014 ошибка становится очевидной."),

        // 6. Внесённые исправления
        heading("6. Внесённые исправления", HeadingLevel.HEADING_1),

        heading("6.1. Пакетное добавление наблюдателей", HeadingLevel.HEADING_2),

        body("Вместо двух последовательных вызовов addObserver() с разными userId, теперь все ID наблюдателей собираются в один массив и отправляются одним API-запросом. Новая функция addObserversBatch() формирует один вызов tasks.task.update с AUDITORS: [116, 154], что корректно устанавливает обоих наблюдателей без перетирания."),

        boldBody("Было (v7.13):", ""),
        codeBlock("addObserver(hook, tid, selectedObsId)  // AUDITORS: [116]"),
        codeBlock("addObserver(hook, tid, '154')          // AUDITORS: [154] \u2192 \u041f\u0415\u0420\u0415\u0417\u0410\u041f\u0418\u0421\u042c!"),

        boldBody("Стало (v7.14):", ""),
        codeBlock("const observerIds = [];"),
        codeBlock("if (selectedObsId) observerIds.push(parseInt(selectedObsId));"),
        codeBlock("if (eodOn) observerIds.push(154);"),
        codeBlock("addObserversBatch(hook, tid, observerIds)"),
        codeBlock("  // AUDITORS: [116, 154] \u2192 \u041e\u0431\u0430 \u043d\u0430\u0431\u043b\u044e\u0434\u0430\u0442\u0435\u043b\u044f \u2714"),

        heading("6.2. Фоллбэк для единичного добавления", HeadingLevel.HEADING_2),

        body("Старая функция addObserver() переименована в addObserverSingle() и используется как фоллбэк внутри addObserversBatch(), если основной запрос tasks.task.update завершается неудачей. Это сохраняет совместимость с предыдущими сценариями, когда добавление наблюдателя работает через альтернативные эндпоинты (task.observers.add и т.д.)."),

        heading("6.3. Логика выбора наблюдателя", HeadingLevel.HEADING_2),

        body("Постановщик и наблюдатель остаются полностью независимыми блоками выбора. Пользователь выбирает каждого из них вручную через чипы. Никакого автоматического связывания между постановщиком и наблюдателем не введено \u2014 это было бы неверным решением, нарушающим принцип явного управления пользователем."),

        // 7. Результаты тестирования
        heading("7. Результаты тестирования после исправления", HeadingLevel.HEADING_1),

        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 2, color: c(P.accent) },
            bottom: { style: BorderStyle.SINGLE, size: 2, color: c(P.accent) },
            left: { style: BorderStyle.NONE },
            right: { style: BorderStyle.NONE },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "D0D0D0" },
            insideVertical: { style: BorderStyle.NONE },
          },
          rows: [
            new TableRow({
              children: [
                makeCell("\u0421\u0446\u0435\u043d\u0430\u0440\u0438\u0439", { bold: true, bg: P.surface }),
                makeCell("\u041e\u0436\u0438\u0434\u0430\u043d\u0438\u0435", { bold: true, bg: P.surface }),
                makeCell("\u0424\u0430\u043a\u0442 v7.14", { bold: true, bg: P.surface }),
                makeCell("\u0421\u0442\u0430\u0442\u0443\u0441", { bold: true, bg: P.surface }),
              ]
            }),
            new TableRow({ children: [
              makeCell("\u041d\u0430\u0431\u043b.\u0410\u041c + EOD \u0432\u043a\u043b"),
              makeCell("\u0410\u041c (116) + \u0411\u043e\u0442 (154)"),
              makeCell("\u0410\u041c (116) + \u0411\u043e\u0442 (154)"),
              makeCell("PASS"),
            ]}),
            new TableRow({ children: [
              makeCell("\u041d\u0430\u0431\u043b.\u0412\u041c + EOD \u0432\u043a\u043b"),
              makeCell("\u0412\u041c (1) + \u0411\u043e\u0442 (154)"),
              makeCell("\u0412\u041c (1) + \u0411\u043e\u0442 (154)"),
              makeCell("PASS"),
            ]}),
            new TableRow({ children: [
              makeCell("\u0411\u0435\u0437 \u043d\u0430\u0431\u043b. + EOD \u0432\u043a\u043b"),
              makeCell("\u0422\u043e\u043b\u044c\u043a\u043e \u0411\u043e\u0442 (154)"),
              makeCell("\u0422\u043e\u043b\u044c\u043a\u043e \u0411\u043e\u0442 (154)"),
              makeCell("PASS"),
            ]}),
            new TableRow({ children: [
              makeCell("\u041d\u0430\u0431\u043b.\u0410\u041c + EOD \u0432\u044b\u043a\u043b"),
              makeCell("\u0422\u043e\u043b\u044c\u043a\u043e \u0410\u041c (116)"),
              makeCell("\u0422\u043e\u043b\u044c\u043a\u043e \u0410\u041c (116)"),
              makeCell("PASS"),
            ]}),
            new TableRow({ children: [
              makeCell("\u0411\u0435\u0437 \u043d\u0430\u0431\u043b. + EOD \u0432\u044b\u043a\u043b"),
              makeCell("\u0411\u0435\u0437 \u043d\u0430\u0431\u043b\u044e\u0434\u0430\u0442\u0435\u043b\u0435\u0439"),
              makeCell("\u0411\u0435\u0437 \u043d\u0430\u0431\u043b\u044e\u0434\u0430\u0442\u0435\u043b\u0435\u0439"),
              makeCell("PASS"),
            ]}),
            new TableRow({ children: [
              makeCell("\u041f\u043e\u0441\u0442\u0430\u043d\u043e\u0432\u0449\u0438\u043a \u0410\u041c, \u043d\u0430\u0431\u043b. \u0412\u041c"),
              makeCell("\u041d\u0435\u0437\u0430\u0432\u0438\u0441\u0438\u043c\u044b\u0439 \u0432\u044b\u0431\u043e\u0440"),
              makeCell("\u041d\u0435\u0437\u0430\u0432\u0438\u0441\u0438\u043c\u044b\u0439 \u0432\u044b\u0431\u043e\u0440"),
              makeCell("PASS"),
            ]}),
          ]
        }),

        // 8. Выводы
        heading("8. Выводы и рекомендации", HeadingLevel.HEADING_1),

        body("Исправление полностью устраняет баг перетирания наблюдателей. Все сценарии выбора наблюдателя и EOD теперь работают корректно. Основной урок: при работе с Bitrix24 REST API поле AUDITORS в методе tasks.task.update работает в режиме replace, а не append. Для добавления нескольких наблюдателей необходимо передавать полный список в одном запросе."),

        body("Рекомендации для будущей разработки: (1) всегда проверять семантику полей API (replace vs append) перед последовательными вызовами; (2) добавлять интеграционные тесты, которые проверяют итоговое состояние задачи в Bitrix24, а не только успешность API-вызовов; (3) при множественных модификациях одной сущности группировать изменения в один запрос, чтобы избежать промежуточных состояний, приводящих к потере данных."),
      ]
    }
  ]
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync("/home/z/my-project/download/protocol-v7.14-observer-bug.docx", buf);
  console.log("Document saved successfully");
});
