import {
  PAGE_SIZE, MAX_PHOTOS, MAX_UPLOAD_BYTES, SUPPORTED_IMAGE_TYPES,
  el, replace, announce, money, parsePriceCents, formatPriceInput,
  parseEighths, formatEighths, stepEighths, parseWhole, api, sendJSON,
  uuid, safeAdminMedia, statusLabel,
} from './common.js';
import {getAuth, privateImage, privateUpload} from './session.js';

const $ = selector => document.querySelector(selector);
const state = {
  page: 1,
  totalPages: 1,
  total: 0,
  query: '',
  filter: 'all',
  cards: [],
  cache: new Map(),
  counts: {},
  categories: [],
  orderVersion: 0,
  stagedMoves: new Map(),
  settings: null,
  settingsVersion: 0,
  packingProfiles: [],
  ordersPage: 1,
  ordersTotalPages: 1,
  busy: false,
};

function clone(value) { return structuredClone(value); }
function cardKey(card) { return card.id || card.clientId; }
function viewKey(page = state.page) { return `${state.query}\u0000${state.filter}\u0000${page}`; }
function hasDirtyCards() { return [...state.cache.values(), state.cards].flat().some(card => card.dirty); }
function currentDirtyCards() { return state.cards.filter(card => card.dirty); }

function emptyDraft() {
  return {
    title: '', description: '', category: null, base_price_cents: null,
    width_eighths: null, height_eighths: null, offered_for_sale: false,
    requested_store_position: null,
    inventory: {quantity_changed: false, intended_available_quantity: null, captured_version: 0},
    photos: [], configurations: [],
  };
}

function normalizePhoto(photo, index) {
  return {
    asset_id: photo.asset_id || photo.id,
    alt: photo.alt ?? photo.alt_text ?? '',
    position: Number.isSafeInteger(photo.position) ? photo.position : index,
    is_main: photo.is_main === true || photo.main === true || (index === 0 && photo.is_main !== false),
    preview_url: photo.preview_url || photo.admin_url || (photo.asset_id || photo.id ? `/api/admin/media/${photo.asset_id || photo.id}/display` : null),
    legacy_path: photo.legacy_path || photo.path || null,
  };
}

function normalizeConfiguration(configuration) {
  return {
    id: configuration.id || uuid(),
    label: configuration.label || '',
    enabled: configuration.enabled === true,
    price_add_on_cents: Number.isSafeInteger(configuration.price_add_on_cents) ? configuration.price_add_on_cents : null,
    packing_profile_id: configuration.packing_profile_id || null,
    _price: formatPriceInput(configuration.price_add_on_cents),
  };
}

function normalizeCard(raw = {}) {
  const source = raw.working_revision?.snapshot || raw.working?.snapshot || raw.draft || raw.snapshot || raw.working_revision || raw.working || raw;
  const draft = {...emptyDraft(), ...clone(source)};
  draft.inventory = {...emptyDraft().inventory, ...(source.inventory || {})};
  draft.photos = (source.photos || []).map(normalizePhoto).sort((a, b) => a.position - b.position).map((photo, index) => ({...photo, position: index}));
  draft.configurations = (source.configurations || []).map(normalizeConfiguration);
  const available = raw.inventory?.available_quantity ?? raw.inventory?.available ?? raw.available_quantity ?? null;
  const inventoryVersion = raw.inventory?.version ?? raw.inventory_version ?? draft.inventory.captured_version ?? 0;
  draft.inventory.captured_version = inventoryVersion;
  const intended = draft.inventory.quantity_changed ? draft.inventory.intended_available_quantity : available;
  return {
    id: raw.id || raw.artwork_id || null,
    clientId: raw.client_id || (!raw.id && !raw.artwork_id ? uuid() : null),
    stableId: raw.stable_id || raw.id || 'Unsaved artwork',
    state: raw.state || 'draft',
    version: raw.version ?? raw.head_version ?? raw.working_version ?? 0,
    storePosition: raw.store_position ?? raw.position ?? null,
    inventoryAvailable: available,
    inventoryVersion,
    draft,
    dirty: raw.__new === true,
    saveState: raw.__new ? 'unsaved' : 'saved',
    fieldErrors: {},
    validation: raw.validation || {},
    _raw: {
      price: formatPriceInput(draft.base_price_cents),
      width: formatEighths(draft.width_eighths).replace(/ in$/, ''),
      height: formatEighths(draft.height_eighths).replace(/ in$/, ''),
      quantity: intended === null || intended === undefined ? '' : String(intended),
    },
  };
}

function cacheCurrent() { state.cache.set(viewKey(), state.cards); }

function setSaveState(card, value, cardNode) {
  card.saveState = value;
  const node = cardNode?.querySelector('.save-state') || document.querySelector(`[data-card-key="${CSS.escape(cardKey(card))}"] .save-state`);
  if (node) {
    node.dataset.state = value;
    node.textContent = ({unsaved: 'Unsaved', saving: 'Saving', saved: 'Saved', failed: 'Save failed'})[value] || value;
  }
  if (cardNode) cardNode.dataset.dirty = String(card.dirty);
}

function markDirty(card, cardNode) {
  card.dirty = true;
  setSaveState(card, 'unsaved', cardNode);
  $('#save-all').disabled = false;
}

function setFieldError(card, name, message) {
  if (message) card.fieldErrors[name] = message;
  else delete card.fieldErrors[name];
}

function normalizePhotoOrder(card) {
  card.draft.photos.forEach((photo, index) => { photo.position = index; });
  if (card.draft.photos.length && !card.draft.photos.some(photo => photo.is_main)) card.draft.photos[0].is_main = true;
  let mainSeen = false;
  for (const photo of card.draft.photos) {
    if (photo.is_main && !mainSeen) mainSeen = true;
    else if (photo.is_main) photo.is_main = false;
  }
}

function serializeCard(card) {
  const errors = {};
  const draft = clone(card.draft);
  try { draft.base_price_cents = parsePriceCents(card._raw.price); } catch (error) { errors.base_price_cents = error.message; }
  try { draft.width_eighths = parseEighths(card._raw.width); } catch (error) { errors.width_eighths = error.message; }
  try { draft.height_eighths = parseEighths(card._raw.height); } catch (error) { errors.height_eighths = error.message; }
  if (draft.inventory.quantity_changed) {
    try { draft.inventory.intended_available_quantity = parseWhole(card._raw.quantity, {allowBlank: true, label: 'Available quantity'}); }
    catch (error) { errors.intended_available_quantity = error.message; }
  } else {
    draft.inventory.intended_available_quantity = null;
  }
  draft.inventory.captured_version = card.inventoryVersion;
  draft.category = draft.category?.trim() || null;
  draft.title = draft.title.trim();
  draft.description = draft.description.trim();
  draft.photos = draft.photos.map(({asset_id, alt, position, is_main}) => ({asset_id, alt: String(alt || '').trim(), position, is_main: is_main === true}));
  if (draft.photos.length > MAX_PHOTOS) errors.photos = 'An artwork may have at most four photos.';
  if (draft.photos.length && draft.photos.filter(photo => photo.is_main).length !== 1) errors.photos = 'Choose exactly one main photo.';
  const seenConfigurations = new Set();
  draft.configurations = draft.configurations.map((configuration, index) => {
    let addOn = null;
    try { addOn = parsePriceCents(configuration._price); }
    catch (error) { errors[`configuration_${index}_price`] = error.message; }
    if (seenConfigurations.has(configuration.id)) errors.configurations = 'Configuration identifiers must be unique.';
    seenConfigurations.add(configuration.id);
    return {id: configuration.id, label: configuration.label.trim(), enabled: configuration.enabled === true, price_add_on_cents: addOn, packing_profile_id: configuration.packing_profile_id || null};
  });
  card.fieldErrors = errors;
  if (Object.keys(errors).length) {
    const error = new Error('Correct the highlighted fields before saving.');
    error.fieldErrors = errors;
    throw error;
  }
  return draft;
}

function inputLabel(labelText, input) {
  const label = el('label', labelText);
  label.append(input);
  return label;
}

function textInput(card, cardNode, field, labelText, options = {}) {
  const input = el(options.multiline ? 'textarea' : 'input', null, options.multiline ? {rows: options.rows || 4} : {type: options.type || 'text'});
  if (options.list) input.setAttribute('list', options.list);
  if (options.maxLength) input.maxLength = options.maxLength;
  input.value = card.draft[field] ?? '';
  input.addEventListener('input', () => { card.draft[field] = input.value; markDirty(card, cardNode); });
  return inputLabel(labelText, input);
}

function rawInput(card, cardNode, rawField, labelText, options = {}) {
  const input = el('input', null, {type: options.type || 'text', inputMode: options.inputMode || 'decimal'});
  input.value = card._raw[rawField] || '';
  if (options.placeholder) input.placeholder = options.placeholder;
  input.addEventListener('input', () => {
    card._raw[rawField] = input.value;
    if (rawField === 'quantity') card.draft.inventory.quantity_changed = true;
    markDirty(card, cardNode);
  });
  return inputLabel(labelText, input);
}

function dimensionControl(card, cardNode, rawField, dataField, labelText) {
  const wrap = el('div', null, {class: 'measurement'});
  const input = el('input', null, {type: 'text', inputMode: 'decimal', placeholder: '12 3/8'});
  input.value = card._raw[rawField] || '';
  input.setAttribute('aria-label', `${labelText} in inches`);
  input.addEventListener('input', () => { card._raw[rawField] = input.value; markDirty(card, cardNode); });
  const label = inputLabel(labelText, input);
  const minus = el('button', '−', {type: 'button', ariaLabel: `Decrease ${labelText} by one eighth inch`});
  const plus = el('button', '+', {type: 'button', ariaLabel: `Increase ${labelText} by one eighth inch`});
  const step = direction => {
    let current = null;
    try { current = parseEighths(card._raw[rawField]); } catch { current = card.draft[dataField]; }
    const next = stepEighths(current, direction);
    card.draft[dataField] = next;
    card._raw[rawField] = next === null ? '' : formatEighths(next).replace(/ in$/, '');
    input.value = card._raw[rawField];
    markDirty(card, cardNode);
  };
  minus.addEventListener('click', () => step(-1));
  plus.addEventListener('click', () => step(1));
  wrap.append(label, minus, plus);
  return wrap;
}

function renderErrors(card, cardNode) {
  const list = cardNode.querySelector('.validation-list');
  replace(list);
  const messages = [...Object.values(card.fieldErrors || {}), ...Object.values(card.validation?.field_errors || {})].filter(Boolean);
  for (const message of new Set(messages)) list.append(el('li', message));
  list.hidden = messages.length === 0;
}

function renderPhotos(card, cardNode, container) {
  const grid = el('div', null, {class: 'photo-grid'});
  for (const photo of card.draft.photos) {
    const photoCard = el('div', null, {class: 'photo-card'});
    const image = el('img', null, {alt: photo.alt || `${card.draft.title || 'Artwork'} photo`});
    const safe = safeAdminMedia(photo.preview_url);
    if (safe) void privateImage(image, safe);
    else if (photo.legacy_path && /^\/art-00[1-9]-[1-4]\.jpg$/.test(photo.legacy_path)) image.src = photo.legacy_path;
    else image.hidden = true;
    const main = el('input', null, {type: 'radio', name: `main-${cardKey(card)}`, checked: photo.is_main});
    main.addEventListener('change', () => {
      card.draft.photos.forEach(item => { item.is_main = item === photo; });
      markDirty(card, cardNode); renderCards();
    });
    const mainLabel = el('label', null, {class: 'sale-row'}); mainLabel.append(main, document.createTextNode(' Main photo'));
    const alt = el('input', null, {type: 'text', value: photo.alt, maxLength: 300});
    alt.setAttribute('aria-label', 'Photo description');
    alt.addEventListener('input', () => { photo.alt = alt.value; markDirty(card, cardNode); });
    const actions = el('div', null, {class: 'photo-actions'});
    const move = direction => {
      const index = card.draft.photos.indexOf(photo), target = index + direction;
      if (target < 0 || target >= card.draft.photos.length) return;
      [card.draft.photos[index], card.draft.photos[target]] = [card.draft.photos[target], card.draft.photos[index]];
      normalizePhotoOrder(card); markDirty(card, cardNode); renderCards();
    };
    const up = el('button', 'Move up', {type: 'button', class: 'secondary', disabled: photo.position === 0}); up.addEventListener('click', () => move(-1));
    const down = el('button', 'Move down', {type: 'button', class: 'secondary', disabled: photo.position === card.draft.photos.length - 1}); down.addEventListener('click', () => move(1));
    const replaceButton = el('button', 'Replace', {type: 'button', class: 'secondary'});
    const replaceInput = el('input', null, {type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true});
    replaceButton.addEventListener('click', () => replaceInput.click());
    replaceInput.addEventListener('change', () => { if (replaceInput.files[0]) void uploadFiles(card, cardNode, [replaceInput.files[0]], photo.asset_id); });
    const remove = el('button', 'Remove', {type: 'button', class: 'danger'});
    remove.addEventListener('click', () => {
      card.draft.photos = card.draft.photos.filter(item => item !== photo);
      normalizePhotoOrder(card); markDirty(card, cardNode); renderCards();
    });
    actions.append(up, down, replaceButton, replaceInput, remove);
    photoCard.append(image, mainLabel, inputLabel('Photo description', alt), actions);
    grid.append(photoCard);
  }
  const uploadBox = el('div', null, {class: 'upload-box'});
  uploadBox.append(el('p', `JPEG, PNG, or WebP. Up to ${MAX_PHOTOS} photos, 5 MiB each, 16 MP, and 8192 px per side. HEIC/HEIF is not supported.`));
  const file = el('input', null, {type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, disabled: card.state === 'archived' || card.draft.photos.length >= MAX_PHOTOS});
  const progress = el('p', '', {class: 'progress', ariaLive: 'polite'});
  file.addEventListener('change', () => { if (file.files.length) void uploadFiles(card, cardNode, [...file.files], null, progress); });
  uploadBox.append(inputLabel('Add photos', file), progress);
  container.append(grid, uploadBox);
}

async function ensureSaved(card) {
  if (!card.id || card.dirty) {
    const succeeded = await saveCards([card]);
    if (!succeeded) throw new Error('Save the draft before uploading a photo.');
  }
}

async function uploadFiles(card, cardNode, files, replaceAssetId = null, progressNode = null) {
  if (replaceAssetId && files.length !== 1) return;
  const availableSlots = replaceAssetId ? 1 : MAX_PHOTOS - card.draft.photos.length;
  if (files.length > availableSlots) { announce(`Only ${availableSlots} more photo${availableSlots === 1 ? '' : 's'} can be added.`, true); return; }
  for (const file of files) {
    if (!SUPPORTED_IMAGE_TYPES.has(file.type)) { announce(`${file.name}: supported types are JPEG, PNG, and WebP.`, true); continue; }
    if (!file.size || file.size > MAX_UPLOAD_BYTES) { announce(`${file.name}: file must be no larger than 5 MiB.`, true); continue; }
    try {
      await ensureSaved(card);
      const allocation = await sendJSON('/api/admin/uploads', 'POST', {artwork_id: card.id, expected_version: card.version, idempotency_key: uuid(), replace_asset_id: replaceAssetId, filename: file.name, content_type: file.type, byte_size: file.size});
      const uploadId = allocation.upload_id || allocation.id;
      if (!uploadId) throw new Error('Upload allocation failed.');
      if (progressNode) progressNode.textContent = `${file.name}: 0%`;
      const result = await privateUpload(allocation.upload_url || `/api/admin/uploads/${uploadId}`, file, percent => {
        const node = progressNode || cardNode.querySelector('.progress');
        if (node) node.textContent = `${file.name}: ${percent}%`;
      });
      if (result.artwork) Object.assign(card, normalizeCard(result.artwork));
      else {
        if (result.asset) {
          const newPhoto = normalizePhoto({...result.asset, is_main: replaceAssetId ? card.draft.photos.find(photo => photo.asset_id === replaceAssetId)?.is_main : card.draft.photos.length === 0}, 0);
          const index = card.draft.photos.findIndex(photo => photo.asset_id === replaceAssetId);
          if (index >= 0) card.draft.photos[index] = newPhoto; else card.draft.photos.push(newPhoto);
          normalizePhotoOrder(card);
        }
        card.version = result.version ?? card.version + 1;
      }
      card.dirty = false; setSaveState(card, 'saved', cardNode);
      announce(`${file.name} uploaded and attached to the private working revision.`);
      renderCards();
    } catch (error) {
      announce(error.message || `${file.name} could not be uploaded.`, true);
      setSaveState(card, 'failed', cardNode);
    }
  }
}

function renderConfigurations(card, cardNode, container) {
  const list = el('div', null, {class: 'configurations'});
  for (const configuration of card.draft.configurations) {
    const row = el('div', null, {class: 'configuration'});
    const label = el('input', null, {type: 'text', value: configuration.label, maxLength: 120});
    label.addEventListener('input', () => { configuration.label = label.value; markDirty(card, cardNode); });
    const price = el('input', null, {type: 'text', value: configuration._price, inputMode: 'decimal', placeholder: '0.00'});
    price.addEventListener('input', () => { configuration._price = price.value; markDirty(card, cardNode); });
    const packing = el('select');
    packing.append(el('option', 'Select packing profile', {value: ''}));
    for (const profile of state.packingProfiles) packing.append(el('option', profile.label || profile.name || profile.id, {value: profile.id, selected: configuration.packing_profile_id === profile.id}));
    packing.addEventListener('change', () => { configuration.packing_profile_id = packing.value || null; markDirty(card, cardNode); });
    const enabled = el('input', null, {type: 'checkbox', checked: configuration.enabled});
    enabled.addEventListener('change', () => { configuration.enabled = enabled.checked; markDirty(card, cardNode); });
    const enabledLabel = el('label', null, {class: 'enabled'}); enabledLabel.append(enabled, document.createTextNode(' Enabled'));
    const remove = el('button', 'Remove', {type: 'button', class: 'danger'});
    remove.addEventListener('click', () => { card.draft.configurations = card.draft.configurations.filter(item => item !== configuration); markDirty(card, cardNode); renderCards(); });
    row.append(inputLabel('Choice label', label), inputLabel('Price add-on (USD)', price), inputLabel('Packing profile', packing), enabledLabel, remove);
    list.append(row);
  }
  const add = el('button', 'Add frame / configuration choice', {type: 'button', class: 'secondary'});
  add.addEventListener('click', () => {
    card.draft.configurations.push(normalizeConfiguration({id: uuid(), enabled: true, price_add_on_cents: 0}));
    markDirty(card, cardNode); renderCards();
  });
  container.append(list, add);
}

function stageMove(card, position) {
  const value = Number(position);
  if (!card.id || !Number.isSafeInteger(value) || value < 1) {
    announce('Choose a valid store position for a saved artwork.', true); return;
  }
  state.stagedMoves.set(card.id, {artwork_id: card.id, to_position: value, title: card.draft.title || card.stableId});
  renderStagedMoves();
}

function renderStagedMoves() {
  const container = $('#staged-order');
  replace(container);
  if (!state.stagedMoves.size) container.textContent = 'No staged order changes.';
  for (const move of state.stagedMoves.values()) {
    const row = el('div', null, {class: 'staged-move'});
    row.append(el('span', `${move.title} → position ${move.to_position}`));
    const remove = el('button', 'Undo', {type: 'button', class: 'link-button'});
    remove.addEventListener('click', () => { state.stagedMoves.delete(move.artwork_id); renderStagedMoves(); });
    row.append(remove); container.append(row);
  }
  $('#save-store-order').disabled = !state.stagedMoves.size;
}

function renderCard(card) {
  const node = el('article', null, {class: 'artwork-card', dataset: {cardKey: cardKey(card), dirty: String(card.dirty)}});
  const heading = el('div', null, {class: 'card-heading'});
  const titleArea = el('div');
  titleArea.append(el('h2', card.draft.title || 'Untitled artwork'));
  const meta = el('div', null, {class: 'card-heading-meta'});
  meta.append(el('span', card.stableId, {class: 'stable-id'}), el('span', statusLabel(card.state), {class: `state-badge ${card.state}`}));
  const saveState = el('span', ({unsaved: 'Unsaved', saving: 'Saving', saved: 'Saved', failed: 'Save failed'})[card.saveState], {class: 'save-state', dataset: {state: card.saveState}});
  meta.append(saveState); titleArea.append(meta);
  heading.append(titleArea);

  const identity = el('div', null, {class: 'field-grid'});
  identity.append(textInput(card, node, 'title', 'Title', {maxLength: 160}), textInput(card, node, 'category', 'Category (optional)', {list: 'category-options', maxLength: 80}));
  const description = textInput(card, node, 'description', 'Description', {multiline: true, rows: 5, maxLength: 10000});
  const commerce = el('div', null, {class: 'field-grid three'});
  commerce.append(rawInput(card, node, 'price', 'Base artwork price (USD)', {placeholder: 'Blank = not set'}), rawInput(card, node, 'quantity', 'Intended available quantity', {inputMode: 'numeric', placeholder: 'Blank = unknown'}));
  const sale = el('select'); sale.append(el('option', 'Display only', {value: 'display', selected: !card.draft.offered_for_sale}), el('option', 'Offered for sale', {value: 'sale', selected: card.draft.offered_for_sale}));
  sale.addEventListener('change', () => { card.draft.offered_for_sale = sale.value === 'sale'; markDirty(card, node); });
  commerce.append(inputLabel('Store availability', sale));
  const measurements = el('div', null, {class: 'field-grid'});
  measurements.append(dimensionControl(card, node, 'width', 'width_eighths', 'Width'), dimensionControl(card, node, 'height', 'height_eighths', 'Height'));

  const storeOrder = el('div', null, {class: 'card-section'}); storeOrder.append(el('h3', 'Store position'));
  const orderControls = el('div', null, {class: 'order-actions'});
  const position = el('input', null, {type: 'number', min: 1, step: 1, value: card.storePosition ?? card.draft.requested_store_position ?? ''});
  position.setAttribute('aria-label', 'Store position');
  if (card.state === 'draft') position.addEventListener('input', () => { card.draft.requested_store_position = position.value ? Number(position.value) : null; markDirty(card, node); });
  const move = el('button', card.state === 'draft' ? 'Set insertion position' : 'Stage move', {type: 'button', class: 'secondary'});
  move.addEventListener('click', () => card.state === 'draft' ? markDirty(card, node) : stageMove(card, position.value));
  const up = el('button', 'Move up', {type: 'button', class: 'secondary', disabled: !card.storePosition || card.state === 'archived'}); up.addEventListener('click', () => stageMove(card, Math.max(1, (card.storePosition || 1) - 1)));
  const down = el('button', 'Move down', {type: 'button', class: 'secondary', disabled: !card.storePosition || card.state === 'archived'}); down.addEventListener('click', () => stageMove(card, (card.storePosition || 0) + 1));
  orderControls.append(position, move, up, down); storeOrder.append(orderControls);

  const photos = el('section', null, {class: 'card-section'}); photos.append(el('h3', `Photos (${card.draft.photos.length}/${MAX_PHOTOS})`)); renderPhotos(card, node, photos);
  const configurations = el('section', null, {class: 'card-section'}); configurations.append(el('h3', 'Frame and packaging choices'), el('p', 'Each enabled choice uses the same artwork inventory. Enable unframed only when it is actually offered.', {class: 'help'})); renderConfigurations(card, node, configurations);
  const errors = el('ul', null, {class: 'validation-list', hidden: true});
  const actions = el('div', null, {class: 'card-actions'});
  const save = el('button', 'Save Draft', {type: 'button', class: 'primary'}); save.addEventListener('click', () => void saveCards([card]));
  const preview = el('button', 'Preview', {type: 'button', class: 'secondary'}); preview.addEventListener('click', () => void previewCard(card));
  const publish = el('button', card.state === 'published_changes' ? 'Publish Changes' : 'Publish', {type: 'button', class: 'secondary', disabled: card.state === 'archived'}); publish.addEventListener('click', () => void publishCard(card));
  const archive = el('button', card.state === 'draft' ? 'Archive Draft' : 'Remove from Store', {type: 'button', class: 'danger', hidden: card.state === 'archived'}); archive.addEventListener('click', () => void archiveCard(card));
  const restore = el('button', 'Restore Draft', {type: 'button', class: 'secondary', hidden: card.state !== 'archived'}); restore.addEventListener('click', () => void restoreCard(card));
  actions.append(save, preview, publish, archive, restore);
  node.append(heading, identity, description, commerce, measurements, storeOrder, photos, configurations, errors, actions);
  renderErrors(card, node);
  return node;
}

function renderCards() {
  const container = $('#artwork-cards');
  replace(container);
  if (!state.cards.length) container.append(el('p', 'No artwork matches this page and filter.'));
  for (const card of state.cards) container.append(renderCard(card));
  $('#save-all').disabled = !currentDirtyCards().length || state.busy;
  renderPagination();
}

function renderCounts() {
  const container = $('#catalog-counts'); replace(container);
  const labels = {all: 'All', draft: 'Drafts', published: 'Published', published_changes: 'Published with unpublished changes', archived: 'Archived'};
  for (const [key, label] of Object.entries(labels)) if (Number.isSafeInteger(state.counts[key])) container.append(el('span', `${label}: ${state.counts[key]}`, {class: 'status-count'}));
}

function renderPagination() {
  const start = state.total ? Math.min(state.total, (state.page - 1) * PAGE_SIZE + 1) : 0;
  const end = state.total ? Math.min(state.total, start + state.cards.filter(card => card.id).length - 1) : 0;
  $('#page-summary').textContent = `Showing ${start}–${end} of ${state.total}`;
  $('#page-number').value = state.page;
  $('#page-number').max = Math.max(state.totalPages, state.page);
  $('#previous-page').disabled = state.page <= 1 || state.busy;
  $('#next-page').disabled = (state.page >= state.totalPages && !state.cache.has(viewKey(state.page + 1))) || state.busy;
}

function mergeDirty(serverCards, dirtyCards) {
  const dirty = new Map(dirtyCards.filter(card => card.dirty).map(card => [cardKey(card), card]));
  const merged = serverCards.map(card => dirty.get(cardKey(card)) || card);
  for (const card of dirty.values()) if (!merged.some(item => cardKey(item) === cardKey(card))) merged.push(card);
  return merged.slice(0, PAGE_SIZE);
}

async function loadArtworks({force = false} = {}) {
  const key = viewKey();
  if (!force && state.cache.has(key)) { state.cards = state.cache.get(key); renderCards(); return; }
  state.busy = true; renderPagination();
  try {
    const params = new URLSearchParams({page: String(state.page), q: state.query, status: state.filter});
    const data = await api(`/api/admin/artworks?${params}`);
    const rawItems = data.items || data.artworks || [];
    const serverCards = rawItems.map(normalizeCard);
    const old = state.cache.get(key) || [];
    state.cards = mergeDirty(serverCards, old);
    const pagination = data.pagination || data;
    state.page = pagination.page || state.page;
    state.total = pagination.total ?? data.total ?? rawItems.length;
    state.totalPages = pagination.total_pages ?? Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    state.counts = data.counts || state.counts;
    state.categories = data.categories || state.categories;
    state.orderVersion = data.order_version ?? state.orderVersion;
    const options = $('#category-options'); replace(options, ...state.categories.map(value => el('option', null, {value})));
    state.cache.set(key, state.cards);
    renderCounts(); renderCards();
    announce('Artwork workspace loaded.');
  } catch (error) { announce(error.message, true); }
  finally { state.busy = false; renderCards(); }
}

function showResultErrors(card, result) {
  card.fieldErrors = result.field_errors || {save: result.error || 'Save failed.'};
  card.dirty = true; card.saveState = 'failed';
}

async function saveCards(cards) {
  const attempted = cards.filter(card => card.dirty);
  if (!attempted.length) return true;
  const items = [];
  for (const card of attempted) {
    try {
      const draft = serializeCard(card);
      items.push({id: card.id || undefined, client_id: card.clientId || undefined, expected_version: card.version, draft});
      card.saveState = 'saving';
    } catch (error) {
      card.fieldErrors = error.fieldErrors || {save: error.message}; card.saveState = 'failed';
    }
  }
  renderCards();
  if (!items.length) return false;
  state.busy = true;
  try {
    const data = await sendJSON('/api/admin/artwork-drafts:batch', 'POST', {items});
    const results = data.results || [];
    for (const card of attempted) {
      const result = results.find(item => (card.id && (item.id === card.id || item.artwork_id === card.id)) || (card.clientId && item.client_id === card.clientId));
      if (!result || result.success === false || result.ok === false) { showResultErrors(card, result || {error: 'No result was returned for this card.'}); continue; }
      if (result.artwork) {
        const updated = normalizeCard(result.artwork);
        Object.assign(card, updated, {clientId: card.clientId || updated.clientId});
      } else {
        card.id = result.id || result.artwork_id || card.id;
        card.stableId = result.stable_id || card.stableId;
        card.version = result.version ?? result.revision_version ?? card.version + 1;
        card.state = result.state || card.state;
      }
      const savedDraft = serializeCard(card);
      savedDraft.configurations = savedDraft.configurations.map(normalizeConfiguration);
      card.draft = savedDraft;
      card.dirty = false; card.saveState = 'saved'; card.fieldErrors = {};
    }
    const successes = attempted.filter(card => !card.dirty).length;
    const failures = attempted.length - successes;
    announce(`${successes} draft${successes === 1 ? '' : 's'} saved${failures ? `; ${failures} failed and kept their inputs` : ''}.`, failures > 0);
  } catch (error) {
    for (const card of attempted) if (card.saveState === 'saving') showResultErrors(card, {error: error.message});
    announce('Save failed. Every unsaved card and photo selection remains in the workspace.', true);
  } finally { state.busy = false; cacheCurrent(); renderCards(); }
  return attempted.every(card => !card.dirty);
}

async function previewCard(card) {
  try {
    const draft = serializeCard(card);
    const data = await sendJSON(`/api/admin/artworks/${encodeURIComponent(card.id || 'unsaved')}/preview`, 'POST', {client_id: card.clientId, draft});
    const preview = data.preview || draft;
    const content = $('#preview-content'); replace(content);
    content.append(el('h3', preview.title || 'Untitled artwork'), el('p', preview.description || 'No description yet.'));
    content.append(el('p', preview.category || 'No category'), el('p', preview.base_price_cents === null ? 'Price not set' : `Base price: ${money(preview.base_price_cents)}`));
    if (preview.width_eighths || preview.height_eighths) content.append(el('p', `Dimensions: ${formatEighths(preview.width_eighths) || 'unknown'} × ${formatEighths(preview.height_eighths) || 'unknown'}`));
    const images = el('div', null, {class: 'preview-images'});
    for (const photo of preview.photos || []) {
      const image = el('img', null, {alt: photo.alt || preview.title || 'Artwork photo'});
      const path = safeAdminMedia(photo.preview_url || `/api/admin/media/${photo.asset_id}/display`);
      if (path) void privateImage(image, path); else if (/^\/art-00[1-9]-[1-4]\.jpg$/.test(photo.legacy_path || '')) image.src = photo.legacy_path;
      images.append(image);
    }
    content.append(images);
    $('#preview-dialog').showModal();
  } catch (error) { card.fieldErrors = error.fieldErrors || {preview: error.message}; renderCards(); announce(error.message, true); }
}

async function publishCard(card) {
  if (!card.id || card.dirty) if (!(await saveCards([card]))) return;
  try {
    const data = await sendJSON(`/api/admin/artworks/${encodeURIComponent(card.id)}/publish`, 'POST', {expected_version: card.version, inventory_version: card.inventoryVersion});
    announce(data.message || `${card.draft.title || 'Artwork'} published.`);
    await loadArtworks({force: true});
  } catch (error) {
    card.fieldErrors = error.fieldErrors || {publish: error.message}; renderCards(); announce(error.message, true);
  }
}

async function archiveCard(card) {
  const label = card.state === 'draft' ? 'archive this private draft' : 'remove this artwork from the public store';
  if (!confirm(`Recoverably ${label}? Revisions, photos, inventory history, and orders will be retained.`)) return;
  try {
    await sendJSON(`/api/admin/artworks/${encodeURIComponent(card.id)}/archive`, 'POST', {expected_version: card.version});
    announce('Artwork archived. It is absent from the store and can be restored as a private draft.');
    await loadArtworks({force: true});
  } catch (error) { announce(error.message, true); }
}

async function restoreCard(card) {
  try {
    await sendJSON(`/api/admin/artworks/${encodeURIComponent(card.id)}/restore`, 'POST', {expected_version: card.version});
    announce('Artwork restored as a private draft. Publish explicitly to return it to the store.');
    await loadArtworks({force: true});
  } catch (error) { announce(error.message, true); }
}

function guardNavigation() {
  if (!currentDirtyCards().length) return true;
  cacheCurrent();
  return confirm('This page has unsaved artwork changes. They will remain in this browser workspace, but are not saved to the store. Continue?');
}

function addArtwork() {
  if (state.cards.length >= PAGE_SIZE) {
    if (!guardNavigation()) return;
    cacheCurrent(); state.page = Math.max(state.page + 1, state.totalPages + 1);
    state.cards = state.cache.get(viewKey()) || [];
  }
  const card = normalizeCard({__new: true, client_id: uuid(), draft: emptyDraft(), state: 'draft'});
  state.cards.push(card); cacheCurrent(); renderCards();
  requestAnimationFrame(() => document.querySelector(`[data-card-key="${CSS.escape(cardKey(card))}"] input`)?.focus());
}

async function saveStoreOrder() {
  if (!state.stagedMoves.size) return;
  try {
    const data = await sendJSON('/api/admin/store-order', 'POST', {expected_version: state.orderVersion, moves: [...state.stagedMoves.values()].map(({artwork_id, to_position}) => ({artwork_id, to_position}))});
    state.orderVersion = data.order_version ?? state.orderVersion + 1; state.stagedMoves.clear(); renderStagedMoves();
    announce('Public store order saved. No draft content was published.'); await loadArtworks({force: true});
  } catch (error) { announce(error.message, true); }
}

function normalizeSettings(data) {
  const settings = data.settings || data;
  state.settingsVersion = data.version ?? settings.version ?? 0;
  state.packingProfiles = (data.packing_profiles || settings.packing_profiles || []).map(profile => ({...profile, id: profile.id || uuid()}));
  state.settings = {
    shipping_origin: settings.shipping_origin || {}, destinations: settings.destinations || [], shipping_services: settings.shipping_services || [],
    handling_amount_cents: settings.handling_amount_cents ?? null, handling_scope: settings.handling_scope || '', fulfillment_methods: settings.fulfillment_methods || [],
    tax_status: settings.tax_status || 'unconfigured', payment_status: settings.payment_status || 'Not connected', payment_mode: settings.payment_mode || 'Disabled',
    shipping_status: settings.shipping_status || 'Not configured', readiness: data.readiness || settings.readiness || {},
  };
}

function renderPackingProfiles() {
  const container = $('#packing-profiles'); replace(container);
  for (const profile of state.packingProfiles) {
    const row = el('div', null, {class: 'packing-profile'});
    const fields = [
      ['label', 'Profile label', 'text'], ['length', 'Packed length', 'number'], ['width', 'Packed width', 'number'],
      ['height', 'Packed height', 'number'], ['weight', 'Packed weight', 'number'],
    ];
    for (const [name, label, type] of fields) {
      const input = el('input', null, {type, value: profile[name] ?? '', min: type === 'number' ? '0.001' : undefined, step: type === 'number' ? 'any' : undefined});
      input.addEventListener('input', () => { profile[name] = input.value; $('#settings-save-state').textContent = 'Unsaved'; $('#settings-save-state').dataset.state = 'unsaved'; });
      row.append(inputLabel(label, input));
    }
    const units = el('select');
    units.append(el('option', 'in / lb', {value: 'in_lb', selected: profile.units === 'in_lb'}), el('option', 'cm / kg', {value: 'cm_kg', selected: profile.units === 'cm_kg'}));
    units.addEventListener('change', () => { profile.units = units.value; $('#settings-save-state').textContent = 'Unsaved'; $('#settings-save-state').dataset.state = 'unsaved'; });
    row.append(inputLabel('Units', units));
    const remove = el('button', 'Remove', {type: 'button', class: 'danger'}); remove.addEventListener('click', () => { state.packingProfiles = state.packingProfiles.filter(item => item !== profile); renderPackingProfiles(); }); row.append(remove);
    container.append(row);
  }
}

function renderSettings() {
  const form = $('#settings-form'), settings = state.settings;
  if (!settings) return;
  const origin = settings.shipping_origin;
  for (const [name, key] of Object.entries({origin_line1: 'line1', origin_line2: 'line2', origin_city: 'city', origin_region: 'region', origin_postal: 'postal_code', origin_country: 'country_code'})) form.elements[name].value = origin[key] || '';
  form.elements.destinations.value = settings.destinations.map(value => typeof value === 'string' ? value : `${value.code || ''}${value.label ? ` | ${value.label}` : ''}`).join('\n');
  form.elements.shipping_services.value = settings.shipping_services.map(value => typeof value === 'string' ? value : `${value.id || ''}${value.label ? ` | ${value.label}` : ''}`).join('\n');
  form.elements.handling_amount.value = formatPriceInput(settings.handling_amount_cents); form.elements.handling_scope.value = settings.handling_scope;
  form.elements.fulfillment_shipping.checked = settings.fulfillment_methods.includes('shipping'); form.elements.fulfillment_pickup.checked = settings.fulfillment_methods.includes('pickup');
  form.elements.tax_status.value = settings.tax_status; form.elements.payment_status.value = settings.payment_status; form.elements.payment_mode.value = settings.payment_mode; form.elements.shipping_status.value = settings.shipping_status;
  const readiness = $('#settings-readiness'); replace(readiness);
  const missing = settings.readiness.missing || [];
  readiness.append(el('strong', missing.length ? 'Store setup is incomplete' : 'Configured store settings are ready'));
  if (missing.length) { const list = el('ul'); for (const item of missing) list.append(el('li', item)); readiness.append(list); }
  else readiness.append(el('p', 'Item readiness is still checked separately for each artwork.'));
  renderPackingProfiles();
}

async function loadSettings() {
  try { normalizeSettings(await api('/api/admin/settings')); renderSettings(); renderCards(); }
  catch (error) { announce(`Settings unavailable: ${error.message}`, true); }
}

function parseLines(value) {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => { const [id, label] = line.split('|').map(part => part.trim()); return label ? {id, label} : id; });
}

async function saveSettings(event) {
  event.preventDefault(); const form = event.currentTarget;
  $('#settings-save-state').textContent = 'Saving'; $('#settings-save-state').dataset.state = 'saving';
  try {
    const handling = parsePriceCents(form.elements.handling_amount.value);
    const payload = {
      expected_version: state.settingsVersion,
      settings: {
        shipping_origin: {line1: form.elements.origin_line1.value.trim() || null, line2: form.elements.origin_line2.value.trim() || null, city: form.elements.origin_city.value.trim() || null, region: form.elements.origin_region.value.trim() || null, postal_code: form.elements.origin_postal.value.trim() || null, country_code: form.elements.origin_country.value.trim().toUpperCase() || null},
        destinations: parseLines(form.elements.destinations.value), shipping_services: parseLines(form.elements.shipping_services.value),
        handling_amount_cents: handling, handling_scope: form.elements.handling_scope.value || null,
        fulfillment_methods: [form.elements.fulfillment_shipping.checked ? 'shipping' : null, form.elements.fulfillment_pickup.checked ? 'pickup' : null].filter(Boolean),
        tax_status: form.elements.tax_status.value,
      },
      packing_profiles: state.packingProfiles.map(profile => ({...profile, length: profile.length === '' ? null : Number(profile.length), width: profile.width === '' ? null : Number(profile.width), height: profile.height === '' ? null : Number(profile.height), weight: profile.weight === '' ? null : Number(profile.weight), units: profile.units || 'in_lb'})),
    };
    normalizeSettings(await sendJSON('/api/admin/settings', 'PUT', payload)); renderSettings(); renderCards();
    $('#settings-save-state').textContent = 'Saved'; $('#settings-save-state').dataset.state = 'saved'; announce('Store settings saved.');
  } catch (error) { $('#settings-save-state').textContent = 'Save failed'; $('#settings-save-state').dataset.state = 'failed'; announce(error.message, true); }
}

function renderOrders(data) {
  const orders = data.items || data.orders || [], container = $('#orders-list'); replace(container);
  if (!orders.length) container.append(el('p', 'No orders have been created.'));
  for (const order of orders) {
    const card = el('article', null, {class: 'order-card'}); const summary = el('div', null, {class: 'order-summary'});
    summary.append(el('div', `Order\n${order.order_number || order.id}`), el('div', `Payment\n${order.payment_status || 'Not started'}`), el('div', `Fulfillment\n${order.fulfillment_status || 'Not started'}`), el('div', `Total\n${Number.isSafeInteger(order.total_cents) ? money(order.total_cents) : 'Quote unresolved'}`));
    const lines = el('ul', null, {class: 'order-lines'}); for (const line of order.lines || []) lines.append(el('li', `${line.title} / ${line.configuration_label || line.label || 'Configuration'} × ${line.quantity}`));
    card.append(summary, lines);
    if (order.delivery) {
      const delivery = el('section', null, {class: 'order-delivery'});
      delivery.append(el('h3', 'Delivery'));
      const address = order.delivery.address || order.delivery;
      const addressNode = el('address');
      for (const value of [
        address.recipient,
        address.line1,
        address.line2,
        [address.city, address.region, address.postal_code].filter(Boolean).join(', '),
        address.country_code
      ].filter(Boolean)) addressNode.append(el('div', value));
      if (addressNode.childNodes.length) delivery.append(addressNode);
      if (order.delivery.service_reference) delivery.append(el('p', `Shipping service: ${order.delivery.service_reference}`));
      card.append(delivery);
    }
    if (order.provider_reference) card.append(el('p', `Provider reference: ${order.provider_reference}`));
    const status = el('select');
    for (const [value, label] of [['unfulfilled', 'Unfulfilled'], ['processing', 'Processing'], ['shipped', 'Shipped'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled']]) {
      status.append(el('option', label, {value, selected: (order.fulfillment_status || 'unfulfilled') === value}));
    }
    const tracking = el('input', null, {type: 'text', value: order.tracking || order.tracking_reference || '', placeholder: 'Tracking number or URL'});
    const save = el('button', 'Save fulfillment', {type: 'button', class: 'secondary'}); save.addEventListener('click', async () => { try { await sendJSON(`/api/admin/orders/${encodeURIComponent(order.id)}/tracking`, 'POST', {fulfillment_status: status.value, tracking_reference: tracking.value.trim() || null}); announce('Fulfillment saved.'); await loadOrders(); } catch (error) { announce(error.message, true); } });
    const row = el('div', null, {class: 'tracking-row'}); row.append(inputLabel('Fulfillment status', status), inputLabel('Tracking', tracking), save); card.append(row); container.append(card);
  }
  const pagination = data.pagination || data; state.ordersPage = pagination.page || state.ordersPage; state.ordersTotalPages = pagination.total_pages || 1;
  $('#orders-summary').textContent = pagination.total ? `Page ${state.ordersPage} of ${state.ordersTotalPages} · ${pagination.total} orders` : 'No orders';
  $('#previous-orders').disabled = state.ordersPage <= 1; $('#next-orders').disabled = state.ordersPage >= state.ordersTotalPages;
}

async function loadOrders() {
  try { renderOrders(await api(`/api/admin/orders?page=${state.ordersPage}`)); }
  catch (error) { announce(`Orders unavailable: ${error.message}`, true); }
}

async function switchView(view) {
  if (view !== 'artwork' && currentDirtyCards().length && !guardNavigation()) return;
  for (const node of document.querySelectorAll('.app-view')) node.hidden = node.id !== `${view}-view`;
  for (const tab of document.querySelectorAll('.nav-tab')) tab.classList.toggle('active', tab.dataset.view === view);
  if (view === 'settings') await loadSettings();
  if (view === 'orders') await loadOrders();
}

$('#catalog-controls').addEventListener('submit', event => {
  event.preventDefault(); if (!guardNavigation()) return;
  cacheCurrent(); state.query = $('#catalog-search').value.trim(); state.filter = $('#status-filter').value; state.page = 1; void loadArtworks();
});
$('#status-filter').addEventListener('change', () => $('#catalog-controls').requestSubmit());
$('#add-artwork').addEventListener('click', addArtwork);
$('#save-all').addEventListener('click', () => void saveCards(currentDirtyCards()));
$('#previous-page').addEventListener('click', () => { if (guardNavigation()) { cacheCurrent(); state.page--; void loadArtworks(); } });
$('#next-page').addEventListener('click', () => { if (guardNavigation()) { cacheCurrent(); state.page++; void loadArtworks(); } });
$('#page-number').addEventListener('change', event => { const page = Number(event.target.value); if (Number.isSafeInteger(page) && page >= 1 && page <= Math.max(state.totalPages, ...[...state.cache.keys()].map(key => Number(key.split('\u0000').at(-1)) || 1)) && guardNavigation()) { cacheCurrent(); state.page = page; void loadArtworks(); } else event.target.value = state.page; });
$('#save-store-order').addEventListener('click', () => void saveStoreOrder());
$('#close-preview').addEventListener('click', () => $('#preview-dialog').close());
$('#preview-dialog').addEventListener('click', event => { if (event.target === $('#preview-dialog')) $('#preview-dialog').close(); });
$('#settings-form').addEventListener('submit', saveSettings);
$('#settings-form').addEventListener('input', () => { $('#settings-save-state').textContent = 'Unsaved'; $('#settings-save-state').dataset.state = 'unsaved'; });
$('#add-packing-profile').addEventListener('click', () => { state.packingProfiles.push({id: uuid(), label: '', length: '', width: '', height: '', weight: '', units: 'in_lb'}); renderPackingProfiles(); });
$('#previous-orders').addEventListener('click', () => { state.ordersPage--; void loadOrders(); });
$('#next-orders').addEventListener('click', () => { state.ordersPage++; void loadOrders(); });
for (const tab of document.querySelectorAll('.nav-tab')) tab.addEventListener('click', () => void switchView(tab.dataset.view));
$('#sign-out').addEventListener('click', async () => { try { await getAuth()?.signOut(); } finally { location.reload(); } });
window.addEventListener('beforeunload', event => { if (hasDirtyCards()) { event.preventDefault(); event.returnValue = ''; } });

void Promise.all([loadSettings(), loadArtworks()]);

