CREATE TABLE IF NOT EXISTS catalog_policy_versions(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 80),
 status TEXT NOT NULL CHECK(status IN ('draft','active','retired')),
 rules_json TEXT NOT NULL CHECK(json_valid(rules_json) AND json_type(rules_json)='object'),
 citations_json TEXT NOT NULL CHECK(json_valid(citations_json) AND json_type(citations_json)='array'),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 160),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 activated_at INTEGER
);

INSERT OR IGNORE INTO catalog_policy_versions(id,status,rules_json,citations_json,actor,activated_at)
VALUES(
 'canonical-listing-v1',
 'active',
 json_object(
  'hard_blocks',json_array('sacred_relic_sale','spiritual_benefit_sale'),
  'human_review',json_array('possible_human_material','possible_reliquary','blessed_or_dedicated','ecclesiastical_ownership','missing_disclosure'),
  'photo_limit','Photographs provide observations only and cannot establish blessing, authenticity, provenance, ownership, or canonical permission.'
 ),
 json_array(
  json_object('code','canon_1190_1','label','Code of Canon Law, Canon 1190 §1','url','https://www.vatican.va/archive/cod-iuris-canonici/eng/documents/cic_lib4-cann1166-1190_en.html'),
  json_object('code','canon_1171','label','Code of Canon Law, Canon 1171','url','https://www.vatican.va/archive/cod-iuris-canonici/eng/documents/cic_lib4-cann1166-1190_en.html'),
  json_object('code','relics_instruction_25','label','Relics in the Church: Authenticity and Conservation, Article 25','url','https://www.vatican.va/roman_curia/congregations/csaints/documents/rc_con_csaints_doc_20171208_istruzione-reliquie_en.html'),
  json_object('code','ccc_2121','label','Catechism of the Catholic Church, 2121','url','https://www.vatican.va/content/catechism/en/part_three/section_two/chapter_one/article_1/iii_you_shall_have_no_other_gods_before_me.html')
 ),
 'system:policy-seed',
 unixepoch()
);

CREATE TABLE IF NOT EXISTS catalog_revision_disclosures(
 revision_id TEXT PRIMARY KEY REFERENCES catalog_artwork_revisions(id) ON DELETE RESTRICT,
 object_kind TEXT NOT NULL DEFAULT 'unknown' CHECK(object_kind IN ('unknown','ordinary_devotional','sacramental','sacred_object','relic','other')),
 blessed_or_dedicated TEXT NOT NULL DEFAULT 'unknown' CHECK(blessed_or_dedicated IN ('unknown','yes','no')),
 purported_relic TEXT NOT NULL DEFAULT 'unknown' CHECK(purported_relic IN ('unknown','yes','no')),
 relic_class_claim TEXT CHECK(relic_class_claim IS NULL OR length(relic_class_claim)<=160),
 contains_human_material TEXT NOT NULL DEFAULT 'unknown' CHECK(contains_human_material IN ('unknown','yes','no')),
 provenance_known TEXT NOT NULL DEFAULT 'unknown' CHECK(provenance_known IN ('unknown','yes','no')),
 ecclesiastical_owner TEXT NOT NULL DEFAULT 'unknown' CHECK(ecclesiastical_owner IN ('unknown','yes','no')),
 authenticity_document TEXT NOT NULL DEFAULT 'unknown' CHECK(authenticity_document IN ('unknown','yes','no')),
 spiritual_benefit_priced TEXT NOT NULL DEFAULT 'unknown' CHECK(spiritual_benefit_priced IN ('unknown','yes','no')),
 seller_attested INTEGER NOT NULL DEFAULT 0 CHECK(seller_attested IN (0,1)),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 160),
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);

CREATE TABLE IF NOT EXISTS catalog_asset_observations(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 asset_id TEXT NOT NULL REFERENCES catalog_media_assets(id) ON DELETE RESTRICT,
 asset_checksum TEXT NOT NULL CHECK(length(asset_checksum) BETWEEN 16 AND 128),
 state TEXT NOT NULL CHECK(state IN ('pending','completed','error')),
 model_id TEXT NOT NULL CHECK(length(model_id) BETWEEN 1 AND 200),
 prompt_version TEXT NOT NULL CHECK(length(prompt_version) BETWEEN 1 AND 80),
 observation_json TEXT NOT NULL CHECK(json_valid(observation_json) AND json_type(observation_json)='object'),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code)<=120),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 160),
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX IF NOT EXISTS catalog_asset_observations_lookup ON catalog_asset_observations(asset_id,asset_checksum,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS catalog_compliance_assessments(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 artwork_id TEXT NOT NULL REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 revision_id TEXT NOT NULL REFERENCES catalog_artwork_revisions(id) ON DELETE RESTRICT,
 policy_version TEXT NOT NULL REFERENCES catalog_policy_versions(id) ON DELETE RESTRICT,
 decision TEXT NOT NULL CHECK(decision IN ('pending','allow','review','block','error')),
 source TEXT NOT NULL CHECK(source IN ('deterministic','ai_assisted','manual')),
 disclosure_hash TEXT CHECK(disclosure_hash IS NULL OR length(disclosure_hash) BETWEEN 16 AND 128),
 observation_set_hash TEXT CHECK(observation_set_hash IS NULL OR length(observation_set_hash) BETWEEN 16 AND 128),
 reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json) AND json_type(reason_codes_json)='array'),
 messages_json TEXT NOT NULL CHECK(json_valid(messages_json) AND json_type(messages_json)='array'),
 citations_json TEXT NOT NULL CHECK(json_valid(citations_json) AND json_type(citations_json)='array'),
 model_id TEXT CHECK(model_id IS NULL OR length(model_id)<=200),
 prompt_version TEXT CHECK(prompt_version IS NULL OR length(prompt_version)<=80),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 160),
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX IF NOT EXISTS catalog_compliance_revision ON catalog_compliance_assessments(revision_id,policy_version,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS catalog_compliance_artwork ON catalog_compliance_assessments(artwork_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS catalog_review_decisions(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 assessment_id TEXT NOT NULL REFERENCES catalog_compliance_assessments(id) ON DELETE RESTRICT,
 decision TEXT NOT NULL CHECK(decision IN ('approve','block','request_information')),
 note TEXT NOT NULL CHECK(length(trim(note)) BETWEEN 8 AND 4000),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 160),
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX IF NOT EXISTS catalog_review_assessment ON catalog_review_decisions(assessment_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS catalog_ai_suggestions(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 artwork_id TEXT NOT NULL REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 revision_id TEXT NOT NULL REFERENCES catalog_artwork_revisions(id) ON DELETE RESTRICT,
 content_hash TEXT NOT NULL CHECK(length(content_hash) BETWEEN 16 AND 128),
 state TEXT NOT NULL CHECK(state IN ('completed','error')),
 model_id TEXT NOT NULL CHECK(length(model_id) BETWEEN 1 AND 200),
 prompt_version TEXT NOT NULL CHECK(length(prompt_version) BETWEEN 1 AND 80),
 suggestion_json TEXT NOT NULL CHECK(json_valid(suggestion_json) AND json_type(suggestion_json)='object'),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='object'),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code)<=120),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 160),
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX IF NOT EXISTS catalog_ai_suggestions_revision ON catalog_ai_suggestions(revision_id,created_at DESC,id DESC);

CREATE TRIGGER IF NOT EXISTS catalog_disclosure_owner BEFORE INSERT ON catalog_revision_disclosures
WHEN NOT EXISTS(SELECT 1 FROM catalog_artwork_revisions WHERE id=NEW.revision_id)
BEGIN SELECT RAISE(ABORT,'DISCLOSURE_REVISION_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS catalog_disclosure_head_immutable_insert BEFORE INSERT ON catalog_revision_disclosures
WHEN EXISTS(SELECT 1 FROM catalog_artwork_heads WHERE working_revision_id=NEW.revision_id OR published_revision_id=NEW.revision_id OR last_published_revision_id=NEW.revision_id)
BEGIN SELECT RAISE(ABORT,'REVISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_disclosure_immutable_update BEFORE UPDATE ON catalog_revision_disclosures BEGIN SELECT RAISE(ABORT,'DISCLOSURE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_disclosure_immutable_delete BEFORE DELETE ON catalog_revision_disclosures BEGIN SELECT RAISE(ABORT,'DISCLOSURE_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS catalog_observation_owner BEFORE INSERT ON catalog_asset_observations
WHEN NOT EXISTS(
 SELECT 1 FROM catalog_media_assets
 WHERE id=NEW.asset_id AND (checksum=NEW.asset_checksum OR (source_kind='legacy_public' AND checksum IS NULL))
)
BEGIN SELECT RAISE(ABORT,'OBSERVATION_ASSET_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS catalog_observation_immutable_update BEFORE UPDATE ON catalog_asset_observations BEGIN SELECT RAISE(ABORT,'OBSERVATION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_observation_immutable_delete BEFORE DELETE ON catalog_asset_observations BEGIN SELECT RAISE(ABORT,'OBSERVATION_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS catalog_assessment_owner BEFORE INSERT ON catalog_compliance_assessments
WHEN NOT EXISTS(SELECT 1 FROM catalog_artwork_revisions WHERE id=NEW.revision_id AND artwork_id=NEW.artwork_id)
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_REVISION_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS catalog_assessment_active_policy_guard BEFORE INSERT ON catalog_compliance_assessments
WHEN NEW.policy_version<>coalesce((
 SELECT id FROM catalog_policy_versions WHERE status='active'
 ORDER BY activated_at DESC,id DESC LIMIT 1
),'')
BEGIN SELECT RAISE(ABORT,'POLICY_CHANGED'); END;
CREATE TRIGGER IF NOT EXISTS catalog_assessment_immutable_update BEFORE UPDATE ON catalog_compliance_assessments BEGIN SELECT RAISE(ABORT,'ASSESSMENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_assessment_immutable_delete BEFORE DELETE ON catalog_compliance_assessments BEGIN SELECT RAISE(ABORT,'ASSESSMENT_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS catalog_review_approve_guard BEFORE INSERT ON catalog_review_decisions
WHEN NEW.decision='approve' AND coalesce((SELECT decision FROM catalog_compliance_assessments WHERE id=NEW.assessment_id),'')<>'review'
BEGIN SELECT RAISE(ABORT,'COMPLIANCE_REVIEW_NOT_APPROVABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_active_policy_guard BEFORE INSERT ON catalog_review_decisions
WHEN (SELECT policy_version FROM catalog_compliance_assessments WHERE id=NEW.assessment_id)<>coalesce((
 SELECT id FROM catalog_policy_versions WHERE status='active'
 ORDER BY activated_at DESC,id DESC LIMIT 1
),'')
BEGIN SELECT RAISE(ABORT,'POLICY_CHANGED'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_latest_guard BEFORE INSERT ON catalog_review_decisions
WHEN EXISTS(
 SELECT 1 FROM catalog_compliance_assessments target
 WHERE target.id=NEW.assessment_id
  AND target.id<>(
   SELECT latest.id FROM catalog_compliance_assessments latest
   WHERE latest.revision_id=target.revision_id AND latest.policy_version=target.policy_version
   ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1
  )
)
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_SUPERSEDED'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_immutable_update BEFORE UPDATE ON catalog_review_decisions BEGIN SELECT RAISE(ABORT,'REVIEW_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_immutable_delete BEFORE DELETE ON catalog_review_decisions BEGIN SELECT RAISE(ABORT,'REVIEW_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS catalog_suggestion_owner BEFORE INSERT ON catalog_ai_suggestions
WHEN NOT EXISTS(SELECT 1 FROM catalog_artwork_revisions WHERE id=NEW.revision_id AND artwork_id=NEW.artwork_id AND content_hash=NEW.content_hash)
BEGIN SELECT RAISE(ABORT,'SUGGESTION_REVISION_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS catalog_suggestion_immutable_update BEFORE UPDATE ON catalog_ai_suggestions BEGIN SELECT RAISE(ABORT,'SUGGESTION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_suggestion_immutable_delete BEFORE DELETE ON catalog_ai_suggestions BEGIN SELECT RAISE(ABORT,'SUGGESTION_IMMUTABLE'); END;

CREATE VIEW IF NOT EXISTS catalog_compliance_effective AS
SELECT a.*,
 CASE
  WHEN a.decision='block' THEN 'block'
  ELSE CASE coalesce((
   SELECT d.decision FROM catalog_review_decisions d
   WHERE d.assessment_id=a.id ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1
  ),'')
   WHEN 'approve' THEN CASE WHEN a.decision='review' THEN 'human_approved' ELSE a.decision END
   WHEN 'block' THEN 'human_blocked'
   WHEN 'request_information' THEN 'request_information'
   ELSE a.decision
  END
 END AS effective_decision
FROM catalog_compliance_assessments a;

CREATE TRIGGER IF NOT EXISTS catalog_compliance_publish_guard BEFORE INSERT ON catalog_publish_commands
WHEN (SELECT offered_for_sale FROM catalog_artwork_revisions WHERE id=NEW.revision_id)=1
BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM catalog_compliance_effective e
  WHERE e.revision_id=NEW.revision_id
   AND e.policy_version=(
    SELECT id FROM catalog_policy_versions WHERE status='active'
    ORDER BY activated_at DESC,id DESC LIMIT 1
   )
   AND e.id=(
    SELECT a2.id FROM catalog_compliance_assessments a2
    WHERE a2.revision_id=NEW.revision_id AND a2.policy_version=e.policy_version
    ORDER BY a2.created_at DESC,a2.rowid DESC LIMIT 1
   )
   AND e.effective_decision IN ('allow','human_approved')
 ) THEN RAISE(ABORT,'COMPLIANCE_REQUIRED') END;
END;

CREATE TRIGGER IF NOT EXISTS catalog_quote_line_compliance_guard BEFORE INSERT ON catalog_quote_lines
WHEN NOT EXISTS(
 SELECT 1 FROM catalog_compliance_effective e
 WHERE e.revision_id=NEW.revision_id
  AND e.policy_version=(
   SELECT id FROM catalog_policy_versions WHERE status='active'
   ORDER BY activated_at DESC,id DESC LIMIT 1
  )
  AND e.id=(
   SELECT a2.id FROM catalog_compliance_assessments a2
   WHERE a2.revision_id=NEW.revision_id AND a2.policy_version=e.policy_version
   ORDER BY a2.created_at DESC,a2.rowid DESC LIMIT 1
  )
  AND e.effective_decision IN ('allow','human_approved')
)
BEGIN SELECT RAISE(ABORT,'COMPLIANCE_CHANGED'); END;

CREATE TRIGGER IF NOT EXISTS catalog_order_line_compliance_guard BEFORE INSERT ON catalog_order_lines
WHEN NOT EXISTS(
 SELECT 1 FROM catalog_compliance_effective e
 WHERE e.revision_id=json_extract(NEW.snapshot_json,'$.revision_id')
  AND e.policy_version=(
   SELECT id FROM catalog_policy_versions WHERE status='active'
   ORDER BY activated_at DESC,id DESC LIMIT 1
  )
  AND e.id=(
   SELECT a2.id FROM catalog_compliance_assessments a2
   WHERE a2.revision_id=json_extract(NEW.snapshot_json,'$.revision_id') AND a2.policy_version=e.policy_version
   ORDER BY a2.created_at DESC,a2.rowid DESC LIMIT 1
  )
  AND e.effective_decision IN ('allow','human_approved')
)
BEGIN SELECT RAISE(ABORT,'COMPLIANCE_CHANGED'); END;

CREATE TRIGGER IF NOT EXISTS catalog_reservation_compliance_guard BEFORE UPDATE OF state ON catalog_inventory_reservations
WHEN NEW.state='committed' AND OLD.state<>'committed' AND (
 NOT EXISTS(SELECT 1 FROM catalog_order_lines WHERE order_id=NEW.order_id) OR
 EXISTS(
  SELECT 1 FROM catalog_order_lines ol
  WHERE ol.order_id=NEW.order_id AND NOT EXISTS(
   SELECT 1 FROM catalog_compliance_effective e
   WHERE e.revision_id=json_extract(ol.snapshot_json,'$.revision_id')
    AND e.policy_version=(
     SELECT id FROM catalog_policy_versions WHERE status='active'
     ORDER BY activated_at DESC,id DESC LIMIT 1
    )
    AND e.id=(
     SELECT a2.id FROM catalog_compliance_assessments a2
     WHERE a2.revision_id=json_extract(ol.snapshot_json,'$.revision_id') AND a2.policy_version=e.policy_version
     ORDER BY a2.created_at DESC,a2.rowid DESC LIMIT 1
    )
    AND e.effective_decision IN ('allow','human_approved')
  )
 )
)
BEGIN SELECT RAISE(ABORT,'COMPLIANCE_CHANGED'); END;

CREATE TRIGGER IF NOT EXISTS catalog_order_payment_compliance_guard BEFORE UPDATE OF payment_status ON catalog_orders
WHEN NEW.payment_status IN ('paid','authorized') AND OLD.payment_status<>NEW.payment_status AND (
 NOT EXISTS(SELECT 1 FROM catalog_order_lines WHERE order_id=NEW.id) OR
 EXISTS(
  SELECT 1 FROM catalog_order_lines ol
  WHERE ol.order_id=NEW.id AND NOT EXISTS(
   SELECT 1 FROM catalog_compliance_effective e
   WHERE e.revision_id=json_extract(ol.snapshot_json,'$.revision_id')
    AND e.policy_version=(
     SELECT id FROM catalog_policy_versions WHERE status='active'
     ORDER BY activated_at DESC,id DESC LIMIT 1
    )
    AND e.id=(
     SELECT a2.id FROM catalog_compliance_assessments a2
     WHERE a2.revision_id=json_extract(ol.snapshot_json,'$.revision_id') AND a2.policy_version=e.policy_version
     ORDER BY a2.created_at DESC,a2.rowid DESC LIMIT 1
    )
    AND e.effective_decision IN ('allow','human_approved')
  )
 )
)
BEGIN SELECT RAISE(ABORT,'COMPLIANCE_CHANGED'); END;

CREATE TRIGGER IF NOT EXISTS catalog_payment_session_compliance_guard BEFORE UPDATE OF status ON catalog_payment_attempts
WHEN NEW.status='ready' AND OLD.status<>NEW.status AND (
 NOT EXISTS(SELECT 1 FROM catalog_order_lines WHERE order_id=NEW.order_id) OR
 EXISTS(
  SELECT 1 FROM catalog_order_lines ol
  WHERE ol.order_id=NEW.order_id AND NOT EXISTS(
   SELECT 1 FROM catalog_compliance_effective e
   WHERE e.revision_id=json_extract(ol.snapshot_json,'$.revision_id')
    AND e.policy_version=(
     SELECT id FROM catalog_policy_versions WHERE status='active'
     ORDER BY activated_at DESC,id DESC LIMIT 1
    )
    AND e.id=(
     SELECT a2.id FROM catalog_compliance_assessments a2
     WHERE a2.revision_id=json_extract(ol.snapshot_json,'$.revision_id') AND a2.policy_version=e.policy_version
     ORDER BY a2.created_at DESC,a2.rowid DESC LIMIT 1
    )
    AND e.effective_decision IN ('allow','human_approved')
  )
 )
)
BEGIN SELECT RAISE(ABORT,'COMPLIANCE_CHANGED'); END;

CREATE TRIGGER IF NOT EXISTS catalog_order_payment_state_guard BEFORE UPDATE OF payment_status ON catalog_orders
WHEN OLD.payment_status<>NEW.payment_status
BEGIN
 SELECT CASE WHEN NOT (
  (OLD.payment_status IN ('pending','session_uncertain') AND NEW.payment_status IN ('authorized','paid','failed','expired','session_uncertain')) OR
  (OLD.payment_status='authorized' AND NEW.payment_status IN ('paid','failed','expired','session_uncertain')) OR
  (OLD.payment_status IN ('failed','expired') AND NEW.payment_status='session_uncertain') OR
  (OLD.payment_status='paid' AND NEW.payment_status='refunded')
 ) THEN RAISE(ABORT,'PAYMENT_STATE_CONFLICT') END;
 SELECT CASE WHEN NEW.payment_status='authorized' AND (
  NOT EXISTS(SELECT 1 FROM catalog_inventory_reservations WHERE order_id=NEW.id) OR
  EXISTS(SELECT 1 FROM catalog_inventory_reservations WHERE order_id=NEW.id AND state<>'active')
 ) THEN RAISE(ABORT,'PAYMENT_STATE_CONFLICT') END;
 SELECT CASE WHEN NEW.payment_status='paid' AND (
  NOT EXISTS(SELECT 1 FROM catalog_inventory_reservations WHERE order_id=NEW.id) OR
  EXISTS(SELECT 1 FROM catalog_inventory_reservations WHERE order_id=NEW.id AND state<>'committed') OR
  EXISTS(SELECT 1 FROM catalog_audit_events WHERE action='early_refund_manual_review' AND json_extract(details_json,'$.order_id')=NEW.id)
 ) THEN RAISE(ABORT,'PAYMENT_STATE_CONFLICT') END;
 SELECT CASE WHEN NEW.payment_status IN ('failed','expired') AND (
  NOT EXISTS(SELECT 1 FROM catalog_inventory_reservations WHERE order_id=NEW.id) OR
  EXISTS(SELECT 1 FROM catalog_inventory_reservations WHERE order_id=NEW.id AND state<>'released')
 ) THEN RAISE(ABORT,'PAYMENT_STATE_CONFLICT') END;
 SELECT CASE WHEN NEW.payment_status='refunded' AND (
  NOT EXISTS(SELECT 1 FROM catalog_inventory_reservations WHERE order_id=NEW.id) OR
  EXISTS(SELECT 1 FROM catalog_inventory_reservations WHERE order_id=NEW.id AND state<>'committed')
 ) THEN RAISE(ABORT,'PAYMENT_STATE_CONFLICT') END;
END;
