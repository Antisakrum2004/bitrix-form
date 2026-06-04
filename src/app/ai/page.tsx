"use client";

import { useState, useRef, useCallback, useEffect } from "react";

const APP_VERSION = "1.1.1";

interface DecomposeResult {
  title: string;
  body: string;
  fullBody: string;
  original: string;
  keywords: string[];
}

interface SimilarTask {
  id: string;
  title: string;
  url: string;
  responsible: string;
  status: string;
  changedDate: string;
}

export default function AIPage() {
  const [aiInput, setAiInput] = useState("");
  const [decomposing, setDecomposing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [decomposeResult, setDecomposeResult] = useState<DecomposeResult | null>(null);
  const [similarTasks, setSimilarTasks] = useState<SimilarTask[]>([]);
  const [searchKeywords, setSearchKeywords] = useState<string[]>([]);
  const [error, setError] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "form-ready") {
        console.log("Form iframe loaded");
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const fillForm = useCallback((data: { title?: string; goal?: string; todo?: string }) => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: "ai-fill", ...data }, "*");
    }
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!aiInput.trim()) return;
    setError("");
    setDecomposing(true);
    setSearching(false);
    setDecomposeResult(null);
    setSimilarTasks([]);
    setSearchKeywords([]);

    try {
      const decomposeRes = await fetch("/api/ai-decompose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: aiInput }),
      });
      if (!decomposeRes.ok) {
        const err = await decomposeRes.json();
        throw new Error(err.error || "Ошибка декомпозиции");
      }
      const result: DecomposeResult = await decomposeRes.json();
      setDecomposeResult(result);
      setDecomposing(false);
      fillForm({ title: result.title, todo: result.fullBody || result.body });

      setSearching(true);
      try {
        const searchRes = await fetch("/api/ai-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keywords: result.keywords }),
        });
        if (searchRes.ok) {
          const data = await searchRes.json();
          setSimilarTasks(data.similar || []);
          setSearchKeywords(data.usedKeywords || []);
        }
      } catch {
        setSimilarTasks([]);
      } finally {
        setSearching(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
      setDecomposing(false);
    }
  }, [aiInput, fillForm]);

  const handleRefill = useCallback(() => {
    if (decomposeResult) {
      fillForm({ title: decomposeResult.title, todo: decomposeResult.fullBody || decomposeResult.body });
    }
  }, [decomposeResult, fillForm]);

  const statusColor = (status: string) => {
    if (status.includes("Заверш") || status.includes("Принят")) return "#22c55e";
    if (status.includes("работе")) return "#3b82f6";
    if (status.includes("Ожида")) return "#f59e0b";
    if (status.includes("Отложен")) return "#6b7280";
    if (status.includes("Просрочен")) return "#ef4444";
    return "#8892a8";
  };

  return (
    <div style={{ display: "flex", height: "100vh", background: "#161616" }}>
      <div style={{ flex: 1, overflow: "hidden" }}>
        <iframe
          ref={iframeRef}
          src="/form.html"
          style={{ width: "100%", height: "100%", border: "none", background: "#161616" }}
          title="Форма задач Bitrix24"
        />
      </div>
      <div
        style={{
          width: 380,
          flexShrink: 0,
          background: "rgba(18, 21, 31, 0.95)",
          borderLeft: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(18, 21, 31, 0.6)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <div
              style={{
                width: 28, height: 28, borderRadius: 6,
                background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14,
              }}
            >
              ✦
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f8", fontFamily: "'JetBrains Mono', monospace" }}>
                AI Ассистент
              </div>
              <div style={{ fontSize: 10, color: "#4a5270", fontFamily: "'JetBrains Mono', monospace" }}>
                Вставь запрос из чата
              </div>
            </div>
            <div
              style={{
                fontSize: 9, color: "#4a5270", fontFamily: "'JetBrains Mono', monospace",
                background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 3, padding: "2px 6px",
              }}
            >
              v{APP_VERSION}
            </div>
          </div>
        </div>

        <div style={{ padding: "14px 18px", flex: "0 0 auto" }}>
          <textarea
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            placeholder="Вставь скопированный текст из чата..."
            style={{
              width: "100%", height: 140, background: "rgba(10, 12, 18, 0.6)",
              border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6,
              color: "#e2e8f8", fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12, padding: "10px 12px", outline: "none", resize: "none",
              lineHeight: 1.6, transition: "border-color 0.15s",
            }}
            onFocus={(e) => { e.target.style.borderColor = "#10b981"; e.target.style.boxShadow = "0 0 0 3px rgba(16,185,129,0.12)"; }}
            onBlur={(e) => { e.target.style.borderColor = "rgba(255,255,255,0.06)"; e.target.style.boxShadow = "none"; }}
          />
          <button
            onClick={handleGenerate}
            disabled={decomposing || searching || !aiInput.trim()}
            style={{
              width: "100%", marginTop: 10, padding: "11px 16px",
              background: aiInput.trim() && !decomposing && !searching ? "#10b981" : "rgba(16,185,129,0.3)",
              color: "#fff", border: "none", borderRadius: 6,
              fontFamily: "'Unbounded', sans-serif", fontSize: 11, fontWeight: 700,
              letterSpacing: "0.04em", textTransform: "uppercase",
              cursor: aiInput.trim() && !decomposing && !searching ? "pointer" : "not-allowed",
              opacity: aiInput.trim() && !decomposing && !searching ? 1 : 0.5,
              transition: "all 0.15s", display: "flex", alignItems: "center",
              justifyContent: "center", gap: 8,
            }}
          >
            {decomposing ? (
              <><span style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite", display: "inline-block" }} />Декомпозиция...</>
            ) : searching ? (
              <><span style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite", display: "inline-block" }} />Поиск аналогов...</>
            ) : (
              <>✦ Сгенерировать описание</>
            )}
          </button>
        </div>

        {decomposeResult && (
          <div style={{ padding: "10px 18px", borderBottom: "1px solid rgba(255,255,255,0.06)", flex: "0 0 auto" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <button
                onClick={handleRefill}
                style={{
                  fontSize: 9, fontWeight: 700, color: "#8892a8",
                  background: "rgba(18,21,31,0.4)", border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 4, padding: "3px 8px", cursor: "pointer",
                  fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: "0.04em",
                }}
              >
                ↻ Перезаполнить
              </button>
            </div>
            {decomposeResult.keywords.length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {decomposeResult.keywords.map((kw, i) => (
                  <span key={i} style={{ fontSize: 9, fontWeight: 600, color: "#10b981", background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 3, padding: "2px 6px", fontFamily: "'JetBrains Mono', monospace" }}>{kw}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{ padding: "10px 18px", background: "rgba(255,79,79,0.08)", borderBottom: "1px solid rgba(255,79,79,0.2)", fontSize: 11, color: "#ff4f4f", fontFamily: "'JetBrains Mono', monospace" }}>{error}</div>
        )}

        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: searching ? "#4a5270" : "#f59e0b", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "'JetBrains Mono', monospace" }}>Аналогичные задачи</div>
            {searching && <span style={{ width: 12, height: 12, border: "2px solid rgba(245,158,11,0.3)", borderTopColor: "#f59e0b", borderRadius: "50%", animation: "spin 0.7s linear infinite", display: "inline-block" }} />}
          </div>

          {searchKeywords.length > 0 && !searching && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
              <span style={{ fontSize: 8, fontWeight: 600, color: "#4a5270", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: "0.04em", lineHeight: "18px" }}>Найдено по:</span>
              {searchKeywords.map((kw, i) => (
                <span key={i} style={{ fontSize: 8, fontWeight: 600, color: "#f59e0b", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 3, padding: "1px 5px", fontFamily: "'JetBrains Mono', monospace" }}>{kw}</span>
              ))}
            </div>
          )}

          {similarTasks.length === 0 && !searching && (
            <div style={{ fontSize: 11, color: "#4a5270", fontStyle: "italic", fontFamily: "'JetBrains Mono', monospace" }}>
              {decomposeResult ? "Аналоги не найдены" : "Здесь появятся аналогичные задачи"}
            </div>
          )}

          {similarTasks.map((task) => (
            <a
              key={task.id}
              href={task.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex", flexDirection: "column", gap: 4,
                padding: "9px 10px", marginBottom: 6, borderRadius: 5,
                border: "1px solid rgba(255,255,255,0.06)", background: "rgba(10, 12, 18, 0.4)",
                textDecoration: "none", transition: "all 0.15s", cursor: "pointer",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(16,185,129,0.3)"; e.currentTarget.style.background = "rgba(16,185,129,0.06)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"; e.currentTarget.style.background = "rgba(10, 12, 18, 0.4)"; }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#10b981", fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>#{task.id}</span>
                <span style={{ fontSize: 10, color: "#7a8699", fontFamily: "'JetBrains Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.responsible}</span>
              </div>
              <div style={{ fontSize: 11, color: "#e2e8f8", fontFamily: "'JetBrains Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.4 }}>{task.title}</div>
              <div style={{ display: "flex", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: statusColor(task.status), background: `${statusColor(task.status)}15`, border: `1px solid ${statusColor(task.status)}30`, borderRadius: 3, padding: "1px 5px", fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{task.status}</span>
              </div>
            </a>
          ))}
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
