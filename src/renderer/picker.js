/* global picker */
let items = [], tab = 'screen', selected = null;
const grid = document.getElementById('grid');
const go = document.getElementById('go');

function render() {
  grid.replaceChildren();
  for (const it of items.filter(i => (tab === 'screen') === i.screen)) {
    const b = document.createElement('button');
    b.className = 'src' + (it.id === selected ? ' sel' : '');
    const img = document.createElement('img'); img.src = it.thumb; img.alt = '';
    const name = document.createElement('div'); name.textContent = it.name;
    b.append(img, name);
    b.onclick = () => { selected = it.id; go.disabled = false; render(); };
    b.ondblclick = () => picker.choose(it.id);
    grid.append(b);
  }
}
for (const t of document.querySelectorAll('.tab')) {
  t.onclick = () => {
    tab = t.dataset.t;
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
    render();
  };
}
go.onclick = () => selected && picker.choose(selected);
document.getElementById('cancel').onclick = () => picker.choose(null);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') picker.choose(null); });
picker.onSources((list) => { items = list; const first = items.find(i => i.screen); if (first) { selected = first.id; go.disabled = false; } render(); });
