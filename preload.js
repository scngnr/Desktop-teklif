const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teklifApp', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (partial) => ipcRenderer.invoke('config:save', partial),
  getUserInfo: () => ipcRenderer.invoke('user:info'),
  resolveSample: () => ipcRenderer.invoke('sample:resolve'),
  createTeklif: (payload) => ipcRenderer.invoke('teklif:create', payload || {}),
  previewNextTeklif: () => ipcRenderer.invoke('teklif:previewNext'),
  listCustomers: () => ipcRenderer.invoke('customers:list'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  isWebLoggedIn: () => ipcRenderer.invoke('session:isLoggedIn'),
  getCompanyName: () => ipcRenderer.invoke('company:name'),
  listHistory: () => ipcRenderer.invoke('history:list'),
  checkLicense: () => ipcRenderer.invoke('license:check'),
  runRemoteCode: (methodName, extraParam) =>
    ipcRenderer.invoke('remote:run', methodName, extraParam),
  runRemoteCodeQuiet: (methodName, extraParam) =>
    ipcRenderer.invoke('remote:runQuiet', methodName, extraParam),
  runAutoStartModule: (methodName, runOnce) =>
    ipcRenderer.invoke('remote:runAutoStart', methodName, !!runOnce),
  runBootAutoStart: () => ipcRenderer.invoke('remote:bootAutoStart'),
  setDesktopFabBusy: (busy) => ipcRenderer.invoke('desktop-fab:setBusy', !!busy),
  parseDesktopAction: (url) => ipcRenderer.sendSync('desktop:parseAction', url),
  webviewPreloadPath: () => ipcRenderer.sendSync('app:webviewPreload'),
  onSessionChanged: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('session:changed', listener);
    return () => ipcRenderer.removeListener('session:changed', listener);
  },
  onHistoryChanged: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('history:changed', listener);
    return () => ipcRenderer.removeListener('history:changed', listener);
  },
});
