const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ctxhub', {
  openDoc: (id) => ipcRenderer.invoke('openDoc', id),
  openMain: () => ipcRenderer.invoke('openMain'),
  openHolo: () => ipcRenderer.invoke('openHolo'),
  brief: () => ipcRenderer.invoke('brief'),
  hide: () => ipcRenderer.invoke('minimizeToday'),
  winAction: (act) => ipcRenderer.send('winAction', act),
  zoom: (dir) => ipcRenderer.send('zoom', dir)
});

// Ctrl + 滚轮缩放页面（Chromium 在 Electron 里默认不开，这里补上）
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  ipcRenderer.send('zoom', e.deltaY < 0 ? 'in' : 'out');
}, { passive: false });
