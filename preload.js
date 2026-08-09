const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teklifApp', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (partial) => ipcRenderer.invoke('config:save', partial),
  getUserInfo: () => ipcRenderer.invoke('user:info'),
  resolveSample: () => ipcRenderer.invoke('sample:resolve'),
  createTeklif: (payload) => ipcRenderer.invoke('teklif:create', payload || {}),
  listCustomers: () => ipcRenderer.invoke('customers:list'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  isWebLoggedIn: () => ipcRenderer.invoke('session:isLoggedIn'),
  getCompanyName: () => ipcRenderer.invoke('company:name'),
  listHistory: () => ipcRenderer.invoke('history:list'),
  checkLicense: () => ipcRenderer.invoke('license:check'),
  setDesktopFabBusy: (busy) => ipcRenderer.invoke('desktop-fab:setBusy', !!busy),
  onSessionChanged: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('session:changed', listener);
    return () => ipcRenderer.removeListener('session:changed', listener);
  },
  onOpenFromFab: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('teklif:open-from-fab', listener);
    return () => ipcRenderer.removeListener('teklif:open-from-fab', listener);
  },
});
