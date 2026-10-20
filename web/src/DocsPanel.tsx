import { useState, useCallback, useMemo } from "react";
import type { Question, SystemOneResult } from "../../../laya/src/types.js";
import type { DecisionFlow } from "../../decision-types";
import { directSystemOne } from "./api";

interface DocsPanelProps {
  apiUrl: string;
  flow: DecisionFlow | null;
}

type DocSection = "direct" | "playground" | "snippets" | "flow";
type PresetKey = "iot" | "service" | "intent";

interface Preset {
  title: string;
  description: string;
  state: string;
  questions: Record<string, Question>;
}

const PRESETS: Record<PresetKey, Preset> = {
  iot: {
    title: "智慧家庭 IOT（意圖、設備、動作與急迫度）",
    description: "單次前向傳播同時輸出是否為 IOT (noul)、設備類別 (choice)、動作 (choice) 與急迫程度 (score)。",
    state: "幫我把客廳的冷氣打開，有點熱",
    questions: {
      is_iot: {
        type: "noul",
        instructions: "這句話是否屬於控制智慧家庭或 IOT 設備的請求？",
        criteria: {
          true: "是智慧家電或設備控制指令",
          false: "一般日常閒聊、搜尋或其他無關對話",
        },
      },
      device: {
        type: "choice",
        instructions: "句子中欲操作的設備種類為何？",
        criteria: {
          air_conditioner: "冷氣機、空調、冷氣",
          fan: "電風扇、排風扇、風扇",
          light: "電燈、照明、客廳燈",
          other: "無法辨識或非支援裝置",
        },
      },
      action: {
        type: "choice",
        instructions: "希望執行的動作為何？",
        criteria: {
          turn_on: "開啟、打開、啟動",
          turn_off: "關閉、關掉、停止",
          adjust: "調整溫度、風量或亮暗",
          query: "查詢狀態或問句",
        },
      },
      urgency: {
        type: "score",
        instructions: "使用者語氣的急迫程度？",
        criteria: ["一般日常", "稍急", "非常緊急"],
      },
    },
  },
  service: {
    title: "客服工單分類（分流、緊急度與客訴風險）",
    description: "判斷工單負責團隊、等級評分與真假二元客訴流失風險。",
    state: "我已經申請退款兩週了都沒收到，這是第三次發信，再不處理我就向消保官投訴！",
    questions: {
      department: {
        type: "choice",
        instructions: "此工單應指派給哪個部門處理？",
        criteria: {
          billing: "費用、退款、發票、扣款爭議",
          support: "系統故障、無法登入、技術諮詢",
          sales: "購買諮詢、方案報價",
        },
      },
      urgency: {
        type: "score",
        instructions: "客戶請求的急迫程度？",
        criteria: ["低", "中", "高", "嚴重緊急"],
      },
      churn_risk: {
        type: "noul",
        instructions: "客戶是否有高度客訴或流失風險？",
        criteria: {
          true: "揚言投訴、強烈抗議或要求退款",
          false: "一般常規提問或正常回饋",
        },
      },
    },
  },
  intent: {
    title: "自然語言是非判定（二元真假）",
    description: "單純使用 noul 判斷敘述是否成立，輸出精確的 P(true) 機率。",
    state: "請問明天台北會下雨嗎？",
    questions: {
      is_question: {
        type: "noul",
        instructions: "這句話是否為疑問句或資訊查詢？",
        criteria: {
          true: "是疑問句或詢問天氣等資訊",
          false: "是命令、操作或陳述句",
        },
      },
    },
  },
};

async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  let ok = false;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    ok = typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    textarea.remove();
  }
  return ok;
}

export function DocsPanel({ apiUrl, flow }: DocsPanelProps) {
  const [section, setSection] = useState<DocSection>("direct");
  const [activePreset, setActivePreset] = useState<PresetKey>("iot");
  const [stateInput, setStateInput] = useState(PRESETS.iot.state);
  const [questionsInput, setQuestionsInput] = useState(() => JSON.stringify(PRESETS.iot.questions, null, 2));
  const [jsonError, setJsonError] = useState("");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [result, setResult] = useState<SystemOneResult<Record<string, Question>> | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [snippetLang, setSnippetLang] = useState<"curl" | "ts" | "python" | "node">("curl");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = useCallback(async (key: string, text: string) => {
    const success = await copyText(text);
    if (success) {
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1500);
    }
  }, []);

  const selectPreset = useCallback((key: PresetKey) => {
    setActivePreset(key);
    const p = PRESETS[key];
    setStateInput(p.state);
    setQuestionsInput(JSON.stringify(p.questions, null, 2));
    setJsonError("");
    setRunError("");
    setResult(null);
    setDurationMs(null);
  }, []);

  const handleRunPlayground = useCallback(async () => {
    let parsedQuestions: Record<string, Question>;
    try {
      parsedQuestions = JSON.parse(questionsInput) as Record<string, Question>;
      setJsonError("");
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : "JSON 語法錯誤");
      return;
    }

    setRunning(true);
    setRunError("");
    setResult(null);
    setDurationMs(null);
    const start = performance.now();
    try {
      const res = await directSystemOne(stateInput, parsedQuestions);
      setDurationMs(Math.round(performance.now() - start));
      setResult(res);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [stateInput, questionsInput]);

  const playgroundCurl = useMemo(() => {
    let questionsObj: unknown;
    try {
      questionsObj = JSON.parse(questionsInput);
    } catch {
      questionsObj = {};
    }
    const payload = JSON.stringify({ state: stateInput, questions: questionsObj }, null, 2);
    return `curl -X POST '${apiUrl}/api/system-one' \\\n  -H 'Content-Type: application/json' \\\n  -d '${payload.replace(/'/g, "'\\''")}'`;
  }, [apiUrl, stateInput, questionsInput]);

  const flowCurl = useMemo(() => {
    const flowId = flow?.id ?? "<flowId>";
    return `curl -X POST '${apiUrl}/api/flows/${flowId}/run' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"input": "幫我把客廳的冷氣打開"}'`;
  }, [apiUrl, flow]);

  const codeSnippets = useMemo(() => {
    return {
      curl: `curl -X POST '${apiUrl}/api/system-one' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "state": "幫我把客廳的冷氣打開，有點熱",
    "questions": {
      "is_iot": {
        "type": "noul",
        "instructions": "這句話是否屬於控制智慧家庭或 IOT 設備的請求？",
        "criteria": { "true": "是智慧家電指令", "false": "其他對話" }
      },
      "device": {
        "type": "choice",
        "instructions": "句子中欲操作的設備種類為何？",
        "criteria": {
          "air_conditioner": "冷氣機、空調",
          "fan": "電風扇、排風扇",
          "light": "電燈、照明",
          "other": "無法辨識或非支援裝置"
        }
      },
      "action": {
        "type": "choice",
        "instructions": "希望執行的動作為何？",
        "criteria": ["turn_on", "turn_off", "adjust", "query"]
      },
      "urgency": {
        "type": "score",
        "instructions": "使用者語氣的急迫程度？",
        "criteria": ["一般日常", "稍急", "非常緊急"]
      }
    }
  }'`,
      ts: `// TypeScript / JavaScript (Node 18+ 或瀏覽器 Fetch)
const response = await fetch("${apiUrl}/api/system-one", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    state: "幫我把客廳的冷氣打開，有點熱",
    questions: {
      is_iot: {
        type: "noul",
        instructions: "是否屬於控制智慧家電請求？",
        criteria: { true: "是", false: "否" }
      },
      device: {
        type: "choice",
        instructions: "欲操作的設備？",
        criteria: { air_conditioner: "冷氣", fan: "風扇", other: "其他" }
      }
    }
  })
});

const data = await response.json();
console.log("裝置分類:", data.answers.device.choice);
console.log("裝置信心度:", data.answers.device.confidence);
console.log("是否為 IOT (P_true):", data.answers.is_iot.noul);`,
      python: `# Python 3 (requests)
import requests

url = "${apiUrl}/api/system-one"
payload = {
    "state": "幫我把客廳的冷氣打開，有點熱",
    "questions": {
        "is_iot": {
            "type": "noul",
            "instructions": "是否屬於控制智慧家電請求？",
            "criteria": {"true": "是", "false": "否"}
        },
        "device": {
            "type": "choice",
            "instructions": "欲操作的設備？",
            "criteria": {
                "air_conditioner": "冷氣機",
                "fan": "風扇",
                "other": "其他"
            }
        }
    }
}

resp = requests.post(url, json=payload)
data = resp.json()
print("Device:", data["answers"]["device"]["choice"])
print("Confidence:", data["answers"]["device"]["confidence"])
print("P(true):", data["answers"]["is_iot"]["noul"])`,
      node: `// Node.js 程式內直接載入 Laya 模型（完全不經 HTTP）
import { Laya } from "@receptron/laya";

const laya = await Laya.load({
  repo: "alexdoandev/laya-multilingual-onnx",
});

const result = await laya.systemOne(
  "幫我把客廳的冷氣打開，有點熱",
  {
    device: {
      type: "choice",
      instructions: "欲操作的設備？",
      criteria: { air_conditioner: "冷氣", fan: "風扇", other: "其他" }
    },
    is_iot: {
      type: "noul",
      instructions: "是否屬於控制智慧家電請求？"
    }
  }
);

console.log(result.answers.device.choice);
console.log(result.answers.is_iot.noul);

await laya.close();`,
    };
  }, [apiUrl]);

  return (
    <article className="docs-panel" aria-label="API 與呼叫手冊">
      <header className="docs-header">
        <div>
          <span className="eyebrow">API 規格與直接呼叫手冊</span>
          <h1>直接呼叫 Laya (System 1) 或執行決策流程</h1>
          <p>
            除了視覺化「決策流程」外，您也可以直接對底層 Laya ONNX 多語言模型發送單次前向傳播（Forward Pass）請求，在一個呼叫中同時完成多個是非、分類或評分判定。
          </p>
        </div>
        <div className="docs-header__badges">
          <span className="badge badge--accent">POST /api/system-one</span>
          <span className="badge">本機推論 · 免金鑰</span>
          <span className="badge">多語言 ONNX</span>
        </div>
      </header>

      <nav className="docs-tabs" role="tablist" aria-label="文件章節">
        <button
          type="button"
          role="tab"
          aria-selected={section === "direct"}
          className={section === "direct" ? "is-active" : ""}
          onClick={() => setSection("direct")}
        >
          直接呼叫規格
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "playground"}
          className={section === "playground" ? "is-active" : ""}
          onClick={() => setSection("playground")}
        >
          線上互動測試 (Playground)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "snippets"}
          className={section === "snippets" ? "is-active" : ""}
          onClick={() => setSection("snippets")}
        >
          程式碼呼叫範例
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "flow"}
          className={section === "flow" ? "is-active" : ""}
          onClick={() => setSection("flow")}
        >
          決策流程樹呼叫對照
        </button>
      </nav>

      {section === "direct" && (
        <section className="docs-section" aria-labelledby="direct-title">
          <div className="docs-card-grid">
            <div className="docs-card">
              <span className="docs-card__tag">何時選擇？</span>
              <h3 id="direct-title">直接呼叫 Laya (`/api/system-one`)</h3>
              <p>適合外部程式或微服務需要直接獲取語意判定結果、多維度信心度與機率分布，而不需維護節點連線圖。</p>
              <ul className="docs-feature-list">
                <li><strong>單次前向傳播（Single Forward Pass）：</strong>一次 request 可包裝任意數量的題目，模型共享上下文編碼，推論延遲極低。</li>
                <li><strong>完整機率與信心度：</strong>回傳各選項精準機率分佈、正規化熵信心度 (0~1) 及真值機率 $P(\text{true})$。</li>
                <li><strong>免管理者 Token：</strong>設計為應用服務可直接對接的免狀態推論端點。</li>
              </ul>
            </div>

            <div className="docs-card">
              <span className="docs-card__tag">對照比較</span>
              <h3>決策流程模式 (`/api/flows/:id/run`)</h3>
              <p>適合需要視覺化分支邏輯、信心門檻預設路由、輸出自訂固定 JSON 格式或版本審查情境。</p>
              <ul className="docs-feature-list">
                <li><strong>視覺化畫布：</strong>多步條件串接，將不同分支路由到對應的 End 節點。</li>
                <li><strong>低信心 Fallback：</strong>信心不足自動切換預設分支，保障自動化系統邊界。</li>
                <li><strong>版本草稿與批次驗證：</strong>可透過 MCP 或網頁建立測試案例進行回歸測試。</li>
              </ul>
            </div>
          </div>

          <div className="docs-detail-panel">
            <h2>端點與請求協議</h2>
            <div className="docs-spec-row">
              <span className="method-pill method-pill--post">POST</span>
              <code>{apiUrl}/api/system-one</code>
            </div>
            <p className="helper-copy">標頭需指定 <code>Content-Type: application/json</code>。無需驗證權杖。</p>

            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>欄位</th>
                    <th>型態</th>
                    <th>必要</th>
                    <th>說明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>state</code></td>
                    <td><code>string | object</code></td>
                    <td>是</td>
                    <td>待判斷的文本（例如句子）或任意 JSON 物件。模型自動對齊上下文。上限 512 tokens。</td>
                  </tr>
                  <tr>
                    <td><code>questions</code></td>
                    <td><code>Record&lt;string, Question&gt;</code></td>
                    <td>是</td>
                    <td>問題集合，Key 為自訂鍵名（回傳時以相同 Key 對應），至少需包含 1 個問題。</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3 className="section-subtitle">三種支援的問題型別（Question Types）</h3>
            <div className="question-types-grid">
              <div className="qtype-card qtype-card--choice">
                <div className="qtype-card__head">
                  <span className="qtype-pill">choice</span>
                  <strong>多選一分類</strong>
                </div>
                <p>將文字指派至多個候選分類之一，輸出最高機率選項及各選項機率分布。</p>
                <div className="qtype-field">
                  <label>criteria 格式：</label>
                  <code>Record&lt;string, string | null&gt; | string[]</code>
                  <small>例如 <code>{`{ "fan": "電風扇", "light": "照明燈" }`}</code> 或 <code>{`["fan", "light"]`}</code>。允許 2～64 個選項（官方建議 ≤ 20 個）。</small>
                </div>
                <div className="qtype-field">
                  <label>回傳結果：</label>
                  <code>choice</code>（選中選項）、<code>probabilities</code>（各選項機率）、<code>confidence</code>（0～1 信心度）。
                </div>
              </div>

              <div className="qtype-card qtype-card--score">
                <div className="qtype-card__head">
                  <span className="qtype-pill">score</span>
                  <strong>程度 / 級距評分</strong>
                </div>
                <p>依順序排列的評分量表，模型輸出加權期望分數（0 至 levels-1）。</p>
                <div className="qtype-field">
                  <label>criteria 格式：</label>
                  <code>string[]</code>
                  <small>由低到高排列的等級名稱，例如 <code>{`["一般", "稍急", "緊急"]`}</code>。允許 2～64 個等級。</small>
                </div>
                <div className="qtype-field">
                  <label>回傳結果：</label>
                  <code>score</code>（加權期望分數，如 1.38）、<code>legend</code>（索引與名稱對照）、<code>confidence</code>。
                </div>
              </div>

              <div className="qtype-card qtype-card--noul">
                <div className="qtype-card__head">
                  <span className="qtype-pill">noul</span>
                  <strong>是非判斷（Yes / No）</strong>
                </div>
                <p>判定陳述是否成立，輸出校準後的真值機率 $P(\text{true})$。</p>
                <div className="qtype-field">
                  <label>criteria 格式：</label>
                  <code>{`{ true?: string, false?: string }`}（可選）</code>
                  <small>可為 true 或 false 加上補充說明，強化模型辨識度（例如 <code>{`{ "true": "符合條件", "false": "其他" }`}</code>）。</small>
                </div>
                <div className="qtype-field">
                  <label>回傳結果：</label>
                  <code>noul</code>（$0.0 \sim 1.0$ 的真值機率值）。
                </div>
              </div>
            </div>

            <h3 className="section-subtitle">長度限制與建議</h3>
            <ul className="docs-note-list">
              <li><strong>state 長度：</strong>最長 512 tokens，超出部分會被模型截斷。</li>
              <li><strong>選項頭部（head_max_len）：</strong>每題的選項名稱與說明總長度上限為 192 tokens。若選項過長模型會拋出例外。</li>
              <li><strong>語言支援：</strong>底層模型為 <code>alexdoandev/laya-multilingual-onnx</code>，支援繁簡中文、英文等 100+ 語言。</li>
            </ul>
          </div>
        </section>
      )}

      {section === "playground" && (
        <section className="docs-section" aria-labelledby="playground-title">
          <div className="playground-toolbar">
            <div className="playground-presets">
              <span className="muted-label">範本情境：</span>
              {(Object.keys(PRESETS) as PresetKey[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`preset-btn${activePreset === key ? " is-active" : ""}`}
                  onClick={() => selectPreset(key)}
                  disabled={running}
                >
                  {PRESETS[key].title.split("（")[0]}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="button button--subtle"
              onClick={() => void handleCopy("playground-curl", playgroundCurl)}
            >
              {copiedKey === "playground-curl" ? "已複製 curl" : "複製目前請求的 curl"}
            </button>
          </div>

          <p className="playground-desc">{PRESETS[activePreset].description}</p>

          <div className="playground-layout">
            <div className="playground-input-col panel">
              <h2>請求設定</h2>
              <label className="field">
                <span>待判斷文本 (state)</span>
                <textarea
                  rows={3}
                  value={stateInput}
                  onChange={(e) => setStateInput(e.target.value)}
                  placeholder="輸入要判斷的自然語言句子或文字…"
                  disabled={running}
                />
              </label>

              <label className="field">
                <span>題組定義 (questions JSON)</span>
                <textarea
                  rows={13}
                  className="code-textarea"
                  value={questionsInput}
                  onChange={(e) => {
                    setQuestionsInput(e.target.value);
                    try {
                      JSON.parse(e.target.value);
                      setJsonError("");
                    } catch (err) {
                      setJsonError(err instanceof Error ? err.message : "JSON 語法錯誤");
                    }
                  }}
                  disabled={running}
                />
              </label>
              {jsonError && <p className="form-error" role="alert">JSON 格式錯誤：{jsonError}</p>}

              <button
                type="button"
                className="button button--primary button--wide"
                onClick={() => void handleRunPlayground()}
                disabled={running || jsonError.length > 0 || stateInput.trim().length === 0}
              >
                {running ? "Laya 模型推論中…" : "直接送出給 Laya 判斷"}
              </button>
              {runError && <p className="form-error" role="alert">{runError}</p>}
            </div>

            <div className="playground-output-col panel">
              <div className="playground-output-head">
                <h2>判斷結果</h2>
                <span>
                  {running
                    ? "推論中…"
                    : result
                    ? `${durationMs ?? 0} ms · 消耗 ${result.usage.input_tokens} tokens`
                    : "尚未執行"}
                </span>
              </div>

              {result ? (
                <div className="playground-results">
                  {Object.entries(result.answers).map(([qid, ans]) => (
                    <div key={qid} className="answer-card">
                      <div className="answer-card__head">
                        <div>
                          <strong>{qid}</strong>
                          <span className={`qtype-tag qtype-tag--${ans.type}`}>{ans.type}</span>
                        </div>
                        {ans.type === "choice" && (
                          <span className="confidence-pill">
                            信心度 {(ans.confidence * 100).toFixed(1)}%
                          </span>
                        )}
                        {ans.type === "score" && (
                          <span className="confidence-pill">
                            信心度 {(ans.confidence * 100).toFixed(1)}%
                          </span>
                        )}
                      </div>

                      {ans.type === "choice" && (
                        <div className="answer-choice-body">
                          <div className="best-choice">
                            <span>最佳分類結果：</span>
                            <strong>{ans.choice}</strong>
                          </div>
                          <div className="prob-bars">
                            {Object.entries(ans.probabilities).map(([opt, prob]) => {
                              const pct = Math.round(prob * 1000) / 10;
                              const isBest = opt === ans.choice;
                              return (
                                <div key={opt} className={`prob-row${isBest ? " is-best" : ""}`}>
                                  <span className="prob-label">{opt}</span>
                                  <div className="prob-track">
                                    <div className="prob-fill" style={{ width: `${pct}%` }} />
                                  </div>
                                  <span className="prob-val">{pct.toFixed(1)}%</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {ans.type === "score" && (
                        <div className="answer-score-body">
                          <div className="score-summary">
                            <span>加權期望值：</span>
                            <strong>{ans.score.toFixed(2)}</strong>
                            <small>
                              （接近等級：{ans.legend[String(Math.round(ans.score))] ?? ans.score.toFixed(1)}）
                            </small>
                          </div>
                          <div className="prob-bars">
                            {Object.entries(ans.probabilities).map(([idx, prob]) => {
                              const label = ans.legend[idx] ?? `等級 ${idx}`;
                              const pct = Math.round(prob * 1000) / 10;
                              return (
                                <div key={idx} className="prob-row">
                                  <span className="prob-label">{label}</span>
                                  <div className="prob-track">
                                    <div className="prob-fill prob-fill--score" style={{ width: `${pct}%` }} />
                                  </div>
                                  <span className="prob-val">{pct.toFixed(1)}%</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {ans.type === "noul" && (
                        <div className="answer-noul-body">
                          <div className="noul-summary">
                            <span>P(True) 真值機率：</span>
                            <strong>{(ans.noul * 100).toFixed(1)}%</strong>
                            <span className={`noul-flag ${ans.noul >= 0.5 ? "is-true" : "is-false"}`}>
                              {ans.noul >= 0.5 ? "✓ 符合 (True)" : "✗ 不符合 (False)"}
                            </span>
                          </div>
                          <div className="prob-track prob-track--large">
                            <div className="prob-fill prob-fill--noul" style={{ width: `${Math.round(ans.noul * 100)}%` }} />
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  <details className="raw-json-details">
                    <summary>查看完整回傳 JSON</summary>
                    <pre>{JSON.stringify(result, null, 2)}</pre>
                  </details>
                </div>
              ) : (
                <div className="playground-empty">
                  <p className="muted">點擊「直接送出給 Laya 判斷」，本頁將直接呼叫 <code>/api/system-one</code> 並將各題目結果視覺化呈現。</p>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {section === "snippets" && (
        <section className="docs-section" aria-labelledby="snippets-title">
          <div className="snippets-header">
            <h2 id="snippets-title">程式碼呼叫範例</h2>
            <div className="snippet-lang-tabs" role="tablist">
              {(["curl", "ts", "python", "node"] as const).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  className={snippetLang === lang ? "is-active" : ""}
                  onClick={() => setSnippetLang(lang)}
                >
                  {lang === "curl" ? "cURL" : lang === "ts" ? "TypeScript (Fetch)" : lang === "python" ? "Python (requests)" : "Node.js SDK"}
                </button>
              ))}
            </div>
          </div>

          <div className="snippet-container panel">
            <div className="snippet-toolbar">
              <span className="snippet-file-label">
                {snippetLang === "curl"
                  ? "terminal"
                  : snippetLang === "ts"
                  ? "direct-laya.ts"
                  : snippetLang === "python"
                  ? "direct_laya.py"
                  : "server-model.ts"}
              </span>
              <button
                type="button"
                className="button button--subtle"
                onClick={() => void handleCopy(snippetLang, codeSnippets[snippetLang])}
              >
                {copiedKey === snippetLang ? "已複製！" : "複製程式碼"}
              </button>
            </div>
            <pre className="snippet-code">
              <code>{codeSnippets[snippetLang]}</code>
            </pre>
          </div>
        </section>
      )}

      {section === "flow" && (
        <section className="docs-section" aria-labelledby="flow-api-title">
          <div className="docs-detail-panel">
            <h2 id="flow-api-title">決策流程樹呼叫規格 (Flow Engine)</h2>
            <p>如果您在設計器中編輯了一條流程圖，並希望由系統依據連線與信心門檻執行，可使用流程專用的 Run 端點：</p>

            <div className="docs-spec-row">
              <span className="method-pill method-pill--post">POST</span>
              <code>{apiUrl}/api/flows/{flow?.id ?? ":flowId"}/run</code>
            </div>
            <p className="helper-copy">
              目前選取的流程：<strong>{flow?.name ?? "尚未選擇流程"}</strong>
            </p>

            <div className="snippet-container panel" style={{ marginTop: 14 }}>
              <div className="snippet-toolbar">
                <span className="snippet-file-label">cURL 範例</span>
                <button
                  type="button"
                  className="button button--subtle"
                  onClick={() => void handleCopy("flow-curl", flowCurl)}
                >
                  {copiedKey === "flow-curl" ? "已複製！" : "複製 cURL"}
                </button>
              </div>
              <pre className="snippet-code">
                <code>{flowCurl}</code>
              </pre>
            </div>

            <div className="docs-flow-compare-table">
              <h3>兩種呼叫模式規格速查</h3>
              <div className="docs-table-wrap">
                <table className="docs-table">
                  <thead>
                    <tr>
                      <th>比較維度</th>
                      <th>直接呼叫 Laya (`/api/system-one`)</th>
                      <th>決策流程樹 (`/api/flows/:id/run`)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><strong>用途</strong></td>
                      <td>直接單步獲取各題目的語意判斷、機率與信心度</td>
                      <td>多步條件決策路徑，輸出約定好的固定 JSON 結構</td>
                    </tr>
                    <tr>
                      <td><strong>端點</strong></td>
                      <td><code>POST /api/system-one</code></td>
                      <td><code>POST /api/flows/:flowId/run</code></td>
                    </tr>
                    <tr>
                      <td><strong>輸入</strong></td>
                      <td><code>{`{ "state": "...", "questions": { ... } }`}</code></td>
                      <td><code>{`{ "input": "..." }`}</code></td>
                    </tr>
                    <tr>
                      <td><strong>輸出</strong></td>
                      <td>包含各題 <code>probabilities</code>, <code>confidence</code>, <code>score</code>, <code>noul</code></td>
                      <td>流程終點節點（End Node）設定的最終 JSON 物件</td>
                    </tr>
                    <tr>
                      <td><strong>狀態依賴</strong></td>
                      <td>完全無狀態（Stateless），不依賴後端資料庫中的任何流程設定</td>
                      <td>依賴資料庫儲存的對應流程結構（需要先儲存）</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      )}
    </article>
  );
}
