const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teklifModal', {
  listCustomers: () => ipcRenderer.invoke('customers:list'),
  createTeklif: (payload) => ipcRenderer.invoke('teklif:create', payload || {}),
  previewNextTeklif: () => ipcRenderer.invoke('teklif:previewNext'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  checkLicense: () => ipcRenderer.invoke('license:check'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setDesktopFabBusy: (busy) =>
    ipcRenderer.invoke('desktop-fab:setBusy', !!busy),
  close: () => ipcRenderer.invoke('teklif-modal:close'),
  notifyCreated: () => ipcRenderer.send('teklif-modal:created'),
});
