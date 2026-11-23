const { contextBridge, ipcRenderer } = require('electron');

const call = async (ch, ...args) => {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld('mh', {
  getState: () => call('state:get'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onDownloads: (fn) => ipcRenderer.on('downloads', (_e, l) => fn(l)),
  onOpen: (fn) => ipcRenderer.on('ui:open', (_e, what, arg) => fn(what, arg)),

  addService: (d) => call('service:add', d),
  updateService: (id, patch) => call('service:update', id, patch),
  removeService: (id) => call('service:remove', id),
  sidebarMove: (drag, target) => call('sidebar:move', drag, target),
  setGroup: (id, groupId) => call('service:setGroup', id, groupId),
  activate: (id) => call('service:activate', id),
  action: (id, a) => call('service:action', id, a),
  contextMenu: (id) => call('service:contextMenu', id),
  overlay: (on) => call('ui:overlay', on),
  updateSettings: (p) => call('settings:update', p),

  group: {
    create: (name, serviceId) => call('group:create', name, serviceId),
    update: (id, patch) => call('group:update', id, patch),
    contextMenu: (id) => call('group:contextMenu', id)
  },

  lock: {
    unlock: (pw) => call('lock:unlock', pw),
    lock: () => call('lock:lock'),
    setPassword: (newPw, currentPw) => call('lock:setPassword', newPw, currentPw),
    disable: (pw) => call('lock:disable', pw),
    options: (o) => call('lock:options', o)
  },

  downloads: {
    action: (id, act) => call('downloads:action', id, act),
    clear: () => call('downloads:clear'),
    openDir: () => call('downloads:openDir'),
    chooseDir: () => call('downloads:chooseDir')
  },

  ext: {
    installStore: (input) => call('ext:installStore', input),
    installCrx: () => call('ext:installCrx'),
    installUnpacked: () => call('ext:installUnpacked'),
    remove: (k) => call('ext:remove', k),
    update: (k) => call('ext:update', k),
    toggle: (k, on) => call('ext:toggle', k, on),
    exclude: (k, sid, ex) => call('ext:exclude', k, sid, ex),
    options: (k) => call('ext:options', k),
    popup: (k, rect) => call('ext:popup', k, rect),
    openWebStore: () => call('ext:openWebStore')
  }
});
