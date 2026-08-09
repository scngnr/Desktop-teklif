const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teklifFab', {
  ready: () => ipcRenderer.send('desktop-fab:ready'),
  click: () => ipcRenderer.invoke('desktop-fab:click'),
  onState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('desktop-fab:state', listener);
    return () => ipcRenderer.removeListener('desktop-fab:state', listener);
  },
});
