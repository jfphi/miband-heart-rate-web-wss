/** 本機預設走 WSS；使用 Firebase 時請填入 firebase 設定並改 defaultBackend */
export const appConfig = {
  defaultBackend: 'wss',
  firebase: {
    apiKey: '',
    authDomain: '',
    databaseURL: '',
    projectId: '',
    appId: '',
  },
  // 由 FastAPI 同機提供時用同源；Pages + 遠端 WSS 時改成 wss://your-api/.../ws
  wsUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
};
