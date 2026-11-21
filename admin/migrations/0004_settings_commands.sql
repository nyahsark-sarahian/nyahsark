CREATE TABLE IF NOT EXISTS catalog_settings_commands(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 shipping_origin_json TEXT CHECK(shipping_origin_json IS NULL OR json_valid(shipping_origin_json)),
 tax_status TEXT NOT NULL CHECK(tax_status IN ('missing','configured','verified')),
 payment_status TEXT NOT NULL CHECK(payment_status IN ('missing','sandbox','live')),
 payment_mode TEXT NOT NULL CHECK(payment_mode IN ('disabled','sandbox','live')),
 handling_cents INTEGER CHECK(handling_cents IS NULL OR handling_cents>=0),
 handling_scope TEXT CHECK(handling_scope IS NULL OR handling_scope IN ('order','package')),
 config_json TEXT NOT NULL CHECK(json_valid(config_json) AND json_type(config_json)='object'),
 actor TEXT NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);

CREATE TRIGGER IF NOT EXISTS catalog_settings_guard BEFORE INSERT ON catalog_settings_commands
BEGIN
 SELECT CASE WHEN NEW.expected_version<>(SELECT version FROM catalog_store_settings WHERE id=1)
  THEN RAISE(ABORT,'SETTINGS_CONFLICT') END;
END;

CREATE TRIGGER IF NOT EXISTS catalog_settings_apply AFTER INSERT ON catalog_settings_commands
BEGIN
 UPDATE catalog_store_settings
 SET version=version+1,
     shipping_origin_json=NEW.shipping_origin_json,
     tax_status=NEW.tax_status,
     payment_status=NEW.payment_status,
     payment_mode=NEW.payment_mode,
     handling_cents=NEW.handling_cents,
     handling_scope=NEW.handling_scope,
     config_json=NEW.config_json,
     updated_at=unixepoch()
 WHERE id=1;
 INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json)
 VALUES(NULL,NEW.actor,'store_settings',json_object('expected_version',NEW.expected_version));
END;

