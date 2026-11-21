import {buildBaselineReconciliation} from './baseline.js';
import {HttpError} from './http.js';
import {MEDIA_LIMITS, mediaCapabilities} from './media.js';

const ADMIN_PAGE_SIZE = 10;
const PUBLIC_PAGE_SIZE = 24;
const MAX_CONFIGURATIONS = 100;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

const uuid = () => crypto.randomUUID();
const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);
const one = async (statement) => statement.first();
const all = async (statement) => (await statement.all()).results ?? [];
const asBool = (value) => value === true || value === 1;
const parseJson = (value, fallback = null) => {
  try { return JSON.parse(value); } catch { return fallback; }
};
const bytes = (value) => value instanceof ArrayBuffer ? value : ArrayBuffer.isView(value) ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : Uint8Array.from(value ?? []).buffer;

function databaseError(error, fallback = 'Catalog request failed') {
  if (error instanceof HttpError) return error;
  const message = String(error?.message ?? error);
  const conflicts = [
    'REVISION_CONFLICT','REVISION_PARENT_CONFLICT','HEAD_CONFLICT','INVENTORY_CONFLICT','ORDER_CONFLICT',
    'ORDER_SET_MISMATCH','ORDER_DUPLICATE','ARTWORK_ARCHIVED','PHOTO_OWNER_MISMATCH','PHOTO_LIMIT',
    'MAIN_PHOTO_REQUIRED','SALE_NOT_READY','TITLE_REQUIRED','UNIQUE constraint failed'
  ];
  const code = conflicts.find((item) => message.includes(item));
  if (code) return new HttpError(409, code.replaceAll('_', ' ').toLowerCase(), {code});
  return new HttpError(500, fallback);
}

function fieldError(fields, name, message) {
  if (!fields[name]) fields[name] = [];
  fields[name].push(message);
}

function nullableInteger(value, min, max, fields, name) {
  if (value === null || value === undefined || value === '') return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) fieldError(fields, name, 'Enter a supported whole number.');
  return value;
}

export function validateDraftSnapshot(input) {
  const fields = {};
  const draft = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const title = typeof draft.title === 'string' ? draft.title : '';
  const description = typeof draft.description === 'string' ? draft.description : '';
  if (title.length > 160) fieldError(fields, 'title', 'Use 160 characters or fewer.');
  if (description.length > 10000) fieldError(fields, 'description', 'Use 10,000 characters or fewer.');
  let category = draft.category === null || draft.category === undefined || draft.category === '' ? null : draft.category;
  if (category !== null && (typeof category !== 'string' || !category.trim() || category.length > 100)) fieldError(fields, 'category', 'Choose a valid category.');
  if (typeof category === 'string') category = category.trim();

  const basePrice = nullableInteger(draft.base_price_cents, 0, 100000000, fields, 'base_price_cents');
  const width = nullableInteger(draft.width_eighths, 1, 1000000, fields, 'width_eighths');
  const height = nullableInteger(draft.height_eighths, 1, 1000000, fields, 'height_eighths');
  if (typeof draft.offered_for_sale !== 'boolean') fieldError(fields, 'offered_for_sale', 'Choose display only or offered for sale.');
  const requestedPosition = nullableInteger(draft.requested_store_position, 1, 1000000, fields, 'requested_store_position');

  const inventoryInput = draft.inventory && typeof draft.inventory === 'object' ? draft.inventory : {};
  const quantityChanged = inventoryInput.quantity_changed === true;
  let intended = null;
  let captured = null;
  if (quantityChanged) {
    intended = nullableInteger(inventoryInput.intended_available_quantity, 0, 1000000, fields, 'inventory.intended_available_quantity');
    captured = nullableInteger(inventoryInput.captured_version, 0, Number.MAX_SAFE_INTEGER, fields, 'inventory.captured_version');
    if (intended === null) fieldError(fields, 'inventory.intended_available_quantity', 'Enter the intended available quantity, including zero.');
    if (captured === null) fieldError(fields, 'inventory.captured_version', 'Reload current inventory before changing quantity.');
  }

  const rawPhotos = Array.isArray(draft.photos) ? draft.photos : [];
  if (rawPhotos.length > MEDIA_LIMITS.maxPhotos) fieldError(fields, 'photos', 'An artwork can have at most four photos.');
  const photoIds = new Set();
  const photos = rawPhotos.map((photo, index) => {
    const assetId = typeof photo?.asset_id === 'string' ? photo.asset_id : '';
    if (!idPattern.test(assetId) || photoIds.has(assetId)) fieldError(fields, `photos.${index}.asset_id`, 'Choose a unique saved photo.');
    photoIds.add(assetId);
    const position = photo?.position;
    if (!Number.isSafeInteger(position) || position !== index) fieldError(fields, `photos.${index}.position`, 'Photo positions must be consecutive.');
    const alt = typeof photo?.alt === 'string' ? photo.alt : '';
    if (alt.length > 500) fieldError(fields, `photos.${index}.alt`, 'Use 500 characters or fewer.');
    return {asset_id: assetId, alt, position: index, is_main: photo?.is_main === true};
  });
  if (photos.length && photos.filter((photo) => photo.is_main).length !== 1) fieldError(fields, 'photos', 'Select exactly one main photo.');

  const rawConfigurations = Array.isArray(draft.configurations) ? draft.configurations : [];
  if (rawConfigurations.length > MAX_CONFIGURATIONS) fieldError(fields, 'configurations', 'Too many configurations.');
  const configurationIds = new Set();
  const configurations = rawConfigurations.map((configuration, index) => {
    const id = configuration?.id;
    if (typeof id !== 'string' || !idPattern.test(id) || configurationIds.has(id)) fieldError(fields, `configurations.${index}.id`, 'Configuration identifiers must be unique.');
    configurationIds.add(id);
    const label = typeof configuration?.label === 'string' ? configuration.label.trim() : '';
    if (!label || label.length > 160) fieldError(fields, `configurations.${index}.label`, 'Enter a label using 160 characters or fewer.');
    const addOn = nullableInteger(configuration?.price_add_on_cents, 0, 100000000, fields, `configurations.${index}.price_add_on_cents`);
    const packing = configuration?.packing_profile_id === null || configuration?.packing_profile_id === undefined || configuration?.packing_profile_id === '' ? null : configuration.packing_profile_id;
    if (packing !== null && (typeof packing !== 'string' || !idPattern.test(packing))) fieldError(fields, `configurations.${index}.packing_profile_id`, 'Choose a saved packing profile.');
    return {id, label, enabled: configuration?.enabled === true, price_add_on_cents: addOn ?? 0, packing_profile_id: packing, position: index};
  });

  if (Object.keys(fields).length) throw new HttpError(400, 'Draft has validation errors', {fields});
  return {
    title,
    description,
    category,
    base_price_cents: basePrice,
    width_eighths: width,
    height_eighths: height,
    offered_for_sale: draft.offered_for_sale === true,
    requested_store_position: requestedPosition,
    inventory: {quantity_changed: quantityChanged, intended_available_quantity: intended, captured_version: captured},
    photos,
    configurations
  };
}

async function hashSnapshot(snapshot) {
  const data = new TextEncoder().encode(JSON.stringify(snapshot));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function revisionInsert(database, {id, artworkId, number, parentId, importKey = null, source = 'admin', snapshot, hash, actor}) {
  return database.prepare(`INSERT INTO catalog_artwork_revisions(
    id,artwork_id,revision_number,parent_revision_id,import_key,source,title,description,category,
    base_price_cents,width_eighths,height_eighths,offered_for_sale,requested_store_position,
    quantity_changed,intended_available_quantity,captured_inventory_version,snapshot_json,content_hash,actor
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, artworkId, number, parentId, importKey, source, snapshot.title, snapshot.description, snapshot.category,
    snapshot.base_price_cents, snapshot.width_eighths, snapshot.height_eighths, snapshot.offered_for_sale ? 1 : 0,
    snapshot.requested_store_position, snapshot.inventory.quantity_changed ? 1 : 0,
    snapshot.inventory.intended_available_quantity, snapshot.inventory.captured_version,
    JSON.stringify(snapshot), hash, actor
  );
}

function childStatements(database, artworkId, revisionId, snapshot) {
  const statements = [];
  for (const photo of snapshot.photos) {
    statements.push(database.prepare('INSERT INTO catalog_revision_photos(revision_id,asset_id,position,is_main,alt_text) VALUES(?,?,?,?,?)')
      .bind(revisionId, photo.asset_id, photo.position, photo.is_main ? 1 : 0, photo.alt));
  }
  for (const configuration of snapshot.configurations) {
    statements.push(database.prepare('INSERT OR IGNORE INTO catalog_configurations(id,artwork_id) VALUES(?,?)').bind(configuration.id, artworkId));
    statements.push(database.prepare(`INSERT INTO catalog_revision_configurations(
      revision_id,configuration_id,label,enabled,price_add_on_cents,packing_profile_id,position
    ) VALUES(?,?,?,?,?,?,?)`).bind(
      revisionId, configuration.id, configuration.label, configuration.enabled ? 1 : 0,
      configuration.price_add_on_cents, configuration.packing_profile_id, configuration.position
    ));
  }
  return statements;
}

function artworkState(row) {
  if (row.archived_at !== null && row.archived_at !== undefined) return 'archived';
  if (!row.published_revision_id) return 'draft';
  return row.working_revision_id === row.published_revision_id ? 'published' : 'published_changes';
}

async function resolveArtwork(database, identifier) {
  if (typeof identifier !== 'string' || !identifier || identifier.length > 160) throw new HttpError(404, 'Artwork not found');
  const row = await one(database.prepare(`SELECT a.id,a.stable_id,a.client_id,h.working_revision_id,h.published_revision_id,
    h.last_published_revision_id,h.working_version,h.archived_at,i.physical_stock,i.reserved_stock,i.version AS inventory_version,
    o.position AS store_position
    FROM catalog_artworks a JOIN catalog_artwork_heads h ON h.artwork_id=a.id
    JOIN catalog_inventory i ON i.artwork_id=a.id LEFT JOIN catalog_store_order o ON o.artwork_id=a.id
    WHERE a.id=? OR a.stable_id=?`).bind(identifier, identifier));
  if (!row) throw new HttpError(404, 'Artwork not found');
  return row;
}

function assembleRevision(revision, photos, configurations, visibility) {
  const snapshot = parseJson(revision.snapshot_json, {});
  snapshot.photos = photos.map((photo) => ({
    asset_id: photo.asset_id,
    position: photo.position,
    is_main: asBool(photo.is_main),
    alt: photo.alt_text,
    source_kind: photo.source_kind,
    mime_type: photo.mime_type,
    width: photo.width,
    height: photo.height,
    byte_size: photo.byte_size,
    state: photo.state,
    url: photo.source_kind === 'legacy_public'
      ? photo.legacy_path
      : `${visibility === 'public' ? '/catalog-media' : '/api/admin/media'}/${photo.asset_id}/display`,
    thumbnail_url: photo.source_kind === 'legacy_public'
      ? photo.legacy_path
      : `${visibility === 'public' ? '/catalog-media' : '/api/admin/media'}/${photo.asset_id}/thumb`
  }));
  snapshot.configurations = configurations.map((configuration) => ({
    ...configuration,
    enabled: asBool(configuration.enabled),
    packing_profile_enabled: configuration.packing_profile_enabled == null ? null : asBool(configuration.packing_profile_enabled)
  }));
  return {revision, snapshot};
}

async function revisionDataMany(database, revisionIds, visibility = 'admin') {
  const ids = [...new Set(revisionIds.filter((id) => typeof id === 'string' && id))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const [revisions, photos, configurations] = await Promise.all([
    all(database.prepare(`SELECT * FROM catalog_artwork_revisions WHERE id IN (${placeholders})`).bind(...ids)),
    all(database.prepare(`SELECT rp.revision_id,rp.asset_id,rp.position,rp.is_main,rp.alt_text,a.source_kind,a.legacy_path,a.mime_type,a.width,a.height,a.byte_size,a.state
      FROM catalog_revision_photos rp JOIN catalog_media_assets a ON a.id=rp.asset_id
      WHERE rp.revision_id IN (${placeholders}) ORDER BY rp.revision_id,rp.position,rp.asset_id`).bind(...ids)),
    all(database.prepare(`SELECT rc.revision_id,rc.configuration_id AS id,rc.label,rc.enabled,rc.price_add_on_cents,
      rc.packing_profile_id,rc.position,p.label AS packing_profile_label,p.enabled AS packing_profile_enabled
      FROM catalog_revision_configurations rc LEFT JOIN catalog_packing_profiles p ON p.id=rc.packing_profile_id
      WHERE rc.revision_id IN (${placeholders}) ORDER BY rc.revision_id,rc.position,rc.configuration_id`).bind(...ids))
  ]);
  const byRevision = new Map(revisions.map((revision) => [revision.id, assembleRevision(
    revision,
    photos.filter((photo) => photo.revision_id === revision.id),
    configurations.filter((configuration) => configuration.revision_id === revision.id),
    visibility
  )]));
  return byRevision;
}

async function revisionData(database, revisionId, visibility = 'admin') {
  const value = (await revisionDataMany(database, [revisionId], visibility)).get(revisionId);
  if (!value) throw new HttpError(404, 'Revision not found');
  return value;
}

async function hydrateAdmin(database, row, loaded = null) {
  const {revision, snapshot} = loaded || await revisionData(database, row.working_revision_id, 'admin');
  return {
    id: row.id,
    stable_id: row.stable_id,
    client_id: row.client_id,
    state: artworkState(row),
    working_revision_id: row.working_revision_id,
    published_revision_id: row.published_revision_id,
    version: row.working_version,
    revision_number: revision.revision_number,
    inventory: {
      physical_stock: row.physical_stock,
      reserved_stock: row.reserved_stock,
      available_quantity: row.physical_stock == null ? null : row.physical_stock - row.reserved_stock,
      version: row.inventory_version
    },
    store_position: row.store_position == null ? null : row.store_position + 1,
    draft: snapshot
  };
}

export async function getAdminArtwork(database, identifier) {
  return hydrateAdmin(database, await resolveArtwork(database, identifier));
}

export async function reconcileBaseline(database, actor = 'system:legacy-reconciliation') {
  const stableRows = await all(database.prepare('SELECT stable_id FROM catalog_artworks'));
  const productRows = await all(database.prepare('SELECT id,title,description,stock,sort_order,status FROM products'));
  const variantRows = await all(database.prepare('SELECT id,product_id,sku,label,price_cents,sort_order FROM variants ORDER BY sort_order,id'));
  const legacyProducts = productRows.map((product) => ({...product, variants: variantRows.filter((variant) => variant.product_id === product.id)}));
  const plan = buildBaselineReconciliation({legacyProducts, existingStableIds: stableRows.map((row) => row.stable_id)});
  const inserted = [];
  for (const item of plan.insert) {
    const publicSnapshot = validateDraftSnapshot(item.published.snapshot);
    const privateDraft = validateDraftSnapshot(item.working.snapshot);
    const publicHash = await hashSnapshot(publicSnapshot);
    const privateHash = await hashSnapshot(privateDraft);
    const legacyExists = legacyProducts.some((product) => product.id === item.artwork.legacy_product_id);
    const statements = [
      database.prepare('INSERT INTO catalog_artworks(id,stable_id) VALUES(?,?)').bind(item.artwork.id, item.artwork.stable_id)
    ];
    for (const asset of item.assets) {
      statements.push(database.prepare(`INSERT INTO catalog_media_assets(id,artwork_id,source_kind,legacy_path,mime_type,state)
        VALUES(?,?,?,?,?,'ready')`).bind(asset.asset_id, item.artwork.id, 'legacy_public', asset.path, asset.mime_type));
    }
    statements.push(revisionInsert(database, {
      id: item.published.id, artworkId: item.artwork.id, number: 1, parentId: null,
      importKey: item.published.import_key, source: 'legacy_public', snapshot: publicSnapshot, hash: publicHash, actor
    }));
    statements.push(...childStatements(database, item.artwork.id, item.published.id, publicSnapshot));
    statements.push(revisionInsert(database, {
      id: item.working.id, artworkId: item.artwork.id, number: 2, parentId: item.published.id,
      importKey: item.working.import_key, source: 'legacy_private', snapshot: privateDraft, hash: privateHash, actor
    }));
    statements.push(...childStatements(database, item.artwork.id, item.working.id, privateDraft));
    statements.push(database.prepare('INSERT INTO catalog_inventory(artwork_id,physical_stock,reserved_stock,version) VALUES(?,?,?,?)')
      .bind(item.artwork.id, item.inventory.physical_stock, item.inventory.reserved_stock, item.inventory.version));
    statements.push(database.prepare('INSERT INTO catalog_store_order(artwork_id,position) VALUES(?,?)').bind(item.artwork.id, item.store_position));
    if (legacyExists) statements.push(database.prepare('INSERT INTO catalog_legacy_artwork_links(legacy_product_id,artwork_id) VALUES(?,?)')
      .bind(item.artwork.legacy_product_id, item.artwork.id));
    statements.push(database.prepare(`INSERT INTO catalog_artwork_heads(
      artwork_id,working_revision_id,published_revision_id,last_published_revision_id,working_version
    ) VALUES(?,?,?,?,2)`).bind(item.artwork.id, item.working.id, item.published.id, item.published.id));
    statements.push(database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(?,?, 'legacy_reconcile', ?)")
      .bind(item.artwork.id, actor, JSON.stringify({stable_id: item.artwork.stable_id, public_revision: item.published.id, working_revision: item.working.id})));
    try {
      await database.batch(statements);
      inserted.push(item.artwork.stable_id);
    } catch (error) {
      const existing = await one(database.prepare('SELECT id FROM catalog_artworks WHERE stable_id=?').bind(item.artwork.stable_id));
      if (!existing) throw databaseError(error, 'Baseline reconciliation failed');
    }
  }
  return {inserted, skipped: [...plan.skip.map((item) => item.stable_id), ...plan.insert.filter((item) => !inserted.includes(item.artwork.stable_id)).map((item) => item.artwork.stable_id)]};
}

function searchClause(query, alias = 'r') {
  const q = typeof query === 'string' ? query.trim().slice(0, 160) : '';
  if (!q) return {sql: '1=1', values: []};
  return {
    sql: `(instr(lower(${alias}.title),lower(?))>0 OR instr(lower(coalesce(${alias}.category,'')),lower(?))>0)`,
    values: [q, q]
  };
}

const stateSql = `CASE WHEN h.archived_at IS NOT NULL THEN 'archived'
 WHEN h.published_revision_id IS NULL THEN 'draft'
 WHEN h.working_revision_id=h.published_revision_id THEN 'published'
 ELSE 'published_changes' END`;

export async function listAdminArtworks(database, options = {}) {
  const page = Number.isSafeInteger(options.page) && options.page > 0 ? options.page : 1;
  const status = ['all','draft','published','published_changes','archived'].includes(options.status) ? options.status : 'all';
  const search = searchClause(options.q);
  let statusSql = '1=1';
  if (status === 'published') statusSql = `${stateSql} IN ('published','published_changes')`;
  else if (status !== 'all') statusSql = `${stateSql}=?`;
  const statusValues = status !== 'all' && status !== 'published' ? [status] : [];
  const baseFrom = `FROM catalog_artworks a JOIN catalog_artwork_heads h ON h.artwork_id=a.id
    JOIN catalog_artwork_revisions r ON r.id=h.working_revision_id
    JOIN catalog_inventory i ON i.artwork_id=a.id LEFT JOIN catalog_store_order o ON o.artwork_id=a.id`;
  const totalRow = await one(database.prepare(`SELECT count(*) AS total ${baseFrom} WHERE ${search.sql} AND ${statusSql}`)
    .bind(...search.values, ...statusValues));
  const total = Number(totalRow?.total ?? 0);
  const pages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const effectivePage = Math.min(page, pages);
  const rows = await all(database.prepare(`SELECT a.id,a.stable_id,a.client_id,h.working_revision_id,h.published_revision_id,
    h.last_published_revision_id,h.working_version,h.archived_at,i.physical_stock,i.reserved_stock,i.version AS inventory_version,
    o.position AS store_position ${baseFrom} WHERE ${search.sql} AND ${statusSql}
    ORDER BY CASE WHEN o.position IS NULL THEN 1 ELSE 0 END,o.position,r.title COLLATE NOCASE,a.stable_id LIMIT ? OFFSET ?`)
    .bind(...search.values, ...statusValues, ADMIN_PAGE_SIZE, (effectivePage - 1) * ADMIN_PAGE_SIZE));
  const countRow = await one(database.prepare(`SELECT count(*) AS all_count,
    sum(CASE WHEN ${stateSql}='draft' THEN 1 ELSE 0 END) AS draft_count,
    sum(CASE WHEN ${stateSql} IN ('published','published_changes') THEN 1 ELSE 0 END) AS published_count,
    sum(CASE WHEN ${stateSql}='published_changes' THEN 1 ELSE 0 END) AS published_changes_count,
    sum(CASE WHEN ${stateSql}='archived' THEN 1 ELSE 0 END) AS archived_count
    ${baseFrom} WHERE ${search.sql}`).bind(...search.values));
  const [orderState, categoryRows] = await Promise.all([
    one(database.prepare('SELECT version FROM catalog_store_order_state WHERE id=1')),
    all(database.prepare(`SELECT DISTINCT r.category ${baseFrom} WHERE h.archived_at IS NULL AND r.category IS NOT NULL AND trim(r.category)<>'' ORDER BY r.category`))
  ]);
  const loaded = await revisionDataMany(database, rows.map((row) => row.working_revision_id), 'admin');
  return {
    page: effectivePage,
    page_size: ADMIN_PAGE_SIZE,
    total,
    pages,
    showing_from: total ? (effectivePage - 1) * ADMIN_PAGE_SIZE + 1 : 0,
    showing_to: Math.min(effectivePage * ADMIN_PAGE_SIZE, total),
    counts: {
      all: Number(countRow?.all_count ?? 0), draft: Number(countRow?.draft_count ?? 0),
      published: Number(countRow?.published_count ?? 0), published_changes: Number(countRow?.published_changes_count ?? 0),
      archived: Number(countRow?.archived_count ?? 0)
    },
    categories: categoryRows.map((row) => row.category),
    order_version: Number(orderState?.version ?? 0),
    items: await Promise.all(rows.map((row) => hydrateAdmin(database, row, loaded.get(row.working_revision_id))))
  };
}

async function saveExisting(database, item, actor) {
  const head = await resolveArtwork(database, item.id);
  if (!Number.isSafeInteger(item.expected_version) || item.expected_version !== head.working_version) throw new HttpError(409, 'Draft changed in another session', {code: 'REVISION_CONFLICT', current_version: head.working_version});
  if (head.archived_at != null) throw new HttpError(409, 'Restore this artwork before editing it', {code: 'ARTWORK_ARCHIVED'});
  const snapshot = validateDraftSnapshot(item.draft);
  const revisionId = uuid();
  const version = head.working_version + 1;
  const hash = await hashSnapshot(snapshot);
  const statements = [
    revisionInsert(database, {id: revisionId, artworkId: head.id, number: version, parentId: head.working_revision_id, snapshot, hash, actor}),
    ...childStatements(database, head.id, revisionId, snapshot),
    database.prepare(`UPDATE catalog_artwork_heads SET working_revision_id=?,working_version=?,updated_at=unixepoch()
      WHERE artwork_id=? AND working_version=? AND archived_at IS NULL`).bind(revisionId, version, head.id, head.working_version),
    database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(?,?, 'save_draft', ?)")
      .bind(head.id, actor, JSON.stringify({revision_id: revisionId, version}))
  ];
  try { await database.batch(statements); } catch (error) { throw databaseError(error, 'Draft could not be saved'); }
  return {artwork_id: head.id, stable_id: head.stable_id, revision_id: revisionId, saved_version: version};
}

async function saveNew(database, item, actor) {
  const clientId = item.client_id;
  if (typeof clientId !== 'string' || !idPattern.test(clientId) || clientId.length > 120) throw new HttpError(400, 'New artwork needs a valid client ID', {fields: {client_id: ['Create a new client identifier.']}});
  const snapshot = validateDraftSnapshot(item.draft);
  const hash = await hashSnapshot(snapshot);
  const prior = await one(database.prepare("SELECT request_hash,response_json FROM catalog_idempotency_records WHERE scope='draft-create' AND idempotency_key=?").bind(clientId));
  if (prior) {
    if (prior.request_hash !== hash) throw new HttpError(409, 'This new-artwork retry has different content', {code: 'IDEMPOTENCY_CONFLICT'});
    return parseJson(prior.response_json);
  }
  const existing = await one(database.prepare(`SELECT a.id,a.stable_id,h.working_version,h.working_revision_id,r.content_hash
    FROM catalog_artworks a JOIN catalog_artwork_heads h ON h.artwork_id=a.id JOIN catalog_artwork_revisions r ON r.id=h.working_revision_id
    WHERE a.client_id=?`).bind(clientId));
  if (existing) {
    if (existing.content_hash !== hash) throw new HttpError(409, 'This client ID already belongs to another draft', {code: 'IDEMPOTENCY_CONFLICT'});
    return {artwork_id: existing.id, stable_id: existing.stable_id, revision_id: existing.working_revision_id, saved_version: existing.working_version};
  }
  const artworkId = uuid();
  const stableId = `art-${artworkId}`;
  const revisionId = uuid();
  const response = {artwork_id: artworkId, stable_id: stableId, revision_id: revisionId, saved_version: 1};
  const statements = [
    database.prepare('INSERT INTO catalog_artworks(id,stable_id,client_id) VALUES(?,?,?)').bind(artworkId, stableId, clientId),
    database.prepare('INSERT INTO catalog_inventory(artwork_id) VALUES(?)').bind(artworkId),
    revisionInsert(database, {id: revisionId, artworkId, number: 1, parentId: null, snapshot, hash, actor}),
    ...childStatements(database, artworkId, revisionId, snapshot),
    database.prepare('INSERT INTO catalog_artwork_heads(artwork_id,working_revision_id,working_version) VALUES(?,?,1)').bind(artworkId, revisionId),
    database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(?,?, 'create_draft', ?)")
      .bind(artworkId, actor, JSON.stringify({revision_id: revisionId, client_id: clientId})),
    database.prepare(`INSERT INTO catalog_idempotency_records(scope,idempotency_key,request_hash,status,response_json)
      VALUES('draft-create',?,?,201,?)`).bind(clientId, hash, JSON.stringify(response))
  ];
  try { await database.batch(statements); } catch (error) { throw databaseError(error, 'New draft could not be saved'); }
  return response;
}

export async function saveDraftBatch(database, payload, actor) {
  const items = payload?.items;
  if (!Array.isArray(items) || !items.length || items.length > 10) throw new HttpError(400, 'Provide one to ten modified cards');
  const results = [];
  for (const item of items) {
    const reference = item?.id ?? item?.client_id ?? null;
    try {
      const saved = item?.id ? await saveExisting(database, item, actor) : await saveNew(database, item, actor);
      results.push({reference, client_id: item?.client_id ?? null, success: true, ...saved});
    } catch (error) {
      const mapped = databaseError(error, 'Draft could not be saved');
      results.push({reference, client_id: item?.client_id ?? null, success: false, status: mapped.status, error: mapped.message, details: mapped.details});
    }
  }
  return {results};
}

async function publicationReadiness(database, artworkId, snapshot, inventory) {
  const fields = {};
  if (!snapshot.title.trim()) fieldError(fields, 'title', 'A title is required to publish.');
  if (!snapshot.photos.length || snapshot.photos.filter((photo) => photo.is_main).length !== 1) fieldError(fields, 'photos', 'A valid main photo is required to publish.');
  if (snapshot.offered_for_sale) {
    if (!(snapshot.base_price_cents > 0)) fieldError(fields, 'base_price_cents', 'A positive base price is required for sale.');
    if (!(snapshot.width_eighths > 0)) fieldError(fields, 'width_eighths', 'Width is required for sale.');
    if (!(snapshot.height_eighths > 0)) fieldError(fields, 'height_eighths', 'Height is required for sale.');
    const available = snapshot.inventory.quantity_changed ? snapshot.inventory.intended_available_quantity : inventory.physical_stock == null ? null : inventory.physical_stock - inventory.reserved_stock;
    if (!(available > 0)) fieldError(fields, 'inventory.intended_available_quantity', 'Positive available stock is required for sale.');
    const packingIds = snapshot.configurations.filter((configuration) => configuration.enabled && configuration.packing_profile_id).map((configuration) => configuration.packing_profile_id);
    let validPacking = false;
    for (const id of packingIds) {
      if (await one(database.prepare('SELECT id FROM catalog_packing_profiles WHERE id=? AND enabled=1').bind(id))) { validPacking = true; break; }
    }
    if (!validPacking) fieldError(fields, 'configurations', 'Enable at least one configuration with valid packing data.');
  }
  return fields;
}

export async function previewDraft(database, identifier, draftInput) {
  const head = await resolveArtwork(database, identifier);
  const snapshot = draftInput ? validateDraftSnapshot(draftInput) : (await revisionData(database, head.working_revision_id)).snapshot;
  const fields = await publicationReadiness(database, head.id, snapshot, head);
  return {artwork_id: head.id, stable_id: head.stable_id, state: artworkState(head), private: true, preview: snapshot, publish_errors: fields, can_publish: Object.keys(fields).length === 0};
}

export async function publishArtwork(database, identifier, payload, actor) {
  const head = await resolveArtwork(database, identifier);
  const expected = payload?.expected_version;
  if (!Number.isSafeInteger(expected) || expected !== head.working_version) throw new HttpError(409, 'Draft changed in another session', {code: 'HEAD_CONFLICT', current_version: head.working_version});
  const {revision, snapshot} = await revisionData(database, head.working_revision_id);
  const fields = await publicationReadiness(database, head.id, snapshot, head);
  if (Object.keys(fields).length) throw new HttpError(400, 'Artwork is not ready to publish', {fields});
  const commandId = uuid();
  const requested = head.store_position == null && revision.requested_store_position != null ? Math.max(0, revision.requested_store_position - 1) : null;
  try {
    await database.prepare(`INSERT INTO catalog_publish_commands(
      id,artwork_id,revision_id,expected_head_version,quantity_changed,expected_inventory_version,intended_available_quantity,requested_position,actor
    ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      commandId, head.id, head.working_revision_id, expected, revision.quantity_changed,
      revision.quantity_changed ? revision.captured_inventory_version : null,
      revision.quantity_changed ? revision.intended_available_quantity : null,
      requested, actor
    ).run();
  } catch (error) { throw databaseError(error, 'Artwork could not be published'); }
  return getAdminArtwork(database, head.id);
}

export async function archiveArtwork(database, identifier, expectedVersion, actor) {
  const head = await resolveArtwork(database, identifier);
  if (!Number.isSafeInteger(expectedVersion)) throw new HttpError(400, 'Expected version is required');
  try {
    await database.prepare('INSERT INTO catalog_archive_commands(id,artwork_id,expected_head_version,actor) VALUES(?,?,?,?)')
      .bind(uuid(), head.id, expectedVersion, actor).run();
  } catch (error) { throw databaseError(error, 'Artwork could not be archived'); }
  return getAdminArtwork(database, head.id);
}

export async function restoreArtwork(database, identifier, expectedVersion, actor) {
  const head = await resolveArtwork(database, identifier);
  if (!Number.isSafeInteger(expectedVersion)) throw new HttpError(400, 'Expected version is required');
  try {
    await database.prepare('INSERT INTO catalog_restore_commands(id,artwork_id,expected_head_version,actor) VALUES(?,?,?,?)')
      .bind(uuid(), head.id, expectedVersion, actor).run();
  } catch (error) { throw databaseError(error, 'Artwork could not be restored'); }
  return getAdminArtwork(database, head.id);
}

export async function saveStoreOrder(database, payload, actor) {
  if (!Number.isSafeInteger(payload?.expected_version) || payload.expected_version < 0) throw new HttpError(400, 'Expected order version is required');
  const rows = await all(database.prepare(`SELECT o.artwork_id,a.stable_id FROM catalog_store_order o JOIN catalog_artworks a ON a.id=o.artwork_id ORDER BY o.position,a.stable_id`));
  let ordered = rows.map((row) => row.artwork_id);
  if (Array.isArray(payload.ordered_artwork_ids)) {
    const byStable = new Map(rows.map((row) => [row.stable_id, row.artwork_id]));
    ordered = payload.ordered_artwork_ids.map((id) => byStable.get(id) ?? id);
  } else if (Array.isArray(payload.moves)) {
    const byAny = new Map(rows.flatMap((row) => [[row.stable_id, row.artwork_id], [row.artwork_id, row.artwork_id]]));
    for (const move of payload.moves) {
      const id = byAny.get(move?.artwork_id ?? move?.stable_id);
      if (!id || !Number.isSafeInteger(move?.to_position) || move.to_position < 1 || move.to_position > ordered.length) throw new HttpError(400, 'Store-order move is invalid');
      ordered.splice(ordered.indexOf(id), 1);
      ordered.splice(move.to_position - 1, 0, id);
    }
  } else throw new HttpError(400, 'Provide staged store-order changes');
  try {
    await database.prepare('INSERT INTO catalog_order_commands(id,expected_version,ordered_artwork_ids_json,actor) VALUES(?,?,?,?)')
      .bind(uuid(), payload.expected_version, JSON.stringify(ordered), actor).run();
  } catch (error) { throw databaseError(error, 'Store order could not be saved'); }
  return {saved: true, version: payload.expected_version + 1, ordered_artwork_ids: ordered};
}

async function hydratePublic(database, row, loaded = null) {
  const {snapshot} = loaded || await revisionData(database, row.published_revision_id, 'public');
  const available = row.physical_stock == null ? null : row.physical_stock - row.reserved_stock;
  return {
    id: row.stable_id,
    revision_id: row.published_revision_id,
    title: snapshot.title,
    description: snapshot.description,
    category: snapshot.category,
    base_price_cents: snapshot.base_price_cents,
    width_eighths: snapshot.width_eighths,
    height_eighths: snapshot.height_eighths,
    offered_for_sale: snapshot.offered_for_sale,
    available_quantity: available,
    sold_out: snapshot.offered_for_sale && available === 0,
    store_position: row.store_position == null ? null : row.store_position + 1,
    photos: snapshot.photos,
    configurations: snapshot.configurations.filter((configuration) => configuration.enabled).map((configuration) => ({
      id: configuration.id,
      label: configuration.label,
      price_add_on_cents: configuration.price_add_on_cents,
      packing_profile_id: configuration.packing_profile_id,
      merchandise_price_cents: snapshot.base_price_cents == null ? null : snapshot.base_price_cents + configuration.price_add_on_cents
    }))
  };
}

function publicWhere(options) {
  const clauses = ['h.archived_at IS NULL', 'h.published_revision_id IS NOT NULL'];
  const values = [];
  const search = searchClause(options.q);
  clauses.push(search.sql); values.push(...search.values);
  if (typeof options.category === 'string' && options.category.trim()) { clauses.push('r.category=?'); values.push(options.category.trim().slice(0,100)); }
  if (options.availability === 'in_stock') clauses.push('r.offered_for_sale=1 AND i.physical_stock IS NOT NULL AND i.physical_stock-i.reserved_stock>0');
  else if (options.availability === 'sold_out') clauses.push('r.offered_for_sale=1 AND i.physical_stock IS NOT NULL AND i.physical_stock-i.reserved_stock<=0');
  else if (options.availability === 'display_only') clauses.push('r.offered_for_sale=0');
  return {sql: clauses.join(' AND '), values};
}

export async function listPublicCatalog(database, options = {}) {
  const page = Number.isSafeInteger(options.page) && options.page > 0 ? options.page : 1;
  const size = Number.isSafeInteger(options.page_size) && options.page_size >= 1 && options.page_size <= 48 ? options.page_size : PUBLIC_PAGE_SIZE;
  const where = publicWhere(options);
  const from = `FROM catalog_artworks a JOIN catalog_artwork_heads h ON h.artwork_id=a.id
    JOIN catalog_artwork_revisions r ON r.id=h.published_revision_id JOIN catalog_inventory i ON i.artwork_id=a.id
    LEFT JOIN catalog_store_order o ON o.artwork_id=a.id`;
  const total = Number((await one(database.prepare(`SELECT count(*) AS n ${from} WHERE ${where.sql}`).bind(...where.values)))?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / size));
  const effective = Math.min(page, pages);
  let order = 'CASE WHEN o.position IS NULL THEN 1 ELSE 0 END,o.position,a.stable_id';
  if (options.sort === 'price_asc') order = '(r.base_price_cents IS NULL),r.base_price_cents ASC,a.stable_id';
  else if (options.sort === 'price_desc') order = '(r.base_price_cents IS NULL),r.base_price_cents DESC,a.stable_id';
  const rows = await all(database.prepare(`SELECT a.id,a.stable_id,h.published_revision_id,i.physical_stock,i.reserved_stock,o.position AS store_position
    ${from} WHERE ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...where.values, size, (effective - 1) * size));
  const categories = (await all(database.prepare(`SELECT DISTINCT r.category ${from} WHERE h.archived_at IS NULL AND h.published_revision_id IS NOT NULL AND r.category IS NOT NULL ORDER BY r.category`)))
    .map((row) => row.category);
  const loaded = await revisionDataMany(database, rows.map((row) => row.published_revision_id), 'public');
  return {currency: 'USD', page: effective, page_size: size, total, pages, categories, items: await Promise.all(rows.map((row) => hydratePublic(database, row, loaded.get(row.published_revision_id))))};
}

export async function getPublicArtwork(database, stableId) {
  const row = await one(database.prepare(`SELECT a.id,a.stable_id,h.published_revision_id,i.physical_stock,i.reserved_stock,o.position AS store_position
    FROM catalog_artworks a JOIN catalog_artwork_heads h ON h.artwork_id=a.id JOIN catalog_inventory i ON i.artwork_id=a.id
    LEFT JOIN catalog_store_order o ON o.artwork_id=a.id
    WHERE a.stable_id=? AND h.archived_at IS NULL AND h.published_revision_id IS NOT NULL`).bind(stableId));
  if (!row) throw new HttpError(404, 'Artwork not found');
  return hydratePublic(database, row);
}

export async function getMediaAsset(database, assetId, {publicOnly = false} = {}) {
  const guard = publicOnly ? `AND EXISTS(SELECT 1 FROM catalog_revision_photos rp JOIN catalog_artwork_heads h ON h.published_revision_id=rp.revision_id
    WHERE rp.asset_id=a.id AND h.archived_at IS NULL)` : '';
  const asset = await one(database.prepare(`SELECT a.* FROM catalog_media_assets a WHERE a.id=? AND a.state='ready' ${guard}`).bind(assetId));
  if (!asset) throw new HttpError(404, 'Photo not found');
  return asset;
}

export async function getManagedMedia(database, assetId, role, {publicOnly = false} = {}) {
  if (!['master','display','thumbnail'].includes(role) || (publicOnly && role === 'master')) throw new HttpError(404, 'Photo not found');
  const asset = await getMediaAsset(database, assetId, {publicOnly});
  if (asset.source_kind !== 'managed') return {legacy_path: asset.legacy_path, content_type: asset.mime_type};
  const object = await one(database.prepare('SELECT content_type,body FROM catalog_media_objects WHERE asset_id=? AND role=?').bind(assetId, role));
  if (!object) throw new HttpError(404, 'Photo not found');
  return {body: bytes(object.body), content_type: object.content_type};
}

export async function allocateUpload(database, payload) {
  const head = await resolveArtwork(database, payload?.artwork_id);
  if (!Number.isSafeInteger(payload?.expected_version) || payload.expected_version !== head.working_version || head.archived_at != null) throw new HttpError(409, 'Artwork changed before upload', {code: 'HEAD_CONFLICT', current_version: head.working_version});
  const key = payload?.idempotency_key;
  if (typeof key !== 'string' || !idPattern.test(key)) throw new HttpError(400, 'Upload idempotency key is required');
  const prior = await one(database.prepare('SELECT * FROM catalog_upload_sessions WHERE idempotency_key=?').bind(key));
  if (prior) {
    if (prior.artwork_id !== head.id || prior.expected_head_version !== head.working_version || (prior.replace_asset_id ?? null) !== (payload.replace_asset_id ?? null)) throw new HttpError(409, 'Upload key is already in use');
    return {upload_id: prior.id, state: prior.state, expires_at: prior.expires_at, asset_id: prior.asset_id};
  }
  let replacement = payload?.replace_asset_id ?? null;
  if (replacement !== null) {
    const found = await one(database.prepare('SELECT 1 AS ok FROM catalog_revision_photos WHERE revision_id=? AND asset_id=?').bind(head.working_revision_id, replacement));
    if (!found) throw new HttpError(400, 'Replacement photo is not in the working revision');
  }
  const id = uuid();
  const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
  try {
    await database.prepare(`INSERT INTO catalog_upload_sessions(id,idempotency_key,artwork_id,expected_head_version,replace_asset_id,expires_at)
      VALUES(?,?,?,?,?,?)`).bind(id, key, head.id, head.working_version, replacement, expiresAt).run();
  } catch (error) { throw databaseError(error, 'Upload could not be allocated'); }
  return {upload_id: id, state: 'allocated', expires_at: expiresAt};
}

export async function commitSuccessfulUpload(database, uploadId, processed, actor) {
  const session = await one(database.prepare(`SELECT u.*,h.working_revision_id,h.working_version,h.archived_at
    FROM catalog_upload_sessions u JOIN catalog_artwork_heads h ON h.artwork_id=u.artwork_id WHERE u.id=?`).bind(uploadId));
  if (!session) throw new HttpError(404, 'Upload not found');
  if (!['allocated','processing'].includes(session.state) || session.expires_at <= Math.floor(Date.now() / 1000)) throw new HttpError(409, 'Upload is no longer active');
  if (session.archived_at != null || session.working_version !== session.expected_head_version) throw new HttpError(409, 'Artwork changed before upload completed', {code: 'HEAD_CONFLICT', current_version: session.working_version});
  if (!processed?.input || !Array.isArray(processed.objects) || processed.objects.length !== 3) throw new HttpError(500, 'Processed photo is incomplete');
  const current = await revisionData(database, session.working_revision_id);
  const snapshot = validateDraftSnapshot(current.snapshot);
  const assetId = uuid();
  let photos = snapshot.photos.map((photo) => ({asset_id: photo.asset_id, alt: photo.alt, position: photo.position, is_main: photo.is_main}));
  if (session.replace_asset_id) {
    const index = photos.findIndex((photo) => photo.asset_id === session.replace_asset_id);
    if (index < 0) throw new HttpError(409, 'Replacement photo is no longer attached');
    photos[index] = {...photos[index], asset_id: assetId};
  } else {
    if (photos.length >= MEDIA_LIMITS.maxPhotos) throw new HttpError(409, 'An artwork can have at most four photos');
    photos.push({asset_id: assetId, alt: snapshot.title, position: photos.length, is_main: photos.length === 0});
  }
  snapshot.photos = photos.map((photo, position) => ({...photo, position}));
  const normalized = validateDraftSnapshot(snapshot);
  const revisionId = uuid();
  const version = session.working_version + 1;
  const hash = await hashSnapshot(normalized);
  const statements = [
    database.prepare(`INSERT INTO catalog_media_assets(id,artwork_id,source_kind,mime_type,width,height,byte_size,checksum,state)
      VALUES(?,?,'managed','image/webp',?,?,?,?, 'ready')`).bind(assetId, session.artwork_id, processed.input.width, processed.input.height, processed.input.bytes, processed.checksum),
    ...processed.objects.map((object) => database.prepare(`INSERT INTO catalog_media_objects(object_key,asset_id,role,content_type,body)
      VALUES(?,?,?,?,?)`).bind(`${assetId}:${object.role}`, assetId, object.role, object.contentType, bytes(object.bytes))),
    revisionInsert(database, {id: revisionId, artworkId: session.artwork_id, number: version, parentId: session.working_revision_id, snapshot: normalized, hash, actor}),
    ...childStatements(database, session.artwork_id, revisionId, normalized),
    database.prepare(`UPDATE catalog_artwork_heads SET working_revision_id=?,working_version=?,updated_at=unixepoch()
      WHERE artwork_id=? AND working_version=? AND archived_at IS NULL`).bind(revisionId, version, session.artwork_id, session.working_version),
    database.prepare(`UPDATE catalog_upload_sessions SET state='committed',asset_id=?,updated_at=unixepoch()
      WHERE id=? AND state IN ('allocated','processing')`).bind(assetId, uploadId),
    database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(?,?, 'photo_commit', ?)")
      .bind(session.artwork_id, actor, JSON.stringify({asset_id: assetId, replaced_asset_id: session.replace_asset_id, revision_id: revisionId}))
  ];
  try { await database.batch(statements); } catch (error) { throw databaseError(error, 'Photo replacement was not saved'); }
  return {asset_id: assetId, revision_id: revisionId, saved_version: version};
}

export async function failUpload(database, uploadId, code = 'PROCESSING_FAILED') {
  await database.prepare(`UPDATE catalog_upload_sessions SET state='failed',error_code=?,updated_at=unixepoch()
    WHERE id=? AND state IN ('allocated','processing')`).bind(String(code).slice(0,120), uploadId).run();
}

export {mediaCapabilities, ADMIN_PAGE_SIZE, PUBLIC_PAGE_SIZE};

