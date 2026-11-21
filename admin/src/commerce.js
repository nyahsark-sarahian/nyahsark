import {HttpError, assertInteger, assertText} from './http.js';

const MAX_MONEY = 100_000_000_000;
const QUOTE_TTL_SECONDS = 15 * 60;
const INCOMPLETE_QUOTE_TTL_SECONDS = 5 * 60;
const RESERVATION_TTL_SECONDS = 30 * 60;
const ORDER_PAGE_SIZE = 20;

const rows = async (statement) => (await statement.all()).results || [];
const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);
const parseJson = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};
const nowSeconds = (context = {}) => Number.isSafeInteger(context.now) ? context.now : Math.floor(Date.now() / 1000);
const uuid = () => crypto.randomUUID();
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;

function saleCompliancePredicate(revisionExpression = 'r.id') {
  return `EXISTS(
    SELECT 1 FROM catalog_compliance_effective e
    WHERE e.revision_id=${revisionExpression}
      AND e.policy_version=(
        SELECT p.id FROM catalog_policy_versions p WHERE p.status='active'
        ORDER BY p.activated_at DESC,p.id DESC LIMIT 1
      )
      AND e.id=(
        SELECT a2.id FROM catalog_compliance_assessments a2
        WHERE a2.revision_id=${revisionExpression} AND a2.policy_version=e.policy_version
        ORDER BY a2.created_at DESC,a2.rowid DESC LIMIT 1
      )
      AND e.effective_decision IN ('allow','human_approved')
  )`;
}

async function saleComplianceAllowed(database, revisionIds) {
  const ids = [...new Set((Array.isArray(revisionIds) ? revisionIds : [])
    .filter((value) => typeof value === 'string' && value))];
  if (!ids.length) return false;
  const placeholders = ids.map(() => '?').join(',');
  const row = await database.prepare(`SELECT count(DISTINCT r.id) AS allowed_count
    FROM catalog_artwork_revisions r
    WHERE r.id IN (${placeholders})
      AND (r.offered_for_sale=0 OR ${saleCompliancePredicate('r.id')})`).bind(...ids).first();
  return Number(row?.allowed_count ?? 0) === ids.length;
}

async function assertSaleCompliance(database, revisionIds) {
  if (!(await saleComplianceAllowed(database, revisionIds))) {
    throw new HttpError(409, 'Listing compliance changed; request a fresh total', {code: 'COMPLIANCE_CHANGED'});
  }
}

async function orderRevisionIds(database, orderId) {
  const lines = await rows(database.prepare('SELECT snapshot_json FROM catalog_order_lines WHERE order_id=? ORDER BY line_number').bind(orderId));
  const revisionIds = lines.map((line) => parseJson(line.snapshot_json, {})?.revision_id);
  return revisionIds.length && revisionIds.every((value) => typeof value === 'string' && value) ? revisionIds : [];
}

async function assertOrderSaleCompliance(database, orderId) {
  await assertSaleCompliance(database, await orderRevisionIds(database, orderId));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

const canonical = (value) => JSON.stringify(stableValue(value));
const hex = (buffer) => [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
async function hash(value) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))));
}
async function hashBytes(value) {
  return hex(await crypto.subtle.digest('SHA-256', value));
}

function requiredString(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${label} is invalid`);
  return value.trim();
}

function optionalString(value, label, max = 200) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${label} is invalid`);
  return value.trim() || null;
}

function normalizeAddress(value, label = 'Address') {
  if (value == null) return null;
  if (!isObject(value)) throw new HttpError(400, `${label} is invalid`);
  const country = requiredString(value.country_code ?? value.country, `${label} country`, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new HttpError(400, `${label} country is invalid`);
  const address = {
    recipient: optionalString(value.recipient, `${label} recipient`, 160),
    line1: requiredString(value.line1, `${label} line 1`, 200),
    line2: optionalString(value.line2, `${label} line 2`, 200),
    city: requiredString(value.city, `${label} city`, 120),
    region: requiredString(value.region, `${label} region`, 100).toUpperCase(),
    postal_code: requiredString(value.postal_code, `${label} postal code`, 32),
    country_code: country
  };
  return address;
}

function containsSecretKey(value) {
  if (Array.isArray(value)) return value.some(containsSecretKey);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    /(?:secret|password|token|api.?key|private.?key|card|credential)/i.test(key) || containsSecretKey(nested));
}

function normalizeConfig(value) {
  if (!isObject(value)) return {};
  if (containsSecretKey(value)) throw new HttpError(400, 'Secrets do not belong in store settings');
  const text = canonical(value);
  if (new TextEncoder().encode(text).byteLength > 32 * 1024) throw new HttpError(413, 'Store settings are too large');
  const output = {...value};
  if (output.packing_strategy != null && output.packing_strategy !== 'separate_packages') {
    throw new HttpError(400, 'Packing strategy is invalid');
  }
  if (output.payment_merchant_reference != null) {
    output.payment_merchant_reference = requiredString(output.payment_merchant_reference, 'Payment merchant reference', 160);
  }
  return output;
}

function normalizePackingProfiles(value) {
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'Packing profiles are invalid');
  const ids = new Set();
  const scaled = (input, label, alreadyScaled = false) => {
    if (alreadyScaled) return assertInteger(input, 1, 100_000_000, label);
    const source = String(input ?? '').trim();
    if (!/^\d+(?:\.\d{1,3})?$/.test(source) || Number(source) <= 0) throw new HttpError(400, `${label} is invalid`);
    const [whole, fraction = ''] = source.split('.');
    const result = Number(whole) * 1000 + Number((fraction + '000').slice(0, 3));
    return assertInteger(result, 1, 100_000_000, label);
  };
  return value.map((profile) => {
    if (!isObject(profile)) throw new HttpError(400, 'Packing profile is invalid');
    const id = requiredString(profile.id, 'Packing profile identifier', 80);
    if (id.length < 8 || ids.has(id)) throw new HttpError(400, 'Packing profile identifier is invalid');
    ids.add(id);
    const hasUiLength = Object.hasOwn(profile, 'length');
    const hasUiWidth = Object.hasOwn(profile, 'width');
    const hasUiHeight = Object.hasOwn(profile, 'height');
    const hasUiWeight = Object.hasOwn(profile, 'weight');
    const uiUnits = profile.units;
    if (uiUnits != null && !['in_lb', 'cm_kg'].includes(uiUnits)) throw new HttpError(400, 'Packing profile units are invalid');
    const dimensionUnit = uiUnits ? (uiUnits === 'cm_kg' ? 'cm' : 'in') : profile.dimension_unit;
    const weightUnit = uiUnits ? (uiUnits === 'cm_kg' ? 'kg' : 'lb') : profile.weight_unit;
    return {
      id,
      label: requiredString(profile.label, 'Packing profile label', 160),
      length_value: scaled(hasUiLength ? profile.length : profile.length_value, 'Packed length', !hasUiLength),
      width_value: scaled(hasUiWidth ? profile.width : profile.width_value, 'Packed width', !hasUiWidth),
      height_value: scaled(hasUiHeight ? profile.height : profile.height_value, 'Packed height', !hasUiHeight),
      dimension_unit: ['in', 'cm'].includes(dimensionUnit) ? dimensionUnit : (() => { throw new HttpError(400, 'Packed dimension unit is invalid'); })(),
      weight_value: scaled(hasUiWeight ? profile.weight : profile.weight_value, 'Packed weight', !hasUiWeight),
      weight_unit: ['oz', 'lb', 'g', 'kg'].includes(weightUnit) ? weightUnit : (() => { throw new HttpError(400, 'Packed weight unit is invalid'); })(),
      enabled: profile.enabled !== false
    };
  });
}

function normalizeServices(value) {
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'Shipping services are invalid');
  const ids = new Set();
  return value.map((raw) => {
    const service = typeof raw === 'string' ? {id: raw, label: raw, provider_service_code: raw, enabled: true} : raw;
    const id = requiredString(service?.id, 'Shipping service identifier', 80);
    if (ids.has(id)) throw new HttpError(400, 'Shipping service identifier is duplicated');
    ids.add(id);
    return {
      id,
      label: requiredString(service.label, 'Shipping service label', 160),
      provider_service_code: optionalString(service.provider_service_code ?? service.id, 'Provider service code', 160),
      enabled: service.enabled !== false
    };
  });
}

function normalizeDestinations(value) {
  if (!Array.isArray(value) || value.length > 200) throw new HttpError(400, 'Supported destinations are invalid');
  const ids = new Set();
  return value.map((raw) => {
    const code = typeof raw === 'string' ? raw : (raw?.code || raw?.id || '');
    const parts = code.toUpperCase().split(/[-:]/, 2);
    const destination = typeof raw === 'string' ? {id: raw, country_code: parts[0], region_code: parts[1] || null, enabled: true} : raw;
    const id = requiredString(destination?.id || code, 'Destination identifier', 80);
    const country = requiredString(destination.country_code || parts[0], 'Destination country', 2).toUpperCase();
    const region = optionalString(destination.region_code ?? parts[1], 'Destination region', 100)?.toUpperCase() || null;
    if (!/^[A-Z]{2}$/.test(country) || ids.has(id)) throw new HttpError(400, 'Supported destination is invalid');
    ids.add(id);
    return {id, country_code: country, region_code: region, enabled: destination.enabled !== false};
  });
}

function normalizeFulfillment(value) {
  if (!Array.isArray(value) || value.length > 20) throw new HttpError(400, 'Fulfillment methods are invalid');
  const ids = new Set();
  return value.map((raw) => {
    const method = typeof raw === 'string' ? {id: raw, label: raw === 'pickup' ? 'Pickup' : 'Shipping', kind: raw, enabled: true} : raw;
    const id = requiredString(method?.id, 'Fulfillment identifier', 80);
    if (ids.has(id) || !['shipping', 'pickup'].includes(method.kind)) throw new HttpError(400, 'Fulfillment method is invalid');
    ids.add(id);
    return {id, label: requiredString(method.label, 'Fulfillment label', 160), kind: method.kind, enabled: method.enabled !== false};
  });
}

function readiness(settings) {
  const missing = [];
  if (!settings.shipping_origin) missing.push('shipping_origin');
  if (!settings.packing_profiles.some((profile) => profile.enabled)) missing.push('packing_profiles');
  if (!settings.shipping_services.some((service) => service.enabled && service.provider_service_code)) missing.push('shipping_services');
  if (!settings.supported_destinations.some((destination) => destination.enabled)) missing.push('supported_destinations');
  if (!settings.fulfillment_methods.some((method) => method.enabled)) missing.push('fulfillment_methods');
  if (settings.handling_cents == null || !settings.handling_scope) missing.push('handling');
  if (settings.tax_status !== 'verified') missing.push('tax_registration');
  if (settings.payment_status === 'missing' || settings.payment_mode === 'disabled' || !settings.config.payment_merchant_reference) missing.push('payment_connection');
  return {catalog_ready: true, quote_ready: missing.filter((item) => item !== 'payment_connection').length === 0, payment_ready: missing.length === 0, missing};
}

export async function getSettings(database) {
  const base = await database.prepare('SELECT * FROM catalog_store_settings WHERE id=1').first();
  if (!base) throw new HttpError(503, 'Store settings are unavailable');
  const [packingProfiles, shippingServices, destinations, fulfillment] = await Promise.all([
    rows(database.prepare('SELECT * FROM catalog_packing_profiles ORDER BY label,id')),
    rows(database.prepare('SELECT * FROM catalog_shipping_services ORDER BY label,id')),
    rows(database.prepare('SELECT * FROM catalog_supported_destinations ORDER BY country_code,region_code,id')),
    rows(database.prepare('SELECT * FROM catalog_fulfillment_methods ORDER BY kind,label,id'))
  ]);
  const normalizedProfiles = packingProfiles.map((profile) => ({
    ...profile, enabled: profile.enabled === 1,
    length: profile.length_value / 1000, width: profile.width_value / 1000,
    height: profile.height_value / 1000, weight: profile.weight_value / 1000,
    units: profile.dimension_unit === 'cm' ? 'cm_kg' : 'in_lb', value_scale: 1000
  }));
  const settings = {
    version: base.version,
    shipping_origin: parseJson(base.shipping_origin_json),
    tax_status: base.tax_status,
    payment_status: base.payment_status,
    payment_mode: base.payment_mode,
    handling_cents: base.handling_cents,
    handling_scope: base.handling_scope,
    config: parseJson(base.config_json, {}),
    packing_profiles: normalizedProfiles,
    shipping_services: shippingServices.map((service) => ({...service, enabled: service.enabled === 1})),
    supported_destinations: destinations.map((destination) => ({...destination, enabled: destination.enabled === 1})),
    fulfillment_methods: fulfillment.map((method) => ({...method, enabled: method.enabled === 1}))
  };
  settings.readiness = readiness(settings);
  const uiTax = {missing: 'unconfigured', configured: 'pending', verified: 'configured'}[settings.tax_status];
  settings.settings = {
    shipping_origin: settings.shipping_origin || {},
    destinations: settings.supported_destinations.filter((item) => item.enabled).map((item) => ({code: `${item.country_code}${item.region_code ? `-${item.region_code}` : ''}`, label: item.id})),
    shipping_services: settings.shipping_services.filter((item) => item.enabled).map((item) => ({id: item.provider_service_code || item.id, label: item.label})),
    handling_amount_cents: settings.handling_cents,
    handling_scope: settings.handling_scope,
    fulfillment_methods: settings.fulfillment_methods.filter((item) => item.enabled).map((item) => item.kind),
    tax_status: uiTax,
    payment_status: settings.payment_status === 'missing' ? 'Not connected' : settings.payment_status,
    payment_mode: settings.payment_mode === 'disabled' ? 'Disabled' : settings.payment_mode,
    shipping_status: settings.readiness.missing.some((item) => item.startsWith('shipping') || item === 'packing_profiles' || item === 'supported_destinations') ? 'Not configured' : 'Configured',
    readiness: settings.readiness
  };
  return settings;
}

export async function saveSettings(database, input, actor = 'admin') {
  if (!isObject(input)) throw new HttpError(400, 'Store settings are invalid');
  const source = isObject(input.settings) ? input.settings : input;
  const current = await getSettings(database);
  const expectedVersion = assertInteger(input.expected_version, 0, Number.MAX_SAFE_INTEGER, 'Settings version');
  const originInput = source.shipping_origin;
  const originBlank = isObject(originInput) && Object.values(originInput).every((value) => value == null || String(value).trim() === '');
  const shippingOrigin = originInput == null || originBlank ? null : normalizeAddress(originInput, 'Shipping origin');
  const uiTax = {unconfigured: 'missing', pending: 'configured', configured: 'verified'}[source.tax_status];
  const taxStatus = uiTax || (['missing', 'configured', 'verified'].includes(source.tax_status) ? source.tax_status : current.tax_status);
  const paymentStatus = current.payment_status;
  const paymentMode = current.payment_mode;
  if (paymentMode !== 'disabled' && paymentStatus !== paymentMode) throw new HttpError(400, 'Payment status and mode do not match');
  const rawHandling = source.handling_cents ?? source.handling_amount_cents;
  const handlingCents = rawHandling == null ? null : assertInteger(rawHandling, 0, 100_000_000, 'Handling amount');
  const handlingScope = source.handling_scope == null ? null : (['order', 'package'].includes(source.handling_scope) ? source.handling_scope : (() => { throw new HttpError(400, 'Handling scope is invalid'); })());
  if ((handlingCents == null) !== (handlingScope == null)) throw new HttpError(400, 'Handling amount and scope must be configured together');
  const config = normalizeConfig(source.config || current.config || {});
  const profiles = normalizePackingProfiles(input.packing_profiles || []);
  const services = normalizeServices(source.shipping_services || []);
  const destinations = normalizeDestinations(source.supported_destinations || source.destinations || []);
  const methods = normalizeFulfillment(source.fulfillment_methods || []);
  const statements = [database.prepare(
    'INSERT INTO catalog_settings_commands(id,expected_version,shipping_origin_json,tax_status,payment_status,payment_mode,handling_cents,handling_scope,config_json,actor) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).bind(uuid(), expectedVersion, shippingOrigin ? JSON.stringify(shippingOrigin) : null, taxStatus, paymentStatus, paymentMode, handlingCents, handlingScope, JSON.stringify(config), actor)];

  statements.push(database.prepare('UPDATE catalog_packing_profiles SET enabled=0,updated_at=unixepoch()'));
  for (const profile of profiles) statements.push(database.prepare(
    `INSERT INTO catalog_packing_profiles(id,label,length_value,width_value,height_value,dimension_unit,weight_value,weight_unit,enabled)
     VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,length_value=excluded.length_value,width_value=excluded.width_value,height_value=excluded.height_value,dimension_unit=excluded.dimension_unit,weight_value=excluded.weight_value,weight_unit=excluded.weight_unit,enabled=excluded.enabled,version=catalog_packing_profiles.version+1,updated_at=unixepoch()`
  ).bind(profile.id, profile.label, profile.length_value, profile.width_value, profile.height_value, profile.dimension_unit, profile.weight_value, profile.weight_unit, profile.enabled ? 1 : 0));
  statements.push(database.prepare('UPDATE catalog_shipping_services SET enabled=0'));
  for (const service of services) statements.push(database.prepare(
    `INSERT INTO catalog_shipping_services(id,label,provider_service_code,enabled) VALUES(?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET label=excluded.label,provider_service_code=excluded.provider_service_code,enabled=excluded.enabled,version=catalog_shipping_services.version+1`
  ).bind(service.id, service.label, service.provider_service_code, service.enabled ? 1 : 0));
  statements.push(database.prepare('UPDATE catalog_supported_destinations SET enabled=0'));
  for (const destination of destinations) statements.push(database.prepare(
    `INSERT INTO catalog_supported_destinations(id,country_code,region_code,enabled) VALUES(?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET country_code=excluded.country_code,region_code=excluded.region_code,enabled=excluded.enabled`
  ).bind(destination.id, destination.country_code, destination.region_code, destination.enabled ? 1 : 0));
  statements.push(database.prepare('UPDATE catalog_fulfillment_methods SET enabled=0'));
  for (const method of methods) statements.push(database.prepare(
    `INSERT INTO catalog_fulfillment_methods(id,label,kind,enabled) VALUES(?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET label=excluded.label,kind=excluded.kind,enabled=excluded.enabled`
  ).bind(method.id, method.label, method.kind, method.enabled ? 1 : 0));
  try {
    await database.batch(statements);
  } catch (error) {
    if (String(error).includes('SETTINGS_CONFLICT')) throw new HttpError(409, 'Store settings changed in another session');
    throw error;
  }
  return getSettings(database);
}

async function readProviderJson(response, label) {
  if (!(response instanceof Response) || !response.ok) throw new HttpError(503, `${label} is unavailable`);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new HttpError(503, `${label} returned an invalid response`);
  try {
    const value = JSON.parse(text);
    if (!isObject(value)) throw Error();
    return value;
  } catch {
    throw new HttpError(503, `${label} returned an invalid response`);
  }
}

async function callJsonBinding(binding, url, body, label) {
  if (!binding?.fetch) throw new HttpError(503, `${label} is not configured`);
  const response = await binding.fetch(new Request(url, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  }));
  return readProviderJson(response, label);
}

function normalizeItems(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw new HttpError(400, 'Provide 1 to 50 cart lines');
  const combined = new Map();
  for (const item of value) {
    const artworkId = requiredString(item?.artwork_id, 'Artwork identifier', 80);
    const configurationId = requiredString(item?.configuration_id, 'Configuration identifier', 80);
    const quantity = assertInteger(item?.quantity, 1, 99, 'Quantity');
    const key = `${artworkId}\u0000${configurationId}`;
    const total = (combined.get(key)?.quantity || 0) + quantity;
    if (total > 99) throw new HttpError(400, 'Quantity limit exceeded');
    combined.set(key, {artwork_id: artworkId, configuration_id: configurationId, quantity: total});
  }
  return [...combined.values()];
}

async function loadMerchandise(database, requested) {
  const lines = [];
  const artworkTotals = new Map();
  let merchandise = 0;
  for (const item of requested) {
    const row = await database.prepare(
      `SELECT a.id AS artwork_internal_id,a.stable_id,h.published_revision_id AS revision_id,
              r.title,r.content_hash,r.base_price_cents,r.width_eighths,r.height_eighths,r.offered_for_sale,
              rc.configuration_id,rc.label AS configuration_label,rc.price_add_on_cents,rc.packing_profile_id,
              p.label AS packing_label,p.length_value,p.width_value,p.height_value,p.dimension_unit,p.weight_value,p.weight_unit,
              i.physical_stock,i.reserved_stock,i.version AS inventory_version
       FROM catalog_artworks a
       JOIN catalog_artwork_heads h ON h.artwork_id=a.id AND h.archived_at IS NULL AND h.published_revision_id IS NOT NULL
       JOIN catalog_artwork_revisions r ON r.id=h.published_revision_id AND r.offered_for_sale=1
       JOIN catalog_revision_configurations rc ON rc.revision_id=r.id AND rc.enabled=1
       JOIN catalog_packing_profiles p ON p.id=rc.packing_profile_id AND p.enabled=1
       JOIN catalog_inventory i ON i.artwork_id=a.id
       WHERE a.stable_id=? AND rc.configuration_id=?`
    ).bind(item.artwork_id, item.configuration_id).first();
    if (!row || !integer(row.base_price_cents, 1, MAX_MONEY) || !integer(row.price_add_on_cents, 0, MAX_MONEY)) {
      throw new HttpError(409, 'An item or frame choice is no longer available');
    }
    const unit = row.base_price_cents + row.price_add_on_cents;
    const lineTotal = unit * item.quantity;
    if (!Number.isSafeInteger(lineTotal) || lineTotal > MAX_MONEY) throw new HttpError(400, 'Cart total is too large');
    merchandise += lineTotal;
    if (!Number.isSafeInteger(merchandise) || merchandise > MAX_MONEY) throw new HttpError(400, 'Cart total is too large');
    const artworkQuantity = (artworkTotals.get(row.artwork_internal_id) || 0) + item.quantity;
    artworkTotals.set(row.artwork_internal_id, artworkQuantity);
    const available = row.physical_stock == null ? null : row.physical_stock - row.reserved_stock;
    if (!integer(available, 0, 1_000_000) || artworkQuantity > available) throw new HttpError(409, 'Insufficient shared artwork stock');
    const snapshot = {
      stable_id: row.stable_id,
      title: row.title,
      revision_id: row.revision_id,
      content_hash: row.content_hash,
      configuration_id: row.configuration_id,
      configuration_label: row.configuration_label,
      base_price_cents: row.base_price_cents,
      price_add_on_cents: row.price_add_on_cents,
      inventory_version: row.inventory_version,
      packing_profile: {
        id: row.packing_profile_id,label: row.packing_label,
        length_value: row.length_value,width_value: row.width_value,height_value: row.height_value,dimension_unit: row.dimension_unit,
        weight_value: row.weight_value,weight_unit: row.weight_unit,value_scale:1000
      }
    };
    lines.push({
      artwork_id: row.artwork_internal_id,
      stable_id: row.stable_id,
      revision_id: row.revision_id,
      configuration_id: row.configuration_id,
      quantity: item.quantity,
      unit_price_cents: unit,
      line_total_cents: lineTotal,
      snapshot
    });
  }
  await assertSaleCompliance(database, lines.map((line) => line.revision_id));
  return {lines, merchandise_cents: merchandise};
}

function publicQuote(quote, lines, missing, checkoutEnabled = false, shippingServices = []) {
  return {
    quote_id: quote.id,
    status: quote.status,
    currency: 'USD',
    expires_at: quote.expires_at,
    lines: lines.map((line) => ({
      artwork_id: line.stable_id,
      configuration_id: line.configuration_id,
      title: line.snapshot.title,
      configuration_label: line.snapshot.configuration_label,
      quantity: line.quantity,
      unit_price_cents: line.unit_price_cents,
      line_total_cents: line.line_total_cents
    })),
    merchandise_cents: quote.merchandise_cents,
    merchandise_subtotal_cents: quote.merchandise_cents,
    shipping_cents: quote.shipping_cents,
    handling_cents: quote.handling_cents,
    tax_cents: quote.tax_cents,
    grand_total_cents: quote.grand_total_cents,
    service_reference: quote.service_reference,
    tax_breakdown: quote.tax_breakdown,
    shipping_services: shippingServices.map((service) => ({id: service.id, label: service.label})),
    missing_setup: [...new Set(missing)],
    shipping_status: quote.shipping_cents == null ? 'Shipping quote required' : 'quoted',
    checkout_enabled: checkoutEnabled,
    checkout_status: checkoutEnabled ? 'ready' : 'Checkout not yet available'
  };
}

async function idempotentResponse(database, scope, key, requestHash, now) {
  if (!key) return null;
  const row = await database.prepare('SELECT request_hash,response_json,expires_at FROM catalog_idempotency_records WHERE scope=? AND idempotency_key=?').bind(scope, key).first();
  if (!row) return null;
  if (row.request_hash !== requestHash) throw new HttpError(409, 'Idempotency key was reused with different data');
  if (row.expires_at != null && row.expires_at <= now) throw new HttpError(409, 'Idempotent quote expired; use a new idempotency key');
  const response = parseJson(row.response_json);
  if (!response) throw new HttpError(503, 'Stored idempotent response is invalid');
  return response;
}

export async function createQuote(database, input, env = {}, context = {}) {
  if (!isObject(input)) throw new HttpError(400, 'Quote request is invalid');
  const requested = normalizeItems(input.items);
  const idempotencyKey = input.idempotency_key == null ? null : requiredString(input.idempotency_key, 'Idempotency key', 160);
  if (idempotencyKey && idempotencyKey.length < 8) throw new HttpError(400, 'Idempotency key is invalid');
  const now = nowSeconds(context);
  const requestHash = await hash(input);
  const prior = await idempotentResponse(database, 'quote', idempotencyKey, requestHash, now);
  if (prior) {
    const record = await quoteRecord(database, prior.quote_id);
    await assertSaleCompliance(database, record.lines.map((line) => line.revision_id));
    return prior;
  }

  const settings = await getSettings(database);
  const merchandise = await loadMerchandise(database, requested);
  const address = input.delivery_address == null ? null : normalizeAddress(input.delivery_address, 'Delivery address');
  const serviceId = input.shipping_service_id == null ? null : requiredString(input.shipping_service_id, 'Shipping service', 80);
  const missing = [];
  if (!address) missing.push('delivery_address');
  if (!serviceId) missing.push('shipping_service');
  if (!settings.shipping_origin) missing.push('shipping_origin');
  if (settings.handling_cents == null || !settings.handling_scope) missing.push('handling');
  if (settings.tax_status !== 'verified') missing.push('tax_registration');
  if (!env.SHIPPING_PROVIDER?.fetch) missing.push('shipping_provider');
  if (!env.TAX_PROVIDER?.fetch) missing.push('tax_provider');
  const itemCount = merchandise.lines.reduce((sum, line) => sum + line.quantity, 0);
  if (itemCount > 1 && settings.config.packing_strategy !== 'separate_packages') missing.push('multi_item_packing_strategy');

  let service = null;
  if (serviceId) {
    service = settings.shipping_services.find((item) => item.id === serviceId && item.enabled && item.provider_service_code);
    if (!service) missing.push('shipping_service');
  }
  if (address) {
    const supported = settings.supported_destinations.some((destination) => destination.enabled && destination.country_code === address.country_code && (!destination.region_code || destination.region_code === address.region));
    if (!supported) missing.push('unsupported_destination');
  }

  let shipping = null;
  let handling = null;
  let tax = null;
  let serviceReference = null;
  let taxBreakdown = null;
  const packages = merchandise.lines.map((line) => ({
    artwork_id: line.stable_id,
    configuration_id: line.configuration_id,
    quantity: line.quantity,
    ...line.snapshot.packing_profile
  }));
  if (!missing.some((item) => ['delivery_address','shipping_service','shipping_origin','shipping_provider','multi_item_packing_strategy','unsupported_destination'].includes(item))) {
    try {
      const result = await callJsonBinding(env.SHIPPING_PROVIDER, 'https://shipping.internal/quote', {
        currency: 'USD', origin: settings.shipping_origin, destination: address,
        service_code: service.provider_service_code, packages,
        packing_strategy: settings.config.packing_strategy || 'single_package'
      }, 'Shipping quote');
      if (result.currency !== 'USD' || !integer(result.shipping_cents, 0, MAX_MONEY) || typeof result.service_reference !== 'string' || !result.service_reference || result.service_reference.length > 200) {
        throw new HttpError(503, 'Shipping quote returned invalid totals');
      }
      shipping = result.shipping_cents;
      serviceReference = result.service_reference;
      handling = settings.handling_scope === 'package' ? settings.handling_cents * packages.reduce((sum, item) => sum + item.quantity, 0) : settings.handling_cents;
      if (!integer(handling, 0, MAX_MONEY)) throw new HttpError(503, 'Handling total is invalid');
    } catch {
      missing.push('shipping_quote_failed');
      shipping = null; handling = null; serviceReference = null;
    }
  }
  if (shipping != null && handling != null && !missing.some((item) => ['tax_registration','tax_provider'].includes(item))) {
    const taxableBasis = merchandise.merchandise_cents + shipping + handling;
    try {
      const result = await callJsonBinding(env.TAX_PROVIDER, 'https://tax.internal/quote', {
        currency: 'USD', destination: address,
        merchandise_cents: merchandise.merchandise_cents,
        seller_shipping_cents: shipping,
        seller_handling_cents: handling,
        taxable_basis_cents: taxableBasis,
        registration_reference: settings.config.tax_registration_reference || null,
        lines: merchandise.lines.map((line) => ({artwork_id: line.stable_id, quantity: line.quantity, line_total_cents: line.line_total_cents}))
      }, 'Tax quote');
      const breakdown = result.breakdown;
      if (
        result.currency !== 'USD' || !integer(result.tax_cents, 0, MAX_MONEY) ||
        result.taxable_basis_cents !== taxableBasis ||
        !isObject(breakdown) || typeof breakdown.jurisdiction !== 'string' || !breakdown.jurisdiction ||
        typeof breakdown.jurisdiction_code !== 'string' || !breakdown.jurisdiction_code ||
        !Array.isArray(breakdown.rates) || breakdown.rates.length < 1 || breakdown.rates.length > 20 ||
        breakdown.rates.some((rate) => !isObject(rate) || typeof rate.name !== 'string' || !rate.name ||
          !(Number.isFinite(rate.rate_basis_points) && rate.rate_basis_points >= 0) && !(Number.isFinite(rate.rate) && rate.rate >= 0)) ||
        typeof breakdown.source_reference !== 'string' || !breakdown.source_reference || breakdown.source_reference.length > 300 ||
        typeof breakdown.calculated_at !== 'string' || !Number.isFinite(Date.parse(breakdown.calculated_at))
      ) throw new HttpError(503, 'Tax quote returned invalid totals');
      tax = result.tax_cents;
      taxBreakdown = {...breakdown, taxable_basis_cents: taxableBasis};
    } catch {
      missing.push('tax_quote_failed');
      tax = null; taxBreakdown = null;
    }
  }

  const ready = shipping != null && handling != null && tax != null && missing.length === 0;
  const grand = ready ? merchandise.merchandise_cents + shipping + handling + tax : null;
  const quote = {
    id: uuid(), status: ready ? 'ready' : 'incomplete', merchandise_cents: merchandise.merchandise_cents,
    shipping_cents: shipping, handling_cents: handling, tax_cents: tax, grand_total_cents: grand,
    service_reference: serviceReference, tax_breakdown: taxBreakdown,
    expires_at: now + (ready ? QUOTE_TTL_SECONDS : INCOMPLETE_QUOTE_TTL_SECONDS)
  };
  const catalogVersion = await hash(merchandise.lines.map((line) => ({
    revision_id: line.revision_id, content_hash: line.snapshot.content_hash,
    configuration_id: line.configuration_id, unit_price_cents: line.unit_price_cents,
    inventory_version: line.snapshot.inventory_version
  })));
  const checkoutEnabled = ready && paymentReady(settings, env);
  const response = publicQuote(quote, merchandise.lines, missing, checkoutEnabled, settings.shipping_services.filter((item) => item.enabled && item.provider_service_code));
  const statements = [database.prepare(
    `INSERT INTO catalog_quotes(id,idempotency_key,status,currency,merchandise_cents,shipping_cents,handling_cents,tax_cents,grand_total_cents,address_json,service_reference,tax_breakdown_json,catalog_version,settings_version,expires_at)
     VALUES(?,? ,?,'USD',?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(quote.id, idempotencyKey, quote.status, quote.merchandise_cents, shipping, handling, tax, grand, address ? JSON.stringify(address) : null, serviceReference, taxBreakdown ? JSON.stringify(taxBreakdown) : null, catalogVersion, settings.version, quote.expires_at)];
  merchandise.lines.forEach((line, index) => statements.push(database.prepare(
    'INSERT INTO catalog_quote_lines(quote_id,line_number,artwork_id,revision_id,configuration_id,quantity,unit_price_cents,line_total_cents,snapshot_json) VALUES(?,?,?,?,?,?,?,?,?)'
  ).bind(quote.id, index, line.artwork_id, line.revision_id, line.configuration_id, line.quantity, line.unit_price_cents, line.line_total_cents, JSON.stringify(line.snapshot))));
  if (idempotencyKey) statements.push(database.prepare(
    'INSERT INTO catalog_idempotency_records(scope,idempotency_key,request_hash,status,response_json,expires_at) VALUES(?,?,?,?,?,?)'
  ).bind('quote', idempotencyKey, requestHash, 200, JSON.stringify(response), quote.expires_at));
  try {
    await database.batch(statements);
  } catch (error) {
    if (String(error).includes('COMPLIANCE_CHANGED')) {
      throw new HttpError(409, 'Listing compliance changed; request a fresh total', {code: 'COMPLIANCE_CHANGED'});
    }
    if (idempotencyKey && String(error).includes('UNIQUE')) {
      const concurrent = await idempotentResponse(database, 'quote', idempotencyKey, requestHash, now);
      if (concurrent) {
        const record = await quoteRecord(database, concurrent.quote_id);
        await assertSaleCompliance(database, record.lines.map((line) => line.revision_id));
        return concurrent;
      }
    }
    throw error;
  }
  return response;
}

async function quoteRecord(database, quoteId) {
  const quote = await database.prepare('SELECT * FROM catalog_quotes WHERE id=?').bind(quoteId).first();
  if (!quote) throw new HttpError(404, 'Quote not found');
  const lines = await rows(database.prepare('SELECT * FROM catalog_quote_lines WHERE quote_id=? ORDER BY line_number').bind(quoteId));
  return {quote, lines: lines.map((line) => ({...line, snapshot: parseJson(line.snapshot_json, {})}))};
}

async function assertQuoteCurrent(database, record, settings, now) {
  const {quote, lines} = record;
  if (quote.status !== 'ready' || quote.expires_at <= now) throw new HttpError(409, 'Quote expired; request a fresh total');
  if (quote.settings_version !== settings.version) throw new HttpError(409, 'Store settings changed; request a fresh total');
  await assertSaleCompliance(database, lines.map((line) => line.revision_id));
  const version = await hash(lines.map((line) => ({
    revision_id: line.revision_id,
    content_hash: line.snapshot.content_hash,
    configuration_id: line.configuration_id,
    unit_price_cents: line.unit_price_cents,
    inventory_version: line.snapshot.inventory_version
  })));
  if (version !== quote.catalog_version) throw new HttpError(409, 'Catalog changed; request a fresh total');
  const totals = new Map();
  for (const line of lines) {
    const current = await database.prepare(
      `SELECT h.published_revision_id,rc.price_add_on_cents,r.base_price_cents,i.physical_stock,i.reserved_stock,i.version AS inventory_version
       FROM catalog_artwork_heads h JOIN catalog_artwork_revisions r ON r.id=h.published_revision_id
       JOIN catalog_revision_configurations rc ON rc.revision_id=r.id AND rc.configuration_id=? AND rc.enabled=1
       JOIN catalog_inventory i ON i.artwork_id=h.artwork_id
       WHERE h.artwork_id=? AND h.archived_at IS NULL AND h.published_revision_id=? AND r.offered_for_sale=1
         AND ${saleCompliancePredicate('r.id')}`
    ).bind(line.configuration_id, line.artwork_id, line.revision_id).first();
    if (!current || current.base_price_cents + current.price_add_on_cents !== line.unit_price_cents || current.inventory_version !== line.snapshot.inventory_version) throw new HttpError(409, 'Catalog changed; request a fresh total');
    totals.set(line.artwork_id, (totals.get(line.artwork_id) || 0) + line.quantity);
    if (current.physical_stock == null || current.physical_stock - current.reserved_stock < totals.get(line.artwork_id)) throw new HttpError(409, 'Inventory changed; request a fresh total');
  }
}

function paymentReady(settings, env) {
  return ['sandbox','live'].includes(settings.payment_mode) && settings.payment_status === settings.payment_mode && !!env.PAYMENT_PROVIDER?.fetch && !!settings.config.payment_merchant_reference;
}

async function paymentSession(binding, payload) {
  const result = await callJsonBinding(binding, 'https://payment.internal/sessions', payload, 'Hosted checkout');
  let hostedUrl = null;
  try {
    hostedUrl = new URL(result.hosted_url);
  } catch {
    hostedUrl = null;
  }
  if (
    typeof result.session_id !== 'string' || !result.session_id ||
    result.session_id.length > 200 || typeof result.hosted_url !== 'string' || result.hosted_url.length > 2048 ||
    !hostedUrl || hostedUrl.protocol !== 'https:' || hostedUrl.username || hostedUrl.password ||
    result.order_id !== payload.order_id || result.amount_cents !== payload.amount_cents || result.currency !== 'USD' ||
    result.mode !== payload.mode || result.merchant_reference !== payload.merchant_reference
  ) throw new HttpError(503, 'Hosted checkout returned an invalid session');
  return {...result, hosted_url: hostedUrl.href};
}

async function cancelPaymentSession(binding, payload) {
  const result = await callJsonBinding(binding, 'https://payment.internal/sessions/cancel', payload, 'Hosted checkout cancellation');
  if (result.cancelled !== true || result.session_id !== payload.session_id || result.order_id !== payload.order_id) {
    throw new HttpError(503, 'Hosted checkout cancellation returned an invalid response');
  }
  return result;
}

async function checkoutReplay(database, row) {
  const current = await database.prepare(`SELECT o.id,o.order_number,o.quote_id,o.payment_status,o.provider_reference,o.delivery_json,
      p.status AS attempt_status,p.provider_session_id
    FROM catalog_orders o
    LEFT JOIN catalog_payment_attempts p ON p.id=(
      SELECT p2.id FROM catalog_payment_attempts p2 WHERE p2.order_id=o.id ORDER BY p2.created_at,p2.id LIMIT 1
    )
    WHERE o.id=?`).bind(row.id).first();
  if (!current) throw new HttpError(404, 'Payment order not found');
  const delivery = parseJson(current.delivery_json, {});
  const storedUrl = typeof delivery.checkout_url === 'string' ? delivery.checkout_url : null;
  const eligible = current.payment_status === 'pending' && current.attempt_status === 'ready' &&
    typeof current.provider_reference === 'string' && current.provider_reference &&
    current.provider_reference === current.provider_session_id;
  const checkoutUrl = eligible ? storedUrl : null;
  if (storedUrl && !eligible) {
    await database.prepare("UPDATE catalog_orders SET delivery_json=json_remove(delivery_json,'$.checkout_url'),updated_at=unixepoch() WHERE id=?").bind(current.id).run();
  }
  return {
    order_id: current.id,
    order_number: current.order_number,
    payment_status: current.payment_status,
    provider_reference: current.provider_reference,
    checkout_url: checkoutUrl,
    hosted_url: checkoutUrl,
    idempotent: true
  };
}

async function withholdHostedSession(database, orderId, attemptId, providerSessionId, {cancelled = false, reason = 'payment_state_changed'} = {}) {
  const current = await database.prepare(`SELECT o.payment_status,p.status AS attempt_status
    FROM catalog_orders o JOIN catalog_payment_attempts p ON p.id=? AND p.order_id=o.id WHERE o.id=?`).bind(attemptId, orderId).first();
  const statements = [];
  if (cancelled && current?.payment_status === 'pending') {
    const reservations = await rows(database.prepare("SELECT id FROM catalog_inventory_reservations WHERE order_id=? AND state='active' ORDER BY id").bind(orderId));
    for (const reservation of reservations) statements.push(database.prepare(
      "UPDATE catalog_inventory_reservations SET state='released',updated_at=unixepoch() WHERE id=? AND state='active'"
    ).bind(reservation.id));
    statements.push(database.prepare("UPDATE catalog_payment_attempts SET provider_session_id=coalesce(provider_session_id,?),status='failed',updated_at=unixepoch() WHERE id=? AND status<>'complete'").bind(providerSessionId, attemptId));
    statements.push(database.prepare("UPDATE catalog_orders SET provider_reference=coalesce(provider_reference,?),payment_status='expired',delivery_json=json_remove(delivery_json,'$.checkout_url'),updated_at=unixepoch() WHERE id=? AND payment_status='pending'").bind(providerSessionId, orderId));
  } else {
    statements.push(database.prepare(`UPDATE catalog_payment_attempts
      SET provider_session_id=coalesce(provider_session_id,?),
          status=CASE WHEN ?=0 AND status<>'complete' THEN 'uncertain' ELSE status END,
          updated_at=unixepoch()
      WHERE id=?`).bind(providerSessionId, cancelled ? 1 : 0, attemptId));
    statements.push(database.prepare(`UPDATE catalog_orders
      SET provider_reference=coalesce(provider_reference,?),
          payment_status=CASE WHEN ?=0 AND payment_status IN ('pending','authorized','failed','expired') THEN 'session_uncertain' ELSE payment_status END,
          delivery_json=json_remove(delivery_json,'$.checkout_url'),updated_at=unixepoch()
      WHERE id=?`).bind(providerSessionId, cancelled ? 1 : 0, orderId));
  }
  statements.push(database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(NULL,'system:checkout','hosted_session_withheld',?)")
    .bind(JSON.stringify({order_id: orderId, provider_session_id: providerSessionId, cancelled, reason, prior_payment_status: current?.payment_status || null, prior_attempt_status: current?.attempt_status || null})));
  await database.batch(statements);
}

async function expireComplianceBlockedCheckout(database, orderId, details = {}) {
  const reservations = await rows(database.prepare(
    "SELECT id FROM catalog_inventory_reservations WHERE order_id=? AND state='active' ORDER BY id"
  ).bind(orderId));
  const statements = reservations.map((reservation) => database.prepare(
    "UPDATE catalog_inventory_reservations SET state='released',updated_at=unixepoch() WHERE id=? AND state='active'"
  ).bind(reservation.id));
  statements.push(
    database.prepare("UPDATE catalog_orders SET payment_status='expired',provider_reference=NULL,delivery_json=json_remove(delivery_json,'$.checkout_url'),updated_at=unixepoch() WHERE id=? AND payment_status IN ('pending','session_uncertain')").bind(orderId),
    database.prepare("UPDATE catalog_payment_attempts SET status='failed',updated_at=unixepoch() WHERE order_id=? AND status IN ('creating','ready')").bind(orderId),
    database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(NULL,'system:compliance','compliance_checkout_blocked',?)")
      .bind(JSON.stringify({order_id: orderId, ...details}))
  );
  await database.batch(statements);
}

async function markHostedSessionUncertain(database, orderId, attemptId, providerSessionId = null) {
  await database.batch([
    database.prepare("UPDATE catalog_payment_attempts SET provider_session_id=coalesce(provider_session_id,?),status='uncertain',updated_at=unixepoch() WHERE id=? AND status<>'complete'").bind(providerSessionId, attemptId),
    database.prepare("UPDATE catalog_orders SET provider_reference=coalesce(provider_reference,?),payment_status='session_uncertain',delivery_json=json_remove(delivery_json,'$.checkout_url'),updated_at=unixepoch() WHERE id=?").bind(providerSessionId, orderId)
  ]);
}

export async function beginCheckout(database, input, env = {}, context = {}) {
  if (!isObject(input)) throw new HttpError(400, 'Checkout request is invalid');
  const quoteId = requiredString(input.quote_id, 'Quote identifier', 120);
  const idempotencyKey = requiredString(input.idempotency_key, 'Idempotency key', 160);
  if (idempotencyKey.length < 8) throw new HttpError(400, 'Idempotency key is invalid');
  const existing = await database.prepare('SELECT id,order_number,quote_id,payment_status,provider_reference,delivery_json FROM catalog_orders WHERE idempotency_key=?').bind(idempotencyKey).first();
  if (existing) {
    if (existing.quote_id !== quoteId) throw new HttpError(409, 'Idempotency key was reused with a different quote');
    await assertOrderSaleCompliance(database, existing.id);
    return checkoutReplay(database, existing);
  }
  const settings = await getSettings(database);
  if (!paymentReady(settings, env)) throw new HttpError(503, 'Checkout not yet available');
  const now = nowSeconds(context);
  const record = await quoteRecord(database, quoteId);
  await assertQuoteCurrent(database, record, settings, now);
  const {quote, lines} = record;
  if (quote.grand_total_cents == null || quote.shipping_cents == null || quote.handling_cents == null || quote.tax_cents == null) {
    throw new HttpError(409, 'Quote is incomplete');
  }
  const orderId = uuid();
  const attemptId = uuid();
  const stamp = new Date(now * 1000).toISOString().slice(0, 10).replaceAll('-', '');
  const orderNumber = `NYA-${stamp}-${orderId.slice(0, 8).toUpperCase()}`;
  const address = parseJson(quote.address_json, {});
  const statements = [database.prepare(
    `INSERT INTO catalog_orders(id,order_number,quote_id,idempotency_key,payment_status,fulfillment_status,currency,merchandise_cents,shipping_cents,handling_cents,tax_cents,grand_total_cents,delivery_json)
     VALUES(?,?,?,?,'pending','unfulfilled','USD',?,?,?,?,?,?)`
  ).bind(orderId, orderNumber, quote.id, idempotencyKey, quote.merchandise_cents, quote.shipping_cents, quote.handling_cents, quote.tax_cents, quote.grand_total_cents, JSON.stringify({
    address,
    service_reference: quote.service_reference,
    tax_breakdown: parseJson(quote.tax_breakdown_json),
    payment: {
      provider: env.PAYMENT_PROVIDER_NAME || 'configured',
      mode: settings.payment_mode,
      merchant_reference: settings.config.payment_merchant_reference
    }
  }))];
  lines.forEach((line) => statements.push(database.prepare(
    'INSERT INTO catalog_order_lines(order_id,line_number,artwork_id,configuration_id,quantity,unit_price_cents,line_total_cents,snapshot_json) VALUES(?,?,?,?,?,?,?,?)'
  ).bind(orderId, line.line_number, line.artwork_id, line.configuration_id, line.quantity, line.unit_price_cents, line.line_total_cents, line.snapshot_json)));
  const reservations = new Map();
  for (const line of lines) reservations.set(line.artwork_id, (reservations.get(line.artwork_id) || 0) + line.quantity);
  for (const [artworkId, quantity] of reservations) statements.push(database.prepare(
    'INSERT INTO catalog_inventory_reservations(id,order_id,artwork_id,quantity,state,expires_at) VALUES(?,?,?,?,\'active\',?)'
  ).bind(uuid(), orderId, artworkId, quantity, now + RESERVATION_TTL_SECONDS));
  statements.push(database.prepare(
    "INSERT INTO catalog_payment_attempts(id,order_id,provider,mode,status,idempotency_key) VALUES(?,?,?,?, 'creating',?)"
  ).bind(attemptId, orderId, env.PAYMENT_PROVIDER_NAME || 'configured', settings.payment_mode, idempotencyKey));
  statements.push(database.prepare("UPDATE catalog_quotes SET status='consumed' WHERE id=? AND status='ready'").bind(quote.id));
  try {
    await database.batch(statements);
  } catch (error) {
    if (String(error).includes('UNIQUE')) {
      const concurrent = await database.prepare('SELECT id,order_number,quote_id,payment_status,provider_reference,delivery_json FROM catalog_orders WHERE idempotency_key=?').bind(idempotencyKey).first();
      if (concurrent) {
        if (concurrent.quote_id !== quoteId) throw new HttpError(409, 'Idempotency key was reused with a different quote');
        await assertOrderSaleCompliance(database, concurrent.id);
        return checkoutReplay(database, concurrent);
      }
      const consumed = await database.prepare('SELECT id FROM catalog_orders WHERE quote_id=?').bind(quoteId).first();
      if (consumed) throw new HttpError(409, 'Quote was already consumed by another checkout');
    }
    if (String(error).includes('INSUFFICIENT_STOCK')) throw new HttpError(409, 'Inventory changed; request a fresh total');
    if (String(error).includes('COMPLIANCE_CHANGED')) {
      throw new HttpError(409, 'Listing compliance changed; request a fresh total', {code: 'COMPLIANCE_CHANGED'});
    }
    throw error;
  }
  try {
    await assertOrderSaleCompliance(database, orderId);
  } catch (error) {
    await expireComplianceBlockedCheckout(database, orderId);
    throw error;
  }
  let result;
  try {
    result = await paymentSession(env.PAYMENT_PROVIDER, {
      order_id: orderId, order_number: orderNumber, quote_id: quote.id,
      amount_cents: quote.grand_total_cents, currency: 'USD', mode: settings.payment_mode,
      merchant_reference: settings.config.payment_merchant_reference,
      idempotency_key: idempotencyKey,
      return_reference: orderId
    });
  } catch {
    await markHostedSessionUncertain(database, orderId, attemptId);
    throw new HttpError(503, 'Payment session outcome is uncertain; inventory remains reserved', {order_id: orderId});
  }
  try {
    await assertOrderSaleCompliance(database, orderId);
    const finalized = await database.batch([
      database.prepare(`UPDATE catalog_payment_attempts SET provider_session_id=?,status='ready',updated_at=unixepoch()
        WHERE id=? AND status='creating' AND EXISTS(
          SELECT 1 FROM catalog_orders o WHERE o.id=catalog_payment_attempts.order_id AND o.payment_status='pending'
        )`).bind(result.session_id, attemptId),
      database.prepare(`UPDATE catalog_orders SET provider_reference=?,delivery_json=json_set(delivery_json,'$.checkout_url',?),updated_at=unixepoch()
        WHERE id=? AND payment_status='pending' AND EXISTS(
          SELECT 1 FROM catalog_payment_attempts p
          WHERE p.id=? AND p.order_id=catalog_orders.id AND p.status='ready' AND p.provider_session_id=?
        )`).bind(result.session_id, result.hosted_url, orderId, attemptId, result.session_id)
    ]);
    const finalState = await database.prepare(`SELECT o.payment_status,o.provider_reference,o.delivery_json,p.status AS attempt_status,p.provider_session_id
      FROM catalog_orders o JOIN catalog_payment_attempts p ON p.id=? AND p.order_id=o.id WHERE o.id=?`).bind(attemptId, orderId).first();
    if (
      changes(finalized[0]) !== 1 || changes(finalized[1]) !== 1 ||
      finalState?.payment_status !== 'pending' || finalState?.attempt_status !== 'ready' ||
      finalState?.provider_reference !== result.session_id || finalState?.provider_session_id !== result.session_id ||
      parseJson(finalState?.delivery_json, {})?.checkout_url !== result.hosted_url
    ) {
      throw new HttpError(409, 'Payment state changed while hosted checkout was being created', {code: 'PAYMENT_STATE_CHANGED'});
    }
    await assertOrderSaleCompliance(database, orderId);
  } catch (error) {
    const complianceChanged = error?.details?.code === 'COMPLIANCE_CHANGED' || String(error?.message || error).includes('COMPLIANCE_CHANGED');
    if (complianceChanged) {
      let cancelled = false;
      try {
        await cancelPaymentSession(env.PAYMENT_PROVIDER, {
          session_id: result.session_id,
          order_id: orderId,
          reason: 'listing_compliance_changed',
          idempotency_key: `cancel:${attemptId}`
        });
        cancelled = true;
      } catch {
        cancelled = false;
      }
      if (cancelled) {
        await expireComplianceBlockedCheckout(database, orderId, {provider_session_id: result.session_id, provider_cancelled: true});
        throw new HttpError(409, 'Listing compliance changed; hosted checkout was cancelled', {code: 'COMPLIANCE_CHANGED'});
      }
      await markHostedSessionUncertain(database, orderId, attemptId, result.session_id);
      throw new HttpError(503, 'Checkout was withheld because listing compliance changed; the payment session requires manual cancellation review', {
        code: 'PAYMENT_SESSION_REVIEW', order_id: orderId
      });
    }
    const paymentStateChanged = error?.details?.code === 'PAYMENT_STATE_CHANGED';
    if (paymentStateChanged) {
      let cancelled = false;
      try {
        await cancelPaymentSession(env.PAYMENT_PROVIDER, {
          session_id: result.session_id,
          order_id: orderId,
          reason: 'payment_state_changed',
          idempotency_key: `cancel:${attemptId}`
        });
        cancelled = true;
      } catch {
        cancelled = false;
      }
      await withholdHostedSession(database, orderId, attemptId, result.session_id, {cancelled, reason: 'payment_state_changed'});
      if (cancelled) {
        throw new HttpError(409, 'Payment state changed; hosted checkout was cancelled and withheld', {code: 'PAYMENT_STATE_CHANGED', order_id: orderId});
      }
      throw new HttpError(503, 'Payment state changed; hosted checkout was withheld for manual cancellation review', {
        code: 'PAYMENT_SESSION_REVIEW', order_id: orderId
      });
    }
    await markHostedSessionUncertain(database, orderId, attemptId, result.session_id);
    throw new HttpError(503, 'Payment session finalization is uncertain; inventory remains reserved', {order_id: orderId});
  }
  return {order_id: orderId, order_number: orderNumber, payment_status: 'pending', checkout_url: result.hosted_url, hosted_url: result.hosted_url, provider_reference: result.session_id, idempotent: false};
}

function filteredWebhookHeaders(headers) {
  const output = new Headers();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === 'content-type' || lower === 'user-agent' || lower.includes('signature') || lower.startsWith('x-') || lower.startsWith('paypal-')) output.set(name, value);
  }
  return output;
}

async function verifiedWebhook(request, env) {
  if (!env.PAYMENT_PROVIDER?.fetch) throw new HttpError(503, 'Payment provider is not configured');
  const raw = new Uint8Array(await request.arrayBuffer());
  if (!raw.length || raw.length > 1024 * 1024) throw new HttpError(413, 'Payment event is invalid');
  const response = await env.PAYMENT_PROVIDER.fetch(new Request('https://payment.internal/webhooks/verify', {
    method: 'POST', headers: filteredWebhookHeaders(request.headers), body: raw
  }));
  const event = await readProviderJson(response, 'Payment verification');
  if (event.verified !== true) throw new HttpError(401, 'Payment event could not be verified');
  for (const field of ['provider','event_id','order_id','event_type','status','currency','merchant_reference','mode']) {
    if (typeof event[field] !== 'string' || !event[field]) throw new HttpError(400, 'Payment event is invalid');
  }
  if (!integer(event.amount_cents, 0, MAX_MONEY)) throw new HttpError(400, 'Payment event amount is invalid');
  event.payload_hash = await hashBytes(raw);
  return event;
}

async function recordComplianceRaceManualReview(database, event, order, context) {
  const occurredAt = integer(event.occurred_at, 0) ? event.occurred_at : nowSeconds(context);
  const statements = [
    database.prepare(
      'INSERT INTO catalog_payment_events(provider,provider_event_id,order_id,event_type,verified,payload_hash,occurred_at) VALUES(?,?,?,?,1,?,?)'
    ).bind(event.provider, event.event_id, order.id, event.event_type, event.payload_hash, occurredAt),
    database.prepare("UPDATE catalog_orders SET payment_status='session_uncertain',updated_at=unixepoch() WHERE id=? AND payment_status IN ('pending','session_uncertain','authorized')").bind(order.id),
    database.prepare("UPDATE catalog_payment_attempts SET status='uncertain',updated_at=unixepoch() WHERE order_id=? AND status<>'complete'").bind(order.id),
    database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(NULL,'payment-provider','compliance_payment_manual_review',?)")
      .bind(JSON.stringify({order_id: order.id, event_id: event.event_id, status: event.status, atomic_guard: true}))
  ];
  try {
    await database.batch(statements);
  } catch (error) {
    if (String(error).includes('UNIQUE')) return {accepted: true, duplicate: true};
    throw error;
  }
  return {accepted: true, duplicate: false, manual_review: true};
}

async function recordPaymentStateRaceManualReview(database, event, order, context) {
  const occurredAt = integer(event.occurred_at, 0) ? event.occurred_at : nowSeconds(context);
  const orderUpdate = event.status === 'refunded'
    ? database.prepare("UPDATE catalog_orders SET payment_status='refunded',updated_at=unixepoch() WHERE id=? AND payment_status='paid'").bind(order.id)
    : database.prepare("UPDATE catalog_orders SET payment_status='session_uncertain',updated_at=unixepoch() WHERE id=? AND payment_status IN ('pending','session_uncertain','authorized','failed','expired')").bind(order.id);
  const statements = [
    database.prepare(
      'INSERT INTO catalog_payment_events(provider,provider_event_id,order_id,event_type,verified,payload_hash,occurred_at) VALUES(?,?,?,?,1,?,?)'
    ).bind(event.provider, event.event_id, order.id, event.event_type, event.payload_hash, occurredAt),
    orderUpdate,
    database.prepare("UPDATE catalog_payment_attempts SET status='uncertain',updated_at=unixepoch() WHERE order_id=? AND status<>'complete'").bind(order.id),
    database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(NULL,'payment-provider','payment_state_race_manual_review',?)")
      .bind(JSON.stringify({order_id: order.id, event_id: event.event_id, status: event.status, atomic_guard: true}))
  ];
  try {
    await database.batch(statements);
  } catch (error) {
    if (String(error).includes('UNIQUE')) return {accepted: true, duplicate: true};
    throw error;
  }
  return {accepted: true, duplicate: false, manual_review: true};
}

export async function handlePaymentWebhook(database, request, env = {}, context = {}) {
  const event = await verifiedWebhook(request, env);
  const duplicate = await database.prepare('SELECT provider_event_id FROM catalog_payment_events WHERE provider=? AND provider_event_id=?').bind(event.provider, event.event_id).first();
  if (duplicate) return {accepted: true, duplicate: true};
  const order = await database.prepare('SELECT * FROM catalog_orders WHERE id=?').bind(event.order_id).first();
  if (!order) throw new HttpError(404, 'Payment order not found');
  const attempt = await database.prepare('SELECT provider,mode FROM catalog_payment_attempts WHERE order_id=? ORDER BY created_at,id LIMIT 1').bind(order.id).first();
  const paymentSnapshot = parseJson(order.delivery_json, {})?.payment;
  if (
    !attempt || !isObject(paymentSnapshot) ||
    event.currency !== order.currency || event.amount_cents !== order.grand_total_cents ||
    event.mode !== attempt.mode || event.mode !== paymentSnapshot.mode ||
    event.merchant_reference !== paymentSnapshot.merchant_reference ||
    event.provider !== attempt.provider || event.provider !== paymentSnapshot.provider
  ) throw new HttpError(409, 'Payment event does not match the order');
  const reservations = await rows(database.prepare('SELECT id,state FROM catalog_inventory_reservations WHERE order_id=? ORDER BY id').bind(order.id));
  const complianceAllowed = ['paid', 'authorized'].includes(event.status)
    ? await saleComplianceAllowed(database, await orderRevisionIds(database, order.id))
    : true;
  const earlierRefund = event.status === 'paid' ? await database.prepare(`SELECT id FROM catalog_audit_events
    WHERE action='early_refund_manual_review' AND json_extract(details_json,'$.order_id')=?
    ORDER BY id DESC LIMIT 1`).bind(order.id).first() : null;
  const statements = [database.prepare(
    'INSERT INTO catalog_payment_events(provider,provider_event_id,order_id,event_type,verified,payload_hash,occurred_at) VALUES(?,?,?,?,1,?,?)'
  ).bind(event.provider, event.event_id, order.id, event.event_type, event.payload_hash, integer(event.occurred_at, 0) ? event.occurred_at : nowSeconds(context))];
  let manualReview = false;
  const payableStates = ['pending','session_uncertain','authorized'];
  if (event.status === 'paid') {
    if (payableStates.includes(order.payment_status)) {
      if (earlierRefund) {
        manualReview = true;
        statements.push(database.prepare("UPDATE catalog_orders SET payment_status='session_uncertain',updated_at=unixepoch() WHERE id=?").bind(order.id));
        statements.push(database.prepare("UPDATE catalog_payment_attempts SET status='uncertain',updated_at=unixepoch() WHERE order_id=? AND status<>'complete'").bind(order.id));
        statements.push(database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(NULL,'payment-provider','payment_after_early_refund_manual_review',?)")
          .bind(JSON.stringify({order_id:order.id,event_id:event.event_id})));
      } else if (!complianceAllowed) {
        manualReview = true;
        statements.push(database.prepare("UPDATE catalog_orders SET payment_status='session_uncertain',updated_at=unixepoch() WHERE id=?").bind(order.id));
        statements.push(database.prepare("UPDATE catalog_payment_attempts SET status='uncertain',updated_at=unixepoch() WHERE order_id=? AND status<>'complete'").bind(order.id));
        statements.push(database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(NULL,'payment-provider','compliance_payment_manual_review',?)")
          .bind(JSON.stringify({order_id: order.id,event_id:event.event_id,status:event.status})));
      } else if (reservations.length && reservations.every((reservation) => reservation.state === 'active')) {
        for (const reservation of reservations) statements.push(database.prepare("UPDATE catalog_inventory_reservations SET state='committed',updated_at=unixepoch() WHERE id=? AND state='active'").bind(reservation.id));
        statements.push(database.prepare("UPDATE catalog_orders SET payment_status='paid',updated_at=unixepoch() WHERE id=?").bind(order.id));
        statements.push(database.prepare("UPDATE catalog_payment_attempts SET status='complete',updated_at=unixepoch() WHERE order_id=?").bind(order.id));
      } else {
        manualReview = true;
        statements.push(database.prepare("UPDATE catalog_orders SET payment_status='session_uncertain',updated_at=unixepoch() WHERE id=?").bind(order.id));
        statements.push(database.prepare("UPDATE catalog_payment_attempts SET status='uncertain',updated_at=unixepoch() WHERE order_id=? AND status<>'complete'").bind(order.id));
        statements.push(database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(NULL,'payment-provider','late_payment_manual_review',?)").bind(JSON.stringify({order_id: order.id,event_id:event.event_id})));
      }
    } else if (['failed','expired'].includes(order.payment_status)) {
      manualReview = true;
      statements.push(database.prepare("UPDATE catalog_orders SET payment_status='session_uncertain',updated_at=unixepoch() WHERE id=?").bind(order.id));
      statements.push(database.prepare("UPDATE catalog_payment_attempts SET status='uncertain',updated_at=unixepoch() WHERE order_id=? AND status<>'complete'").bind(order.id));
      statements.push(database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(NULL,'payment-provider','late_payment_manual_review',?)").bind(JSON.stringify({order_id: order.id,event_id:event.event_id})));
    }
  } else if (['failed','expired'].includes(event.status)) {
    if (payableStates.includes(order.payment_status)) {
      for (const reservation of reservations.filter((item) => item.state === 'active')) statements.push(database.prepare("UPDATE catalog_inventory_reservations SET state='released',updated_at=unixepoch() WHERE id=? AND state='active'").bind(reservation.id));
      statements.push(database.prepare('UPDATE catalog_orders SET payment_status=?,updated_at=unixepoch() WHERE id=?').bind(event.status, order.id));
      statements.push(database.prepare("UPDATE catalog_payment_attempts SET status='failed',updated_at=unixepoch() WHERE order_id=? AND status<>'complete'").bind(order.id));
    }
  } else if (event.status === 'authorized') {
    if (['pending','session_uncertain'].includes(order.payment_status)) {
      if (complianceAllowed) {
        statements.push(database.prepare("UPDATE catalog_orders SET payment_status='authorized',updated_at=unixepoch() WHERE id=?").bind(order.id));
      } else {
        manualReview = true;
        statements.push(database.prepare("UPDATE catalog_orders SET payment_status='session_uncertain',updated_at=unixepoch() WHERE id=?").bind(order.id));
        statements.push(database.prepare("UPDATE catalog_payment_attempts SET status='uncertain',updated_at=unixepoch() WHERE order_id=? AND status<>'complete'").bind(order.id));
        statements.push(database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(NULL,'payment-provider','compliance_payment_manual_review',?)")
          .bind(JSON.stringify({order_id: order.id,event_id:event.event_id,status:event.status})));
      }
    }
  } else if (event.status === 'refunded') {
    if (order.payment_status === 'paid') {
      statements.push(database.prepare("UPDATE catalog_orders SET payment_status='refunded',updated_at=unixepoch() WHERE id=?").bind(order.id));
    } else if (['pending','session_uncertain','authorized','failed','expired'].includes(order.payment_status)) {
      manualReview = true;
      statements.push(database.prepare("UPDATE catalog_orders SET payment_status='session_uncertain',updated_at=unixepoch() WHERE id=?").bind(order.id));
      statements.push(database.prepare("UPDATE catalog_payment_attempts SET status='uncertain',updated_at=unixepoch() WHERE order_id=? AND status<>'complete'").bind(order.id));
      statements.push(database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(NULL,'payment-provider','early_refund_manual_review',?)")
        .bind(JSON.stringify({order_id:order.id,event_id:event.event_id,prior_status:order.payment_status})));
    }
  } else {
    throw new HttpError(400, 'Payment event status is unsupported');
  }
  try {
    await database.batch(statements);
  } catch (error) {
    if (String(error).includes('UNIQUE')) return {accepted: true, duplicate: true};
    if (String(error).includes('COMPLIANCE_CHANGED') && ['paid','authorized'].includes(event.status)) {
      return recordComplianceRaceManualReview(database, event, order, context);
    }
    if (String(error).includes('PAYMENT_STATE_CONFLICT')) {
      return recordPaymentStateRaceManualReview(database, event, order, context);
    }
    throw error;
  }
  return {accepted: true, duplicate: false, manual_review: manualReview};
}

async function orderWithLines(database, order) {
  const lines = await rows(database.prepare('SELECT * FROM catalog_order_lines WHERE order_id=? ORDER BY line_number').bind(order.id));
  const normalizedLines = lines.map((line) => {
    const snapshot = parseJson(line.snapshot_json, {});
    return {...line, snapshot, title: snapshot.title, configuration_label: snapshot.configuration_label};
  });
  return {
    ...order,
    total_cents: order.grand_total_cents,
    tracking: order.tracking_reference,
    delivery: parseJson(order.delivery_json, {}),
    lines: normalizedLines
  };
}

export async function listOrders(database, options = {}) {
  const page = integer(Number(options.page), 1, 1_000_000) ? Number(options.page) : 1;
  const allowed = ['pending','session_uncertain','authorized','paid','failed','expired','refunded'];
  const status = options.status && allowed.includes(options.status) ? options.status : null;
  const where = status ? ' WHERE payment_status=?' : '';
  const totalRow = await (status ? database.prepare(`SELECT count(*) AS total FROM catalog_orders${where}`).bind(status) : database.prepare('SELECT count(*) AS total FROM catalog_orders')).first();
  const statement = database.prepare(`SELECT * FROM catalog_orders${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`);
  const selected = await rows(status ? statement.bind(status, ORDER_PAGE_SIZE, (page - 1) * ORDER_PAGE_SIZE) : statement.bind(ORDER_PAGE_SIZE, (page - 1) * ORDER_PAGE_SIZE));
  const items = [];
  for (const order of selected) items.push(await orderWithLines(database, order));
  const total = Number(totalRow?.total || 0);
  const pages = Math.max(1, Math.ceil(total / ORDER_PAGE_SIZE));
  return {items, pagination: {page, page_size: ORDER_PAGE_SIZE, total, pages, total_pages: pages}};
}

export async function getOrder(database, id) {
  const order = await database.prepare('SELECT * FROM catalog_orders WHERE id=?').bind(requiredString(id, 'Order identifier', 120)).first();
  if (!order) throw new HttpError(404, 'Order not found');
  return orderWithLines(database, order);
}

export async function updateTracking(database, id, input, actor = 'admin') {
  const orderId = requiredString(id, 'Order identifier', 120);
  if (!isObject(input)) throw new HttpError(400, 'Tracking update is invalid');
  const existing = await database.prepare('SELECT id,fulfillment_status FROM catalog_orders WHERE id=?').bind(orderId).first();
  if (!existing) throw new HttpError(404, 'Order not found');
  const status = input.fulfillment_status == null ? existing.fulfillment_status : (['unfulfilled','processing','shipped','delivered','cancelled'].includes(input.fulfillment_status) ? input.fulfillment_status : null);
  if (!status) throw new HttpError(400, 'Fulfillment status is invalid');
  const tracking = optionalString(input.tracking_reference ?? input.tracking, 'Tracking reference', 200);
  await database.batch([
    database.prepare('UPDATE catalog_orders SET fulfillment_status=?,tracking_reference=?,updated_at=unixepoch() WHERE id=?').bind(status, tracking, orderId),
    database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(NULL,?,'order_tracking',?)").bind(actor, JSON.stringify({order_id:orderId,fulfillment_status:status,tracking_reference:tracking}))
  ]);
  return getOrder(database, orderId);
}

