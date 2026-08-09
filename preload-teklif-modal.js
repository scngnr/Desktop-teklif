const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teklifModal', {
  listCustomers: () => ipcRenderer.invoke('customers:list'),
  createTeklif: (payload) => ipcRenderer.invoke('teklif:create', payload || {}),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  checkLicense: () => ipcRenderer.invoke('license:check'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  close: () => ipcRenderer.invoke('teklif-modal:close'),
  notifyCreated: () => ipcRenderer.send('teklif-modal:created'),
});
