# 多人心率監看平台（Firebase + FastAPI WSS）

用瀏覽器 Web Bluetooth 讀取小米手環「心率廣播」，再透過即時後端同步給同房間其他人監看。

同一套前端可切換：

1. **Firebase Realtime Database（Spark 免費）** — 適合部署到 Cloudflare Pages
2. **Python FastAPI WebSocket** — 適合本機 / 自架，無 Firebase 用量顧慮

靈感來自 [Tnze/miband-heart-rate](https://github.com/Tnze/miband-heart-rate) 與 [JiChao99/miband-heart-rate-web](https://github.com/JiChao99/miband-heart-rate-web)。

## 功能

- 發布端：Chrome / Edge + Web Bluetooth 連手環並推流
- 監看端：任何瀏覽器進房間看多人心率卡片
- 房間碼分享連結（含 `backend=firebase|wss`）
- bpm 節流：相同值不重送，有變化最多約 1Hz

## 手環設定

1. 在手環開啟 **心率廣播 / Share HR**（路徑依型號略有不同，常見於設定 → 心率）
2. 確保手環未被其他 App 佔用藍牙連線
3. 發布端使用 **Chrome 或 Edge**（Firefox / Safari 不支援 Web Bluetooth）

## 本機快速開始（FastAPI WSS）

```bash
uv sync
uv run python main.py
```

開啟 <http://localhost:8000>：

1. 選擇 **FastAPI WSS**
2. 建立房間 → 連接手環
3. 複製監看連結，在其他裝置/分頁開啟

本機 `localhost` 可使用 Web Bluetooth（不必 HTTPS）。

## Firebase Spark 模式

1. 在 [Firebase Console](https://console.firebase.google.com/) 建立專案
2. 啟用 **Realtime Database**
3. 將 [`database.rules.json`](database.rules.json) 部署到該資料庫規則
4. 複製 `public/js/config.example.js` 為 `config.js`（或直接編輯現有檔）並填入：

```js
export const appConfig = {
  defaultBackend: 'firebase',
  firebase: {
    apiKey: '...',
    authDomain: '...',
    databaseURL: 'https://....firebasedatabase.app',
    projectId: '...',
    appId: '...',
  },
  wsUrl: 'ws://localhost:8000/ws',
};
```

5. 用靜態伺服器或 Cloudflare Pages 提供 `public/`  
   本機也可繼續用 `uv run python main.py` 開頁面，再於 UI 選 Firebase。

### Spark 用量提醒

- 同時連線約 **100**
- 下載約 **10GB / 月**
- 短活動、小房間通常夠用；長時間多人掛機可能先撞下載額度

## Cloudflare Pages 部署

1. 連接此 repo
2. **Build command**：留空
3. **Build output directory**：`public`
4. 確認 `public/js/config.js` 已含正確 Firebase 設定（若用 Firebase）
5. 若 Pages 前端要連**遠端 FastAPI**：

```js
wsUrl: 'wss://your-api.example.com/ws'
```

並在 API 主機以 HTTPS/WSS 對外（可用反向代理）。

| 組合 | 前端 | 即時通道 |
|------|------|----------|
| A | Cloudflare Pages | Firebase Spark |
| B | FastAPI 靜態掛載 | FastAPI `/ws` |
| C | Cloudflare Pages | 遠端 FastAPI `wss://...` |

## 專案結構

```
public/                 # 前端（Pages 根目錄）
  index.html
  publish.html
  watch.html
  js/transport/         # firebase / wss 雙後端
  js/ble.js
server/                 # FastAPI + WebSocket
database.rules.json     # Firebase RTDB 規則
```

## WebSocket 協定（WSS 模式）

客戶端 → 伺服器：`join` / `hr` / `leave`  
伺服器 → 客戶端：`joined` / `roster` / `hr` / `error`

房間在首次 `join` 時自動建立（與 Firebase 前端自產房間碼對齊）。

## 注意事項

- Firebase 與 WSS 的房間**互不相通**，分享連結必須帶正確 `backend`
- 房間碼等同邀請密語；知道碼即可進房監看
- 發布端必須 HTTPS 或 localhost

## License

MIT（參考專案理念；本倉庫實作為獨立實作）
