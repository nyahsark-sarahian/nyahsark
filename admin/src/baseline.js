const uuid=(family,n)=>`00000000-0000-${family}-8000-${String(n).padStart(12,'0')}`;

const source=[
 ['art-001','Devotional art','Praying figure with golden rays','A veiled figure with joined hands, a green cloak, gold-colored rays and floral accents, with reflective embellishments.',[['/art-001-1.jpg','Praying figure with golden rays, view 1']]],
 ['art-002','Devotional art','Jesus with outstretched arms','A figure of Jesus with outstretched arms, red and pale robes, and glowing clouds, depicted in rows of reflective round elements.',[['/art-002-1.jpg','Jesus with outstretched arms, view 1'],['/art-002-2.jpg','Jesus with outstretched arms, view 2']]],
 ['art-003','Devotional art','St. Mother Teresa in Prayer','A diamond mosaic of Saint Teresa of Calcutta in prayer, her hands clasped beneath the blue-trimmed white sari of the Missionaries of Charity. The design calls for nearly 80,000 square drills.',[['/art-003-1.jpg','St. Mother Teresa in Prayer, view 1']]],
 ['art-004','Devotional art','Haloed figure with two angels','A central haloed figure in red and blue with two smaller winged figures, depicted in a mosaic-like surface.',[['/art-004-1.jpg','Haloed figure with two angels, view 1'],['/art-004-2.jpg','Haloed figure with two angels, view 2'],['/art-004-3.jpg','Haloed figure with two angels, view 3']]],
 ['art-005','Devotional art','Praying figure with a crown of thorns','A bowed figure with joined hands, a crown of thorns, pale and blue clothing, and a reflective mosaic-like surface.',[['/art-005-1.jpg','Praying figure with a crown of thorns, view 1']]],
 ['art-006','Decorative art','Floral skull','A pale skull surrounded by red, orange, blue and white flowers with green foliage.',[['/art-006-1.jpg','Floral skull, view 1']]],
 ['art-007','Decorative art','Coastal skull with blue flowers','A pale skull with large blue flowers and smaller pale blooms beneath a beach and ocean scene.',[['/art-007-1.jpg','Coastal skull with blue flowers, view 1']]],
 ['art-008','Decorative art','Black cat beneath a starry sky','A black cat against a swirling blue sky with yellow stars and a crescent moon.',[['/art-008-1.jpg','Black cat beneath a starry sky, view 1']]],
 ['art-009','Devotional art','Veiled figure with a radiant heart','A diamond mosaic of a veiled figure with a golden halo and a red heart motif.',[['/art-009-1.jpg','Diamond mosaic of a veiled figure with a golden halo and a red heart']]],
];

let assetSequence=0;
export const LEGACY_BASELINE=Object.freeze(source.map(([stableId,category,title,description,photos],index)=>Object.freeze({
 id:stableId,
 artwork_id:uuid('5000',index+1),
 legacy_product_id:uuid('4000',index+1),
 legacy_variant_id:uuid('4001',index+1),
 published_revision_id:uuid('5001',index+1),
 private_revision_id:uuid('5003',index+1),
 display_order:index,
 category,title,description,
 photos:Object.freeze(photos.map(([path,alt],position)=>Object.freeze({
  asset_id:uuid('5002',++assetSequence),path,alt,position,is_main:position===0,
 }))),
})));

export function publishedSnapshot(item){
 return {
  title:item.title,description:item.description,category:item.category,
  base_price_cents:null,width_eighths:null,height_eighths:null,
  offered_for_sale:false,requested_store_position:item.display_order+1,
  inventory:{quantity_changed:false,intended_available_quantity:null,captured_version:0},
  photos:item.photos.map(p=>({asset_id:p.asset_id,alt:p.alt,position:p.position,is_main:p.is_main})),
  configurations:[],
 };
}

export function privateSnapshot(item,legacyProduct){
 const variants=Array.isArray(legacyProduct?.variants)?legacyProduct.variants:[];
 return {
  title:legacyProduct?.title??item.title,
  description:legacyProduct?.description??item.description,
  category:item.category,
  base_price_cents:variants.length===1?variants[0].price_cents??null:null,
  width_eighths:null,height_eighths:null,offered_for_sale:false,
  requested_store_position:null,
  inventory:{quantity_changed:false,intended_available_quantity:legacyProduct?.stock??null,captured_version:0},
  photos:[],
  configurations:variants.map((v,position)=>({
   id:v.id||item.legacy_variant_id,label:v.label||'Artwork',enabled:true,
   price_add_on_cents:0,packing_profile_id:null,position,
  })),
 };
}

// Produces deterministic, rerunnable reconciliation input. The persistence layer
// must insert by stable_id/import_key and treat conflicts as reviewable evidence;
// it must never overwrite an existing working head.
export function buildBaselineReconciliation({legacyProducts=[],existingStableIds=[]}={}){
 const legacyById=new Map(legacyProducts.map(p=>[p.id,p]));
 const existing=new Set(existingStableIds);
 const insert=[],skip=[];
 for(const item of LEGACY_BASELINE){
  if(existing.has(item.id)){skip.push({stable_id:item.id,reason:'already_present'});continue;}
  const legacy=legacyById.get(item.legacy_product_id);
  insert.push({
   artwork:{id:item.artwork_id,stable_id:item.id,legacy_product_id:item.legacy_product_id},
   published:{id:item.published_revision_id,import_key:'legacy-public-v1',revision_number:1,snapshot:publishedSnapshot(item)},
   working:{id:item.private_revision_id,import_key:'legacy-private-v1',revision_number:2,snapshot:privateSnapshot(item,legacy)},
   inventory:{physical_stock:legacy?.stock??null,reserved_stock:0,version:0},
   store_position:item.display_order,
   assets:item.photos.map(p=>({...p,source_kind:'legacy_public',mime_type:'image/jpeg'})),
  });
 }
 return {insert,skip};
}
