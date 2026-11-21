PRAGMA foreign_keys=ON;
CREATE TABLE products(id TEXT PRIMARY KEY,title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),description TEXT NOT NULL DEFAULT '',stock INTEGER DEFAULT NULL CHECK(stock IS NULL OR (typeof(stock)='integer' AND stock BETWEEN 0 AND 1000000)),status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 100000));
CREATE TABLE variants(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,sku TEXT NOT NULL UNIQUE,label TEXT NOT NULL,price_cents INTEGER DEFAULT NULL CHECK(price_cents IS NULL OR (typeof(price_cents)='integer' AND price_cents BETWEEN 0 AND 100000000)),sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 100000));
CREATE TABLE images(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,object_key TEXT NOT NULL UNIQUE,alt_text TEXT NOT NULL DEFAULT '',sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 100000));
CREATE INDEX variants_product ON variants(product_id,sort_order);
CREATE INDEX images_product ON images(product_id,sort_order);
CREATE INDEX products_status ON products(status,sort_order);

CREATE TRIGGER publish_valid BEFORE UPDATE ON products WHEN NEW.status='published' BEGIN
 SELECT CASE WHEN NEW.stock IS NULL OR NOT EXISTS(SELECT 1 FROM variants WHERE product_id=NEW.id) OR EXISTS(SELECT 1 FROM variants WHERE product_id=NEW.id AND price_cents IS NULL) THEN RAISE(ABORT,'Publication requires stock and priced variants') END;
END;
CREATE TRIGGER insert_product_stock BEFORE INSERT ON products WHEN NEW.status='published' AND NEW.stock IS NULL BEGIN SELECT RAISE(ABORT,'Publication requires stock'); END;
CREATE TRIGGER insert_variant_price BEFORE INSERT ON variants WHEN NEW.price_cents IS NULL AND (SELECT status FROM products WHERE id=NEW.product_id)='published' BEGIN SELECT RAISE(ABORT,'Published price required'); END;
CREATE TRIGGER update_variant_price BEFORE UPDATE ON variants WHEN NEW.price_cents IS NULL AND (SELECT status FROM products WHERE id=NEW.product_id)='published' BEGIN SELECT RAISE(ABORT,'Published price required'); END;

CREATE TRIGGER variant_limit BEFORE INSERT ON variants WHEN (SELECT count(*) FROM variants WHERE product_id=NEW.product_id)>=100 BEGIN SELECT RAISE(ABORT,'Variant limit reached'); END;
CREATE TRIGGER draft_only_variant_delete BEFORE DELETE ON variants WHEN (SELECT status FROM products WHERE id=OLD.product_id)='published' BEGIN SELECT RAISE(ABORT,'Unpublish before removing variant'); END;
