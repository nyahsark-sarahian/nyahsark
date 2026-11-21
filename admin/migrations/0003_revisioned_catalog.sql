CREATE TABLE IF NOT EXISTS catalog_artworks(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 80),
 stable_id TEXT NOT NULL UNIQUE CHECK(length(stable_id) BETWEEN 1 AND 80),
 client_id TEXT UNIQUE CHECK(client_id IS NULL OR length(client_id) BETWEEN 8 AND 120),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);

CREATE TABLE IF NOT EXISTS catalog_legacy_artwork_links(
 legacy_product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE RESTRICT,
 artwork_id TEXT NOT NULL UNIQUE REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 import_key TEXT NOT NULL DEFAULT 'legacy-private-v1',
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);

CREATE TABLE IF NOT EXISTS catalog_artwork_revisions(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 80),
 artwork_id TEXT NOT NULL REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 revision_number INTEGER NOT NULL CHECK(typeof(revision_number)='integer' AND revision_number>=1),
 parent_revision_id TEXT REFERENCES catalog_artwork_revisions(id) ON DELETE RESTRICT,
 import_key TEXT,
 source TEXT NOT NULL DEFAULT 'admin' CHECK(source IN ('admin','legacy_public','legacy_private','system')),
 title TEXT NOT NULL DEFAULT '' CHECK(length(title)<=160),
 description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=10000),
 category TEXT CHECK(category IS NULL OR length(category) BETWEEN 1 AND 100),
 base_price_cents INTEGER CHECK(base_price_cents IS NULL OR (typeof(base_price_cents)='integer' AND base_price_cents BETWEEN 0 AND 100000000)),
 width_eighths INTEGER CHECK(width_eighths IS NULL OR (typeof(width_eighths)='integer' AND width_eighths BETWEEN 1 AND 1000000)),
 height_eighths INTEGER CHECK(height_eighths IS NULL OR (typeof(height_eighths)='integer' AND height_eighths BETWEEN 1 AND 1000000)),
 offered_for_sale INTEGER NOT NULL DEFAULT 0 CHECK(offered_for_sale IN (0,1)),
 requested_store_position INTEGER CHECK(requested_store_position IS NULL OR (typeof(requested_store_position)='integer' AND requested_store_position>=0)),
 quantity_changed INTEGER NOT NULL DEFAULT 0 CHECK(quantity_changed IN (0,1)),
 intended_available_quantity INTEGER CHECK(intended_available_quantity IS NULL OR (typeof(intended_available_quantity)='integer' AND intended_available_quantity BETWEEN 0 AND 1000000)),
 captured_inventory_version INTEGER CHECK(captured_inventory_version IS NULL OR (typeof(captured_inventory_version)='integer' AND captured_inventory_version>=0)),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
 content_hash TEXT NOT NULL CHECK(length(content_hash) BETWEEN 16 AND 128),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 160),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 UNIQUE(artwork_id,revision_number),
 UNIQUE(artwork_id,import_key),
 CHECK((quantity_changed=0 AND intended_available_quantity IS NULL) OR (quantity_changed=1 AND intended_available_quantity IS NOT NULL AND captured_inventory_version IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS catalog_revisions_artwork ON catalog_artwork_revisions(artwork_id,revision_number DESC);
CREATE INDEX IF NOT EXISTS catalog_revisions_title ON catalog_artwork_revisions(title COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS catalog_artwork_heads(
 artwork_id TEXT PRIMARY KEY REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 working_revision_id TEXT NOT NULL REFERENCES catalog_artwork_revisions(id) ON DELETE RESTRICT,
 published_revision_id TEXT REFERENCES catalog_artwork_revisions(id) ON DELETE RESTRICT,
 last_published_revision_id TEXT REFERENCES catalog_artwork_revisions(id) ON DELETE RESTRICT,
 working_version INTEGER NOT NULL CHECK(typeof(working_version)='integer' AND working_version>=1),
 archived_at INTEGER,
 updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX IF NOT EXISTS catalog_heads_public ON catalog_artwork_heads(published_revision_id,archived_at);

CREATE TABLE IF NOT EXISTS catalog_media_assets(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 80),
 artwork_id TEXT NOT NULL REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('legacy_public','managed')),
 legacy_path TEXT UNIQUE CHECK(legacy_path IS NULL OR (legacy_path GLOB '/*' AND length(legacy_path)<=300)),
 mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp')),
 width INTEGER CHECK(width IS NULL OR (typeof(width)='integer' AND width BETWEEN 1 AND 8192)),
 height INTEGER CHECK(height IS NULL OR (typeof(height)='integer' AND height BETWEEN 1 AND 8192)),
 byte_size INTEGER CHECK(byte_size IS NULL OR (typeof(byte_size)='integer' AND byte_size BETWEEN 1 AND 5242880)),
 checksum TEXT CHECK(checksum IS NULL OR length(checksum) BETWEEN 16 AND 128),
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('temporary','ready','failed')),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 CHECK((source_kind='legacy_public' AND legacy_path IS NOT NULL) OR (source_kind='managed' AND legacy_path IS NULL))
);
CREATE INDEX IF NOT EXISTS catalog_media_artwork ON catalog_media_assets(artwork_id,created_at);

CREATE TABLE IF NOT EXISTS catalog_media_objects(
 object_key TEXT PRIMARY KEY CHECK(length(object_key) BETWEEN 8 AND 160),
 asset_id TEXT NOT NULL REFERENCES catalog_media_assets(id) ON DELETE RESTRICT,
 role TEXT NOT NULL CHECK(role IN ('master','display','thumbnail')),
 content_type TEXT NOT NULL CHECK(content_type='image/webp'),
 body BLOB NOT NULL CHECK(typeof(body)='blob' AND length(body) BETWEEN 1 AND 1900000),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 UNIQUE(asset_id,role)
);

CREATE TABLE IF NOT EXISTS catalog_revision_photos(
 revision_id TEXT NOT NULL REFERENCES catalog_artwork_revisions(id) ON DELETE RESTRICT,
 asset_id TEXT NOT NULL REFERENCES catalog_media_assets(id) ON DELETE RESTRICT,
 position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 0 AND 3),
 is_main INTEGER NOT NULL CHECK(is_main IN (0,1)),
 alt_text TEXT NOT NULL DEFAULT '' CHECK(length(alt_text)<=500),
 PRIMARY KEY(revision_id,asset_id),
 UNIQUE(revision_id,position)
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_revision_one_main ON catalog_revision_photos(revision_id) WHERE is_main=1;
CREATE INDEX IF NOT EXISTS catalog_revision_photos_asset ON catalog_revision_photos(asset_id,revision_id);

CREATE TABLE IF NOT EXISTS catalog_store_settings(
 id INTEGER PRIMARY KEY CHECK(id=1),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 shipping_origin_json TEXT CHECK(shipping_origin_json IS NULL OR json_valid(shipping_origin_json)),
 tax_status TEXT NOT NULL DEFAULT 'missing' CHECK(tax_status IN ('missing','configured','verified')),
 payment_status TEXT NOT NULL DEFAULT 'missing' CHECK(payment_status IN ('missing','sandbox','live')),
 payment_mode TEXT NOT NULL DEFAULT 'disabled' CHECK(payment_mode IN ('disabled','sandbox','live')),
 handling_cents INTEGER CHECK(handling_cents IS NULL OR (typeof(handling_cents)='integer' AND handling_cents>=0)),
 handling_scope TEXT CHECK(handling_scope IS NULL OR handling_scope IN ('order','package')),
 config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config_json) AND json_type(config_json)='object'),
 updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);
INSERT OR IGNORE INTO catalog_store_settings(id) VALUES(1);

CREATE TABLE IF NOT EXISTS catalog_packing_profiles(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 80),
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 160),
 length_value INTEGER NOT NULL CHECK(typeof(length_value)='integer' AND length_value>0),
 width_value INTEGER NOT NULL CHECK(typeof(width_value)='integer' AND width_value>0),
 height_value INTEGER NOT NULL CHECK(typeof(height_value)='integer' AND height_value>0),
 dimension_unit TEXT NOT NULL CHECK(dimension_unit IN ('in','cm')),
 weight_value INTEGER NOT NULL CHECK(typeof(weight_value)='integer' AND weight_value>0),
 weight_unit TEXT NOT NULL CHECK(weight_unit IN ('oz','lb','g','kg')),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);

CREATE TABLE IF NOT EXISTS catalog_configurations(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 80),
 artwork_id TEXT NOT NULL REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 UNIQUE(id,artwork_id)
);

CREATE TABLE IF NOT EXISTS catalog_revision_configurations(
 revision_id TEXT NOT NULL REFERENCES catalog_artwork_revisions(id) ON DELETE RESTRICT,
 configuration_id TEXT NOT NULL REFERENCES catalog_configurations(id) ON DELETE RESTRICT,
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 160),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 price_add_on_cents INTEGER NOT NULL DEFAULT 0 CHECK(typeof(price_add_on_cents)='integer' AND price_add_on_cents BETWEEN 0 AND 100000000),
 packing_profile_id TEXT REFERENCES catalog_packing_profiles(id) ON DELETE RESTRICT,
 position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 0 AND 99),
 PRIMARY KEY(revision_id,configuration_id),
 UNIQUE(revision_id,position)
);

CREATE TABLE IF NOT EXISTS catalog_inventory(
 artwork_id TEXT PRIMARY KEY REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 physical_stock INTEGER CHECK(physical_stock IS NULL OR (typeof(physical_stock)='integer' AND physical_stock BETWEEN 0 AND 1000000)),
 reserved_stock INTEGER NOT NULL DEFAULT 0 CHECK(typeof(reserved_stock)='integer' AND reserved_stock BETWEEN 0 AND 1000000),
 version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(version)='integer' AND version>=0),
 updated_at INTEGER NOT NULL DEFAULT(unixepoch()),
 CHECK(physical_stock IS NULL OR reserved_stock<=physical_stock)
);

CREATE TABLE IF NOT EXISTS catalog_store_order_state(
 id INTEGER PRIMARY KEY CHECK(id=1),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);
INSERT OR IGNORE INTO catalog_store_order_state(id) VALUES(1);

CREATE TABLE IF NOT EXISTS catalog_store_order(
 artwork_id TEXT PRIMARY KEY REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),
 updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX IF NOT EXISTS catalog_store_order_position ON catalog_store_order(position,artwork_id);

CREATE TABLE IF NOT EXISTS catalog_shipping_services(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 80),
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 160),
 provider_service_code TEXT CHECK(provider_service_code IS NULL OR length(provider_service_code)<=160),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
);
CREATE TABLE IF NOT EXISTS catalog_supported_destinations(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 80),
 country_code TEXT NOT NULL CHECK(length(country_code)=2),
 region_code TEXT,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 UNIQUE(country_code,region_code)
);
CREATE TABLE IF NOT EXISTS catalog_fulfillment_methods(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 80),
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 160),
 kind TEXT NOT NULL CHECK(kind IN ('shipping','pickup')),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
);

CREATE TABLE IF NOT EXISTS catalog_upload_sessions(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 artwork_id TEXT NOT NULL REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 expected_head_version INTEGER NOT NULL CHECK(expected_head_version>=1),
 replace_asset_id TEXT REFERENCES catalog_media_assets(id) ON DELETE RESTRICT,
 state TEXT NOT NULL DEFAULT 'allocated' CHECK(state IN ('allocated','processing','ready','committed','failed','expired')),
 asset_id TEXT REFERENCES catalog_media_assets(id) ON DELETE RESTRICT,
 error_code TEXT,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX IF NOT EXISTS catalog_upload_expiry ON catalog_upload_sessions(state,expires_at);

CREATE TABLE IF NOT EXISTS catalog_idempotency_records(
 scope TEXT NOT NULL CHECK(length(scope) BETWEEN 1 AND 80),
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 request_hash TEXT NOT NULL CHECK(length(request_hash) BETWEEN 16 AND 128),
 status INTEGER NOT NULL CHECK(status BETWEEN 100 AND 599),
 response_json TEXT NOT NULL CHECK(json_valid(response_json)),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 expires_at INTEGER,
 PRIMARY KEY(scope,idempotency_key)
);

CREATE TABLE IF NOT EXISTS catalog_quotes(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 idempotency_key TEXT UNIQUE CHECK(idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 160),
 status TEXT NOT NULL CHECK(status IN ('incomplete','ready','expired','consumed')),
 currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 merchandise_cents INTEGER NOT NULL CHECK(merchandise_cents>=0),
 shipping_cents INTEGER CHECK(shipping_cents IS NULL OR shipping_cents>=0),
 handling_cents INTEGER CHECK(handling_cents IS NULL OR handling_cents>=0),
 tax_cents INTEGER CHECK(tax_cents IS NULL OR tax_cents>=0),
 grand_total_cents INTEGER CHECK(grand_total_cents IS NULL OR grand_total_cents>=0),
 address_json TEXT CHECK(address_json IS NULL OR json_valid(address_json)),
 service_reference TEXT,
 tax_breakdown_json TEXT CHECK(tax_breakdown_json IS NULL OR json_valid(tax_breakdown_json)),
 catalog_version TEXT NOT NULL,
 settings_version INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 CHECK((status='ready' AND shipping_cents IS NOT NULL AND tax_cents IS NOT NULL AND grand_total_cents IS NOT NULL) OR status!='ready')
);
CREATE INDEX IF NOT EXISTS catalog_quotes_expiry ON catalog_quotes(status,expires_at);

CREATE TABLE IF NOT EXISTS catalog_quote_lines(
 quote_id TEXT NOT NULL REFERENCES catalog_quotes(id) ON DELETE RESTRICT,
 line_number INTEGER NOT NULL CHECK(line_number>=0),
 artwork_id TEXT NOT NULL REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 revision_id TEXT NOT NULL REFERENCES catalog_artwork_revisions(id) ON DELETE RESTRICT,
 configuration_id TEXT NOT NULL REFERENCES catalog_configurations(id) ON DELETE RESTRICT,
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99),
 unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0),
 line_total_cents INTEGER NOT NULL CHECK(line_total_cents>=0),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 PRIMARY KEY(quote_id,line_number)
);

CREATE TABLE IF NOT EXISTS catalog_orders(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 order_number TEXT NOT NULL UNIQUE CHECK(length(order_number) BETWEEN 4 AND 80),
 quote_id TEXT NOT NULL UNIQUE REFERENCES catalog_quotes(id) ON DELETE RESTRICT,
 idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 payment_status TEXT NOT NULL CHECK(payment_status IN ('pending','session_uncertain','authorized','paid','failed','expired','refunded')),
 fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled' CHECK(fulfillment_status IN ('unfulfilled','processing','shipped','delivered','cancelled')),
 currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 merchandise_cents INTEGER NOT NULL CHECK(merchandise_cents>=0),
 shipping_cents INTEGER NOT NULL CHECK(shipping_cents>=0),
 handling_cents INTEGER NOT NULL CHECK(handling_cents>=0),
 tax_cents INTEGER NOT NULL CHECK(tax_cents>=0),
 grand_total_cents INTEGER NOT NULL CHECK(grand_total_cents>=0),
 delivery_json TEXT NOT NULL CHECK(json_valid(delivery_json)),
 provider_reference TEXT,
 tracking_reference TEXT,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);

CREATE TABLE IF NOT EXISTS catalog_order_lines(
 order_id TEXT NOT NULL REFERENCES catalog_orders(id) ON DELETE RESTRICT,
 line_number INTEGER NOT NULL CHECK(line_number>=0),
 artwork_id TEXT NOT NULL REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 configuration_id TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99),
 unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0),
 line_total_cents INTEGER NOT NULL CHECK(line_total_cents>=0),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 PRIMARY KEY(order_id,line_number)
);

CREATE TABLE IF NOT EXISTS catalog_inventory_reservations(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 order_id TEXT NOT NULL REFERENCES catalog_orders(id) ON DELETE RESTRICT,
 artwork_id TEXT NOT NULL REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000000),
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','released','committed')),
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 updated_at INTEGER NOT NULL DEFAULT(unixepoch()),
 UNIQUE(order_id,artwork_id)
);
CREATE INDEX IF NOT EXISTS catalog_reservations_expiry ON catalog_inventory_reservations(state,expires_at);

CREATE TABLE IF NOT EXISTS catalog_payment_attempts(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 order_id TEXT NOT NULL REFERENCES catalog_orders(id) ON DELETE RESTRICT,
 provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 80),
 provider_session_id TEXT UNIQUE,
 mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
 status TEXT NOT NULL CHECK(status IN ('creating','uncertain','ready','failed','complete')),
 idempotency_key TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);

CREATE TABLE IF NOT EXISTS catalog_payment_events(
 provider TEXT NOT NULL,
 provider_event_id TEXT NOT NULL,
 order_id TEXT REFERENCES catalog_orders(id) ON DELETE RESTRICT,
 event_type TEXT NOT NULL,
 verified INTEGER NOT NULL CHECK(verified IN (0,1)),
 payload_hash TEXT NOT NULL,
 occurred_at INTEGER,
 received_at INTEGER NOT NULL DEFAULT(unixepoch()),
 PRIMARY KEY(provider,provider_event_id)
);

CREATE TABLE IF NOT EXISTS catalog_audit_events(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 artwork_id TEXT REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 actor TEXT NOT NULL,
 action TEXT NOT NULL,
 details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX IF NOT EXISTS catalog_audit_artwork ON catalog_audit_events(artwork_id,created_at DESC);

CREATE TABLE IF NOT EXISTS catalog_publish_commands(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 artwork_id TEXT NOT NULL REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 revision_id TEXT NOT NULL REFERENCES catalog_artwork_revisions(id) ON DELETE RESTRICT,
 expected_head_version INTEGER NOT NULL CHECK(expected_head_version>=1),
 quantity_changed INTEGER NOT NULL CHECK(quantity_changed IN (0,1)),
 expected_inventory_version INTEGER,
 intended_available_quantity INTEGER CHECK(intended_available_quantity IS NULL OR intended_available_quantity BETWEEN 0 AND 1000000),
 requested_position INTEGER CHECK(requested_position IS NULL OR requested_position>=0),
 actor TEXT NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 CHECK((quantity_changed=0 AND expected_inventory_version IS NULL AND intended_available_quantity IS NULL) OR (quantity_changed=1 AND expected_inventory_version IS NOT NULL AND intended_available_quantity IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS catalog_archive_commands(
 id TEXT PRIMARY KEY,
 artwork_id TEXT NOT NULL REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 expected_head_version INTEGER NOT NULL,
 actor TEXT NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE IF NOT EXISTS catalog_restore_commands(
 id TEXT PRIMARY KEY,
 artwork_id TEXT NOT NULL REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 expected_head_version INTEGER NOT NULL,
 actor TEXT NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE IF NOT EXISTS catalog_order_commands(
 id TEXT PRIMARY KEY,
 expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 ordered_artwork_ids_json TEXT NOT NULL CHECK(json_valid(ordered_artwork_ids_json) AND json_type(ordered_artwork_ids_json)='array'),
 actor TEXT NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);

CREATE TRIGGER IF NOT EXISTS catalog_revision_cas BEFORE INSERT ON catalog_artwork_revisions
WHEN EXISTS(SELECT 1 FROM catalog_artwork_heads WHERE artwork_id=NEW.artwork_id)
BEGIN
 SELECT CASE WHEN NEW.revision_number<>(SELECT working_version+1 FROM catalog_artwork_heads WHERE artwork_id=NEW.artwork_id) THEN RAISE(ABORT,'REVISION_CONFLICT') END;
 SELECT CASE WHEN coalesce(NEW.parent_revision_id,'')<>coalesce((SELECT working_revision_id FROM catalog_artwork_heads WHERE artwork_id=NEW.artwork_id),'') THEN RAISE(ABORT,'REVISION_PARENT_CONFLICT') END;
 SELECT CASE WHEN (SELECT archived_at FROM catalog_artwork_heads WHERE artwork_id=NEW.artwork_id) IS NOT NULL THEN RAISE(ABORT,'ARTWORK_ARCHIVED') END;
END;
CREATE TRIGGER IF NOT EXISTS catalog_revision_immutable_update BEFORE UPDATE ON catalog_artwork_revisions BEGIN SELECT RAISE(ABORT,'REVISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_revision_immutable_delete BEFORE DELETE ON catalog_artwork_revisions BEGIN SELECT RAISE(ABORT,'REVISION_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS catalog_photo_cap BEFORE INSERT ON catalog_revision_photos
WHEN (SELECT count(*) FROM catalog_revision_photos WHERE revision_id=NEW.revision_id)>=4
BEGIN SELECT RAISE(ABORT,'PHOTO_LIMIT'); END;
CREATE TRIGGER IF NOT EXISTS catalog_photo_asset_owner BEFORE INSERT ON catalog_revision_photos
WHEN (SELECT artwork_id FROM catalog_artwork_revisions WHERE id=NEW.revision_id)<>(SELECT artwork_id FROM catalog_media_assets WHERE id=NEW.asset_id)
BEGIN SELECT RAISE(ABORT,'PHOTO_OWNER_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS catalog_photo_head_immutable_insert BEFORE INSERT ON catalog_revision_photos
WHEN EXISTS(SELECT 1 FROM catalog_artwork_heads WHERE working_revision_id=NEW.revision_id OR published_revision_id=NEW.revision_id OR last_published_revision_id=NEW.revision_id)
BEGIN SELECT RAISE(ABORT,'REVISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_photo_head_immutable_update BEFORE UPDATE ON catalog_revision_photos BEGIN SELECT RAISE(ABORT,'REVISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_photo_head_immutable_delete BEFORE DELETE ON catalog_revision_photos BEGIN SELECT RAISE(ABORT,'REVISION_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS catalog_configuration_owner BEFORE INSERT ON catalog_revision_configurations
WHEN (SELECT artwork_id FROM catalog_artwork_revisions WHERE id=NEW.revision_id)<>(SELECT artwork_id FROM catalog_configurations WHERE id=NEW.configuration_id)
BEGIN SELECT RAISE(ABORT,'CONFIGURATION_OWNER_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS catalog_configuration_head_immutable_insert BEFORE INSERT ON catalog_revision_configurations
WHEN EXISTS(SELECT 1 FROM catalog_artwork_heads WHERE working_revision_id=NEW.revision_id OR published_revision_id=NEW.revision_id OR last_published_revision_id=NEW.revision_id)
BEGIN SELECT RAISE(ABORT,'REVISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_configuration_immutable_update BEFORE UPDATE ON catalog_revision_configurations BEGIN SELECT RAISE(ABORT,'REVISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_configuration_immutable_delete BEFORE DELETE ON catalog_revision_configurations BEGIN SELECT RAISE(ABORT,'REVISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_media_object_immutable_update BEFORE UPDATE ON catalog_media_objects BEGIN SELECT RAISE(ABORT,'MEDIA_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_media_object_referenced_delete BEFORE DELETE ON catalog_media_objects
WHEN EXISTS(SELECT 1 FROM catalog_revision_photos WHERE asset_id=OLD.asset_id)
BEGIN SELECT RAISE(ABORT,'MEDIA_RETAINED'); END;

CREATE TRIGGER IF NOT EXISTS catalog_publish_guard BEFORE INSERT ON catalog_publish_commands
BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM catalog_artwork_heads h JOIN catalog_artwork_revisions r ON r.id=NEW.revision_id
  WHERE h.artwork_id=NEW.artwork_id AND r.artwork_id=NEW.artwork_id AND h.archived_at IS NULL
    AND h.working_revision_id=NEW.revision_id AND h.working_version=NEW.expected_head_version
 ) THEN RAISE(ABORT,'HEAD_CONFLICT') END;
 SELECT CASE WHEN length(trim((SELECT title FROM catalog_artwork_revisions WHERE id=NEW.revision_id)))=0 THEN RAISE(ABORT,'TITLE_REQUIRED') END;
 SELECT CASE WHEN (SELECT count(*) FROM catalog_revision_photos WHERE revision_id=NEW.revision_id) NOT BETWEEN 1 AND 4
   OR (SELECT count(*) FROM catalog_revision_photos WHERE revision_id=NEW.revision_id AND is_main=1)<>1
   OR EXISTS(SELECT 1 FROM catalog_revision_photos rp JOIN catalog_media_assets a ON a.id=rp.asset_id WHERE rp.revision_id=NEW.revision_id AND a.state<>'ready')
  THEN RAISE(ABORT,'MAIN_PHOTO_REQUIRED') END;
 SELECT CASE WHEN NEW.quantity_changed=1 AND NOT EXISTS(
  SELECT 1 FROM catalog_inventory WHERE artwork_id=NEW.artwork_id AND version=NEW.expected_inventory_version
 ) THEN RAISE(ABORT,'INVENTORY_CONFLICT') END;
 SELECT CASE WHEN (SELECT offered_for_sale FROM catalog_artwork_revisions WHERE id=NEW.revision_id)=1 AND (
  coalesce((SELECT base_price_cents FROM catalog_artwork_revisions WHERE id=NEW.revision_id),0)<=0 OR
  coalesce((SELECT width_eighths FROM catalog_artwork_revisions WHERE id=NEW.revision_id),0)<=0 OR
  coalesce((SELECT height_eighths FROM catalog_artwork_revisions WHERE id=NEW.revision_id),0)<=0 OR
  NOT EXISTS(SELECT 1 FROM catalog_revision_configurations c JOIN catalog_packing_profiles p ON p.id=c.packing_profile_id WHERE c.revision_id=NEW.revision_id AND c.enabled=1 AND p.enabled=1) OR
  CASE WHEN NEW.quantity_changed=1 THEN NEW.intended_available_quantity ELSE coalesce((SELECT physical_stock-reserved_stock FROM catalog_inventory WHERE artwork_id=NEW.artwork_id),0) END <=0
 ) THEN RAISE(ABORT,'SALE_NOT_READY') END;
END;

CREATE TRIGGER IF NOT EXISTS catalog_publish_apply AFTER INSERT ON catalog_publish_commands
BEGIN
 UPDATE catalog_inventory
 SET physical_stock=NEW.intended_available_quantity+reserved_stock,version=version+1,updated_at=unixepoch()
 WHERE artwork_id=NEW.artwork_id AND NEW.quantity_changed=1;
 UPDATE catalog_store_order
 SET position=position+1,updated_at=unixepoch()
 WHERE NEW.requested_position IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM catalog_store_order WHERE artwork_id=NEW.artwork_id)
   AND position>=NEW.requested_position;
 UPDATE catalog_store_order_state
 SET version=version+1,updated_at=unixepoch()
 WHERE id=1 AND NOT EXISTS(SELECT 1 FROM catalog_store_order WHERE artwork_id=NEW.artwork_id);
 INSERT OR IGNORE INTO catalog_store_order(artwork_id,position)
 VALUES(NEW.artwork_id,coalesce(NEW.requested_position,(SELECT coalesce(max(position)+1,0) FROM catalog_store_order)));
 UPDATE catalog_artwork_heads
 SET last_published_revision_id=NEW.revision_id,published_revision_id=NEW.revision_id,updated_at=unixepoch()
 WHERE artwork_id=NEW.artwork_id;
 INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json)
 VALUES(NEW.artwork_id,NEW.actor,'publish',json_object('revision_id',NEW.revision_id,'quantity_changed',NEW.quantity_changed));
END;

CREATE TRIGGER IF NOT EXISTS catalog_archive_guard BEFORE INSERT ON catalog_archive_commands
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM catalog_artwork_heads WHERE artwork_id=NEW.artwork_id AND working_version=NEW.expected_head_version AND archived_at IS NULL) THEN RAISE(ABORT,'HEAD_CONFLICT') END;
END;
CREATE TRIGGER IF NOT EXISTS catalog_archive_apply AFTER INSERT ON catalog_archive_commands
BEGIN
 UPDATE catalog_store_order_state SET version=version+1,updated_at=unixepoch()
 WHERE id=1 AND EXISTS(SELECT 1 FROM catalog_store_order WHERE artwork_id=NEW.artwork_id);
 UPDATE catalog_store_order SET position=position-1,updated_at=unixepoch()
 WHERE position>(SELECT position FROM catalog_store_order WHERE artwork_id=NEW.artwork_id);
 DELETE FROM catalog_store_order WHERE artwork_id=NEW.artwork_id;
 UPDATE catalog_artwork_heads
 SET last_published_revision_id=coalesce(published_revision_id,last_published_revision_id),published_revision_id=NULL,archived_at=unixepoch(),updated_at=unixepoch()
 WHERE artwork_id=NEW.artwork_id;
 INSERT INTO catalog_audit_events(artwork_id,actor,action) VALUES(NEW.artwork_id,NEW.actor,'archive');
END;

CREATE TRIGGER IF NOT EXISTS catalog_restore_guard BEFORE INSERT ON catalog_restore_commands
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM catalog_artwork_heads WHERE artwork_id=NEW.artwork_id AND working_version=NEW.expected_head_version AND archived_at IS NOT NULL) THEN RAISE(ABORT,'HEAD_CONFLICT') END;
END;
CREATE TRIGGER IF NOT EXISTS catalog_restore_apply AFTER INSERT ON catalog_restore_commands
BEGIN
 UPDATE catalog_artwork_heads SET published_revision_id=NULL,archived_at=NULL,updated_at=unixepoch() WHERE artwork_id=NEW.artwork_id;
 INSERT INTO catalog_audit_events(artwork_id,actor,action) VALUES(NEW.artwork_id,NEW.actor,'restore');
END;

CREATE TRIGGER IF NOT EXISTS catalog_order_guard BEFORE INSERT ON catalog_order_commands
BEGIN
 SELECT CASE WHEN NEW.expected_version<>(SELECT version FROM catalog_store_order_state WHERE id=1) THEN RAISE(ABORT,'ORDER_CONFLICT') END;
 SELECT CASE WHEN json_array_length(NEW.ordered_artwork_ids_json)<>(SELECT count(*) FROM catalog_store_order) THEN RAISE(ABORT,'ORDER_SET_MISMATCH') END;
 SELECT CASE WHEN (SELECT count(DISTINCT value) FROM json_each(NEW.ordered_artwork_ids_json))<>(SELECT count(*) FROM catalog_store_order) THEN RAISE(ABORT,'ORDER_DUPLICATE') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.ordered_artwork_ids_json) j LEFT JOIN catalog_store_order o ON o.artwork_id=j.value WHERE o.artwork_id IS NULL) THEN RAISE(ABORT,'ORDER_SET_MISMATCH') END;
END;
CREATE TRIGGER IF NOT EXISTS catalog_order_apply AFTER INSERT ON catalog_order_commands
BEGIN
 UPDATE catalog_store_order
 SET position=(SELECT CAST(key AS INTEGER) FROM json_each(NEW.ordered_artwork_ids_json) WHERE value=artwork_id),updated_at=unixepoch();
 UPDATE catalog_store_order_state SET version=version+1,updated_at=unixepoch() WHERE id=1;
 INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json)
 VALUES(NULL,NEW.actor,'store_order',json_object('expected_version',NEW.expected_version,'count',json_array_length(NEW.ordered_artwork_ids_json)));
END;

CREATE TRIGGER IF NOT EXISTS catalog_reservation_guard BEFORE INSERT ON catalog_inventory_reservations
BEGIN
 SELECT CASE WHEN NEW.state<>'active' THEN RAISE(ABORT,'RESERVATION_STATE') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM catalog_inventory i JOIN catalog_artwork_heads h ON h.artwork_id=i.artwork_id JOIN catalog_artwork_revisions r ON r.id=h.published_revision_id
  WHERE i.artwork_id=NEW.artwork_id AND h.archived_at IS NULL AND r.offered_for_sale=1
    AND i.physical_stock IS NOT NULL AND i.physical_stock-i.reserved_stock>=NEW.quantity
 ) THEN RAISE(ABORT,'INSUFFICIENT_STOCK') END;
END;
CREATE TRIGGER IF NOT EXISTS catalog_reservation_apply AFTER INSERT ON catalog_inventory_reservations
BEGIN
 UPDATE catalog_inventory SET reserved_stock=reserved_stock+NEW.quantity,version=version+1,updated_at=unixepoch() WHERE artwork_id=NEW.artwork_id;
END;
CREATE TRIGGER IF NOT EXISTS catalog_reservation_transition_guard BEFORE UPDATE ON catalog_inventory_reservations
BEGIN
 SELECT CASE WHEN OLD.order_id<>NEW.order_id OR OLD.artwork_id<>NEW.artwork_id OR OLD.quantity<>NEW.quantity THEN RAISE(ABORT,'RESERVATION_IMMUTABLE') END;
 SELECT CASE WHEN OLD.state<>'active' OR NEW.state NOT IN ('released','committed') THEN RAISE(ABORT,'RESERVATION_STATE') END;
 SELECT CASE WHEN NEW.state='committed' AND NOT EXISTS(SELECT 1 FROM catalog_inventory WHERE artwork_id=OLD.artwork_id AND physical_stock IS NOT NULL AND physical_stock>=OLD.quantity AND reserved_stock>=OLD.quantity) THEN RAISE(ABORT,'INVENTORY_CONFLICT') END;
END;
CREATE TRIGGER IF NOT EXISTS catalog_reservation_release AFTER UPDATE OF state ON catalog_inventory_reservations
WHEN OLD.state='active' AND NEW.state='released'
BEGIN
 UPDATE catalog_inventory SET reserved_stock=reserved_stock-OLD.quantity,version=version+1,updated_at=unixepoch() WHERE artwork_id=OLD.artwork_id;
END;
CREATE TRIGGER IF NOT EXISTS catalog_reservation_commit AFTER UPDATE OF state ON catalog_inventory_reservations
WHEN OLD.state='active' AND NEW.state='committed'
BEGIN
 UPDATE catalog_inventory SET physical_stock=physical_stock-OLD.quantity,reserved_stock=reserved_stock-OLD.quantity,version=version+1,updated_at=unixepoch() WHERE artwork_id=OLD.artwork_id;
END;
