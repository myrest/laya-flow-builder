# Laya 決策流程測試環境（PR #11）

此目錄以隔壁的 `../laya` 原始碼與 `node_modules` 執行 Laya 多語言 ONNX 模型，並提供可視化決策樹編輯器與 HTTP API。模型快取共用 Laya 的既有位置，不會再下載一份。

## 啟動

```bash
cd ~/TEST/laya-test
npm run dev
```

- 網頁編輯器：`http://<這台機器的 IP>:5173`
- API：`http://<這台機器的 IP>:3000`
- 健康檢查：`http://localhost:3000/health`

服務監聽 `0.0.0.0`，可讓同網段機器連線。API 沒有登入驗證；只在可信任的內網使用，並用防火牆限制來源。

首次執行若模型尚未快取，Laya 會自 Hugging Face 下載約 1.7 GB 權重至 `~/.cache/receptron-laya`。流程資料預設儲存在 `data/decision-system.json`；可用 `LAYA_DATA_DIR` 改變資料目錄。

## 編輯與測試流程

編輯器預載 IoT 操作範例。左側基本積木與範本可拖曳至畫布，或按「＋」新增（點卡片本身不會新增）；拖曳節點出口可連接下一步。起點只有一個「下一步」出口；若需更換既有連線，先選取連線並按 Delete，再拖曳到新節點。刪除節點時，其相連連線也會一併移除。支援單選、是非機率門檻、評分數值切分點與 JSON 結束節點。每個分類／評分出口都要接線。

每個決策節點有最低信心設定，預設 0.2，設為 0 可停用。低於門檻時會採用指定的既有選項，沿用該出口；choice 預設優先選 `other`，其次 `no`，再其次第一個選項；是非題預設選「否」，評分預設選最低分段，並以所選分段下界作為結果。設定為一般分類選項即可自行設計「信心不足」結果，不需額外出口。Laya 的 confidence 是答案分布集中度指標，不是答對機率；門檻應依實際輸入調整。

選取決策積木後可把它儲存成範本；再次加入會建立獨立副本，包含信心門檻與低信心預設。JSON 輸出欄位可設固定 JSON 值，或引用該路徑上已執行的決策結果；低於門檻時，引用值會是指定的預設選項。測試面板顯示原始模型答案、採用的分支與信心，信心以百分比顯示至小數點後兩位。

測試面板可切換「單次測試／批次測試」。批次測試案例依流程分開保存，包含名稱、文字或 JSON 輸入、預期 JSON 輸出與啟用狀態；執行時只跑啟用案例，並以 JSON 結構比對完整輸出（物件欄位順序不影響，陣列順序有影響）。結果分為通過、未通過與執行錯誤，最近一次各案例結果會保留；流程內容變更時標示舊結果，案例變更時清除舊結果。批次執行使用目前流程內容，包含尚未儲存的編輯。

執行只回傳流程設定的 JSON；不操作 IoT 裝置、不送 HTTP/MQTT。下游服務需自行驗證結果並決定是否執行裝置操作。

## 決策流程 API

先查詢流程清單取得 `<flow-id>`：

```bash
curl http://<這台機器的 IP>:3000/api/flows
```

執行流程時，`input` 可為文字、物件或其他 JSON 值：

```bash
curl -X POST http://<這台機器的 IP>:3000/api/flows/<flow-id>/run \
  -H "Content-Type: application/json" \
  -d '{"input":"打開風扇"}'
```
網頁「同網段呼叫」卡片會顯示完整的 `curl` 指令並提供複製按鈕；區網 HTTP 會使用相容複製方式，若瀏覽器仍阻擋複製，可直接選取顯示的指令。

`/run` 只回傳流程設定的 JSON 物件，不包含 trace envelope。網頁測試使用另一個 endpoint：

```bash
curl -X POST http://localhost:3000/api/flows/<flow-id>/test \
  -H "Content-Type: application/json" \
  -d '{"input":"打開風扇"}'
```

`/test` 回傳 `{ "status": "completed", "output", "trace", "durationMs" }`。測試面板會附上目前流程快照，因此未儲存的編輯也能測試；快照只用於當次測試，不會寫入流程資料。API 呼叫省略 `flow` 欄位時則使用已儲存版本。`/run` 回傳流程設定的 JSON；低信心結果也會依指定預設選項繼續執行。舊流程若連接了獨立的「信心不足」出口，需改成一般選項出口並指定為低信心預設。流程支援建立、讀取、更新、刪除；範本支援建立、讀取、刪除。`POST /api/flows/<flow-id>/validate` 檢查流程是否完整。

批次測試 API：`GET /api/flows/<flow-id>/test-cases` 讀取套件；`PUT` 同一路徑以 `{ "revision": <套件版本>, "cases": [...] }` 儲存案例（每個案例包含 `id`、`name`、文字或其他 JSON `input`、物件 `expectedOutput`、`enabled`）。版本不符時回傳 `409`，避免另一個頁面覆蓋較新的案例。`POST /api/flows/<flow-id>/test-cases/run` 接受 `{ "flow": <流程快照> }`，可選擇附上 `caseIds` 只重跑指定案例；省略時執行所有啟用案例。回應包含套件與最近一次各案例結果，單一案例會標示 `passed`、`failed` 或 `error`。

## 相容的 Laya endpoint

既有 `POST /api/system-one` 維持可用。請求格式仍是 Laya 的 `state` 與 `questions`，不是決策流程的 `/run` 格式。

```bash
curl -X POST http://<這台機器的 IP>:3000/api/system-one \
  -H "Content-Type: application/json" \
  -d '{"state":"打開風扇","questions":{"action":{"type":"choice","instructions":"要做什麼？","criteria":{"on":"打開","off":"關閉"}}}}'
```

## 建置與檢查

```bash
npm run typecheck
npm test
npm run build
```

建置後可用 `npm start` 單獨啟動 API 與已建置的網頁（同樣使用 3000 埠）。`npm run dev` 則會同時啟動 API 與 Vite 開發伺服器。

## 磁碟配置

- 根目錄 `node_modules` 是 `../laya/node_modules` 的軟連結。
- `web/node_modules` 安裝編輯器依賴。
- Laya ONNX 模型使用既有 `~/.cache/receptron-laya` 快取。
- `data/decision-system.json` 儲存流程與積木範本。
