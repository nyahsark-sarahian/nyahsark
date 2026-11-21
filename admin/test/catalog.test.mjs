import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {
  reconcileBaseline,listAdminArtworks,getAdminArtwork,saveDraftBatch,previewDraft,publishArtwork,
  archiveArtwork,restoreArtwork,saveStoreOrder,listPublicCatalog,getPublicArtwork,validateDraftSnapshot,
  allocateUpload,commitSuccessfulUpload
} from '../src/catalog.js';
import {LEGACY_BASELINE} from '../src/baseline.js';
import {runDeterministicAssessment, saveAssessment, saveAiSuggestion} from '../src/compliance.js';

const migrations=['0001_legacy_inventory.sql','0002_private_image_objects.sql','0003_revisioned_catalog.sql','0004_settings_commands.sql','0005_listing_compliance.sql']
  .map(name=>readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));

const clearCompliance={
 object_kind:'ordinary_devotional',blessed_or_dedicated:'no',purported_relic:'no',relic_class_claim:null,
 contains_human_material:'no',provenance_known:'yes',ecclesiastical_owner:'no',authenticity_document:'no',
 spiritual_benefit_priced:'no',seller_attested:true
};

function d1(){
 const sqlite=new DatabaseSync(':memory:');for(const sql of migrations)sqlite.exec(sql);
 const wrap=(sql,values=[])=>({
  bind(...next){return wrap(sql,next.map(v=>v instanceof ArrayBuffer?new Uint8Array(v):v));},
  run(){const meta=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(meta.changes),last_row_id:Number(meta.lastInsertRowid)}};},
  first(){return sqlite.prepare(sql).get(...values)??null;},
  all(){return {results:sqlite.prepare(sql).all(...values)};}
 });
 const DB={
  prepare(sql){return wrap(sql);},
  async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const out=[];for(const statement of statements)out.push(await statement.run());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}},
  async exec(sql){sqlite.exec(sql);return {count:0};}
 };
 return {sqlite,DB};
}

function seedLegacy(sqlite){
 for(const item of LEGACY_BASELINE){
  sqlite.prepare('INSERT INTO products(id,title,description,stock,status,sort_order) VALUES(?,?,?,NULL,?,?)')
   .run(item.legacy_product_id,item.title,item.description,'draft',item.display_order);
  sqlite.prepare('INSERT INTO variants(id,product_id,sku,label,price_cents,sort_order) VALUES(?,?,?,?,NULL,0)')
   .run(item.legacy_variant_id,item.legacy_product_id,item.id,'Artwork');
 }
}

const draft=(title='Draft')=>({
 title,description:'Description',category:'Test',base_price_cents:null,width_eighths:null,height_eighths:null,
 offered_for_sale:false,requested_store_position:null,
 inventory:{quantity_changed:false,intended_available_quantity:null,captured_version:0},photos:[],configurations:[]
});

async function baseline(){const state=d1();seedLegacy(state.sqlite);await reconcileBaseline(state.DB);return state;}

function directPublished(sqlite,n,{price=null,category='Test',available=null,offered=false}={}){
 const tail=String(n).padStart(12,'0'),art=`10000000-0000-5000-8000-${tail}`,rev=`10000000-0000-5001-8000-${tail}`,asset=`10000000-0000-5002-8000-${tail}`,stable=`extra-${String(n).padStart(3,'0')}`;
 const snapshot={...draft('Extra '+n),category,base_price_cents:price,offered_for_sale:offered,photos:[{asset_id:asset,alt:'Photo',position:0,is_main:true}],configurations:[],compliance:{...clearCompliance}};
 sqlite.prepare('INSERT INTO catalog_artworks(id,stable_id) VALUES(?,?)').run(art,stable);
 sqlite.prepare("INSERT INTO catalog_media_assets(id,artwork_id,source_kind,legacy_path,mime_type,state) VALUES(?,?,'legacy_public',?,'image/jpeg','ready')").run(asset,art,'/art-001-1.jpg?fixture='+n);
 sqlite.prepare(`INSERT INTO catalog_artwork_revisions(id,artwork_id,revision_number,source,title,description,category,base_price_cents,offered_for_sale,snapshot_json,content_hash,actor)
  VALUES(?,?,1,'system',?,?,?,?,?,?,?,'test')`).run(rev,art,snapshot.title,snapshot.description,snapshot.category,price,offered?1:0,JSON.stringify(snapshot),'hashhashhashhash'+n);
 sqlite.prepare('INSERT INTO catalog_revision_photos(revision_id,asset_id,position,is_main,alt_text) VALUES(?,?,0,1,?)').run(rev,asset,'Photo');
 sqlite.prepare(`INSERT INTO catalog_revision_disclosures(
  revision_id,object_kind,blessed_or_dedicated,purported_relic,relic_class_claim,contains_human_material,
  provenance_known,ecclesiastical_owner,authenticity_document,spiritual_benefit_priced,seller_attested,actor
 ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  rev,clearCompliance.object_kind,clearCompliance.blessed_or_dedicated,clearCompliance.purported_relic,clearCompliance.relic_class_claim,
  clearCompliance.contains_human_material,clearCompliance.provenance_known,clearCompliance.ecclesiastical_owner,
  clearCompliance.authenticity_document,clearCompliance.spiritual_benefit_priced,1,'test'
 );
 sqlite.prepare('INSERT INTO catalog_artwork_heads(artwork_id,working_revision_id,published_revision_id,last_published_revision_id,working_version) VALUES(?,?,?,?,1)').run(art,rev,rev,rev);
 sqlite.prepare('INSERT INTO catalog_inventory(artwork_id,physical_stock) VALUES(?,?)').run(art,available);
 const position=Number(sqlite.prepare('SELECT coalesce(max(position)+1,0) AS n FROM catalog_store_order').get().n);
 sqlite.prepare('INSERT INTO catalog_store_order(artwork_id,position) VALUES(?,?)').run(art,position);
 if(offered)sqlite.prepare(`INSERT INTO catalog_compliance_assessments(
  id,artwork_id,revision_id,policy_version,decision,source,reason_codes_json,messages_json,citations_json,actor
 ) VALUES(?,?,?,'canonical-listing-v1','allow','deterministic','["seller_disclosures_clear"]','["Allowed"]','[]','test')`)
  .run(`assessment-${tail}`,art,rev);
 return {art,rev,asset,stable};
}

test('baseline reconciles exactly nine public revisions and twelve photos without overwriting private drafts',async()=>{
 const {sqlite,DB}=d1();seedLegacy(sqlite);
 const first=await reconcileBaseline(DB);assert.equal(first.inserted.length,9);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM catalog_artworks').get().n,9);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM catalog_media_assets').get().n,12);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM catalog_revision_photos').get().n,12);
 assert.equal((await listPublicCatalog(DB)).total,9);
 const admin=await listAdminArtworks(DB,{page:1});assert.equal(admin.total,9);assert(admin.items.every(item=>item.state==='published_changes'));
 assert(admin.items.every(item=>item.draft.photos.length===0));
 const second=await reconcileBaseline(DB);assert.equal(second.inserted.length,0);assert.equal(sqlite.prepare('SELECT count(*) n FROM catalog_artworks').get().n,9);
});

test('server pagination produces 10, 10 and 1 for 21 artworks',async()=>{
 const {DB}=await baseline();
 for(let group=0;group<2;group++){
  const count=group?2:10;const items=Array.from({length:count},(_,i)=>({client_id:`client-${group}-${String(i).padStart(3,'0')}`,draft:draft(`New ${group}-${i}`)}));
  const result=await saveDraftBatch(DB,{items},'test');assert(result.results.every(row=>row.success));
 }
 const a=await listAdminArtworks(DB,{page:1}),b=await listAdminArtworks(DB,{page:2}),c=await listAdminArtworks(DB,{page:3});
 assert.deepEqual([a.items.length,b.items.length,c.items.length],[10,10,1]);assert.equal(c.total,21);assert.equal(c.showing_from,21);assert.equal(c.showing_to,21);
});

test('batch saves report independent validation and retry new cards without duplication',async()=>{
 const {sqlite,DB}=await baseline();
 const good={client_id:'client-independent-001',draft:draft('Good')};
 const result=await saveDraftBatch(DB,{items:[good,{client_id:'client-independent-002',draft:draft('x'.repeat(161))}]},'test');
 assert.equal(result.results[0].success,true);assert.equal(result.results[1].success,false);assert(result.results[1].details.fields.title);
 const retry=await saveDraftBatch(DB,{items:[good]},'test');assert.equal(retry.results[0].artwork_id,result.results[0].artwork_id);
 assert.equal(sqlite.prepare("SELECT count(*) n FROM catalog_artworks WHERE client_id='client-independent-001'").get().n,1);
});

test('draft text rejects invisible and bidi controls before revision storage',async()=>{
 const {DB}=await baseline();
 for(const [field,value] of [
  ['title','Holy re\u200blic'],
  ['description','Price includes a bl\u200bessing.'],
  ['category','Devotional\u202e art']
 ]){
  const candidate={...draft('Visible title'),[field]:value};
  assert.throws(()=>validateDraftSnapshot(candidate),(error)=>error.status===400&&Boolean(error.details?.fields?.[field]),field);
  const saved=await saveDraftBatch(DB,{items:[{client_id:`client-control-${field}`,draft:candidate}]},'test');
  assert.equal(saved.results[0].success,false,field);
  assert(saved.results[0].details.fields[field],field);
 }
 assert.throws(()=>validateDraftSnapshot({...draft(),photos:[{asset_id:'asset-photo-1',alt:'Photo\u200b text',position:0,is_main:true}]}),/validation/i);
 assert.throws(()=>validateDraftSnapshot({...draft(),configurations:[{id:'configuration-1',label:'Artwork\u2066 label',enabled:true,price_add_on_cents:0,packing_profile_id:null}]}),/validation/i);
 const normalized=validateDraftSnapshot({...draft('\uff2e\uff59\uff41\uff48'),description:'Description'});
 assert.equal(normalized.title,'Nyah');
});

test('draft revisions persist normalized immutable disclosures and hydrate exact-revision copilot state',async()=>{
 const {sqlite,DB}=await baseline();let item=await getAdminArtwork(DB,'art-001');
 assert.deepEqual(item.draft.compliance,{
  object_kind:'unknown',blessed_or_dedicated:'unknown',purported_relic:'unknown',relic_class_claim:null,
  contains_human_material:'unknown',provenance_known:'unknown',ecclesiastical_owner:'unknown',
  authenticity_document:'unknown',spiritual_benefit_priced:'unknown',seller_attested:false
 });
 const saved=await saveDraftBatch(DB,{items:[{id:item.id,expected_version:item.version,draft:{...item.draft,compliance:{...clearCompliance}}}]},'test');
 assert(saved.results[0].success);item=await getAdminArtwork(DB,item.id);
 assert.deepEqual(item.draft.compliance,clearCompliance);
 assert.equal(sqlite.prepare('SELECT object_kind FROM catalog_revision_disclosures WHERE revision_id=?').get(item.working_revision_id).object_kind,'ordinary_devotional');
 const publicAsset=sqlite.prepare('SELECT asset_id FROM catalog_revision_photos WHERE revision_id=? ORDER BY position LIMIT 1').get(item.published_revision_id).asset_id;
 await saveAiSuggestion(DB,{
  artworkId:item.id,revisionId:item.working_revision_id,assetId:publicAsset,promptVersion:'listing-copilot-v1',model:'test/vision',
  suggestions:{title:'Suggested devotional title',description:'Visible painted details.',category:'Devotional',visible_condition:'No obvious damage.',alt_texts:[{asset_id:publicAsset,alt:'Painted devotional artwork.'}]},
  observations:[],uncertainties:['Reverse is not visible.']
 },'test');
 item=await getAdminArtwork(DB,item.id);
 assert.equal(item.ai_suggestion.title,'Suggested devotional title');
 assert.deepEqual(item.ai_suggestion.uncertainties,['Reverse is not visible.']);
 assert.throws(()=>sqlite.prepare("UPDATE catalog_revision_disclosures SET object_kind='relic' WHERE revision_id=?").run(item.working_revision_id),/DISCLOSURE_IMMUTABLE/);
});

test('draft saves preserve public content and exact money, eighths, nulls and intentional zero',async()=>{
 const {DB}=await baseline();const before=await getPublicArtwork(DB,'art-001');
 const item=await getAdminArtwork(DB,'art-001');
 const changed={...item.draft,title:'Private changed title',base_price_cents:12345,width_eighths:99,height_eighths:100,inventory:{quantity_changed:true,intended_available_quantity:0,captured_version:item.inventory.version}};
 const save=await saveDraftBatch(DB,{items:[{id:'art-001',expected_version:item.version,draft:changed}]},'test');assert.equal(save.results[0].success,true);
 const after=await getAdminArtwork(DB,'art-001');assert.equal(after.draft.base_price_cents,12345);assert.equal(after.draft.width_eighths,99);assert.equal(after.draft.height_eighths,100);assert.equal(after.draft.inventory.intended_available_quantity,0);
 assert.equal((await getPublicArtwork(DB,'art-001')).title,before.title);
 const empty=validateDraftSnapshot(draft());assert.equal(empty.base_price_cents,null);assert.equal(empty.width_eighths,null);
});

test('display publication, archive and restore preserve revision history',async()=>{
 const {sqlite,DB}=await baseline();let item=await getAdminArtwork(DB,'art-001');
 const publicPhoto=sqlite.prepare("SELECT asset_id FROM catalog_revision_photos WHERE revision_id=? ORDER BY position").get(item.published_revision_id).asset_id;
 const next={...item.draft,title:'Published changed title',photos:[{asset_id:publicPhoto,alt:'Main',position:0,is_main:true}]};
 const saved=await saveDraftBatch(DB,{items:[{id:item.id,expected_version:item.version,draft:next}]},'test');assert(saved.results[0].success);
 item=await getAdminArtwork(DB,item.id);await publishArtwork(DB,item.id,{expected_version:item.version},'test');
 assert.equal((await getPublicArtwork(DB,'art-001')).title,'Published changed title');
 item=await getAdminArtwork(DB,item.id);assert.equal(item.state,'published');
 await archiveArtwork(DB,item.id,item.version,'test');assert.equal((await getAdminArtwork(DB,item.id)).state,'archived');await assert.rejects(()=>getPublicArtwork(DB,'art-001'),/not found/i);
 await restoreArtwork(DB,item.id,item.version,'test');assert.equal((await getAdminArtwork(DB,item.id)).state,'draft');
 assert(sqlite.prepare('SELECT count(*) n FROM catalog_artwork_revisions WHERE artwork_id=?').get(item.id).n>=3);
});

test('global order moves position 21 to 1 without duplicates or losses',async()=>{
 const {sqlite,DB}=await baseline();let last;for(let i=10;i<=21;i++)last=directPublished(sqlite,i);
 const before=await listPublicCatalog(DB,{page_size:48});assert.equal(before.total,21);const state=sqlite.prepare('SELECT version FROM catalog_store_order_state WHERE id=1').get().version;
 await saveStoreOrder(DB,{expected_version:state,moves:[{artwork_id:last.stable,to_position:1}]},'test');
 const rows=sqlite.prepare('SELECT artwork_id,position FROM catalog_store_order ORDER BY position,artwork_id').all();assert.equal(rows.length,21);assert.equal(new Set(rows.map(row=>row.artwork_id)).size,21);assert.equal(rows[0].artwork_id,last.art);
 await assert.rejects(()=>saveStoreOrder(DB,{expected_version:state,moves:[{artwork_id:last.stable,to_position:2}]},'test'),/order conflict/i);
});

test('photo limits/main selection and failed replacement leave the saved photo intact',async()=>{
 assert.throws(()=>validateDraftSnapshot({...draft(),photos:Array.from({length:5},(_,i)=>({asset_id:`asset-photo-${i}`,alt:'',position:i,is_main:i===0}))}),/validation/i);
 assert.throws(()=>validateDraftSnapshot({...draft(),photos:[{asset_id:'asset-photo-1',alt:'',position:0,is_main:false}]}),/validation/i);
 const {sqlite,DB}=await baseline();let item=await getAdminArtwork(DB,'art-001');
 let allocation=await allocateUpload(DB,{artwork_id:item.id,expected_version:item.version,idempotency_key:'upload-add-0001'});
 const webp=Uint8Array.from([0x52,0x49,0x46,0x46,0,0,0,0,0x57,0x45,0x42,0x50]);
 const processed={input:{mime:'image/heic',width:1,height:1,bytes:12},checksum:'1234567890abcdef',objects:['master','display','thumbnail'].map(role=>({role,contentType:'image/webp',bytes:webp}))};
 const added=await commitSuccessfulUpload(DB,allocation.upload_id,processed,'test');item=await getAdminArtwork(DB,item.id);assert.equal(item.draft.photos.length,1);assert.equal(item.draft.photos[0].asset_id,added.asset_id);
 assert.equal(sqlite.prepare('SELECT mime_type FROM catalog_media_assets WHERE id=?').get(added.asset_id).mime_type,'image/webp');
 assert.deepEqual(sqlite.prepare('SELECT DISTINCT content_type FROM catalog_media_objects WHERE asset_id=?').all(added.asset_id).map(row=>row.content_type),['image/webp']);
 allocation=await allocateUpload(DB,{artwork_id:item.id,expected_version:item.version,idempotency_key:'upload-replace-0001',replace_asset_id:added.asset_id});
 await assert.rejects(()=>commitSuccessfulUpload(DB,allocation.upload_id,{...processed,objects:processed.objects.slice(0,2)},'test'),/incomplete/i);
 assert.equal((await getAdminArtwork(DB,item.id)).draft.photos[0].asset_id,added.asset_id);
 const replaced=await commitSuccessfulUpload(DB,allocation.upload_id,processed,'test');assert.notEqual(replaced.asset_id,added.asset_id);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM catalog_revision_photos WHERE asset_id=?').get(added.asset_id).n,1);
});

test('public catalog filters and price sorts keep unpriced art last in both directions',async()=>{
 const {sqlite,DB}=await baseline();directPublished(sqlite,10,{price:2000,category:'Sale',available:2,offered:true});directPublished(sqlite,11,{price:1000,category:'Sale',available:0,offered:true});
 const asc=await listPublicCatalog(DB,{sort:'price_asc',page_size:48});const desc=await listPublicCatalog(DB,{sort:'price_desc',page_size:48});
 assert.deepEqual(asc.items.slice(0,2).map(item=>item.base_price_cents),[1000,2000]);assert.deepEqual(desc.items.slice(0,2).map(item=>item.base_price_cents),[2000,1000]);assert.equal(asc.items.at(-1).base_price_cents,null);assert.equal(desc.items.at(-1).base_price_cents,null);
 const stock=await listPublicCatalog(DB,{availability:'in_stock',category:'Sale'});assert.equal(stock.total,1);assert.equal(stock.items[0].available_quantity,2);
 const sold=await listPublicCatalog(DB,{availability:'sold_out'});assert.equal(sold.total,1);assert.equal(sold.items[0].sold_out,true);
});

test('sale publication requires exact-revision approval and a later pending assessment withdraws the public offer',async()=>{
 const {sqlite,DB}=await baseline();let item=await getAdminArtwork(DB,'art-001');
 const publicAsset=sqlite.prepare('SELECT asset_id FROM catalog_revision_photos WHERE revision_id=? ORDER BY position LIMIT 1').get(item.published_revision_id).asset_id;
 sqlite.prepare(`INSERT INTO catalog_packing_profiles(id,label,length_value,width_value,height_value,dimension_unit,weight_value,weight_unit)
  VALUES('packing-allow-01','Standard',10,10,10,'in',16,'oz')`).run();
 const saleDraft={...item.draft,title:'Approved devotional artwork',base_price_cents:2500,width_eighths:80,height_eighths:64,offered_for_sale:true,
  inventory:{quantity_changed:true,intended_available_quantity:1,captured_version:item.inventory.version},
  photos:[{asset_id:publicAsset,alt:'Main photo',position:0,is_main:true}],compliance:{...clearCompliance},
  configurations:[{id:'config-allow-001',label:'Artwork',enabled:true,price_add_on_cents:0,packing_profile_id:'packing-allow-01'}]};
 const saved=await saveDraftBatch(DB,{items:[{id:item.id,expected_version:item.version,draft:saleDraft}]},'test');assert(saved.results[0].success);
 item=await getAdminArtwork(DB,item.id);
 await assert.rejects(()=>publishArtwork(DB,item.id,{expected_version:item.version},'test'),error=>Boolean(error.details?.fields?.compliance));
 const assessment=await runDeterministicAssessment(DB,{
  artwork_id:item.id,revision_id:item.working_revision_id,offered_for_sale:true,disclosures:item.draft.compliance
 },'test');
 assert.equal(assessment.effective_decision,'allow');
 item=await getAdminArtwork(DB,item.id);assert.equal(item.compliance_assessment.effective_decision,'allow');
 await publishArtwork(DB,item.id,{expected_version:item.version},'test');
 assert.equal((await getPublicArtwork(DB,'art-001')).offered_for_sale,true);
 assert.equal((await listPublicCatalog(DB,{availability:'in_stock'})).items.some(row=>row.id==='art-001'),true);
 await saveAssessment(DB,{
  artwork_id:item.id,revision_id:item.working_revision_id,policy_version:'canonical-listing-v1',decision:'pending',source:'ai_assisted',
  reason_codes:['analysis_pending'],messages:['Review pending.'],citations:[]
 },'test');
 const held=await getPublicArtwork(DB,'art-001');
 assert.equal(held.offered_for_sale,false);assert.equal(held.base_price_cents,null);assert.equal(held.available_quantity,null);
 assert.equal((await listPublicCatalog(DB,{availability:'in_stock'})).items.some(row=>row.id==='art-001'),false);
 assert.equal((await listPublicCatalog(DB,{availability:'display_only',page_size:48})).items.some(row=>row.id==='art-001'),true);
});

