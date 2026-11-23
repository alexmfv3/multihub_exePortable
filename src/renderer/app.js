/* global mh */
let S = { services: [], groups: [], extensions: [], catalog: [], downloads: [], settings: {}, lock: {}, activeId: null };

// ── Helpers ────────────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}
const $ = (s) => document.querySelector(s);

let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (error ? ' error' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), error ? 6000 : 3000);
}
async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r === undefined ? true : r; }
  catch (e) { toast(e.message, true); if (!$('#modal-root').children.length) alert(e.message); return undefined; }
}
function fmtBytes(n) {
  if (!n || n < 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`;
}

// Icona del servei: la imatge desada en local o, si no n'hi ha, la inicial sobre el seu color
function iconEl(svc) {
  const letter = h('div', { class: 'letter', style: `background:${svc.color || '#607d8b'}`, text: (svc.name || '?')[0].toUpperCase() });
  if (!svc.icon) return letter;
  const img = h('img', { class: 'icon-img', src: svc.icon, alt: '', draggable: 'false' });
  img.addEventListener('error', () => img.replaceWith(letter));
  return img;
}

// ── Barra lateral (serveis i grups) ─────────────────────────────────────────
// Arrossegar i deixar anar:
//  · Serveis i grups es poden moure lliurement amunt i avall.
//  · La meitat superior d'un element = posar ABANS; la inferior = DESPRÉS.
//  · Sobre la part central d'un grup plegat (o la inferior d'un de desplegat) = posar el servei DINS del grup.
//  · Espai buit del final = moure al final i fora de qualsevol grup.
let drag = null; // { kind: 'service' | 'group', id }
const numbers = () => { const m = new Map(); let n = 0; for (const s of S.services) if (s.enabled) m.set(s.id, ++n); return m; };

function clearDropMarks() {
  for (const el of document.querySelectorAll('.drop-before, .drop-after, .drop-into')) el.classList.remove('drop-before', 'drop-after', 'drop-into');
}

function zoneFor(el, e, target) {
  const r = el.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  if (target.kind === 'group' && drag.kind === 'service') {
    if (target.collapsed) return y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'into';
    return y < 0.5 ? 'before' : 'into'; // desplegat: els membres ja surten a sota
  }
  return y < 0.5 ? 'before' : 'after';
}

function makeDraggable(el, item) {
  el.setAttribute('draggable', 'true');
  el.addEventListener('dragstart', (e) => {
    drag = item; e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.id);
    e.stopPropagation();
    requestAnimationFrame(() => el.classList.add('dragging'));
  });
  el.addEventListener('dragend', () => { drag = null; el.classList.remove('dragging'); clearDropMarks(); });
}

function makeDropTarget(el, target) {
  el.addEventListener('dragover', (e) => {
    if (!drag || (drag.kind === target.kind && drag.id === target.id)) return;
    if (drag.kind === 'group' && target.kind === 'service' && target.groupId === drag.id) return; // dins de si mateix
    e.preventDefault(); e.stopPropagation();
    clearDropMarks();
    el.classList.add(`drop-${zoneFor(el, e, target)}`);
  });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-before', 'drop-after', 'drop-into'); });
  el.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault(); e.stopPropagation();
    const position = zoneFor(el, e, target);
    const d = drag; clearDropMarks();
    run(() => mh.sidebarMove(d, { kind: target.kind, id: target.id, position }));
  });
}

function serviceItem(svc, nums) {
  const idx = nums.get(svc.id);
  const btn = h('button', {
    class: `svc${svc.id === S.activeId ? ' active' : ''}${svc.enabled ? '' : ' disabled'}`,
    title: `${svc.name}${idx && idx < 10 ? `  (Ctrl+${idx})` : ''}${svc.crashed ? ' — s\'ha bloquejat, clica per recarregar' : ''}`,
    onclick: () => {
      if (!svc.enabled) return run(() => mh.updateService(svc.id, { enabled: true }));
      if (svc.crashed) mh.action(svc.id, 'reload');
      mh.activate(svc.id);
    },
    oncontextmenu: (e) => { e.preventDefault(); mh.contextMenu(svc.id); }
  }, iconEl(svc));
  if (svc.badge) btn.append(h('span', { class: 'badge', text: svc.badge > 99 ? '99+' : String(svc.badge) }));
  if (svc.muted || svc.notifications === false) btn.append(h('span', { class: 'corner',
    text: svc.notifications === false ? '🔕' : '🔇', title: svc.notifications === false ? 'Notificacions desactivades' : 'Silenciat' }));
  if (svc.crashed) btn.append(h('span', { class: 'corner', text: '⚠' }));
  const item = h('div', { class: `item${svc.id === S.activeId ? ' current' : ''}` }, btn,
    S.settings.showNames ? h('div', { class: 'label', text: svc.name, title: svc.name }) : null);
  makeDraggable(item, { kind: 'service', id: svc.id });
  makeDropTarget(item, { kind: 'service', id: svc.id, groupId: svc.groupId || null });
  return item;
}

function groupItem(g, members, nums) {
  const containsActive = members.some(m => m.id === S.activeId);
  const badge = members.reduce((a, m) => a + (m.badge || 0), 0);
  const mini = h('div', { class: 'mini' }, members.slice(0, 4).map(m => h('div', { class: 'mini-cell' }, iconEl(m))));
  const head = h('button', {
    class: `svc group-tile${!g.collapsed ? ' open' : ''}${g.collapsed && containsActive ? ' active' : ''}`,
    title: `${g.name} — ${members.length} serveis (clic per ${g.collapsed ? 'desplegar' : 'plegar'}; arrossega per moure'l)`,
    onclick: () => mh.group.update(g.id, { collapsed: !g.collapsed }),
    oncontextmenu: (e) => { e.preventDefault(); mh.group.contextMenu(g.id); }
  }, g.collapsed ? mini : h('div', { class: 'folder-open', text: '▾' }));
  if (g.collapsed && badge) head.append(h('span', { class: 'badge', text: badge > 99 ? '99+' : String(badge) }));

  const headItem = h('div', { class: `item group-head${g.collapsed && containsActive ? ' current' : ''}` }, head,
    S.settings.showNames || !g.collapsed ? h('div', { class: 'label group-label', text: g.name, title: g.name }) : null);
  makeDropTarget(headItem, { kind: 'group', id: g.id, collapsed: g.collapsed });

  const box = h('div', { class: `group${g.collapsed ? '' : ' expanded'}` }, headItem);
  makeDraggable(box, { kind: 'group', id: g.id });
  if (!g.collapsed) for (const m of members) box.append(serviceItem(m, nums));
  return box;
}

function renderSidebar() {
  const list = $('#service-list');
  list.replaceChildren();
  list.classList.toggle('with-names', !!S.settings.showNames);
  const nums = numbers();
  const groups = new Map(S.groups.map(g => [g.id, g]));
  const done = new Set();
  for (const svc of S.services) {
    const g = svc.groupId && groups.get(svc.groupId);
    if (!g) { list.append(serviceItem(svc, nums)); continue; }
    if (done.has(g.id)) continue;
    done.add(g.id);
    list.append(groupItem(g, S.services.filter(s => s.groupId === g.id), nums));
  }
  list.append(h('div', { class: 'list-end' })); // zona per deixar anar al final
}
// Deixar anar a l'espai buit del final = moure al final (fora de qualsevol grup)
const listEl = $('#service-list');
listEl.addEventListener('dragover', (e) => {
  if (!drag) return; e.preventDefault(); clearDropMarks();
  listEl.querySelector('.list-end')?.classList.add('drop-before');
});
listEl.addEventListener('drop', (e) => {
  if (!drag) return; e.preventDefault();
  const d = drag; clearDropMarks();
  run(() => mh.sidebarMove(d, { kind: 'end' }));
});

function renderToolbar() {
  const active = S.services.find(s => s.id === S.activeId);
  $('#active-name').textContent = active ? active.name : '';
  $('#empty').style.display = active && active.enabled ? 'none' : '';
  const box = $('#ext-actions');
  box.replaceChildren();
  for (const ext of S.extensions) {
    if (!ext.enabled || !ext.id || (active && ext.excluded?.includes(active.id))) continue;
    if (!ext.popup && !ext.options) continue;
    const btn = h('button', {
      class: 'ext-btn', title: `${ext.name}${ext.options ? ' (clic dret: opcions)' : ''}`,
      onclick: () => mh.ext.popup(ext.key, btn.getBoundingClientRect().toJSON()),
      oncontextmenu: (e) => { e.preventDefault(); mh.ext.options(ext.key); }
    }, ext.icon ? h('img', { src: ext.icon, alt: '' }) : h('span', { class: 'fallback', text: ext.name.slice(0, 2) }));
    box.append(btn);
  }
  renderDownloadBadge();
}

function renderDownloadBadge() {
  const n = (S.downloads || []).filter(d => d.state === 'progressing').length;
  const b = $('#dl-badge');
  b.textContent = n ? String(n) : '';
  b.className = n ? 'dl-badge' : '';
}

// ── Pantalla de bloqueig ───────────────────────────────────────────────────
function renderLock() {
  const locked = !!S.lock?.locked;
  const ls = $('#lockscreen');
  if (locked && ls.hidden) {
    closeModal(false);
    ls.hidden = false;
    $('#lock-pw').value = ''; $('#lock-error').textContent = '';
    setTimeout(() => $('#lock-pw').focus(), 50);
  } else if (!locked) ls.hidden = true;
}
$('#lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#lock-submit'); btn.disabled = true;
  try {
    const ok = await mh.lock.unlock($('#lock-pw').value);
    if (!ok) { $('#lock-error').textContent = 'Contrasenya incorrecta'; $('#lock-pw').select(); }
  } catch (err) { $('#lock-error').textContent = err.message; }
  btn.disabled = false;
});

let lastExtSig = '';
function render() {
  renderLock();
  if (S.lock?.locked) return;
  renderSidebar(); renderToolbar();
  // Només refem les llistes del modal obert si han canviat (no per cada missatge nou)
  const sig = JSON.stringify([S.extensions.map(e => [e.key, e.enabled, e.excluded, e.version, e.id]),
    S.services.map(s => [s.id, s.name]), S.lock, S.settings, S.groups.map(g => g.name)]);
  if (sig !== lastExtSig) { lastExtSig = sig; currentModal?.refresh?.(); }
  if (currentModal?.kind === 'downloads') currentModal.refreshDownloads();
}

// ── Modals ─────────────────────────────────────────────────────────────────
let currentModal = null;
function openModal(title, body, footer = [], opts = {}) {
  closeModal(false);
  const root = $('#modal-root');
  const m = h('div', { class: `modal${opts.wide ? ' wide' : ''}`, onclick: (e) => e.stopPropagation() },
    h('header', {}, h('h2', { text: title }), opts.headerExtra || null, h('button', { class: 'close', text: '✕', onclick: () => closeModal() })),
    h('div', { class: 'body' }, body),
    footer.length ? h('footer', {}, footer) : null);
  root.onclick = () => closeModal();
  root.replaceChildren(m);
  mh.overlay(true);
  currentModal = { el: m, ...opts };
  setTimeout(() => m.querySelector('input:not([type=checkbox])')?.focus(), 30);
  return m;
}
function closeModal(restore = true) {
  if (!currentModal) return;
  $('#modal-root').replaceChildren();
  currentModal = null;
  if (restore) mh.overlay(false);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function groupSelect(defaultName) {
  const sel = h('select', {},
    h('option', { value: '', text: 'Sense grup' }),
    S.groups.map(g => h('option', { value: g.id, text: g.name })),
    h('option', { value: '__new', text: '＋ Nou grup…' }));
  const name = h('input', { type: 'text', value: defaultName, placeholder: 'Nom del grup' });
  const nameRow = h('div', { class: 'hint-row', style: 'display:none' }, name);
  sel.onchange = () => { nameRow.style.display = sel.value === '__new' ? '' : 'none'; if (sel.value === '__new') name.focus(); };
  return { sel, nameRow, value: () => sel.value === '__new' ? { newGroup: name.value } : { groupId: sel.value || null } };
}

// Afegir / editar servei --------------------------------------------------------
function showAdd() {
  const grid = h('div', { class: 'grid' });
  for (const c of S.catalog) {
    const count = S.services.filter(s => s.type === c.type).length;
    grid.append(h('button', { class: 'cat', onclick: () => showAddForm(c) },
      h('div', { class: 'icon' }, iconEl(c)), h('div', { text: c.name }),
      count ? h('div', { class: 'hint', text: `${count} compte${count > 1 ? 's' : ''}` }) : null));
  }
  openModal('Afegeix un servei', h('div', {},
    h('p', { class: 'hint', text: 'Pots afegir el mateix servei tantes vegades com vulguis: cada compte té la seva sessió independent.' }), grid));
}

function showAddForm(c, existing = null) {
  const count = S.services.filter(s => s.type === c.type).length;
  const name = h('input', { type: 'text', value: existing ? existing.name : (count ? `${c.name} ${count + 1}` : c.name) });
  const url = h('input', { type: 'url', value: existing ? existing.url : c.url, placeholder: 'https://...' });
  // Si ja hi ha un grup amb el nom del servei (p. ex. "Claude"), el proposem per defecte
  const grp = groupSelect(c.name);
  if (!existing) { const same = S.groups.find(g => g.name.toLowerCase() === c.name.toLowerCase()); if (same) grp.sel.value = same.id; }
  else grp.sel.value = existing.groupId || '';
  const save = h('button', { class: 'primary', text: existing ? 'Desa' : 'Afegeix' });
  const submit = async () => {
    save.disabled = true;
    const g = grp.value();
    const ok = await run(async () => {
      if (existing) {
        await mh.updateService(existing.id, { name: name.value, url: url.value });
        if (g.newGroup) await mh.group.create(g.newGroup, existing.id);
        else if ((g.groupId || null) !== (existing.groupId || null)) await mh.setGroup(existing.id, g.groupId);
      } else await mh.addService({ type: c.type, name: name.value, url: url.value, ...g });
    });
    save.disabled = false;
    if (ok !== undefined) closeModal();
  };
  save.onclick = submit;
  for (const i of [name, url]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  openModal(existing ? `Edita — ${existing.name}` : `Nou compte: ${c.name}`, h('div', {},
    h('label', { text: 'Nom (p. ex. "Feina", "Personal")' }), name,
    h('label', { text: 'Adreça' }), url,
    c.hint ? h('div', { class: 'hint', text: c.hint }) : null,
    h('label', { text: 'Grup' }), grp.sel, grp.nameRow),
  [existing ? null : h('button', { class: 'btn', text: '‹ Enrere', onclick: showAdd }), save].filter(Boolean));
}

// Grups ------------------------------------------------------------------------
function showGroupName({ serviceId, groupId }) {
  const g = groupId && S.groups.find(x => x.id === groupId);
  const svc = serviceId && S.services.find(s => s.id === serviceId);
  const cat = svc && S.catalog.find(c => c.type === svc.type);
  const name = h('input', { type: 'text', value: g ? g.name : (cat?.name || '') });
  const save = h('button', { class: 'primary', text: g ? 'Reanomena' : 'Crea el grup' });
  const submit = async () => {
    if (!name.value.trim()) return;
    const ok = await run(() => g ? mh.group.update(g.id, { name: name.value }) : mh.group.create(name.value, serviceId));
    if (ok !== undefined) closeModal();
  };
  save.onclick = submit;
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  openModal(g ? 'Reanomena el grup' : 'Nou grup', h('div', {},
    h('label', { text: 'Nom del grup' }), name,
    !g ? h('div', { class: 'hint', text: 'Després pots arrossegar altres serveis a sobre del grup per afegir-los-hi.' }) : null), [save]);
}

// Extensions --------------------------------------------------------------------
function showExtensions() {
  const input = h('input', { type: 'text', placeholder: 'Enllaç de la Chrome Web Store o ID (p. ex. bhghoamapcdpbohphigoooaddinpkbai)' });
  const installBtn = h('button', { class: 'primary', text: 'Instal·la' });
  const doInstall = async () => {
    if (!input.value.trim()) return;
    installBtn.disabled = true; installBtn.replaceChildren(h('span', { class: 'spinner' }));
    const r = await run(() => mh.ext.installStore(input.value.trim()));
    installBtn.disabled = false; installBtn.textContent = 'Instal·la';
    if (r) { toast(`✔ ${r.name} instal·lada a tots els serveis`); input.value = ''; }
  };
  installBtn.onclick = doInstall;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doInstall(); });

  const list = h('div');
  const fill = () => {
    list.replaceChildren();
    if (!S.extensions.length) list.append(h('div', { class: 'empty-list', text: 'Encara no hi ha cap extensió. Prova amb Authenticator: enganxa el seu enllaç de la Web Store a dalt.' }));
    for (const ext of S.extensions) list.append(extItem(ext));
  };
  fill();

  openModal('Extensions del navegador', h('div', {},
    h('div', { class: 'ext-install' },
      h('div', { class: 'row' }, input, installBtn),
      h('div', { class: 'row' },
        h('button', { class: 'btn', text: '📦 Fitxer .crx / .zip', onclick: async () => { const r = await run(() => mh.ext.installCrx()); if (r && r.name) toast(`✔ ${r.name} instal·lada`); } }),
        h('button', { class: 'btn', text: '📁 Carpeta descomprimida', onclick: async () => { const r = await run(() => mh.ext.installUnpacked()); if (r && r.name) toast(`✔ ${r.name} instal·lada`); } }),
        h('button', { class: 'btn', text: '↗ Obre la Chrome Web Store', onclick: () => mh.ext.openWebStore() })),
      h('div', { class: 'hint', text: 'Cada extensió s\'activa a TOTS els serveis. Les seves dades (p. ex. els codis d\'Authenticator) són compartides entre tots els comptes.' })),
    list), [], { refresh: fill });
}

function extItem(ext) {
  const toggle = h('input', { type: 'checkbox', checked: ext.enabled, onchange: () => run(() => mh.ext.toggle(ext.key, toggle.checked)) });
  const svcBox = h('div');
  for (const s of S.services) {
    const cb = h('input', { type: 'checkbox', checked: !ext.excluded?.includes(s.id),
      onchange: () => run(() => mh.ext.exclude(ext.key, s.id, !cb.checked)) });
    svcBox.append(h('label', { class: 'svc-check' }, cb, s.name));
  }
  const applied = S.services.length - S.services.filter(s => ext.excluded?.includes(s.id)).length;
  const src = { webstore: 'Chrome Web Store', crx: 'Fitxer CRX', zip: 'Fitxer ZIP', unpacked: 'Carpeta local' }[ext.source] || ext.source;
  return h('div', { class: `ext-item${ext.enabled ? '' : ' off'}` },
    ext.icon ? h('img', { src: ext.icon, alt: '' }) : h('div', { class: 'noicon', text: '🧩' }),
    h('div', { class: 'info' },
      h('div', { class: 'title', text: ext.name }),
      h('div', { class: 'meta', text: `v${ext.version} · MV${ext.manifestVersion || '?'} · ${src}${ext.id ? '' : ' · ⚠ no carregada'}` }),
      ext.description ? h('div', { class: 'desc', text: ext.description }) : null,
      h('div', { class: 'actions' },
        ext.options ? h('button', { class: 'btn', text: 'Opcions', onclick: () => mh.ext.options(ext.key) }) : null,
        (ext.source === 'webstore' || ext.source === 'unpacked') ? h('button', { class: 'btn', text: 'Actualitza',
          onclick: () => run(() => mh.ext.update(ext.key), 'Extensió actualitzada') }) : null,
        h('button', { class: 'btn', text: 'Elimina', onclick: () => {
          if (confirm(`Vols eliminar "${ext.name}"? Se'n perdran les dades (p. ex. els codis desats).`)) run(() => mh.ext.remove(ext.key), 'Extensió eliminada');
        } })),
      S.services.length ? h('details', {}, h('summary', { text: `S'aplica a ${applied} de ${S.services.length} serveis` }), svcBox) : null),
    h('label', { class: 'switch', title: ext.enabled ? 'Activada' : 'Desactivada' }, toggle, h('span')));
}

// Descàrregues ------------------------------------------------------------------
const DL_STATE = { progressing: 'Descarregant', completed: 'Completada', cancelled: 'Cancel·lada', interrupted: 'Interrompuda' };
function showDownloads() {
  const list = h('div', { class: 'dl-list' });
  const fill = () => {
    list.replaceChildren();
    if (!S.downloads.length) { list.append(h('div', { class: 'empty-list', text: 'No hi ha cap descàrrega.' })); return; }
    for (const d of S.downloads) list.append(dlItem(d));
  };
  fill();
  openModal('Descàrregues', list, [
    h('button', { class: 'btn', text: '📂 Obre la carpeta', onclick: () => mh.downloads.openDir() }),
    h('button', { class: 'btn', text: 'Neteja l\'historial', onclick: () => run(() => mh.downloads.clear()) })
  ], { kind: 'downloads', refreshDownloads: fill, wide: true });
}

function dlItem(d) {
  const pct = d.total > 0 ? Math.min(100, Math.round(d.received / d.total * 100)) : null;
  const btn = (text, act, cls = 'btn') => h('button', { class: cls, text, onclick: () => run(() => mh.downloads.action(d.id, act)) });
  const prog = d.state === 'progressing';
  let meta = `${d.service || ''} · `;
  if (prog) meta += d.paused ? `En pausa · ${fmtBytes(d.received)} de ${fmtBytes(d.total)}` : `${fmtBytes(d.received)} de ${fmtBytes(d.total)}${pct != null ? ` (${pct}%)` : ''}`;
  else meta += `${DL_STATE[d.state] || d.state}${d.state === 'completed' ? ` · ${fmtBytes(d.total || d.received)}` : ''}${d.state === 'completed' && d.exists === false ? ' · el fitxer ja no existeix' : ''}`;
  meta += ` · ${new Date(d.start).toLocaleString('ca-ES', { dateStyle: 'short', timeStyle: 'short' })}`;
  const ext = (d.filename.split('.').pop() || '').slice(0, 4).toUpperCase();
  return h('div', { class: `dl-item ${d.state}` },
    h('div', { class: 'dl-icon', text: ext || '📄' }),
    h('div', { class: 'info' },
      h('div', { class: 'title', text: d.filename, title: d.savePath || d.url }),
      h('div', { class: 'meta', text: meta }),
      prog ? h('div', { class: 'bar' }, h('div', { class: `fill${pct == null ? ' indeterminate' : ''}`, style: `width:${pct ?? 30}%` })) : null,
      h('div', { class: 'actions' },
        prog && !d.paused ? btn('⏸ Pausa', 'pause') : null,
        prog && d.paused ? btn('▶ Reprèn', 'resume') : null,
        prog ? btn('✕ Cancel·la', 'cancel') : null,
        d.state === 'completed' && d.exists !== false ? btn('Obre', 'open', 'primary small') : null,
        d.state === 'completed' && d.exists !== false ? btn('Mostra a la carpeta', 'folder') : null,
        (d.state === 'cancelled' || d.state === 'interrupted') ? btn('↻ Torna-ho a provar', 'retry') : null,
        !prog ? btn('Treu de la llista', 'remove') : null,
        d.state === 'completed' && d.exists !== false ? h('button', { class: 'btn', text: '🗑 Envia a la paperera', onclick: () => {
          if (confirm(`Vols enviar "${d.filename}" a la paperera?`)) run(() => mh.downloads.action(d.id, 'deleteFile'));
        } }) : null)));
}

// Configuració ------------------------------------------------------------------
function showSettings() {
  const body = h('div');
  const fill = () => {
    body.replaceChildren();
    const sw = (checked, onchange) => { const cb = h('input', { type: 'checkbox', checked: !!checked, onchange: () => onchange(cb.checked) }); return h('label', { class: 'switch' }, cb, h('span')); };
    const row = (title, hint, control) => h('div', { class: 'setting' }, h('div', {}, h('div', { text: title }), hint ? h('div', { class: 'hint', text: hint }) : null), control);
    const set = (key) => sw(S.settings[key], (v) => mh.updateSettings({ [key]: v }));

    body.append(h('h3', { text: 'General' }),
      row('Mostra el nom de cada servei', 'Sota la icona, a la barra lateral.', set('showNames')),
      row('Tancar a la safata del sistema', 'En tancar la finestra, MultiHub continua obert per rebre notificacions.', set('closeToTray')),
      row('Iniciar minimitzat', 'Arrenca directament a la safata.', set('startMinimized')),
      row('Compatibilitat d\'inici de sessió de Google', 'Evita l\'error "Aquest navegador pot no ser segur".', set('googleLoginCompat')));

    // Descàrregues
    body.append(h('h3', { text: 'Descàrregues' }),
      row('Carpeta de descàrregues', S.settings.downloadDir || 'Carpeta de Baixades de l\'usuari',
        h('button', { class: 'btn', text: 'Canvia…', onclick: () => run(() => mh.downloads.chooseDir()) })),
      row('Pregunta on desar cada fitxer', 'Si està desactivat, es desen directament a la carpeta.', set('askDownload')));

    // Contrasenya mestra
    body.append(h('h3', { text: 'Contrasenya mestra' }));
    const L = S.lock || {};
    if (!L.enabled) {
      const p1 = h('input', { type: 'password', placeholder: 'Nova contrasenya (mínim 4 caràcters)' });
      const p2 = h('input', { type: 'password', placeholder: 'Repeteix-la' });
      body.append(h('div', { class: 'hint', text: 'Bloqueja MultiHub perquè ningú no pugui veure els teus comptes sense la contrasenya. Si l\'oblides, no es pot recuperar.' }),
        h('div', { class: 'row pw-row' }, p1, p2,
          h('button', { class: 'primary', text: 'Activa', onclick: () => {
            if (p1.value !== p2.value) return toast('Les contrasenyes no coincideixen', true);
            run(() => mh.lock.setPassword(p1.value), '🔒 Contrasenya mestra activada. Ctrl+L per bloquejar.');
          } })));
    } else {
      const minutes = h('select', { onchange: () => mh.lock.options({ autoMinutes: Number(minutes.value) }) },
        [0, 1, 5, 10, 15, 30, 60].map(m => h('option', { value: String(m), text: m ? `Després de ${m} min d'inactivitat` : 'Mai', selected: L.autoMinutes === m })));
      const cur = h('input', { type: 'password', placeholder: 'Contrasenya actual' });
      const n1 = h('input', { type: 'password', placeholder: 'Nova contrasenya' });
      const n2 = h('input', { type: 'password', placeholder: 'Repeteix la nova' });
      const off = h('input', { type: 'password', placeholder: 'Contrasenya actual' });
      body.append(
        row('Bloqueig automàtic', null, minutes),
        row('Bloqueja quan es bloqueja Windows o s\'atura l\'ordinador', null, sw(L.onSystemLock, (v) => mh.lock.options({ onSystemLock: v }))),
        row('Bloqueja ara', 'Drecera: Ctrl+L', h('button', { class: 'btn', text: '🔒 Bloqueja', onclick: () => mh.lock.lock() })),
        h('details', {}, h('summary', { text: 'Canvia la contrasenya' }),
          h('div', { class: 'row pw-row' }, cur, n1, n2, h('button', { class: 'primary', text: 'Canvia', onclick: () => {
            if (n1.value !== n2.value) return toast('Les contrasenyes noves no coincideixen', true);
            run(() => mh.lock.setPassword(n1.value, cur.value), 'Contrasenya canviada');
          } }))),
        h('details', {}, h('summary', { text: 'Desactiva la contrasenya mestra' }),
          h('div', { class: 'row pw-row' }, off, h('button', { class: 'danger', text: 'Desactiva', onclick: () => run(() => mh.lock.disable(off.value), 'Contrasenya mestra desactivada') }))));
    }

    body.append(h('p', { class: 'hint', text: 'Dreceres: Ctrl+1…9 canviar de servei · Ctrl+Tab següent · Ctrl+R recarregar · Ctrl+N afegir · Ctrl+E extensions · Ctrl+J descàrregues · Ctrl+L bloquejar · Ctrl+Shift+M silenciar.' }));
  };
  fill();
  openModal('Configuració', body, [], { refresh: fill });
}

function showRemove(id) {
  const svc = S.services.find(s => s.id === id); if (!svc) return;
  openModal('Eliminar servei', h('p', { text: `Segur que vols eliminar "${svc.name}"? Es tancarà la sessió i s'esborraran les seves dades locals.` }),
    [h('button', { class: 'btn', text: 'Cancel·la', onclick: () => closeModal() }),
     h('button', { class: 'danger', text: 'Elimina', onclick: async () => { await run(() => mh.removeService(id)); closeModal(); } })]);
}

// ── Esdeveniments ───────────────────────────────────────────────────────────
$('#btn-add').onclick = showAdd;
$('#empty-add').onclick = showAdd;
$('#btn-ext').onclick = showExtensions;
$('#btn-settings').onclick = showSettings;
$('#btn-downloads').onclick = showDownloads;
$('#btn-lock').onclick = () => {
  if (S.lock?.enabled) mh.lock.lock();
  else { showSettings(); toast('Primer defineix una contrasenya mestra'); }
};
for (const b of document.querySelectorAll('#toolbar [data-act]')) b.onclick = () => S.activeId && mh.action(S.activeId, b.dataset.act);

mh.onState((s) => { S = s; render(); });
mh.onDownloads((list) => {
  const exists = new Map(S.downloads.map(d => [d.id, d.exists]));
  S.downloads = list.map(d => ({ ...d, exists: exists.get(d.id) }));
  renderDownloadBadge();
  if (currentModal?.kind === 'downloads') currentModal.refreshDownloads();
});
mh.onOpen((what, arg) => {
  if (S.lock?.locked) return;
  if (what === 'add') showAdd();
  else if (what === 'extensions') showExtensions();
  else if (what === 'settings') showSettings();
  else if (what === 'downloads') showDownloads();
  else if (what === 'remove') showRemove(arg);
  else if (what === 'newGroup') showGroupName({ serviceId: arg });
  else if (what === 'renameGroup') showGroupName({ groupId: arg });
  else if (what === 'edit') {
    const svc = S.services.find(s => s.id === arg);
    const cat = S.catalog.find(c => c.type === svc?.type);
    if (svc && cat) showAddForm(cat, svc);
  }
});
mh.getState().then((s) => { S = s; render(); });
