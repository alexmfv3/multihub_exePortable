const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onSources: (fn) => ipcRenderer.on('picker:sources', (_e, items) => fn(items)),
  choose: (id) => ipcRenderer.send('picker:choose', id)
});
