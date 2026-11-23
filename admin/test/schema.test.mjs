import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {LEGACY_BASELINE,buildBaselineReconciliation,publishedSnapshot} from '../src/baseline.js';
import {d1MigrationScript,ensureSchema,resetSchemaReadinessForTest} from '../src/schema.js';

const migrations=['0001_legacy_inventory.sql','0002_private_image_objects.sql','0003_revisioned_catalog.sql'];
function database(){
 const db=new DatabaseSync(':memory:');
 for(const name of migrations)db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 return db;
}
const json=value=>JSON.stringify(value);
const revision=(db,{artwork='artwork-1',id='revision-1',number=1,parent=null,title='Artwork',offered=0,quantityChanged=0,intended=null,captured=null})=>{
 const snapshot={title,description:'Description',category:null,base_price_cents:offered?1000:null,width_eighths:offered?80:null,height_eighths:offered?80:null,offered_for_sale:!!offered,requested_store_position:null,inventory:{quantity_changed:!!quantityChanged,intended_available_quantity:intended,captured_version:captured},photos:[],configurations:[]};
 db.prepare(`INSERT INTO catalog_artwork_revisions(id,artwork_id,revision_number,parent_revision_id,title,description,base_price_cents,width_eighths,height_eighths,offered_for_sale,quantity_changed,intended_available_quantity,captured_inventory_version,snapshot_json,content_hash,actor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,artwork,number,parent,title,'Description',offered?1000:null,offered?80:null,offered?80:null,offered,quantityChanged,intended,captured,json(snapshot),'0123456789abcdef','test');
};
function seedArt(db,{artwork='artwork-1',revisionId='revision-1',asset='asset-01',stable='art-test',offered=0,stock=null,withConfig=false}={}){
 db.prepare('INSERT INTO catalog_artworks(id,stable_id) VALUES(?,?)').run(artwork,stable);
 revision(db,{artwork,id:revisionId,offered});
 db.prepare("INSERT INTO catalog_media_assets(id,artwork_id,source_kind,legacy_path,mime_type) VALUES(?,?, 'legacy_public',?, 'image/jpeg')").run(asset,artwork,'/'+asset+'.jpg');
 db.prepare('INSERT INTO catalog_revision_photos(revision_id,asset_id,position,is_main,alt_text) VALUES(?,?,0,1,?)').run(revisionId,asset,'Main');
 if(withConfig){
  db.prepare("INSERT INTO catalog_packing_profiles(id,label,length_value,width_value,height_value,dimension_unit,weight_value,weight_unit) VALUES('pack-0001','Box',12,10,3,'in',32,'oz')").run();
  db.prepare("INSERT INTO catalog_configurations(id,artwork_id) VALUES('config-0001',?)").run(artwork);
  db.prepare("INSERT INTO catalog_revision_configurations(revision_id,configuration_id,label,enabled,price_add_on_cents,packing_profile_id,position) VALUES(?,'config-0001','Unframed',1,0,'pack-0001',0)").run(revisionId);
 }
 db.prepare('INSERT INTO catalog_inventory(artwork_id,physical_stock) VALUES(?,?)').run(artwork,stock);
 db.prepare('INSERT INTO catalog_artwork_heads(artwork_id,working_revision_id,working_version) VALUES(?,?,1)').run(artwork,revisionId);
}
const publish=(db,{id='pub-0001',artwork='artwork-1',revisionId='revision-1',version=1,quantityChanged=0,inventoryVersion=null,intended=null,position=null}={})=>db.prepare('INSERT INTO catalog_publish_commands(id,artwork_id,revision_id,expected_head_version,quantity_changed,expected_inventory_version,intended_available_quantity,requested_position,actor) VALUES(?,?,?,?,?,?,?,?,?)').run(id,artwork,revisionId,version,quantityChanged,inventoryVersion,intended,position,'test');

test('all additive migrations apply and preserve legacy tables',()=>{
 const db=database();
 const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
 for(const name of ['products','variants','images','private_image_objects','catalog_artworks','catalog_artwork_revisions','catalog_inventory','catalog_orders'])assert.ok(names.includes(name),name);
});

test('runtime bootstrap is complete, idempotent, and repairs a missing schema object',async()=>{
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../migrations/0001_legacy_inventory.sql',import.meta.url),'utf8'));
 sqlite.exec(readFileSync(new URL('../migrations/0002_private_image_objects.sql',import.meta.url),'utf8'));
 const wrap=(sql,values=[])=>({
  bind(...next){return wrap(sql,next);},
  first(){return sqlite.prepare(sql).get(...values)??null;},
  all(){return {results:sqlite.prepare(sql).all(...values)}}
 });
 const DB={prepare(sql){return wrap(sql);},async exec(sql){
  for(const statement of sql.split('\n')){
   assert.equal(statement.includes('\n'),false);
   sqlite.exec(statement);
  }
 }};
 const revisioned=readFileSync(new URL('../migrations/0003_revisioned_catalog.sql',import.meta.url),'utf8');
 const commands=readFileSync(new URL('../migrations/0004_settings_commands.sql',import.meta.url),'utf8');
 const compliance=readFileSync(new URL('../migrations/0005_listing_compliance.sql',import.meta.url),'utf8');
 const governance=readFileSync(new URL('../migrations/0006_ai_governance.sql',import.meta.url),'utf8');
 assert.match(d1MigrationScript(revisioned),/^CREATE TABLE IF NOT EXISTS catalog_artworks/);
 assert.match(d1MigrationScript(compliance),/catalog_order_payment_state_guard[\s\S]*PAYMENT_STATE_CONFLICT/);
 resetSchemaReadinessForTest();
 await ensureSchema(DB,revisioned,commands,compliance,governance);
 assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'catalog_%'").get().n,42);
 assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='catalog_settings_apply'").get().n,1);
 assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='catalog_compliance_publish_guard'").get().n,1);
 assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='view' AND name='catalog_compliance_effective'").get().n,1);
 assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='catalog_ai_reservation_budget_guard'").get().n,1);
 assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='catalog_review_escalation_seller_clearance_guard'").get().n,1);
 assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='catalog_listing_price_floors'").get().n,1);
 sqlite.exec('DROP INDEX catalog_audit_artwork');
 resetSchemaReadinessForTest();
 await ensureSchema(DB,revisioned,commands,compliance,governance);
 assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='catalog_audit_artwork'").get().n,1);
 sqlite.exec('DROP TRIGGER catalog_review_escalation_seller_clearance_guard');
 resetSchemaReadinessForTest();
 await ensureSchema(DB,revisioned,commands,compliance,governance);
 assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='catalog_review_escalation_seller_clearance_guard'").get().n,1);
 resetSchemaReadinessForTest();
});

test('verified baseline is deterministic, complete, and rerunnable',()=>{
 assert.equal(LEGACY_BASELINE.length,9);
 assert.equal(LEGACY_BASELINE.flatMap(x=>x.photos).length,12);
 assert.deepEqual(LEGACY_BASELINE.map(x=>x.id),Array.from({length:9},(_,i)=>`art-${String(i+1).padStart(3,'0')}`));
 assert.equal(LEGACY_BASELINE[0].legacy_product_id,'00000000-0000-4000-8000-000000000001');
 assert.equal(LEGACY_BASELINE[8].legacy_variant_id,'00000000-0000-4001-8000-000000000009');
 assert.equal(publishedSnapshot(LEGACY_BASELINE[3]).photos.length,3);
 const first=buildBaselineReconciliation();
 assert.equal(first.insert.length,9);
 const rerun=buildBaselineReconciliation({existingStableIds:LEGACY_BASELINE.map(x=>x.id)});
 assert.equal(rerun.insert.length,0);assert.equal(rerun.skip.length,9);
});

test('working revisions use optimistic head CAS and stay immutable',()=>{
 const db=database();seedArt(db);
 revision(db,{artwork:'artwork-1',id:'revision-2',number:2,parent:'revision-1'});
 db.prepare("UPDATE catalog_artwork_heads SET working_revision_id='revision-2',working_version=2 WHERE artwork_id='artwork-1'").run();
 assert.throws(()=>revision(db,{artwork:'artwork-1',id:'revision-stale',number:2,parent:'revision-1'}),/REVISION_CONFLICT/);
 assert.throws(()=>db.prepare("UPDATE catalog_artwork_revisions SET title='changed' WHERE id='revision-1'").run(),/REVISION_IMMUTABLE/);
 assert.throws(()=>db.prepare("INSERT INTO catalog_revision_photos(revision_id,asset_id,position,is_main) VALUES('revision-2','asset-01',0,1)").run(),/REVISION_IMMUTABLE/);
});

test('media cleanup permits only unreferenced objects',()=>{
 const db=database();seedArt(db);
 db.prepare("INSERT INTO catalog_media_assets(id,artwork_id,source_kind,mime_type,state) VALUES('asset-temp','artwork-1','managed','image/webp','temporary')").run();
 db.prepare("INSERT INTO catalog_media_objects(object_key,asset_id,role,content_type,body) VALUES('object-temp','asset-temp','display','image/webp',?)").run(new Uint8Array([1,2,3]));
 db.prepare("DELETE FROM catalog_media_objects WHERE object_key='object-temp'").run();
 db.prepare("INSERT INTO catalog_media_objects(object_key,asset_id,role,content_type,body) VALUES('object-live','asset-01','display','image/webp',?)").run(new Uint8Array([1,2,3]));
 assert.throws(()=>db.prepare("DELETE FROM catalog_media_objects WHERE object_key='object-live'").run(),/MEDIA_RETAINED/);
});

test('display publication switches the public head and inserts global order atomically',()=>{
 const db=database();seedArt(db);
 publish(db,{position:0});
 const head=db.prepare("SELECT working_revision_id,published_revision_id FROM catalog_artwork_heads WHERE artwork_id='artwork-1'").get();
 assert.deepEqual({...head},{working_revision_id:'revision-1',published_revision_id:'revision-1'});
 assert.deepEqual({...db.prepare('SELECT artwork_id,position FROM catalog_store_order').get()},{artwork_id:'artwork-1',position:0});
 assert.equal(db.prepare('SELECT version FROM catalog_store_order_state WHERE id=1').get().version,1);
});

test('publication requires a title and exactly one ready main photo',()=>{
 const db=database();
 db.prepare("INSERT INTO catalog_artworks(id,stable_id) VALUES('artwork-1','art-test')").run();
 revision(db,{title:''});
 db.prepare("INSERT INTO catalog_inventory(artwork_id) VALUES('artwork-1')").run();
 db.prepare("INSERT INTO catalog_artwork_heads(artwork_id,working_revision_id,working_version) VALUES('artwork-1','revision-1',1)").run();
 assert.throws(()=>publish(db),/TITLE_REQUIRED|MAIN_PHOTO_REQUIRED/);
});

test('sale publication validates packing and applies intended available quantity without consuming reservations',()=>{
 const db=database();seedArt(db,{offered:1,stock:0,withConfig:true});
 publish(db,{quantityChanged:1,inventoryVersion:0,intended:2});
 assert.deepEqual({...db.prepare("SELECT physical_stock,reserved_stock,version FROM catalog_inventory WHERE artwork_id='artwork-1'").get()},{physical_stock:2,reserved_stock:0,version:1});
 const db2=database();seedArt(db2,{offered:1,stock:1});
 assert.throws(()=>publish(db2),/SALE_NOT_READY/);
});

test('archive removes public order and restore returns a private draft',()=>{
 const db=database();seedArt(db);publish(db);
 db.prepare("INSERT INTO catalog_archive_commands(id,artwork_id,expected_head_version,actor) VALUES('archive-1','artwork-1',1,'test')").run();
 let h=db.prepare("SELECT published_revision_id,archived_at FROM catalog_artwork_heads WHERE artwork_id='artwork-1'").get();
 assert.equal(h.published_revision_id,null);assert.ok(h.archived_at);assert.equal(db.prepare('SELECT count(*) n FROM catalog_store_order').get().n,0);
 db.prepare("INSERT INTO catalog_restore_commands(id,artwork_id,expected_head_version,actor) VALUES('restore-1','artwork-1',1,'test')").run();
 h=db.prepare("SELECT published_revision_id,archived_at FROM catalog_artwork_heads WHERE artwork_id='artwork-1'").get();
 assert.deepEqual({...h},{published_revision_id:null,archived_at:null});
});

test('global order command rejects stale versions and applies a complete unique order',()=>{
 const db=database();seedArt(db);publish(db,{id:'publish-1',position:0});
 seedArt(db,{artwork:'artwork-2',revisionId:'revision-2',asset:'asset-02',stable:'art-two'});publish(db,{id:'publish-2',artwork:'artwork-2',revisionId:'revision-2',position:1});
 const version=db.prepare('SELECT version FROM catalog_store_order_state WHERE id=1').get().version;
 db.prepare('INSERT INTO catalog_order_commands(id,expected_version,ordered_artwork_ids_json,actor) VALUES(?,?,?,?)').run('order-1',version,json(['artwork-2','artwork-1']),'test');
 assert.deepEqual(db.prepare('SELECT artwork_id FROM catalog_store_order ORDER BY position').all().map(x=>x.artwork_id),['artwork-2','artwork-1']);
 assert.throws(()=>db.prepare('INSERT INTO catalog_order_commands(id,expected_version,ordered_artwork_ids_json,actor) VALUES(?,?,?,?)').run('order-stale',version,json(['artwork-1','artwork-2']),'test'),/ORDER_CONFLICT/);
});

function order(db,{quote,order}){
 db.prepare("INSERT INTO catalog_quotes(id,status,merchandise_cents,shipping_cents,handling_cents,tax_cents,grand_total_cents,catalog_version,settings_version,expires_at) VALUES(?,'ready',1000,100,0,88,1188,'v1',0,unixepoch()+600)").run(quote);
 db.prepare("INSERT INTO catalog_orders(id,order_number,quote_id,idempotency_key,payment_status,currency,merchandise_cents,shipping_cents,handling_cents,tax_cents,grand_total_cents,delivery_json) VALUES(?,?,?,?, 'pending','USD',1000,100,0,88,1188,'{}')").run(order,'N-'+order,quote,'idem-'+order);
}

test('shared-stock reservations allow at most available stock and commit or release once',()=>{
 const db=database();seedArt(db,{offered:1,stock:1,withConfig:true});publish(db);
 order(db,{quote:'quote-01',order:'order-01'});order(db,{quote:'quote-02',order:'order-02'});
 db.prepare("INSERT INTO catalog_inventory_reservations(id,order_id,artwork_id,quantity,expires_at) VALUES('reserve-1','order-01','artwork-1',1,unixepoch()+600)").run();
 assert.equal(db.prepare("SELECT reserved_stock FROM catalog_inventory WHERE artwork_id='artwork-1'").get().reserved_stock,1);
 assert.throws(()=>db.prepare("INSERT INTO catalog_inventory_reservations(id,order_id,artwork_id,quantity,expires_at) VALUES('reserve-2','order-02','artwork-1',1,unixepoch()+600)").run(),/INSUFFICIENT_STOCK/);
 db.prepare("UPDATE catalog_inventory_reservations SET state='released' WHERE id='reserve-1'").run();
 assert.equal(db.prepare("SELECT reserved_stock FROM catalog_inventory WHERE artwork_id='artwork-1'").get().reserved_stock,0);
 db.prepare("INSERT INTO catalog_inventory_reservations(id,order_id,artwork_id,quantity,expires_at) VALUES('reserve-2','order-02','artwork-1',1,unixepoch()+600)").run();
 db.prepare("UPDATE catalog_inventory_reservations SET state='committed' WHERE id='reserve-2'").run();
 assert.deepEqual({...db.prepare("SELECT physical_stock,reserved_stock FROM catalog_inventory WHERE artwork_id='artwork-1'").get()},{physical_stock:0,reserved_stock:0});
 assert.throws(()=>db.prepare("UPDATE catalog_inventory_reservations SET state='released' WHERE id='reserve-2'").run(),/RESERVATION_STATE/);
});
