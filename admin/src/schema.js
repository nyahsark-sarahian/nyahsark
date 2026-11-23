let readiness;
let readinessLevel = 0;

export function d1MigrationScript(sql) {
  if (typeof sql !== 'string') throw Error('Migration SQL is required');
  const statements = [];
  let current = [];
  let trigger = false;
  for (const rawLine of sql.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!current.length) trigger = /^CREATE\s+TRIGGER\b/i.test(line);
    current.push(line);
    const complete = trigger
      ? (/^END;$/i.test(line) || /\bBEGIN\b.*\bEND;\s*$/i.test(line))
      : /;\s*$/.test(line);
    if (complete) {
      statements.push(current.join(' '));
      current = [];
      trigger = false;
    }
  }
  if (current.length) throw Error('Migration contains an incomplete statement');
  return statements.join('\n');
}

async function hasObjects(database, type, names) {
  if (!names.length) return true;
  try {
    const placeholders = names.map(() => '?').join(',');
    const row = await database.prepare(
      `SELECT count(*) AS object_count FROM sqlite_master WHERE type=? AND name IN (${placeholders})`
    ).bind(type, ...names).first();
    return Number(row?.object_count) === names.length;
  } catch {
    return false;
  }
}

async function schemaReady(database, objects) {
  const states = await Promise.all(Object.entries(objects).map(([type, names]) => hasObjects(database, type, names)));
  return states.every(Boolean);
}

const coreObjects = {
  table: [
    'catalog_artworks','catalog_legacy_artwork_links','catalog_artwork_revisions','catalog_artwork_heads',
    'catalog_media_assets','catalog_media_objects','catalog_revision_photos','catalog_store_settings',
    'catalog_packing_profiles','catalog_configurations','catalog_revision_configurations','catalog_inventory',
    'catalog_store_order_state','catalog_store_order','catalog_shipping_services','catalog_supported_destinations',
    'catalog_fulfillment_methods','catalog_upload_sessions','catalog_idempotency_records','catalog_quotes',
    'catalog_quote_lines','catalog_orders','catalog_order_lines','catalog_inventory_reservations',
    'catalog_payment_attempts','catalog_payment_events','catalog_audit_events','catalog_publish_commands',
    'catalog_archive_commands','catalog_restore_commands','catalog_order_commands'
  ],
  trigger: [
    'catalog_revision_cas','catalog_revision_immutable_update','catalog_revision_immutable_delete',
    'catalog_photo_cap','catalog_photo_asset_owner','catalog_photo_head_immutable_insert',
    'catalog_photo_head_immutable_update','catalog_photo_head_immutable_delete','catalog_configuration_owner',
    'catalog_configuration_head_immutable_insert','catalog_configuration_immutable_update',
    'catalog_configuration_immutable_delete','catalog_media_object_immutable_update',
    'catalog_media_object_referenced_delete','catalog_publish_guard','catalog_publish_apply',
    'catalog_archive_guard','catalog_archive_apply','catalog_restore_guard','catalog_restore_apply',
    'catalog_order_guard','catalog_order_apply','catalog_reservation_guard','catalog_reservation_apply',
    'catalog_reservation_transition_guard','catalog_reservation_release','catalog_reservation_commit'
  ],
  index: [
    'catalog_revisions_artwork','catalog_revisions_title','catalog_heads_public','catalog_media_artwork',
    'catalog_revision_one_main','catalog_revision_photos_asset','catalog_store_order_position','catalog_upload_expiry','catalog_quotes_expiry',
    'catalog_reservations_expiry','catalog_audit_artwork'
  ]
};
const commandObjects = {
  table: ['catalog_settings_commands'],
  trigger: ['catalog_settings_guard','catalog_settings_apply'],
  index: []
};
const complianceObjects = {
  table: [
    'catalog_policy_versions','catalog_revision_disclosures','catalog_asset_observations',
    'catalog_compliance_assessments','catalog_review_decisions','catalog_ai_suggestions'
  ],
  trigger: [
    'catalog_disclosure_owner','catalog_disclosure_head_immutable_insert','catalog_disclosure_immutable_update',
    'catalog_disclosure_immutable_delete','catalog_observation_owner','catalog_observation_immutable_update',
    'catalog_observation_immutable_delete','catalog_assessment_owner','catalog_assessment_active_policy_guard','catalog_assessment_immutable_update',
    'catalog_assessment_immutable_delete','catalog_review_approve_guard','catalog_review_active_policy_guard','catalog_review_latest_guard','catalog_review_immutable_update',
    'catalog_review_immutable_delete','catalog_suggestion_owner','catalog_suggestion_immutable_update',
    'catalog_suggestion_immutable_delete','catalog_compliance_publish_guard',
    'catalog_quote_line_compliance_guard','catalog_order_line_compliance_guard',
    'catalog_reservation_compliance_guard','catalog_order_payment_compliance_guard',
    'catalog_payment_session_compliance_guard','catalog_order_payment_state_guard'
  ],
  index: [
    'catalog_asset_observations_lookup','catalog_compliance_revision','catalog_compliance_artwork',
    'catalog_review_assessment','catalog_ai_suggestions_revision'
  ],
  view: ['catalog_compliance_effective']
};
const governanceObjects = {
  table: [
    'catalog_ai_budget_months','catalog_ai_inference_ledger','catalog_listing_price_floors',
    'catalog_review_escalations'
  ],
  trigger: [
    'catalog_ai_reservation_state_guard','catalog_ai_reservation_month_guard','catalog_ai_reservation_action_guard',
    'catalog_ai_reservation_image_cap_guard','catalog_ai_reservation_budget_guard','catalog_ai_reservation_apply',
    'catalog_ai_reconcile_guard','catalog_ai_reconcile_apply','catalog_ai_inference_delete_guard',
    'catalog_listing_price_floor_immutable_update','catalog_listing_price_floor_immutable_delete',
    'catalog_review_escalation_owner','catalog_review_escalation_active_policy_guard',
    'catalog_review_escalation_latest_guard','catalog_review_escalation_unresolved_guard',
    'catalog_review_escalation_seller_clearance_guard',
    'catalog_review_escalation_terminal_guard','catalog_review_escalation_sequence_guard',
    'catalog_review_escalation_immutable_update','catalog_review_escalation_immutable_delete',
    'catalog_review_consultation_guard'
  ],
  index: [
    'catalog_ai_inference_month','catalog_ai_inference_state','catalog_listing_price_floor_lookup',
    'catalog_review_escalation_assessment'
  ]
};

async function applyIfMissing(database, objects, sql) {
  if (await schemaReady(database, objects)) return;
  if (typeof database.exec !== 'function' || typeof sql !== 'string' || !sql.trim()) throw Error('Catalog migration is required');
  try {
    await database.exec(d1MigrationScript(sql));
  } catch (error) {
    // Concurrent cold starts can both observe an absent schema. Treat the
    // second create attempt as successful only after every required object is
    // independently visible; partial migrations still fail closed.
    if (!(await schemaReady(database, objects))) throw error;
  }
  if (!(await schemaReady(database, objects))) throw Error('Catalog migration did not complete');
}

export function ensureSchema(database, revisionedSchema, commandSchema = '', complianceSchema = '', governanceSchema = '') {
  const requestedLevel = governanceSchema.trim() ? 4 : complianceSchema.trim() ? 3 : commandSchema.trim() ? 2 : 1;
  if (!readiness || readinessLevel < requestedLevel) {
    readinessLevel = requestedLevel;
    readiness = (async () => {
      await applyIfMissing(database, coreObjects, revisionedSchema);
      await applyIfMissing(database, commandObjects, commandSchema);
      if (complianceSchema.trim()) await applyIfMissing(database, complianceObjects, complianceSchema);
      if (governanceSchema.trim()) await applyIfMissing(database, governanceObjects, governanceSchema);
    })().catch((error) => {
      readiness = undefined;
      readinessLevel = 0;
      throw error;
    });
  }
  return readiness;
}

export function resetSchemaReadinessForTest() {
  readiness = undefined;
  readinessLevel = 0;
}

