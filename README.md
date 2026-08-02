# 多人心率監看平台（Firebase + FastAPI WSS）

用瀏覽器 Web Bluetooth 讀取小米手環「心率廣播」，再透過即時後端同步給同房間其他人監看。

後端模式由 **`.env` 的 `MIBAND_BACKEND`** 決定（不在 UI 選擇）：

1. `fastapi_wss` — Python FastAPI WebSocket（本機 / 自架）
2. `firebase` — Firebase Realtime Database Spark（適合 Cloudflare Pages）

靈感來自 [Tnze/miband-heart-rate](https://github.com/Tnze/miband-heart-rate) 與 [JiChao99/miband-heart-rate-web](https://github.com/JiChao99/miband-heart-rate-web)。

## 功能

- 發布端：Chrome / Edge + Web Bluetooth 連手環並推流
- 監看端：任何瀏覽器進房間看多人心率卡片
- 房間碼分享連結
- bpm 節流：相同值不重送，有變化最多約 1Hz

## 手環設定

1. 在手環開啟 **心率廣播 / Share HR**
2. 確保手環未被其他 App 佔用藍牙連線
3. 發布端使用 **Chrome 或 Edge**

## 環境變數（`.env`）

複製 [`.env.example`](.env.example) 為 `.env`：

```env
# fastapi_wss | firebase
MIBAND_BACKEND=fastapi_wss

# 可選：自訂 WSS 位址（留空則用目前網站同源 /ws）
# MIBAND_WS_URL=wss://your-api.example.com/ws

# Firebase（MIBAND_BACKEND=firebase 時必填）
# MIBAND_FIREBASE_API_KEY=
# MIBAND_FIREBASE_AUTH_DOMAIN=
# MIBAND_FIREBASE_DATABASE_URL=
# MIBAND_FIREBASE_PROJECT_ID=
# MIBAND_FIREBASE_APP_ID=
```

FastAPI 會透過 `GET /api/config` 把上述公開設定交給前端。

## 本機快速開始（FastAPI WSS）

```bash
cp .env.example .env   # Windows: copy .env.example .env
# 確認 MIBAND_BACKEND=fastapi_wss
uv sync
uv run python main.py
```

開啟 <http://localhost:8000> → 建立房間 → 連接手環 → 分享監看連結。

## Firebase 模式

1. Firebase Console 建立專案並啟用 Realtime Database
2. 部署 [`database.rules.json`](database.rules.json)
3. `.env` 設為：

```env
MIBAND_BACKEND=firebase
MIBAND_FIREBASE_API_KEY=...
MIBAND_FIREBASE_AUTH_DOMAIN=...
MIBAND_FIREBASE_DATABASE_URL=...
MIBAND_FIREBASE_PROJECT_ID=...
MIBAND_FIREBASE_APP_ID=...
```

4. 本機仍可用 `uv run python main.py`（由 `/api/config` 讀 `.env`）

### Spark 用量提醒

- 同時連線約 **100**
- 下載約 **10GB / 月**

## Cloudflare Pages 部署

純靜態沒有 `/api/config`，需先從 `.env` 產生前端設定：

```bash
uv run python scripts/generate_config.py
```

會寫入 `public/js/config.generated.js`。

Pages 設定：

1. Build command：`uv run python scripts/generate_config.py`（或在 CI 注入同等環境變數後執行）
2. Build output directory：`public`
3. 在 Pages Environment Variables 設定與 `.env` 相同的 `MIBAND_*`

若前端在 Pages、WSS 在遠端 API：`MIBAND_BACKEND=fastapi_wss` 且 `MIBAND_WS_URL=wss://your-api.example.com/ws`。

## 專案結構

```
.env / .env.example     # 後端模式與 Firebase 設定
public/                 # 前端
server/                 # FastAPI + WebSocket + /api/config
scripts/generate_config.py
database.rules.json
```

## License

MIT（參考專案理念；本倉庫實作為獨立實作）
