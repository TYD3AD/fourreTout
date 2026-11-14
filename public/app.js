const $ = selector => document.querySelector(selector);
const board = $('#board');
const boardContent = $('#board-content');
const state = { items: [], selection: new Set(), viewFilter: 'all', selectedTool: 'select', editingItemId: null, zoom: 100, panX: 0, panY: 0, moving: null, activeShareItem: null, activeShareItems: [], shareAsBundle: false, activeShareToken: null, toastTimer: null };

function iconFor(type) {
  return ({ note: '▧', link: '↗', file: '▤', image: '▧' })[type] || '▤';
}
function formatSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} Mo`;
}
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
}
async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || `Erreur ${response.status}`);
  return data;
}
function displayLogin() {
  $('#login-screen').hidden = false;
  $('#app-shell').hidden = true;
  $('#share-screen').hidden = true;
}
function displayApp(username) {
  $('#login-screen').hidden = true;
  $('#share-screen').hidden = true;
  $('#app-shell').hidden = false;
  $('#profile-name').textContent = username;
  $('#settings-username').textContent = username;
  $('#profile-avatar').textContent = username.slice(0, 2).toUpperCase();
  $('.avatar-small').textContent = username.slice(0, 2).toUpperCase();
}
function setItems(items) {
  state.items = items;
  renderItems();
}
function renderItems() {
  boardContent.querySelectorAll('.item-card').forEach(card => card.remove());
  const visibleItems = state.viewFilter === 'favorites'
    ? state.items.filter(item => item.favorite)
    : state.viewFilter === 'recent'
      ? [...state.items].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8)
      : state.items;
  board.classList.toggle('has-items', visibleItems.length > 0);
  $('#board-count').textContent = state.viewFilter === 'recent' ? `${visibleItems.length} récents` : state.viewFilter === 'favorites' ? `${visibleItems.length} favori${visibleItems.length === 1 ? '' : 's'}` : `${state.items.length} élément${state.items.length === 1 ? '' : 's'}`;
  state.selection = new Set([...state.selection].filter(id => state.items.some(item => item.id === id)));
  for (const item of visibleItems) boardContent.append(makeCard(item));
  updateSelectionUi();
}
function updateSelectionUi() {
  const count = state.selection.size;
  $('#selection-count').textContent = String(count);
  $('#selection-bar').hidden = count === 0;
  boardContent.querySelectorAll('.item-card').forEach(card => {
    const selected = state.selection.has(card.dataset.id);
    card.classList.toggle('is-selected', selected);
    card.setAttribute('aria-checked', String(selected));
  });
}
function toggleSelection(id) {
  if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id);
  updateSelectionUi();
}
function updateCanvasTransform() {
  const scale = state.zoom / 100;
  boardContent.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${scale})`;
  $('.board-grid').style.backgroundSize = `${19 * scale}px ${19 * scale}px`;
}
function fitBoard() {
  const cards = [...boardContent.querySelectorAll('.item-card')];
  if (!cards.length) { state.zoom = 100; state.panX = 0; state.panY = 0; }
  else {
    const bounds = board.getBoundingClientRect();
    const minX = Math.min(...cards.map(card => card.offsetLeft));
    const minY = Math.min(...cards.map(card => card.offsetTop));
    const maxX = Math.max(...cards.map(card => card.offsetLeft + card.offsetWidth));
    const maxY = Math.max(...cards.map(card => card.offsetTop + card.offsetHeight));
    const scale = Math.min(1, (bounds.width - 70) / Math.max(1, maxX - minX), (bounds.height - 70) / Math.max(1, maxY - minY));
    state.zoom = Math.round(scale * 100);
    state.panX = Math.max(20, (bounds.width - (maxX - minX) * scale) / 2 - minX * scale);
    state.panY = Math.max(20, (bounds.height - (maxY - minY) * scale) / 2 - minY * scale);
  }
  $('#zoom-level').textContent = `${state.zoom} %`;
  updateCanvasTransform();
}
function makeCard(item) {
  const card = document.createElement('article');
  card.className = 'item-card';
  card.dataset.id = item.id;
  card.dataset.type = item.type;
  card.style.left = `${item.x ?? 12}%`;
  card.style.top = `${item.y ?? 16}%`;
  card.setAttribute('role', 'checkbox');
  card.setAttribute('aria-label', item.title);
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-checked', 'false');
  if (item.type === 'file' && /^image\/(jpeg|png|gif|webp)$/.test(item.mimeType || '')) {
    const image = document.createElement('img');
    image.className = 'item-image';
    image.alt = item.title;
    image.loading = 'lazy';
    image.src = `/api/items/${encodeURIComponent(item.id)}/preview`;
    card.append(image);
  } else if (item.type === 'file' && (item.mimeType === 'application/pdf' || item.title.toLowerCase().endsWith('.pdf'))) {
    const pdf = document.createElement('iframe');
    pdf.className = 'file-preview pdf-preview';
    pdf.title = `Première page de ${item.title}`;
    pdf.loading = 'lazy';
    pdf.src = `/api/items/${encodeURIComponent(item.id)}/preview#page=1&toolbar=0&view=FitH`;
    pdf.tabIndex = -1;
    card.append(pdf);
  } else if (item.type === 'file' && item.title.toLowerCase().endsWith('.docx')) {
    const preview = document.createElement('div');
    preview.className = 'docx-preview';
    preview.dataset.previewItem = item.id;
    preview.textContent = 'Chargement de l’aperçu…';
    card.append(preview);
    api(`/api/items/${encodeURIComponent(item.id)}/preview-text`).then(result => {
      if (!preview.isConnected) return;
      preview.textContent = result.text || 'Ce document ne contient pas de texte prévisualisable.';
    }).catch(() => { if (preview.isConnected) preview.textContent = 'Aperçu DOCX indisponible.'; });
  }
  const body = document.createElement('div');
  body.className = 'item-body';
  const top = document.createElement('div');
  top.className = 'item-topline';
  if (!(item.type === 'file' && /^image\/(jpeg|png|gif|webp)$/.test(item.mimeType || ''))) {
    const icon = document.createElement('span');
    icon.className = 'item-icon';
    icon.textContent = iconFor(item.type);
    top.append(icon);
  }
  const heading = document.createElement('div');
  heading.className = 'item-heading';
  const title = document.createElement('strong');
  title.textContent = item.title;
  const kind = document.createElement('small');
  kind.textContent = item.type === 'file' ? `${item.mimeType?.split('/')[1]?.toUpperCase() || 'FICHIER'} · ${formatSize(item.size)}` : item.type === 'link' ? 'LIEN' : 'NOTE';
  heading.append(title, kind);
  top.append(heading);
  body.append(top);
  if (item.type === 'note' || item.type === 'link') {
    const content = document.createElement('p');
    content.className = 'item-content';
    content.textContent = item.content;
    content.title = 'Cliquer pour copier le contenu';
    content.addEventListener('pointerdown', event => event.stopPropagation());
    content.addEventListener('click', async event => {
      event.stopPropagation();
      try { await navigator.clipboard.writeText(item.content); showToast('Contenu copié dans le presse-papiers.'); }
      catch { showToast('Copie impossible. Vérifiez les autorisations du navigateur.'); }
    });
    body.append(content);
    if (item.type === 'note') {
      const tag = document.createElement('span');
      tag.className = 'item-tag';
      tag.textContent = 'À explorer';
      body.append(tag);
    }
  } else if (item.type === 'file') {
    const lock = document.createElement('div');
    lock.className = 'item-lock';
    lock.innerHTML = '<span aria-hidden="true">⌑</span> Privé · partageable avec mot de passe';
    body.append(lock);
  }
  card.append(body);
  const actions = document.createElement('div');
  actions.className = 'item-actions';
  actions.setAttribute('aria-label', 'Actions de la ressource');
  const share = document.createElement('button');
  share.type = 'button'; share.title = 'Créer un lien protégé'; share.setAttribute('aria-label', 'Créer un lien protégé'); share.innerHTML = '<span aria-hidden="true">↗</span><span class="action-label">Partager</span>';
  share.addEventListener('pointerdown', event => event.stopPropagation());
  share.addEventListener('click', event => { event.stopPropagation(); openShare(item); });
  const favorite = document.createElement('button');
  favorite.type = 'button'; favorite.title = item.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'; favorite.setAttribute('aria-label', favorite.title); favorite.className = item.favorite ? 'is-favorite' : ''; favorite.innerHTML = `<span aria-hidden="true">${item.favorite ? '★' : '☆'}</span><span class="action-label">Favori</span>`;
  favorite.addEventListener('pointerdown', event => event.stopPropagation());
  favorite.addEventListener('click', async event => {
    event.stopPropagation();
    try { await api(`/api/items/${encodeURIComponent(item.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: !item.favorite }) }); item.favorite = !item.favorite; renderItems(); }
    catch (error) { showToast(error.message); }
  });
  const remove = document.createElement('button');
  remove.type = 'button'; remove.title = 'Supprimer'; remove.setAttribute('aria-label', `Supprimer ${item.title}`); remove.className = 'delete'; remove.innerHTML = '<span aria-hidden="true">×</span><span class="action-label">Supprimer</span>';
  remove.addEventListener('pointerdown', event => event.stopPropagation());
  remove.addEventListener('click', event => { event.stopPropagation(); deleteItem(item); });
  if (item.type === 'note' || item.type === 'link') {
    const edit = document.createElement('button');
    edit.type = 'button'; edit.title = 'Modifier'; edit.setAttribute('aria-label', `Modifier ${item.title}`); edit.innerHTML = '<span aria-hidden="true">✎</span><span class="action-label">Modifier</span>';
    edit.addEventListener('pointerdown', event => event.stopPropagation());
    edit.addEventListener('click', event => { event.stopPropagation(); openModal(item.type, item); });
    actions.append(share, favorite, edit, remove);
  } else actions.append(share, favorite, remove);
  card.append(actions);
  card.addEventListener('pointerdown', startMove);
  card.addEventListener('pointermove', moveItem);
  card.addEventListener('pointerup', finishMove);
  card.addEventListener('pointercancel', finishMove);
  card.addEventListener('keydown', event => {
    if (event.target !== card || (event.key !== ' ' && event.key !== 'Enter')) return;
    event.preventDefault();
    toggleSelection(item.id);
  });
  return card;
}
function startMove(event) {
  if (event.button !== 0 || event.target.closest('button')) return;
  const card = event.currentTarget;
  const cardRect = card.getBoundingClientRect();
  const scale = state.zoom / 100;
  state.moving = { card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, dx: (event.clientX - cardRect.left) / scale, dy: (event.clientY - cardRect.top) / scale };
  card.setPointerCapture(event.pointerId);
  card.classList.add('is-moving');
  event.preventDefault();
}
function moveItem(event) {
  const moving = state.moving;
  if (!moving || moving.card !== event.currentTarget || moving.pointerId !== event.pointerId) return;
  if (!moving.moved && Math.hypot(event.clientX - moving.startX, event.clientY - moving.startY) < 5) return;
  moving.moved = true;
  const rect = board.getBoundingClientRect();
  const scale = state.zoom / 100;
  const left = Math.max(0, Math.min(rect.width - moving.card.offsetWidth, (event.clientX - rect.left - state.panX) / scale - moving.dx));
  const top = Math.max(0, Math.min(rect.height - moving.card.offsetHeight, (event.clientY - rect.top - state.panY) / scale - moving.dy));
  moving.card.style.left = `${left}px`;
  moving.card.style.top = `${top}px`;
}
async function finishMove(event) {
  const moving = state.moving;
  if (!moving || moving.card !== event.currentTarget) return;
  state.moving = null;
  moving.card.classList.remove('is-moving');
  if (!moving.moved) { toggleSelection(moving.card.dataset.id); return; }
  const rect = board.getBoundingClientRect();
  const x = Math.round(moving.card.offsetLeft / rect.width * 1000) / 10;
  const y = Math.round(moving.card.offsetTop / rect.height * 1000) / 10;
  const item = state.items.find(entry => entry.id === moving.card.dataset.id);
  if (item) { item.x = x; item.y = y; }
  try { await api(`/api/items/${encodeURIComponent(moving.card.dataset.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x, y }) }); }
  catch (error) { showToast(error.message); }
}
async function deleteItem(item) {
  if (!confirm(`Supprimer « ${item.title} » et révoquer ses liens de partage ?`)) return;
  try {
    await api(`/api/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    setItems(state.items.filter(entry => entry.id !== item.id));
    showToast('Ressource supprimée.');
  } catch (error) { showToast(error.message); }
}
function openModal(type, item = null) {
  state.selectedTool = type;
  state.editingItemId = item?.id || null;
  const isLink = type === 'link';
  $('#modal-icon').textContent = isLink ? '↗' : '▧';
  $('#modal-eyebrow').textContent = item ? (isLink ? 'MODIFIER LE LIEN' : 'MODIFIER LA NOTE') : (isLink ? 'NOUVEAU LIEN' : 'NOUVELLE NOTE');
  $('#modal-title').textContent = item ? (isLink ? 'Modifier le lien' : 'Modifier la note') : (isLink ? 'Ajouter un lien' : 'Ajouter une note');
  $('#modal-subtitle').textContent = isLink ? 'Enregistrez une adresse utile sur votre whiteboard.' : 'Une idée rapide à garder sous la main.';
  $('#resource-title').value = item?.title || '';
  $('#resource-title').placeholder = isLink ? 'Ex. Références utiles' : 'Ex. Idée de collection';
  $('#resource-content-label').textContent = isLink ? 'Adresse du lien' : 'Votre texte';
  $('#resource-content').value = item?.content || '';
  $('#resource-content').placeholder = isLink ? 'https://…' : 'Écrivez votre idée…';
  $('#resource-content').rows = isLink ? 2 : 5;
  $('#resource-error').hidden = true;
  $('#resource-submit').textContent = item ? 'Enregistrer les modifications' : 'Ajouter au whiteboard';
  $('#modal-layer').hidden = false;
  $('#resource-title').focus();
}
function openShare(input, asBundle = false) {
  const items = Array.isArray(input) ? input : [input];
  state.activeShareItems = items;
  state.activeShareItem = items[0];
  state.shareAsBundle = asBundle;
  const label = asBundle ? `${items.length} ressource${items.length === 1 ? '' : 's'} sélectionnée${items.length === 1 ? '' : 's'}` : items[0].title;
  $('#share-modal-title').textContent = asBundle ? 'Partager la sélection en ZIP' : 'Partager cette ressource';
  $('.share-modal .modal-subtitle').textContent = asBundle ? 'Un seul lien protégé permettra de télécharger toutes les ressources dans une archive ZIP.' : 'Toute personne disposant du lien et du mot de passe pourra télécharger cette ressource.';
  $('#share-item-name').textContent = label;
  $('#share-item-meta').textContent = asBundle ? 'Archive ZIP · textes et liens au format .txt' : items[0].type === 'file' ? `${items[0].mimeType?.split('/')[1]?.toUpperCase() || 'FICHIER'} · ${formatSize(items[0].size)}` : items[0].type === 'link' ? 'Lien · fichier .txt au téléchargement' : 'Note · fichier .txt au téléchargement';
  $('#share-item-icon').textContent = asBundle ? '▣' : iconFor(items[0].type);
  const shares = [...new Map(items.flatMap(item => item.shares || []).map(share => [share.token, share])).values()];
  $('#existing-share-links').hidden = shares.length === 0;
  $('#active-link-count').textContent = String(shares.length);
  $('#share-form button[type="submit"]').textContent = asBundle ? 'Générer le lien ZIP protégé' : 'Générer le lien protégé';
  $('#share-password-create').value = '';
  $('#share-password-create').type = 'password';
  $('#toggle-share-password').textContent = 'Afficher';
  $('#share-create-error').hidden = true;
  $('#share-result').hidden = true;
  $('#share-url-output').value = '';
  state.activeShareToken = null;
  $('#format-note').hidden = asBundle ? !items.some(item => ['note', 'link'].includes(item.type)) : !['note', 'link'].includes(items[0].type);
  if (asBundle) $('#format-note').innerHTML = 'Les notes et liens sont inclus dans le ZIP au format <strong>.txt</strong>.';
  else $('#format-note').innerHTML = 'Les textes et liens partagés sont téléchargés au format <strong>.txt</strong>.';
  $('#share-modal-layer').hidden = false;
  $('#share-password-create').focus();
}
function closeModals(event) {
  if (!event.target.closest('[data-close-modal]')) return;
  $('#modal-layer').hidden = true;
}
function closeShareModal(event) {
  if (!event.target.closest('[data-close-share]')) return;
  $('#share-modal-layer').hidden = true;
}
function setView(filter, activeId) {
  state.viewFilter = filter;
  state.selection.clear();
  document.querySelectorAll('.nav-section .nav-link').forEach(button => button.classList.toggle('active', button.id === activeId));
  renderItems();
  fitBoard();
}
async function uploadFiles(fileList) {
  for (const file of fileList) {
    const form = new FormData();
    form.append('file', file, file.name);
    try {
      const result = await api('/api/items', { method: 'POST', body: form });
      state.items.push(result.item);
      renderItems();
    } catch (error) { showToast(`${file.name} : ${error.message}`); }
  }
  if (fileList.length) showToast(`${fileList.length} fichier${fileList.length > 1 ? 's ajoutés' : ' ajouté'} au whiteboard.`);
}
async function loadItems() {
  const data = await api('/api/items');
  setItems(data.items);
}
function showSharedResource(token) {
  $('#login-screen').hidden = true;
  $('#app-shell').hidden = true;
  $('#share-screen').hidden = false;
  $('#share-unlocked').hidden = true;
  $('#share-unlock-form').hidden = false;
  api(`/api/share/${encodeURIComponent(token)}`).then(data => {
    $('#share-title').textContent = data.title || 'Une ressource vous attend';
    $('#share-description').textContent = 'Saisissez le mot de passe communiqué par la personne qui vous a partagé ce lien.';
  }).catch(error => {
    $('#share-title').textContent = 'Lien indisponible';
    $('#share-description').textContent = error.message;
    $('#share-unlock-form').hidden = true;
  });
  $('#share-unlock-form').onsubmit = async event => {
    event.preventDefault();
    $('#share-error').hidden = true;
    const button = event.submitter;
    button.disabled = true;
    try {
      const result = await api(`/api/share/${encodeURIComponent(token)}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#share-password-input').value }) });
      $('#download-link').href = result.downloadUrl;
      $('#share-unlock-form').hidden = true;
      $('#share-unlocked').hidden = false;
    } catch (error) {
      $('#share-error').textContent = error.message;
      $('#share-error').hidden = false;
    } finally { button.disabled = false; }
  };
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $('#login-error').hidden = true;
  try {
    const result = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#login-username').value, password: $('#login-password').value }) });
    displayApp(result.username);
    await loadItems();
  } catch (error) {
    $('#login-error').textContent = error.message;
    $('#login-error').hidden = false;
  } finally { button.disabled = false; }
});
$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } finally { displayLogin(); }
});
$('#upload-trigger').addEventListener('click', () => $('#file-input').click());
$('#toolbar-upload').addEventListener('click', () => $('#file-input').click());
$('#empty-add').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', event => { uploadFiles(event.target.files); event.target.value = ''; });
document.querySelectorAll('.tool-button[data-tool]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.tool-button').forEach(tool => tool.classList.remove('is-active'));
  button.classList.add('is-active');
  state.selectedTool = button.dataset.tool;
  if (button.dataset.tool === 'note' || button.dataset.tool === 'link') openModal(button.dataset.tool);
}));
$('#resource-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#resource-submit');
  button.disabled = true;
  $('#resource-error').hidden = true;
  try {
    const payload = { type: state.selectedTool, title: $('#resource-title').value, content: $('#resource-content').value };
    const editingItemId = state.editingItemId;
    if (editingItemId) {
      const result = await api(`/api/items/${encodeURIComponent(editingItemId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const index = state.items.findIndex(item => item.id === editingItemId);
      if (index !== -1) state.items[index] = result.item;
    } else {
      const result = await api('/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      state.items.push(result.item);
    }
    renderItems();
    $('#modal-layer').hidden = true;
    showToast(editingItemId ? 'Modifications enregistrées.' : state.selectedTool === 'link' ? 'Lien ajouté au whiteboard.' : 'Note ajoutée au whiteboard.');
    state.editingItemId = null;
  } catch (error) {
    $('#resource-error').textContent = error.message;
    $('#resource-error').hidden = false;
  } finally { button.disabled = false; }
});
$('#modal-layer').addEventListener('click', closeModals);
$('#share-modal-layer').addEventListener('click', closeShareModal);
$('#settings-layer').addEventListener('click', event => { if (event.target.closest('[data-close-settings]')) $('#settings-layer').hidden = true; });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { $('#modal-layer').hidden = true; $('#share-modal-layer').hidden = true; $('#settings-layer').hidden = true; }
});
$('#share-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $('#share-create-error').hidden = true;
  try {
    const result = state.shareAsBundle
      ? await api('/api/bundles/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemIds: state.activeShareItems.map(item => item.id), password: $('#share-password-create').value }) })
      : await api(`/api/items/${encodeURIComponent(state.activeShareItem.id)}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#share-password-create').value }) });
    $('#share-url-output').value = result.url;
    state.activeShareToken = result.token;
    for (const item of state.activeShareItems) {
      item.shares ||= [];
      item.shares.push({ token: result.token, createdAt: new Date().toISOString() });
      item.hasShare = true;
    }
    const activeShares = [...new Map(state.activeShareItems.flatMap(item => item.shares || []).map(share => [share.token, share])).values()];
    $('#active-link-count').textContent = String(activeShares.length);
    $('#existing-share-links').hidden = false;
    $('#share-result').hidden = false;
    showToast('Lien protégé généré.');
  } catch (error) {
    $('#share-create-error').textContent = error.message;
    $('#share-create-error').hidden = false;
  } finally { button.disabled = false; }
});
$('#copy-share-link').addEventListener('click', async () => {
  const input = $('#share-url-output');
  try { await navigator.clipboard.writeText(input.value); showToast('Lien copié.'); }
  catch { input.select(); document.execCommand('copy'); showToast('Lien copié.'); }
});
$('#copy-share-password').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#share-password-create').value); showToast('Mot de passe copié.'); }
  catch { $('#share-password-create').select(); document.execCommand('copy'); showToast('Mot de passe copié.'); }
});
$('#toggle-share-password').addEventListener('click', event => {
  const input = $('#share-password-create');
  input.type = input.type === 'password' ? 'text' : 'password';
  event.currentTarget.textContent = input.type === 'password' ? 'Afficher' : 'Masquer';
  event.currentTarget.setAttribute('aria-label', input.type === 'password' ? 'Afficher le mot de passe' : 'Masquer le mot de passe');
});
$('#revoke-share-link').addEventListener('click', async () => {
  if (!state.activeShareToken) return;
  try {
    await api(`/api/shares/${encodeURIComponent(state.activeShareToken)}`, { method: 'DELETE' });
    for (const item of state.items) {
      item.shares = (item.shares || []).filter(share => share.token !== state.activeShareToken);
      item.hasShare = item.shares.length > 0;
    }
    const activeShares = [...new Map(state.activeShareItems.flatMap(item => item.shares || []).map(share => [share.token, share])).values()];
    $('#active-link-count').textContent = String(activeShares.length);
    $('#existing-share-links').hidden = activeShares.length === 0;
    $('#share-result').hidden = true;
    $('#share-password-create').value = '';
    state.activeShareToken = null;
    showToast('Lien révoqué.');
  } catch (error) { showToast(error.message); }
});
$('#revoke-existing-links').addEventListener('click', async () => {
  const shares = [...new Map(state.activeShareItems.flatMap(item => item.shares || []).map(share => [share.token, share])).values()];
  if (!shares.length) return;
  if (!confirm(`Révoquer les ${shares.length} liens actifs de cette ressource ?`)) return;
  try {
    await Promise.all(shares.map(share => api(`/api/shares/${encodeURIComponent(share.token)}`, { method: 'DELETE' })));
    const revoked = new Set(shares.map(share => share.token));
    for (const item of state.items) {
      item.shares = (item.shares || []).filter(share => !revoked.has(share.token));
      item.hasShare = item.shares.length > 0;
    }
    $('#existing-share-links').hidden = true;
    $('#share-result').hidden = true;
    $('#share-password-create').value = '';
    state.activeShareToken = null;
    showToast('Tous les liens de cette ressource ont été révoqués.');
  } catch (error) { showToast(error.message); }
});
$('#clear-selection').addEventListener('click', () => { state.selection.clear(); updateSelectionUi(); });
$('#delete-selection').addEventListener('click', async () => {
  const selected = state.items.filter(item => state.selection.has(item.id));
  if (!selected.length || !confirm(`Supprimer les ${selected.length} ressources sélectionnées et révoquer leurs liens ?`)) return;
  try {
    await Promise.all(selected.map(item => api(`/api/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' })));
    state.items = state.items.filter(item => !state.selection.has(item.id));
    state.selection.clear();
    renderItems();
    showToast(`${selected.length} ressource${selected.length > 1 ? 's supprimées' : ' supprimée'}.`);
  } catch (error) { showToast(error.message); }
});
$('#share-selection').addEventListener('click', () => {
  const selected = state.items.filter(item => state.selection.has(item.id));
  if (selected.length) openShare(selected, true);
});
$('#nav-home').addEventListener('click', () => setView('all', 'nav-home'));
$('#nav-whiteboards').addEventListener('click', () => setView('all', 'nav-whiteboards'));
$('#nav-recent').addEventListener('click', () => setView('recent', 'nav-recent'));
$('#nav-favorites').addEventListener('click', () => setView('favorites', 'nav-favorites'));
$('#nav-settings').addEventListener('click', () => { $('#settings-layer').hidden = false; });
$('#settings-logout').addEventListener('click', () => { $('#settings-layer').hidden = true; $('#logout-button').click(); });
board.addEventListener('dragover', event => { event.preventDefault(); board.classList.add('is-dragover'); });
board.addEventListener('dragleave', event => { if (!board.contains(event.relatedTarget)) board.classList.remove('is-dragover'); });
board.addEventListener('drop', event => {
  event.preventDefault(); board.classList.remove('is-dragover');
  const files = [...(event.dataTransfer?.files || [])];
  if (files.length) uploadFiles(files);
});
$('#zoom-in').addEventListener('click', () => { state.zoom = Math.min(150, state.zoom + 10); updateCanvasTransform(); $('#zoom-level').textContent = `${state.zoom} %`; });
$('#zoom-out').addEventListener('click', () => { state.zoom = Math.max(60, state.zoom - 10); updateCanvasTransform(); $('#zoom-level').textContent = `${state.zoom} %`; });
$('#fit-board').addEventListener('click', () => { fitBoard(); showToast('Vue ajustée à vos ressources.'); });

const shareRoute = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/);
if (shareRoute) showSharedResource(shareRoute[1]);
else api('/api/session').then(async session => {
  if (!session.authenticated) { displayLogin(); return; }
  displayApp(session.username);
  await loadItems();
}).catch(displayLogin);
