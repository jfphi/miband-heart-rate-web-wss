/** 複製此檔為 config.js 並填入實際設定 */
export const appConfig = {
  defaultBackend: 'wss', // 'firebase' | 'wss'
  firebase: {
    apiKey: 'YOUR_API_KEY',
    authDomain: 'YOUR_PROJECT.firebaseapp.com',
    databaseURL: 'https://YOUR_PROJECT-default-rtdb.REGION.firebasedatabase.app',
    projectId: 'YOUR_PROJECT',
    appId: 'YOUR_APP_ID',
  },
  // 本機 FastAPI：ws://localhost:8000/ws
  // 生產環境：wss://your-api.example.com/ws
  wsUrl: 'ws://localhost:8000/ws',
};
