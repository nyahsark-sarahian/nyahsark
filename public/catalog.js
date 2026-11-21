const CART_KEY = 'nyahsark.cart.v1';
const MAX_CART_LINES = 50;
const MAX_LINE_QUANTITY = 99;

const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const text = value => typeof value === 'string' ? value : '';

export function money(cents) {
  if (!integer(cents)) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function formatEighths(value) {
  if (!integer(value, 1)) return null;
  const whole = Math.floor(value / 8);
  const remainder = value % 8;
  if (!remainder) return `${whole} in`;
  const divisors = [[4, 2, 4], [2, 1, 4], [6, 3, 4]];
  const match = divisors.find(([numerator]) => numerator === remainder);
  const fraction = match ? `${match[1]}/${match[2]}` : `${remainder}/8`;
  return `${whole ? whole + ' ' : ''}${fraction} in`;
}

export function sanitizeCart(value) {
  if (!Array.isArray(value)) return [];
  const results = [];
  const seen = new Set();
  for (const item of value) {
    const artworkId = text(item?.artwork_id);
    const configurationId = text(item?.configuration_id);
    const quantity = Number(item?.quantity);
    const key = artworkId + '\n' + configurationId;
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(artworkId) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(configurationId) || !integer(quantity, 1) || quantity > MAX_LINE_QUANTITY || seen.has(key)) continue;
    seen.add(key);
    results.push({ artwork_id: artworkId, configuration_id: configurationId, quantity });
    if (results.length === MAX_CART_LINES) break;
  }
  return results;
}

function normalizedPhotos(snapshot, raw) {
  const source = Array.isArray(snapshot.photos) ? snapshot.photos : Array.isArray(raw.photos) ? raw.photos : Array.isArray(raw.images) ? raw.images : [];
  const hasExplicitMain = source.some(photo => photo?.is_main === true || photo?.main === true);
  return source.map((photo, index) => {
    const assetId = text(photo.asset_id || photo.id || photo.object_key);
    const url = text(photo.url || photo.path) || (assetId ? `/catalog-media/${encodeURIComponent(assetId)}/display` : '');
    return { asset_id: assetId, url, alt: text(photo.alt || photo.alt_text), position: integer(photo.position) ? photo.position : integer(photo.sort_order) ? photo.sort_order : index, is_main: photo.is_main === true || photo.main === true || (!hasExplicitMain && index === 0) };
  }).filter(photo => photo.url).sort((a, b) => a.position - b.position);
}

function normalizedConfigurations(snapshot, raw, basePrice) {
  const source = Array.isArray(snapshot.configurations) ? snapshot.configurations : Array.isArray(raw.configurations) ? raw.configurations : Array.isArray(raw.variants) ? raw.variants : [];
  return source.map((configuration, index) => {
    const fullPrice = integer(configuration.price_cents) ? configuration.price_cents : null;
    const addOn = integer(configuration.price_add_on_cents) ? configuration.price_add_on_cents : fullPrice !== null && basePrice !== null ? Math.max(0, fullPrice - basePrice) : null;
    return {
      id: text(configuration.id || configuration.configuration_id),
      label: text(configuration.label) || `Option ${index + 1}`,
      enabled: configuration.enabled !== false,
      price_add_on_cents: addOn,
      full_price_cents: fullPrice,
      packing_profile_id: text(configuration.packing_profile_id) || null
    };
  }).filter(configuration => configuration.id);
}

export function normalizeArtwork(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const revision = raw.published_revision && typeof raw.published_revision === 'object' ? raw.published_revision : raw.revision && typeof raw.revision === 'object' ? raw.revision : raw;
  const snapshot = revision.snapshot && typeof revision.snapshot === 'object' ? revision.snapshot : revision;
  const id = text(raw.stable_id || raw.artwork_id || raw.id);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) return null;
  const basePrice = integer(snapshot.base_price_cents) ? snapshot.base_price_cents : integer(raw.base_price_cents) ? raw.base_price_cents : null;
  const inventory = raw.inventory && typeof raw.inventory === 'object' ? raw.inventory : {};
  const available = integer(raw.available_quantity) ? raw.available_quantity : integer(inventory.available_quantity) ? inventory.available_quantity : integer(inventory.available) ? inventory.available : integer(raw.stock) ? raw.stock : null;
  const photos = normalizedPhotos(snapshot, raw);
  const configurations = normalizedConfigurations(snapshot, raw, basePrice);
  const offered = snapshot.offered_for_sale === true || raw.offered_for_sale === true;
  const enabled = configurations.filter(configuration => configuration.enabled);
  const saleReady = offered && integer(basePrice, 1) && integer(available, 1) && enabled.some(configuration => configuration.packing_profile_id && (integer(configuration.price_add_on_cents) || integer(configuration.full_price_cents, 1)));
  return {
    id,
    title: text(snapshot.title || raw.title) || 'Untitled artwork',
    description: text(snapshot.description || raw.description),
    category: text(snapshot.category || raw.category) || null,
    base_price_cents: basePrice,
    width_eighths: integer(snapshot.width_eighths, 1) ? snapshot.width_eighths : null,
    height_eighths: integer(snapshot.height_eighths, 1) ? snapshot.height_eighths : null,
    offered_for_sale: offered,
    sale_ready: saleReady,
    available_quantity: available,
    photos,
    configurations: enabled,
    store_position: integer(raw.store_position) ? raw.store_position : null
  };
}

export function configurationPrice(artwork, configuration) {
  if (integer(configuration?.full_price_cents)) return configuration.full_price_cents;
  if (!integer(artwork?.base_price_cents) || !integer(configuration?.price_add_on_cents)) return null;
  const total = artwork.base_price_cents + configuration.price_add_on_cents;
  return Number.isSafeInteger(total) ? total : null;
}

function element(tag, value, attributes = {}) {
  const node = document.createElement(tag);
  if (value !== undefined && value !== null) node.textContent = value;
  for (const [name, attribute] of Object.entries(attributes)) {
    if (attribute === null || attribute === undefined || attribute === false) continue;
    if (name === 'className') node.className = attribute;
    else if (name === 'disabled') node.disabled = Boolean(attribute);
    else node.setAttribute(name, String(attribute));
  }
  return node;
}

async function api(path, init) {
  const response = await fetch(path, { ...init, credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const error = new Error(text(payload?.error) || 'The store could not complete this request.');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  if (!payload || typeof payload !== 'object') throw new Error('The store returned an unexpected response.');
  return payload;
}

function readCart() {
  try { return sanitizeCart(JSON.parse(localStorage.getItem(CART_KEY) || '[]')); } catch { return []; }
}

function writeCart(cart) {
  const clean = sanitizeCart(cart);
  try { localStorage.setItem(CART_KEY, JSON.stringify(clean)); } catch { /* storage can be unavailable */ }
  updateCartCount(clean);
  return clean;
}

function updateCartCount(cart = readCart()) {
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  document.querySelectorAll('.cart-count').forEach(node => { node.textContent = String(count); node.setAttribute('aria-label', `${count} item${count === 1 ? '' : 's'} in cart`); });
}

function addToCart(artworkId, configurationId) {
  const cart = readCart();
  const existing = cart.find(item => item.artwork_id === artworkId && item.configuration_id === configurationId);
  if (existing) existing.quantity = Math.min(MAX_LINE_QUANTITY, existing.quantity + 1);
  else cart.push({ artwork_id: artworkId, configuration_id: configurationId, quantity: 1 });
  writeCart(cart);
}

function mainPhoto(artwork) {
  return artwork.photos.find(photo => photo.is_main) || artwork.photos[0] || null;
}

function dimensions(artwork) {
  const width = formatEighths(artwork.width_eighths);
  const height = formatEighths(artwork.height_eighths);
  return width && height ? `${width} × ${height}` : 'Dimensions not yet recorded';
}

function availability(artwork) {
  if (!artwork.offered_for_sale) return 'Display only';
  if (!integer(artwork.available_quantity)) return 'Availability not yet confirmed';
  if (artwork.available_quantity === 0) return 'Sold out';
  if (!artwork.sale_ready) return 'Purchase details incomplete';
  return artwork.available_quantity === 1 ? 'One available' : `${artwork.available_quantity} available`;
}

function purchaseControls(artwork) {
  const container = element('div', null, { className: 'purchase-controls' });
  const configurations = artwork.configurations.filter(configuration => configuration.packing_profile_id && configurationPrice(artwork, configuration) !== null);
  if (!artwork.offered_for_sale || !artwork.sale_ready || !integer(artwork.available_quantity, 1) || !configurations.length) {
    container.append(element('p', availability(artwork), { className: 'availability' }));
    return container;
  }
  const label = element('label', 'Choose configuration');
  const select = element('select', null, { 'aria-label': `Configuration for ${artwork.title}` });
  for (const configuration of configurations) {
    const price = money(configurationPrice(artwork, configuration));
    select.append(element('option', `${configuration.label}${price ? ` — ${price}` : ''}`, { value: configuration.id }));
  }
  const priceLine = element('p', '', { className: 'selected-price', 'aria-live': 'polite' });
  const updatePrice = () => {
    const configuration = configurations.find(option => option.id === select.value);
    priceLine.textContent = money(configurationPrice(artwork, configuration)) || 'Price unavailable';
  };
  select.addEventListener('change', updatePrice);
  label.append(select); container.append(label, priceLine);
  const add = element('button', 'Add to cart', { type: 'button', className: 'button' });
  add.addEventListener('click', () => { addToCart(artwork.id, select.value); add.textContent = 'Added'; setTimeout(() => { add.textContent = 'Add to cart'; }, 1200); });
  container.append(add); updatePrice();
  return container;
}

function galleryCard(artwork) {
  const card = element('article', null, { className: 'gallery-card', id: artwork.id });
  const photo = mainPhoto(artwork);
  if (photo) {
    const link = element('a', null, { className: 'gallery-image', href: `/artwork.html?id=${encodeURIComponent(artwork.id)}`, 'aria-label': `View ${artwork.title}` });
    link.append(element('img', null, { src: photo.url, alt: photo.alt || artwork.title, loading: 'lazy', decoding: 'async' })); card.append(link);
  }
  const copy = element('div', null, { className: 'gallery-copy' });
  copy.append(element('span', artwork.category || 'Artwork', { className: 'number' }));
  const heading = element('h3'); heading.append(element('a', artwork.title, { href: `/artwork.html?id=${encodeURIComponent(artwork.id)}` })); copy.append(heading);
  copy.append(element('p', artwork.description));
  const base = money(artwork.base_price_cents);
  copy.append(element('p', base && artwork.offered_for_sale ? `Base artwork price ${base}` : availability(artwork), { className: 'gallery-coming' }));
  copy.append(purchaseControls(artwork)); card.append(copy);
  return card;
}

function payloadItems(payload) {
  const source = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.artworks) ? payload.artworks : Array.isArray(payload.products) ? payload.products : [];
  return source.map(normalizeArtwork).filter(Boolean);
}

const catalogState = { page: 1, pages: 1 };

function fillCategoryOptions(payload) {
  const select = document.querySelector('#category-filter');
  if (!select) return;
  const selected = select.value;
  const source = payload.facets?.categories || payload.categories || [];
  const categories = source.map(item => typeof item === 'string' ? item : item?.value || item?.category).filter(value => typeof value === 'string' && value.trim()).sort();
  if (!categories.length) return;
  select.replaceChildren(element('option', 'All categories', { value: '' }));
  for (const category of [...new Set(categories)]) select.append(element('option', category, { value: category }));
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

async function loadCatalog(page = 1) {
  const form = document.querySelector('#catalog-controls');
  const grid = document.querySelector('#gallery-grid');
  const status = document.querySelector('#catalog-status');
  const values = new FormData(form);
  const query = new URLSearchParams({ page: String(page), page_size: '24', sort: text(values.get('sort')) || 'store', availability: text(values.get('availability')) || 'all' });
  if (text(values.get('category'))) query.set('category', text(values.get('category')));
  status.textContent = 'Loading the collection…'; grid.replaceChildren();
  try {
    const payload = await api(`/api/catalog?${query}`);
    const items = payloadItems(payload);
    fillCategoryOptions(payload);
    for (const artwork of items) grid.append(galleryCard(artwork));
    const pagination = payload.pagination || {};
    catalogState.page = integer(pagination.page, 1) ? pagination.page : page;
    catalogState.pages = integer(pagination.pages, 1) ? pagination.pages : integer(payload.total_pages, 1) ? payload.total_pages : 1;
    const total = integer(pagination.total) ? pagination.total : integer(payload.total) ? payload.total : items.length;
    const first = integer(pagination.from, 1) ? pagination.from : items.length ? (catalogState.page - 1) * 24 + 1 : 0;
    const last = integer(pagination.to) ? pagination.to : first + Math.max(0, items.length - 1);
    status.textContent = items.length ? `Showing ${first}–${last} of ${total} artworks.` : 'No published artwork matches these filters.';
    const nav = document.querySelector('#catalog-pagination');
    nav.hidden = catalogState.pages <= 1;
    document.querySelector('#catalog-page-summary').textContent = `Page ${catalogState.page} of ${catalogState.pages}`;
    nav.querySelector('[data-page-action="previous"]').disabled = catalogState.page <= 1;
    nav.querySelector('[data-page-action="next"]').disabled = catalogState.page >= catalogState.pages;
  } catch (error) {
    status.textContent = `${error.message} Please contact Nyah's Ark if you need information about a piece.`;
  }
}

function renderItem(artwork) {
  const detail = document.querySelector('#item-detail');
  detail.replaceChildren();
  const layout = element('div', null, { className: 'item-layout' });
  const media = element('div', null, { className: 'item-media' });
  const primary = mainPhoto(artwork);
  if (primary) {
    const mainImage = element('img', null, { className: 'item-primary-image', src: primary.url, alt: primary.alt || artwork.title }); media.append(mainImage);
    if (artwork.photos.length > 1) {
      const views = element('div', null, { className: 'item-views', 'aria-label': 'Additional views' });
      for (const photo of artwork.photos) {
        const button = element('button', null, { type: 'button', 'aria-label': `Show ${photo.alt || artwork.title}` });
        button.append(element('img', null, { src: photo.url, alt: '' }));
        button.addEventListener('click', () => { mainImage.src = photo.url; mainImage.alt = photo.alt || artwork.title; }); views.append(button);
      }
      media.append(views);
    }
  }
  const copy = element('div', null, { className: 'item-copy' });
  copy.append(element('p', artwork.category || 'Artwork', { className: 'eyebrow' }), element('h1', artwork.title), element('p', artwork.description), element('p', dimensions(artwork), { className: 'item-fact' }), element('p', availability(artwork), { className: 'item-fact' }), purchaseControls(artwork));
  layout.append(media, copy); detail.append(layout); detail.hidden = false;
}

async function loadItem() {
  const id = new URLSearchParams(location.search).get('id') || '';
  const status = document.querySelector('#item-status');
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) { status.textContent = 'Artwork not found.'; return; }
  try {
    const payload = await api(`/api/catalog/${encodeURIComponent(id)}`);
    const artwork = normalizeArtwork(payload.item || payload.artwork || payload.product || payload);
    if (!artwork) throw new Error('Artwork not found.');
    document.title = `${artwork.title} | Nyah's Ark`; renderItem(artwork); status.textContent = '';
  } catch (error) { status.textContent = error.message; }
}

let currentQuote = null;
const checkoutAttempt = {quoteId: null, key: null};

export function idempotencyKeyForQuote(quoteId, state = checkoutAttempt, create = () => crypto.randomUUID()) {
  if (typeof quoteId !== 'string' || !quoteId) throw new Error('Quote identifier is required.');
  if (state.quoteId !== quoteId || typeof state.key !== 'string' || !state.key) {
    state.quoteId = quoteId;
    state.key = create();
  }
  return state.key;
}

function cartPayload() {
  return readCart().map(({ artwork_id, configuration_id, quantity }) => ({ artwork_id, configuration_id, quantity }));
}

function setAmount(id, cents, missing) {
  const node = document.querySelector(id);
  if (node) node.textContent = money(cents) || missing;
}

function updateCartLine(artworkId, configurationId, quantity) {
  let cart = readCart();
  if (quantity <= 0) cart = cart.filter(item => item.artwork_id !== artworkId || item.configuration_id !== configurationId);
  else cart = cart.map(item => item.artwork_id === artworkId && item.configuration_id === configurationId ? { ...item, quantity: Math.min(MAX_LINE_QUANTITY, quantity) } : item);
  writeCart(cart); loadCart();
}

function renderQuote(payload) {
  currentQuote = payload;
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const container = document.querySelector('#cart-lines'); container.replaceChildren();
  for (const line of lines) {
    const artworkId = text(line.artwork_id || line.product_id);
    const configurationId = text(line.configuration_id || line.variant_id);
    const row = element('article', null, { className: 'cart-line' });
    const details = element('div'); details.append(element('h2', text(line.title) || artworkId), element('p', text(line.configuration_label || line.label) || configurationId), element('p', money(line.line_total_cents) || 'Price unavailable'));
    const controls = element('div', null, { className: 'cart-line-controls' });
    const quantity = element('input', null, { type: 'number', min: '1', max: String(MAX_LINE_QUANTITY), step: '1', value: integer(line.quantity, 1) ? line.quantity : 1, 'aria-label': `Quantity for ${text(line.title) || artworkId}` });
    quantity.value = String(integer(line.quantity, 1) ? line.quantity : 1);
    quantity.addEventListener('change', () => { const value = Number(quantity.value); if (integer(value, 1) && value <= MAX_LINE_QUANTITY) updateCartLine(artworkId, configurationId, value); });
    const remove = element('button', 'Remove', { type: 'button' }); remove.addEventListener('click', () => updateCartLine(artworkId, configurationId, 0)); controls.append(quantity, remove); row.append(details, controls); container.append(row);
  }
  setAmount('#subtotal', payload.merchandise_subtotal_cents ?? payload.subtotal_cents, '—');
  setAmount('#shipping', payload.shipping_cents, 'Shipping quote required');
  setAmount('#handling', payload.handling_cents, 'Calculated after delivery address');
  setAmount('#tax', payload.tax_cents, 'Calculated after delivery address');
  setAmount('#total', payload.grand_total_cents ?? payload.total_cents, 'Shipping quote required');
  const serviceSelect = document.querySelector('#shipping-service');
  const selectedService = serviceSelect.value;
  const services = Array.isArray(payload.shipping_services) ? payload.shipping_services : [];
  serviceSelect.replaceChildren(element('option', services.length ? 'Choose a shipping service' : 'No shipping quote available', { value: '' }));
  for (const service of services) serviceSelect.append(element('option', `${text(service.label) || text(service.id)}${money(service.amount_cents) ? ` — ${money(service.amount_cents)}` : ''}`, { value: text(service.id) }));
  if ([...serviceSelect.options].some(option => option.value === selectedService)) serviceSelect.value = selectedService;
  const checkout = document.querySelector('#checkout');
  const ready = payload.checkout_enabled === true && text(payload.quote_id);
  checkout.disabled = !ready; checkout.textContent = ready ? 'Continue to secure checkout' : 'Checkout not yet available';
  const reasons = Array.isArray(payload.missing_setup) ? payload.missing_setup : Array.isArray(payload.errors) ? payload.errors : [];
  document.querySelector('#checkout-status').textContent = ready ? 'Your verified total is ready for secure hosted checkout.' : reasons.length ? reasons.map(reason => typeof reason === 'string' ? reason : reason.message).filter(Boolean).join(' ') : 'Checkout not yet available';
}

async function requestQuote(address = null, serviceId = null) {
  const items = cartPayload();
  if (!items.length) return null;
  return api('/api/cart/quote', { method: 'POST', body: JSON.stringify({ items, delivery_address: address, shipping_service_id: serviceId || null }) });
}

async function loadCart() {
  const cart = readCart(); updateCartCount(cart);
  const status = document.querySelector('#cart-status');
  if (!cart.length) {
    document.querySelector('#cart-lines').replaceChildren(element('p', 'Your cart is empty.')); status.textContent = '';
    document.querySelector('#quote-form').querySelector('button').disabled = true; return;
  }
  status.textContent = 'Checking current prices and availability…';
  try { renderQuote(await requestQuote()); status.textContent = 'Current merchandise prices and availability checked.'; }
  catch (error) {
    status.textContent = error.message;
    const container = document.querySelector('#cart-lines'); container.replaceChildren();
    for (const item of cart) container.append(element('p', `Saved selection: ${item.artwork_id}, configuration ${item.configuration_id}, quantity ${item.quantity}. Price requires a server check.`));
  }
}

function addressFromForm(form) {
  const values = new FormData(form);
  return { line1: text(values.get('line1')).trim(), line2: text(values.get('line2')).trim() || null, city: text(values.get('city')).trim(), region: text(values.get('region')).trim(), postal_code: text(values.get('postal_code')).trim(), country: text(values.get('country')).trim().toUpperCase() };
}

async function initCart() {
  await loadCart();
  document.querySelector('#quote-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { renderQuote(await requestQuote(addressFromForm(event.currentTarget), text(new FormData(event.currentTarget).get('service_id')))); document.querySelector('#cart-status').textContent = 'Delivery quote refreshed. Review any changed total before checkout.'; }
    catch (error) { document.querySelector('#cart-status').textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.querySelector('#checkout').addEventListener('click', async () => {
    const button = document.querySelector('#checkout');
    if (button.disabled || !text(currentQuote?.quote_id)) return;
    button.disabled = true;
    try {
      const result = await api('/api/checkout', { method: 'POST', body: JSON.stringify({ quote_id: currentQuote.quote_id, idempotency_key: idempotencyKeyForQuote(currentQuote.quote_id) }) });
      const destination = new URL(result.checkout_url);
      if (destination.protocol !== 'https:') throw new Error('Secure checkout URL unavailable.');
      location.assign(destination.href);
    } catch (error) { document.querySelector('#cart-status').textContent = error.message; button.disabled = false; }
  });
}

async function init() {
  updateCartCount();
  const page = document.body.dataset.page;
  if (page === 'catalog') {
    const form = document.querySelector('#catalog-controls'); form.addEventListener('submit', event => { event.preventDefault(); loadCatalog(1); });
    document.querySelector('#catalog-pagination').addEventListener('click', event => { const action = event.target.closest('button')?.dataset.pageAction; if (action === 'previous' && catalogState.page > 1) loadCatalog(catalogState.page - 1); if (action === 'next' && catalogState.page < catalogState.pages) loadCatalog(catalogState.page + 1); });
    await loadCatalog();
  } else if (page === 'artwork') await loadItem();
  else if (page === 'cart') await initCart();
}

if (typeof document !== 'undefined') init().catch(() => { const status = document.querySelector('[role="status"]'); if (status) status.textContent = 'The store could not finish loading.'; });

