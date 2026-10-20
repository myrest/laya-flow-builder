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

服務監聽 `0.0.0.0`，可讓同網段機器連線。流程、範本與流程草稿可公開讀取；建立、更新、刪除流程／範本、修改或執行會保存結果的批次測試、建立或修改草稿及歷史還原都需要管理員憑證。若未設定 `LAYA_ADMIN_TOKEN`／`LAYA_MCP_TOKEN`，啟動時會在資料目錄產生 `admin-token` 與 `mcp-token`（各 32 bytes、檔案權限 `0600`），只會記錄檔案路徑、不會輸出憑證；設定這兩個環境變數可改用自訂憑證，且憑證須不同。管理員登入畫面使用 `admin-token`。`/run`、`/test`、`/validate`、`/system-one` 維持免憑證。僅在可信任的內網使用，並用防火牆限制來源；跨網段時必須使用 HTTPS，避免憑證以明文傳送。

首次執行若模型尚未快取，Laya 會自 Hugging Face 下載約 1.7 GB 權重至 `~/.cache/receptron-laya`。流程資料預設儲存在 `data/decision-system.json`；可用 `LAYA_DATA_DIR` 改變資料目錄。

## 編輯與測試流程

「流程設計」工作區預載 IoT 操作判斷範例。頂欄可切換與儲存流程；「流程選項」可建立或刪除流程。桌面版左側積木與範本可拖曳至畫布，或按「＋」新增（點卡片本身不會新增）；平板與手機從「積木與範本」面板開啟。起點只能連到一個下一步；每個決策分支只能連到一個下一步，決策節點只能有一個上游，分支按所選出口依序繼續判斷，不支援平行分流或匯聚。互斥出口可共用同一個結束節點，例如 IoT 判斷的「否」、裝置／操作的 other 可共用「非 IoT 或不支援」End。刪除節點時，相連連線及其他決策對該節點的前置引用會一併移除；結束節點失效引用會標示，可改成固定 JSON 或有效的上游決策，或一鍵帶入上游已執行的決策結果。支援單選、是非機率門檻、評分數值切分點與 JSON 結束節點。每個分類／評分出口都要接線。只有「流程設計」工作區會套用 Delete／Backspace 刪除選取項目；切換至測試或草稿不會修改畫布。低高度橫向視窗的節點設定面板會留在可視區域，欄位可在面板內捲動。流程選項的建立或刪除錯誤會顯示在該對話框內。
每個決策節點有最低信心設定，預設 0.2，設為 0 可停用。低於門檻時會採用指定的既有選項，沿用該出口；choice 預設優先選 `other`，其次 `no`，再其次第一個選項；是非題預設選「否」，評分預設選最低分段，並以所選分段下界作為結果。設定為一般分類選項即可自行設計「信心不足」結果，不需額外出口。Laya 的 confidence 是答案分布集中度指標，不是答對機率；門檻應依實際輸入調整。

評分題的切分點需輸入逗號分隔數字，再按「套用切分點」更新分支；無效草稿不會改動連線，需修正或取消後才能儲存／測試。已套用移除的出口會連同其連線刪除。

選取決策積木後可把它儲存成範本；再次加入會建立獨立副本，包含信心門檻與低信心預設。JSON 輸出欄位可設固定 JSON 值，或引用該路徑上已執行的決策結果；低於門檻時，引用值會是指定的預設選項。單次測試結果會顯示原始模型答案、採用的分支與信心，信心以百分比顯示至小數點後兩位。

「測試」工作區分為「單次測試／批次測試」。批次測試案例依流程分開保存，包含名稱、文字或 JSON 輸入、預期 JSON 輸出與啟用狀態；執行時只跑啟用案例，並以 JSON 結構比對完整輸出（物件欄位順序不影響，陣列順序有影響）。結果分為通過、未通過與執行錯誤，最近一次各案例結果會保留；流程內容變更時標示舊結果，案例變更時清除舊結果。批次執行使用目前流程內容，包含尚未儲存的編輯。單次／批次切換或工作區切換會保留案例草稿；切換流程時會提示是否捨棄未儲存的流程或案例草稿。

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
網頁頂欄的「API 呼叫」會開啟側邊抽屜，顯示目前流程的完整 `curl` 指令並提供複製按鈕；區網 HTTP 會將暫存文字框放在開啟的對話框內並聚焦後複製，若瀏覽器仍阻擋，錯誤會顯示在對話框中，可手動選取指令或改用 HTTPS。

`/run` 只回傳流程設定的 JSON 物件，不包含 trace envelope。網頁測試使用另一個 endpoint：

```bash
curl -X POST http://localhost:3000/api/flows/<flow-id>/test \
  -H "Content-Type: application/json" \
  -d '{"input":"打開風扇"}'
```

`/test` 回傳 `{ "status": "completed", "output", "trace", "durationMs" }`。網頁「測試」工作區會附上目前流程快照，因此未儲存的編輯也能測試；快照只用於當次測試，不會寫入流程資料。API 抽屜中的 `/run` 使用已儲存流程。API 呼叫省略 `flow` 欄位時則使用已儲存版本。`/run` 回傳流程設定的 JSON；低信心結果也會依指定預設選項繼續執行。舊流程若連接了獨立的「信心不足」出口，需改成一般選項出口並指定為低信心預設。流程支援建立、讀取、更新、刪除；範本支援建立、讀取、刪除。`POST /api/flows/<flow-id>/validate` 檢查流程是否完整。

批次測試 API：`GET /api/flows/<flow-id>/test-cases` 讀取套件；`PUT` 同一路徑以 `{ "revision": <套件版本>, "cases": [...] }` 儲存案例（每個案例包含 `id`、`name`、文字或其他 JSON `input`、物件 `expectedOutput`、`enabled`）。版本不符時回傳 `409`，避免另一個頁面覆蓋較新的案例。`POST /api/flows/<flow-id>/test-cases/run` 接受 `{ "flow": <流程快照> }`，可選擇附上 `caseIds` 只重跑指定案例；省略時執行所有啟用案例。回應包含套件與最近一次各案例結果，單一案例會標示 `passed`、`failed` 或 `error`。因執行結果會寫回正式測試套件，儲存案例與執行此批次 API 需要管理員憑證。

## MCP：AI 草稿與人工覆寫

MCP 只操作隔離的流程草稿；MCP 身份沒有正式流程寫入、套用、歷史還原或範本寫入權限。AI 可讀取正式流程作為來源、建立 `流程-copy` 草稿或新流程草稿、修改草稿流程與測試案例、驗證、單次測試、執行基準／候選批次回歸測試、送審或捨棄。模型只由 API 載入一次；MCP stdio 程序透過 HTTP 呼叫 API，不會再載入模型。

一次性安裝 MCP 套件：

```bash
npm install --prefix mcp
```

根目錄 `.mcp.json` 已加入 Claude Code 的 project-level server `laya-flow`。安裝依賴並啟動 API 後，在 Claude Code 信任此專案並核准此 server。設定直接執行 `tsx`；`mcp/claude-launcher.ts` 從 `data/mcp-token` 讀取憑證，不將 token 寫入設定檔。若 API 使用自訂 `LAYA_DATA_DIR`，MCP host 也需設定相同路徑；`LAYA_API_URL` 可覆寫預設 API URL。

其他 MCP host 可直接執行 stdio server（不要用 `npm run` 啟動 host 命令；npm 會把腳本提示寫到 stdout，污染 MCP JSON-RPC 通道）。請使用本機絕對路徑，並以 `data/mcp-token` 內容替換憑證：

```json
{
  "command": "/完整路徑/laya-test/mcp/node_modules/.bin/tsx",
  "args": ["/完整路徑/laya-test/mcp/mcp-server.ts"],
  "env": {
    "LAYA_API_URL": "http://127.0.0.1:3000",
    "LAYA_MCP_TOKEN": "<data/mcp-token 的內容>"
  }
}
```

- `LAYA_API_URL`：API URL，預設 `http://127.0.0.1:3000`。
- `LAYA_MCP_TOKEN`：API 資料目錄中的 `mcp-token` 內容。預設位置為 `data/mcp-token`；自訂 `LAYA_DATA_DIR` 時改讀該目錄。

API 啟動後可用下列命令手動啟動 stdio server（供 MCP host 以相同方式呼叫；不要將 `admin-token` 提供給 AI agent）：

```bash
LAYA_API_URL=http://127.0.0.1:3000 \
LAYA_MCP_TOKEN="$(cat data/mcp-token)" \
./mcp/node_modules/.bin/tsx mcp/mcp-server.ts
```

MCP host 需直接啟動 stdio 命令，不能用 `npm run` 或把其他輸出混入 stdout，以免污染 MCP JSON-RPC 通道。MCP token 與管理員 token 不同；勿把 `admin-token` 提供給 AI agent。若 API 經網路連線，需使用 HTTPS 並限制 API 可達來源。

人工審查在「草稿」工作區進行（頁面標題為「草稿審查」）：草稿清單預設顯示所有流程草稿，可篩選目前流程或新流程；選取草稿後檢視基準／候選流程差異、預期案例變更、批次結果及失敗 trace。管理員登入後才能執行草稿批次測試、送交審查、捨棄或執行人工套用；只有「草稿」狀態可以送交審查，「審查中」代表已送審，不能重複送審。覆寫前會重新檢查來源完整快照與測試案例 revision；若來源在草稿建立後有任何變更，操作以衝突停止，不能強制蓋過。套用保留正式流程 ID 與名稱，並將套用前的流程及測試案例存入歷史；可以人工確認歷史並以新版本還原。建立新流程草稿時，人工確認後才會新增正式流程。套用或還原都不由 MCP 提供。
審查確認只適用於當前草稿、來源流程／案例版本與批次結果；任何相關資料變更都會要求重新確認。套用或歷史還原期間，編輯器會鎖定流程切換與編輯，並以 API 回傳的新流程及測試套件同步畫面；歷史還原目標是所選草稿的來源流程。

MCP 僅能呼叫 `/api/mcp/...` 的白名單路徑；即使 MCP token 用於一般 API 寫入路徑也會被拒絕。管理員 token 只存在當前瀏覽器 sessionStorage，API 對帶 Origin 的管理員寫入檢查其 Origin/Host 一致；Vite 開發代理保留瀏覽器的 Host，以維持這項同源檢查。

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

建置後可用 `npm start` 單獨啟動 API 與已建置的網頁；API 預設使用 3000 埠，可用 `PORT` 改變。`npm run dev` 同時啟動 API 與 Vite，API 埠優先讀 `API_PORT`、其次 `PORT`、預設 3000；Vite 埠讀 `WEB_PORT`、預設 5173。編輯器顯示的 curl 指令會使用實際 API 埠。

## 磁碟配置

- 根目錄 `node_modules` 是 `../laya/node_modules` 的軟連結。
- `web/node_modules` 安裝編輯器依賴。
- Laya ONNX 模型使用既有 `~/.cache/receptron-laya` 快取。
- `data/decision-system.json` 儲存流程與積木範本。
