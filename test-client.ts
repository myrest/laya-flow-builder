interface ApiResponse {
  model?: string;
  answers?: Record<string, {
    type: string;
    choice?: string;
    score?: number;
    noul?: number;
    probabilities?: Record<string, number>;
    confidence?: number;
  }>;
  usage?: { input_tokens: number; output_tokens: number };
  durationMs?: number;
  error?: string;
}

const targetUrl = process.env.API_URL || "http://localhost:3000/api/system-one";

console.log(`正在向 ${targetUrl} 發送測試決策請求...`);

const payload = {
  state: {
    subject: "退款進度詢問",
    body: "我已經於兩週前取消訂閱，至今仍未收到退款，已經是第三次聯絡客服了，請盡快處理。",
  },
  questions: {
    department: {
      type: "choice",
      instructions: "這張工單應該由哪一個部門處理？",
      criteria: {
        billing: "款項、退款、發票與帳單問題",
        support: "產品使用操作與系統錯誤回報",
        sales: "新產品採購與方案升級諮詢",
      },
    },
    urgency: {
      type: "score",
      instructions: "此工單的急迫程度為何？",
      criteria: ["一般", "微急", "緊急", "非常緊急"],
    },
    churn_risk: {
      type: "noul",
      instructions: "客戶是否面臨高流失風險或可能發起信用卡爭議？",
    },
  },
};

try {
  const t0 = performance.now();
  const res = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const duration = Math.round(performance.now() - t0);
  const data = (await res.json()) as ApiResponse;

  if (!res.ok) {
    console.error(`[錯誤 HTTP ${res.status}]:`, data.error || data);
    process.exit(1);
  }

  console.log(`\n[成功收到回應] (網路往返耗時: ${duration} ms, 伺服器推論耗時: ${data.durationMs} ms)`);
  console.log("-------------------------------------------------");
  console.log("模型:", data.model);
  console.log("Token 用量:", data.usage);
  console.log("\n決策回答:");
  if (data.answers) {
    for (const [key, ans] of Object.entries(data.answers)) {
      if (ans.type === "choice") {
        console.log(`  - [部門分類 choice] ${key}: "${ans.choice}" (信心度: ${ans.confidence?.toFixed(4)}, 機率分佈: ${JSON.stringify(ans.probabilities)})`);
      } else if (ans.type === "score") {
        console.log(`  - [急迫評分 score]  ${key}: ${ans.score?.toFixed(2)} (信心度: ${ans.confidence?.toFixed(4)})`);
      } else if (ans.type === "noul") {
        console.log(`  - [流失判定 noul]   ${key}: P(true) = ${ans.noul?.toFixed(4)}`);
      }
    }
  }
  console.log("-------------------------------------------------");
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("連線伺服器失敗，請確認 API 服務是否已啟動:", message);
  process.exit(1);
}
