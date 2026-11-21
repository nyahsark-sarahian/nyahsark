import {
  PAGE_SIZE, MAX_PHOTOS, MAX_UPLOAD_BYTES, SUPPORTED_IMAGE_TYPES,
  el, replace, announce, money, parsePriceCents, formatPriceInput,
  parseEighths, formatEighths, stepEighths, parseWhole, api, sendJSON,
  uuid, safeAdminMedia, statusLabel, uploadMimeType,
} from './common.js';
import {getAuth, privateImage, privateUpload} from './session.js';

const $ = selector => document.querySelector(selector);
const TRI_STATE_OPTIONS = [['unknown', 'Not yet confirmed'], ['no', 'No'], ['yes', 'Yes']];
const OBJECT_KIND_OPTIONS = [
  ['unknown', 'Not yet confirmed'],
  ['ordinary_devotional', 'Ordinary devotional artwork or object'],
  ['sacramental', 'Sacramental'],
  ['sacred_object', 'Blessed or dedicated sacred object'],
  ['relic', 'Relic or purported relic'],
  ['other', 'Other / needs review'],
];
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

function emptyCompliance() {
  return {
    object_kind: 'unknown',
    blessed_or_dedicated: 'unknown',
    purported_relic: 'unknown',
    relic_class_claim: null,
    contains_human_material: 'unknown',
    provenance_known: 'unknown',
    ecclesiastical_owner: 'unknown',
    authenticity_document: 'unknown',
    spiritual_benefit_priced: 'unknown',
    seller_attested: false,
  };
}

function normalizeCompliance(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {...emptyCompliance()};
  const objectKinds = new Set(OBJECT_KIND_OPTIONS.map(([item]) => item));
  if (objectKinds.has(source.object_kind)) normalized.object_kind = source.object_kind;
  const triStates = new Set(TRI_STATE_OPTIONS.map(([item]) => item));
  for (const field of [
    'blessed_or_dedicated', 'purported_relic', 'contains_human_material', 'provenance_known',
    'ecclesiastical_owner', 'authenticity_document', 'spiritual_benefit_priced',
  ]) if (triStates.has(source[field])) normalized[field] = source[field];
  normalized.relic_class_claim = typeof source.relic_class_claim === 'string' && source.relic_class_claim.trim()
    ? source.relic_class_claim.trim().slice(0, 160)
    : null;
  normalized.seller_attested = source.seller_attested === true;
  return normalized;
}

function emptyDraft() {
  return {
    title: '', description: '', category: null, base_price_cents: null,
    width_eighths: null, height_eighths: null, offered_for_sale: false,
    requested_store_position: null,
    inventory: {quantity_changed: false, intended_available_quantity: null, captured_version: 0},
    photos: [], configurations: [], compliance: emptyCompliance(),
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
  draft.compliance = normalizeCompliance(source.compliance);
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
    copilot: {
      assessment: raw.compliance_assessment || raw.assistance?.assessment || null,
      suggestion: raw.ai_suggestion || raw.assistance?.suggestion || null,
      priceGuidance: null,
      priceFloor: '',
      message: '',
      busy: false,
      reviewNote: '',
    },
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
  draft.compliance = normalizeCompliance(draft.compliance);
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
    const replaceInput = el('input', null, {type: 'file', accept: '.heic,.heif,image/heic,image/heif,image/jpeg,image/png,image/webp', hidden: true});
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
  uploadBox.append(el('p', `JPEG, PNG, WebP, HEIC, or HEIF. The backend converts every accepted upload to private WebP derivatives. Up to ${MAX_PHOTOS} photos, 5 MiB each, 16 MP, and 8192 px per side.`));
  const file = el('input', null, {type: 'file', accept: '.heic,.heif,image/heic,image/heif,image/jpeg,image/png,image/webp', multiple: true, disabled: card.state === 'archived' || card.draft.photos.length >= MAX_PHOTOS});
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
    const contentType = uploadMimeType(file);
    if (!SUPPORTED_IMAGE_TYPES.has(contentType)) { announce(`${file.name}: supported types are JPEG, PNG, WebP, HEIC, and HEIF.`, true); continue; }
    if (!file.size || file.size > MAX_UPLOAD_BYTES) { announce(`${file.name}: file must be no larger than 5 MiB.`, true); continue; }
    try {
      await ensureSaved(card);
      const allocation = await sendJSON('/api/admin/uploads', 'POST', {artwork_id: card.id, expected_version: card.version, idempotency_key: uuid(), replace_asset_id: replaceAssetId, filename: file.name, content_type: contentType, byte_size: file.size});
      const uploadId = allocation.upload_id || allocation.id;
      if (!uploadId) throw new Error('Upload allocation failed.');
      if (progressNode) progressNode.textContent = `${file.name}: 0%`;
      const result = await privateUpload(allocation.upload_url || `/api/admin/uploads/${uploadId}`, file, contentType, percent => {
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

function disclosureSelect(card, cardNode, field, labelText, choices = TRI_STATE_OPTIONS) {
  const select = el('select');
  for (const [value, label] of choices) select.append(el('option', label, {value, selected: card.draft.compliance[field] === value}));
  select.addEventListener('change', () => {
    card.draft.compliance[field] = select.value;
    markDirty(card, cardNode);
  });
  return inputLabel(labelText, select);
}

function normalizeCopySuggestion(payload) {
  const source = payload?.suggestion || payload?.suggestions || payload?.copy || payload;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('The assistant returned an unexpected suggestion. No draft fields were changed.');
  const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
  const rawAlt = Array.isArray(source.alt_texts) ? source.alt_texts : Array.isArray(source.photo_alt_texts) ? source.photo_alt_texts : [];
  const altTexts = rawAlt.map((item, index) => {
    if (typeof item === 'string') return {index, asset_id: null, alt: text(item)};
    return {
      index: Number.isSafeInteger(item?.index) ? item.index : index,
      asset_id: text(item?.asset_id),
      alt: text(item?.alt_text ?? item?.alt ?? item?.text),
    };
  }).filter(item => item.alt);
  const observations = (Array.isArray(source.observations) ? source.observations : []).map((item) => ({
    code: text(item?.code),
    summary: text(item?.summary),
    evidence: text(item?.evidence),
    asset_id: text(item?.asset_id),
    confidence: typeof item?.confidence === 'number' && Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : null,
  })).filter(item => item.summary && item.evidence);
  const suggestion = {
    title: text(source.title),
    description: text(source.description),
    category: text(source.category),
    visible_condition: text(source.visible_condition ?? source.condition),
    alt_texts: altTexts,
    observations,
    uncertainties: (Array.isArray(source.uncertainties) ? source.uncertainties : []).map(text).filter(Boolean),
  };
  if (!suggestion.title && !suggestion.description && !suggestion.category && !suggestion.visible_condition && !suggestion.alt_texts.length) {
    throw new Error('The assistant did not return any usable suggestions. No draft fields were changed.');
  }
  return suggestion;
}

function applyCopilotSuggestion(card, field = 'all') {
  const suggestion = card.copilot?.suggestion;
  if (!suggestion) return;
  if ((field === 'all' || field === 'title') && suggestion.title) card.draft.title = suggestion.title;
  if ((field === 'all' || field === 'description') && suggestion.description) card.draft.description = suggestion.description;
  if ((field === 'all' || field === 'category') && suggestion.category) card.draft.category = suggestion.category;
  if ((field === 'all' || field === 'visible_condition') && suggestion.visible_condition) {
    const condition = `Visible condition: ${suggestion.visible_condition}`;
    if (!card.draft.description.includes(condition)) card.draft.description = [card.draft.description.trim(), condition].filter(Boolean).join('\n\n');
  }
  if (field === 'all' || field === 'alt_texts') {
    for (const item of suggestion.alt_texts || []) {
      const photo = item.asset_id
        ? card.draft.photos.find(candidate => candidate.asset_id === item.asset_id)
        : card.draft.photos[item.index];
      if (photo) photo.alt = item.alt;
    }
  }
  markDirty(card);
  card.copilot.message = 'Suggestions were applied only to the unsaved form. Review them, then save explicitly.';
  renderCards();
}

function copilotUnavailableMessage(error) {
  const code = error?.details?.details?.code;
  if ([404, 501].includes(error?.status) || (error?.status === 503 && code === 'AI_ASSIST_UNAVAILABLE')) return 'Listing Copilot is not configured yet. No draft fields were changed.';
  if (error?.status === 503) return 'Listing Copilot is temporarily unavailable. No draft fields were changed; try again later.';
  return error?.message || 'Listing Copilot could not complete the request. No draft fields were changed.';
}

function copilotReady(card) {
  return Boolean(card.id) && !card.dirty && card.state !== 'archived' && !card.copilot.busy;
}

async function requestCopySuggestion(card) {
  if (!copilotReady(card)) {
    card.copilot.message = card.dirty ? 'Save the current draft before asking for suggestions.' : 'Save this artwork before asking for suggestions.';
    renderCards();
    return;
  }
  card.copilot.busy = true;
  card.copilot.message = 'Preparing editable wording suggestions…';
  renderCards();
  try {
    const result = await sendJSON(`/api/admin/artworks/${encodeURIComponent(card.id)}/assist/draft-copy`, 'POST', {expected_version: card.version});
    card.copilot.suggestion = normalizeCopySuggestion(result);
    card.copilot.message = result.message || 'Suggestions are ready. Nothing has been saved or published.';
    announce('Listing wording suggestions are ready for review.');
  } catch (error) {
    card.copilot.message = copilotUnavailableMessage(error);
    announce(card.copilot.message, true);
  } finally {
    card.copilot.busy = false;
    renderCards();
  }
}

async function requestComplianceAssessment(card) {
  if (!copilotReady(card)) {
    card.copilot.message = card.dirty ? 'Save the current disclosures before running canonical review.' : 'Save this artwork before running canonical review.';
    renderCards();
    return;
  }
  card.copilot.busy = true;
  card.copilot.message = 'Checking the saved revision against the canonical listing policy…';
  renderCards();
  try {
    const result = await sendJSON(`/api/admin/artworks/${encodeURIComponent(card.id)}/compliance/assess`, 'POST', {expected_version: card.version});
    card.copilot.assessment = result.assessment || result.compliance_assessment || result;
    if (result.suggestion) card.copilot.suggestion = normalizeCopySuggestion(result);
    card.copilot.message = result.message || 'Canonical review completed for this saved revision.';
    announce('Canonical listing review completed.');
  } catch (error) {
    card.copilot.message = copilotUnavailableMessage(error);
    announce(card.copilot.message, true);
  } finally {
    card.copilot.busy = false;
    renderCards();
  }
}

function effectiveComplianceDecision(card) {
  return String(card.copilot?.assessment?.effective_decision || card.copilot?.assessment?.decision || '').toLowerCase();
}

function normalizePriceGuidance(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const initial = source.initial && typeof source.initial === 'object' && !Array.isArray(source.initial) ? source.initial : null;
  const markdown = source.markdown && typeof source.markdown === 'object' && !Array.isArray(source.markdown) ? source.markdown : null;
  const evidence = source.evidence && typeof source.evidence === 'object' && !Array.isArray(source.evidence) ? source.evidence : {};
  if (!initial && !markdown) throw new Error('Price guidance returned an unexpected response. No price was changed.');
  return {initial, markdown, evidence};
}

async function requestPriceGuidance(card) {
  if (!copilotReady(card)) {
    card.copilot.message = card.dirty ? 'Save the current listing before asking for price guidance.' : 'Save this artwork before asking for price guidance.';
    renderCards();
    return;
  }
  if (!['allow', 'human_approved'].includes(effectiveComplianceDecision(card))) {
    card.copilot.message = 'Canonical listing review must allow this exact revision before price guidance is available.';
    renderCards();
    return;
  }
  let floor = null;
  try {
    floor = parsePriceCents(card.copilot.priceFloor, {allowBlank: true});
    const current = parsePriceCents(card._raw.price, {allowBlank: true, positive: true});
    if (current !== null && floor !== null && floor > current) throw new Error('Seller floor cannot be higher than the saved price.');
  } catch (error) {
    card.copilot.message = error.message;
    renderCards();
    return;
  }
  card.copilot.busy = true;
  card.copilot.message = 'Checking verified sales and server-owned listing activity…';
  renderCards();
  try {
    const result = await sendJSON(`/api/admin/artworks/${encodeURIComponent(card.id)}/assist/price`, 'POST', {
      expected_version: card.version,
      seller_floor_cents: floor,
    });
    card.copilot.priceGuidance = normalizePriceGuidance(result);
    card.copilot.message = result.message || 'Advisory price guidance is ready. No price was changed.';
    announce('Advisory price guidance is ready for review.');
  } catch (error) {
    card.copilot.message = error?.message || 'Price guidance could not be prepared. No price was changed.';
    announce(card.copilot.message, true);
  } finally {
    card.copilot.busy = false;
    renderCards();
  }
}

function applyPriceGuidance(card, cents, label) {
  if (!Number.isSafeInteger(cents) || cents < 1) return;
  card._raw.price = formatPriceInput(cents);
  card.draft.base_price_cents = cents;
  markDirty(card);
  card.copilot.message = `${label} was applied only to the unsaved form. Sarah can change or discard it before saving.`;
  renderCards();
}

async function submitHumanReview(card, decision) {
  const note = card.copilot.reviewNote.trim();
  if (!note) {
    card.copilot.message = 'Enter a review or appeal note before recording a human decision.';
    renderCards();
    return;
  }
  if (!copilotReady(card)) {
    card.copilot.message = 'Save the current draft before recording a human review decision.';
    renderCards();
    return;
  }
  card.copilot.busy = true;
  card.copilot.message = 'Recording the human review decision…';
  renderCards();
  try {
    const result = await sendJSON(`/api/admin/artworks/${encodeURIComponent(card.id)}/compliance/review`, 'POST', {expected_version: card.version, decision, note});
    const assessment = result.assessment || result.compliance_assessment || result.decision;
    card.copilot.assessment = typeof assessment === 'string' ? {decision: assessment} : assessment || card.copilot.assessment;
    card.copilot.reviewNote = '';
    card.copilot.message = result.message || 'Human review decision recorded in the audit history.';
    announce('Human compliance review recorded.');
  } catch (error) {
    card.copilot.message = copilotUnavailableMessage(error);
    announce(card.copilot.message, true);
  } finally {
    card.copilot.busy = false;
    renderCards();
  }
}

function renderCopySuggestion(card, container) {
  const suggestion = card.copilot.suggestion;
  if (!suggestion) return;
  const panel = el('section', null, {class: 'copilot-suggestion', ariaLabel: 'Editable assistant suggestions'});
  panel.append(el('h4', 'Suggested wording'));
  const fields = [
    ['title', 'Title'], ['description', 'Description'], ['category', 'Category'], ['visible_condition', 'Visible condition'],
  ];
  for (const [field, label] of fields) {
    if (!suggestion[field]) continue;
    const item = el('div', null, {class: 'suggestion-item'});
    item.append(el('strong', label), el('p', suggestion[field]));
    const apply = el('button', `Apply ${label.toLowerCase()}`, {type: 'button', class: 'secondary'});
    apply.addEventListener('click', () => applyCopilotSuggestion(card, field));
    item.append(apply); panel.append(item);
  }
  if (suggestion.alt_texts?.length) {
    const item = el('div', null, {class: 'suggestion-item'});
    item.append(el('strong', 'Photo descriptions'));
    const list = el('ul');
    for (const alt of suggestion.alt_texts) list.append(el('li', alt.alt));
    item.append(list);
    const apply = el('button', 'Apply photo descriptions', {type: 'button', class: 'secondary'});
    apply.addEventListener('click', () => applyCopilotSuggestion(card, 'alt_texts'));
    item.append(apply); panel.append(item);
  }
  if (suggestion.uncertainties?.length) {
    panel.append(el('strong', 'Seller verification needed'));
    const list = el('ul', null, {class: 'copilot-uncertainties'});
    for (const uncertainty of suggestion.uncertainties) list.append(el('li', uncertainty));
    panel.append(list);
  }
  if (suggestion.observations?.length) {
    panel.append(el('strong', 'Bounded visual observations (not authentication)'));
    const list = el('ul', null, {class: 'copilot-observations'});
    for (const observation of suggestion.observations) {
      const confidence = observation.confidence === null ? '' : ` Confidence: ${Math.round(observation.confidence * 100)}%.`;
      list.append(el('li', `${observation.summary} Evidence: ${observation.evidence}.${confidence}`));
    }
    panel.append(list);
  }
  const applyAll = el('button', 'Apply all suggested wording', {type: 'button', class: 'primary'});
  applyAll.addEventListener('click', () => applyCopilotSuggestion(card));
  panel.append(applyAll, el('p', 'Applying suggestions changes only this unsaved form. It never saves or publishes.', {class: 'help'}));
  container.append(panel);
}

function renderPriceGuidance(card, container) {
  const wrapper = el('section', null, {class: 'copilot-pricing', ariaLabel: 'Advisory price guidance'});
  wrapper.append(
    el('h4', 'Advisory price guidance'),
    el('p', 'Guidance uses verified store sales and server-owned activity only. It never changes a price automatically, and Sarah may override every suggestion.', {class: 'help'}),
  );
  const controls = el('div', null, {class: 'pricing-controls'});
  const floor = el('input', null, {
    type: 'text', inputMode: 'decimal', placeholder: 'Optional', value: card.copilot.priceFloor || '', disabled: !copilotReady(card),
  });
  floor.addEventListener('input', () => { card.copilot.priceFloor = floor.value; });
  const request = el('button', card.copilot.busy ? 'Working…' : 'Get price guidance', {
    type: 'button', class: 'secondary',
    disabled: !copilotReady(card) || !['allow', 'human_approved'].includes(effectiveComplianceDecision(card)),
  });
  request.addEventListener('click', () => void requestPriceGuidance(card));
  controls.append(inputLabel('Seller floor (USD, optional)', floor), request);
  wrapper.append(controls);
  if (!['allow', 'human_approved'].includes(effectiveComplianceDecision(card))) {
    wrapper.append(el('p', 'Complete canonical listing review for this saved revision before requesting price guidance.', {class: 'help'}));
  }

  const guidance = card.copilot.priceGuidance;
  if (guidance) {
    const initial = guidance.initial;
    const markdown = guidance.markdown;
    const results = el('div', null, {class: 'pricing-results'});
    const initialPanel = el('div', null, {class: 'pricing-result'});
    initialPanel.append(el('strong', 'Initial price range'));
    if (initial?.status === 'suggested' && Number.isSafeInteger(initial.low_cents) && Number.isSafeInteger(initial.midpoint_cents) && Number.isSafeInteger(initial.high_cents)) {
      initialPanel.append(
        el('p', `${money(initial.low_cents)}–${money(initial.high_cents)}; midpoint ${money(initial.midpoint_cents)}.`),
        el('p', `${initial.comparable_count || 0} verified comparable sale${initial.comparable_count === 1 ? '' : 's'} · ${String(initial.confidence || 'low')} confidence.`, {class: 'help'}),
      );
      const apply = el('button', `Apply ${money(initial.midpoint_cents)} midpoint`, {type: 'button', class: 'secondary'});
      apply.addEventListener('click', () => applyPriceGuidance(card, initial.midpoint_cents, 'The suggested midpoint'));
      initialPanel.append(apply);
    } else {
      initialPanel.append(el('p', initial?.reason || 'There is not enough verified comparable-sale evidence yet.', {class: 'help'}));
    }
    const markdownPanel = el('div', null, {class: 'pricing-result'});
    markdownPanel.append(el('strong', 'Listing-age adjustment'));
    if (markdown?.status === 'suggested' && Number.isSafeInteger(markdown.proposed_price_cents) && Number.isSafeInteger(markdown.suggested_markdown_percent)) {
      markdownPanel.append(
        el('p', `Consider ${markdown.suggested_markdown_percent}% off, to ${money(markdown.proposed_price_cents)}.`),
        el('p', Array.isArray(markdown.rationale) ? markdown.rationale.join(' ') : 'The recommendation uses listing age and verified buyer activity.', {class: 'help'}),
      );
      const apply = el('button', `Apply ${money(markdown.proposed_price_cents)}`, {type: 'button', class: 'secondary'});
      apply.addEventListener('click', () => applyPriceGuidance(card, markdown.proposed_price_cents, 'The suggested markdown'));
      markdownPanel.append(apply);
    } else {
      markdownPanel.append(el('p', markdown?.reason || 'There is not enough listing-age and buyer-activity evidence for a markdown.', {class: 'help'}));
    }
    results.append(initialPanel, markdownPanel);
    wrapper.append(results, el('p', 'Applying guidance changes only the unsaved price field. It never saves, publishes, or changes a live price.', {class: 'help'}));
  }
  container.append(wrapper);
}

function renderAssessment(card, container) {
  const assessment = card.copilot.assessment;
  const decision = String(assessment?.effective_decision || assessment?.decision || assessment?.status || 'not_checked').toLowerCase();
  const labels = {
    allow: 'Allowed by the current listing policy',
    human_approved: 'Approved after human review',
    review: 'Human review required',
    request_information: 'More information required',
    block: 'Sale listing blocked',
    human_blocked: 'Blocked after human review',
    pending: 'Review pending',
    error: 'Review could not be completed',
    not_checked: 'Not checked yet',
  };
  const status = el('div', null, {class: `copilot-status ${decision}`, role: 'status', ariaLive: 'polite'});
  status.append(el('strong', labels[decision] || 'Review status unavailable'));
  const reasons = assessment?.messages || assessment?.reasons || assessment?.reason_codes || [];
  if (Array.isArray(reasons) && reasons.length) {
    const list = el('ul');
    for (const reason of reasons) list.append(el('li', typeof reason === 'string' ? reason : reason.message || reason.code || 'Review note'));
    status.append(list);
  }
  const policy = assessment?.policy_version || assessment?.policyVersion;
  status.append(el('p', policy ? `Policy: ${policy}` : 'Policy: canonical-listing-v1', {class: 'help'}));
  container.append(status);
}

function renderListingCopilot(card, cardNode) {
  card.draft.compliance = normalizeCompliance(card.draft.compliance);
  card.copilot ||= {assessment: null, suggestion: null, priceGuidance: null, priceFloor: '', message: '', busy: false, reviewNote: ''};
  card.copilot.priceGuidance ??= null;
  card.copilot.priceFloor ??= '';
  const section = el('section', null, {class: 'card-section copilot-panel'});
  section.append(
    el('h3', 'Listing Copilot'),
    el('p', 'These disclosures and photographs support description drafting and canonical-policy screening. A photograph cannot prove a blessing, provenance, or relic authenticity.', {class: 'help'}),
  );

  const disclosures = el('fieldset', null, {class: 'compliance-disclosures'});
  disclosures.append(el('legend', 'Seller disclosures'));
  const grid = el('div', null, {class: 'field-grid three disclosure-grid'});
  grid.append(
    disclosureSelect(card, cardNode, 'object_kind', 'Object type', OBJECT_KIND_OPTIONS),
    disclosureSelect(card, cardNode, 'blessed_or_dedicated', 'Blessed or dedicated?'),
    disclosureSelect(card, cardNode, 'purported_relic', 'Claimed to be a relic?'),
    disclosureSelect(card, cardNode, 'contains_human_material', 'Contains human material?'),
    disclosureSelect(card, cardNode, 'provenance_known', 'Provenance known?'),
    disclosureSelect(card, cardNode, 'ecclesiastical_owner', 'Owned by a church or ecclesiastical entity?'),
    disclosureSelect(card, cardNode, 'authenticity_document', 'Relic authenticity document present?'),
    disclosureSelect(card, cardNode, 'spiritual_benefit_priced', 'Price includes a blessing or spiritual benefit?'),
  );
  const relicClaim = el('input', null, {type: 'text'});
  relicClaim.maxLength = 160;
  relicClaim.placeholder = 'Example: first-class, ex ossibus, contact relic';
  relicClaim.value = card.draft.compliance.relic_class_claim || '';
  relicClaim.addEventListener('input', () => {
    card.draft.compliance.relic_class_claim = relicClaim.value.trim() || null;
    markDirty(card, cardNode);
  });
  grid.append(inputLabel('Relic classification claimed (if any)', relicClaim));
  disclosures.append(grid);
  const attestation = el('input', null, {type: 'checkbox', checked: card.draft.compliance.seller_attested});
  attestation.addEventListener('change', () => { card.draft.compliance.seller_attested = attestation.checked; markDirty(card, cardNode); });
  const attestationLabel = el('label', null, {class: 'copilot-attestation'});
  attestationLabel.append(attestation, document.createTextNode(' I confirm these answers are accurate to the best of my knowledge and understand that AI observations are not authentication.'));
  disclosures.append(attestationLabel);
  section.append(disclosures);

  renderAssessment(card, section);
  const unavailableReason = !card.id ? 'Save this artwork to enable Listing Copilot.'
    : card.dirty ? 'Save the current draft and disclosures to enable analysis for the exact revision.'
      : card.state === 'archived' ? 'Restore this artwork before using Listing Copilot.' : '';
  if (unavailableReason) section.append(el('p', unavailableReason, {class: 'help copilot-prerequisite'}));

  const actions = el('div', null, {class: 'copilot-actions'});
  const suggest = el('button', card.copilot.busy ? 'Working…' : 'Draft description and alt text', {type: 'button', class: 'secondary', disabled: !copilotReady(card)});
  suggest.addEventListener('click', () => void requestCopySuggestion(card));
  const assess = el('button', card.copilot.busy ? 'Working…' : 'Run canonical listing review', {type: 'button', class: 'secondary', disabled: !copilotReady(card)});
  assess.addEventListener('click', () => void requestComplianceAssessment(card));
  actions.append(suggest, assess); section.append(actions);

  if (card.copilot.message) section.append(el('p', card.copilot.message, {class: 'copilot-message', role: 'status', ariaLive: 'polite'}));
  renderCopySuggestion(card, section);
  renderPriceGuidance(card, section);

  const review = el('div', null, {class: 'copilot-review'});
  review.append(el('h4', 'Human review or appeal'));
  const note = el('textarea', null, {rows: 3, minLength: 8, maxLength: 2000, placeholder: 'Record the evidence, clarification, or appeal reason (at least 8 characters).'});
  note.value = card.copilot.reviewNote;
  const reviewActions = el('div', null, {class: 'copilot-actions'});
  const approve = el('button', 'Approve after review', {type: 'button', class: 'secondary'});
  const requestInfo = el('button', 'Request more information', {type: 'button', class: 'secondary'});
  const block = el('button', 'Block after review', {type: 'button', class: 'danger'});
  const currentDecision = String(card.copilot.assessment?.effective_decision || card.copilot.assessment?.decision || card.copilot.assessment?.status || 'not_checked').toLowerCase();
  const updateReviewButtons = () => {
    const disabled = !copilotReady(card) || card.copilot.reviewNote.trim().length < 8 || !card.copilot.assessment;
    approve.disabled = disabled || currentDecision !== 'review';
    requestInfo.disabled = disabled; block.disabled = disabled;
  };
  note.addEventListener('input', () => { card.copilot.reviewNote = note.value; updateReviewButtons(); });
  approve.addEventListener('click', () => void submitHumanReview(card, 'approve'));
  requestInfo.addEventListener('click', () => void submitHumanReview(card, 'request_information'));
  block.addEventListener('click', () => void submitHumanReview(card, 'block'));
  reviewActions.append(approve, requestInfo, block); updateReviewButtons();
  review.append(inputLabel('Review / appeal note', note), reviewActions);
  if (currentDecision === 'block') review.append(el('p', 'A hard block for an explicit relic sale or priced spiritual benefit cannot be overridden. The note can document an appeal or corrected evidence for a new revision.', {class: 'help'}));
  review.append(el('p', 'Human decisions are recorded separately from AI observations and should cite the evidence reviewed.', {class: 'help'}));
  section.append(review);
  return section;
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
  const copilot = renderListingCopilot(card, node);

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
  node.append(heading, identity, description, commerce, measurements, copilot, storeOrder, photos, configurations, errors, actions);
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
        card.copilot = {assessment: null, suggestion: null, priceGuidance: null, priceFloor: '', message: '', busy: false, reviewNote: ''};
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

