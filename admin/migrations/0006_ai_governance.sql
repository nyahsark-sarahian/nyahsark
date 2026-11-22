CREATE TABLE IF NOT EXISTS catalog_ai_budget_months(
 month_utc TEXT PRIMARY KEY CHECK(month_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
 image_cap INTEGER NOT NULL CHECK(image_cap BETWEEN 1 AND 1000000),
 budget_microusd INTEGER NOT NULL CHECK(budget_microusd BETWEEN 1 AND 1000000000000),
 max_images_per_action INTEGER NOT NULL CHECK(max_images_per_action BETWEEN 1 AND 100),
 attempted_images INTEGER NOT NULL DEFAULT 0 CHECK(attempted_images>=0),
 reserved_microusd INTEGER NOT NULL DEFAULT 0 CHECK(reserved_microusd>=0),
 actual_microusd INTEGER NOT NULL DEFAULT 0 CHECK(actual_microusd>=0),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);

CREATE TABLE IF NOT EXISTS catalog_ai_inference_ledger(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 action_id TEXT NOT NULL UNIQUE CHECK(length(action_id) BETWEEN 8 AND 160),
 month_utc TEXT NOT NULL REFERENCES catalog_ai_budget_months(month_utc) ON DELETE RESTRICT,
 image_count INTEGER NOT NULL CHECK(image_count BETWEEN 1 AND 100),
 model_id TEXT NOT NULL CHECK(length(model_id) BETWEEN 1 AND 200),
 state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','completed','failed','uncertain')),
 estimated_cost_microusd INTEGER NOT NULL CHECK(estimated_cost_microusd>=0),
 actual_cost_microusd INTEGER CHECK(actual_cost_microusd IS NULL OR actual_cost_microusd>=0),
 usage_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(usage_json) AND json_type(usage_json)='object'),
 error_code TEXT CHECK(error_code IS NULL OR length(error_code)<=120),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 160),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 reconciled_at INTEGER
);
CREATE INDEX IF NOT EXISTS catalog_ai_inference_month ON catalog_ai_inference_ledger(month_utc,created_at,id);
CREATE INDEX IF NOT EXISTS catalog_ai_inference_state ON catalog_ai_inference_ledger(state,created_at,id);

CREATE TRIGGER IF NOT EXISTS catalog_ai_reservation_state_guard BEFORE INSERT ON catalog_ai_inference_ledger
WHEN NEW.state<>'reserved' OR NEW.actual_cost_microusd IS NOT NULL OR NEW.reconciled_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'AI_RESERVATION_STATE'); END;

CREATE TRIGGER IF NOT EXISTS catalog_ai_reservation_month_guard BEFORE INSERT ON catalog_ai_inference_ledger
WHEN NEW.month_utc<>strftime('%Y-%m',NEW.created_at,'unixepoch')
 OR NOT EXISTS(SELECT 1 FROM catalog_ai_budget_months WHERE month_utc=NEW.month_utc)
BEGIN SELECT RAISE(ABORT,'AI_BUDGET_MONTH'); END;

CREATE TRIGGER IF NOT EXISTS catalog_ai_reservation_action_guard BEFORE INSERT ON catalog_ai_inference_ledger
WHEN NEW.image_count>coalesce((SELECT max_images_per_action FROM catalog_ai_budget_months WHERE month_utc=NEW.month_utc),0)
BEGIN SELECT RAISE(ABORT,'AI_ACTION_IMAGE_CAP'); END;

CREATE TRIGGER IF NOT EXISTS catalog_ai_reservation_image_cap_guard BEFORE INSERT ON catalog_ai_inference_ledger
WHEN NEW.image_count+coalesce((SELECT attempted_images FROM catalog_ai_budget_months WHERE month_utc=NEW.month_utc),0)
 >coalesce((SELECT image_cap FROM catalog_ai_budget_months WHERE month_utc=NEW.month_utc),0)
BEGIN SELECT RAISE(ABORT,'AI_MONTHLY_IMAGE_CAP'); END;

CREATE TRIGGER IF NOT EXISTS catalog_ai_reservation_budget_guard BEFORE INSERT ON catalog_ai_inference_ledger
WHEN NEW.estimated_cost_microusd
 +coalesce((SELECT reserved_microusd+actual_microusd FROM catalog_ai_budget_months WHERE month_utc=NEW.month_utc),0)
 >coalesce((SELECT budget_microusd FROM catalog_ai_budget_months WHERE month_utc=NEW.month_utc),0)
BEGIN SELECT RAISE(ABORT,'AI_MONTHLY_BUDGET_CAP'); END;

CREATE TRIGGER IF NOT EXISTS catalog_ai_reservation_apply AFTER INSERT ON catalog_ai_inference_ledger
BEGIN
 UPDATE catalog_ai_budget_months
 SET attempted_images=attempted_images+NEW.image_count,
     reserved_microusd=reserved_microusd+NEW.estimated_cost_microusd,
     updated_at=unixepoch()
 WHERE month_utc=NEW.month_utc;
END;

CREATE TRIGGER IF NOT EXISTS catalog_ai_reconcile_guard BEFORE UPDATE ON catalog_ai_inference_ledger
WHEN OLD.state<>'reserved'
 OR NEW.state NOT IN ('completed','failed','uncertain')
 OR NEW.actual_cost_microusd IS NULL
 OR NEW.reconciled_at IS NULL
 OR NEW.id<>OLD.id OR NEW.action_id<>OLD.action_id OR NEW.month_utc<>OLD.month_utc
 OR NEW.image_count<>OLD.image_count OR NEW.model_id<>OLD.model_id
 OR NEW.estimated_cost_microusd<>OLD.estimated_cost_microusd
 OR NEW.actor<>OLD.actor OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'AI_RECONCILIATION_STATE'); END;

CREATE TRIGGER IF NOT EXISTS catalog_ai_reconcile_apply AFTER UPDATE ON catalog_ai_inference_ledger
BEGIN
 UPDATE catalog_ai_budget_months
 SET reserved_microusd=reserved_microusd-OLD.estimated_cost_microusd,
     actual_microusd=actual_microusd+NEW.actual_cost_microusd,
     updated_at=unixepoch()
 WHERE month_utc=NEW.month_utc;
END;

CREATE TRIGGER IF NOT EXISTS catalog_ai_inference_delete_guard BEFORE DELETE ON catalog_ai_inference_ledger
BEGIN SELECT RAISE(ABORT,'AI_LEDGER_IMMUTABLE'); END;

CREATE TABLE IF NOT EXISTS catalog_listing_price_floors(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 artwork_id TEXT NOT NULL REFERENCES catalog_artworks(id) ON DELETE RESTRICT,
 seller_floor_cents INTEGER NOT NULL CHECK(typeof(seller_floor_cents)='integer' AND seller_floor_cents BETWEEN 1 AND 100000000),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 160),
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX IF NOT EXISTS catalog_listing_price_floor_lookup ON catalog_listing_price_floors(artwork_id,created_at DESC,id DESC);
CREATE TRIGGER IF NOT EXISTS catalog_listing_price_floor_immutable_update BEFORE UPDATE ON catalog_listing_price_floors
BEGIN SELECT RAISE(ABORT,'PRICE_FLOOR_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_listing_price_floor_immutable_delete BEFORE DELETE ON catalog_listing_price_floors
BEGIN SELECT RAISE(ABORT,'PRICE_FLOOR_IMMUTABLE'); END;

CREATE TABLE IF NOT EXISTS catalog_review_escalations(
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 120),
 assessment_id TEXT NOT NULL REFERENCES catalog_compliance_assessments(id) ON DELETE RESTRICT,
 stage TEXT NOT NULL CHECK(stage IN ('seller_clarification','local_priest','diocesan_chancery')),
 outcome TEXT NOT NULL CHECK(outcome IN ('requested','cleared','blocked','escalated','unable_to_resolve')),
 reviewer_role TEXT NOT NULL CHECK(length(trim(reviewer_role)) BETWEEN 2 AND 160),
 note TEXT NOT NULL CHECK(length(trim(note)) BETWEEN 8 AND 4000),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 160),
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX IF NOT EXISTS catalog_review_escalation_assessment ON catalog_review_escalations(assessment_id,created_at,id);
CREATE TRIGGER IF NOT EXISTS catalog_review_escalation_owner BEFORE INSERT ON catalog_review_escalations
WHEN NOT EXISTS(SELECT 1 FROM catalog_compliance_assessments WHERE id=NEW.assessment_id)
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_escalation_active_policy_guard BEFORE INSERT ON catalog_review_escalations
WHEN NOT EXISTS(
 SELECT 1 FROM catalog_compliance_assessments a
 WHERE a.id=NEW.assessment_id AND a.policy_version=(
  SELECT id FROM catalog_policy_versions WHERE status='active' ORDER BY activated_at DESC,id DESC LIMIT 1
 )
)
BEGIN SELECT RAISE(ABORT,'POLICY_CHANGED'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_escalation_latest_guard BEFORE INSERT ON catalog_review_escalations
WHEN NEW.assessment_id<>(
 SELECT a2.id FROM catalog_compliance_assessments a2
 WHERE a2.revision_id=(SELECT revision_id FROM catalog_compliance_assessments WHERE id=NEW.assessment_id)
  AND a2.policy_version=(SELECT policy_version FROM catalog_compliance_assessments WHERE id=NEW.assessment_id)
 ORDER BY a2.created_at DESC,a2.rowid DESC LIMIT 1
)
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_SUPERSEDED'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_escalation_unresolved_guard BEFORE INSERT ON catalog_review_escalations
WHEN coalesce((SELECT decision FROM catalog_compliance_assessments WHERE id=NEW.assessment_id),'')<>'review'
 OR EXISTS(SELECT 1 FROM catalog_review_decisions WHERE assessment_id=NEW.assessment_id)
BEGIN SELECT RAISE(ABORT,'ASSESSMENT_RESOLVED'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_escalation_seller_clearance_guard BEFORE INSERT ON catalog_review_escalations
WHEN NEW.stage='seller_clarification' AND NEW.outcome='cleared'
BEGIN SELECT RAISE(ABORT,'SELLER_CLEARANCE_NOT_ALLOWED'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_escalation_terminal_guard BEFORE INSERT ON catalog_review_escalations
WHEN EXISTS(
 SELECT 1 FROM catalog_review_escalations e WHERE e.assessment_id=NEW.assessment_id
  AND e.rowid=(SELECT e2.rowid FROM catalog_review_escalations e2 WHERE e2.assessment_id=NEW.assessment_id ORDER BY e2.created_at DESC,e2.rowid DESC LIMIT 1)
  AND (e.outcome IN ('cleared','blocked') OR (e.stage='diocesan_chancery' AND e.outcome IN ('escalated','unable_to_resolve')))
)
BEGIN SELECT RAISE(ABORT,'ESCALATION_TERMINAL'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_escalation_sequence_guard BEFORE INSERT ON catalog_review_escalations
WHEN (NOT EXISTS(SELECT 1 FROM catalog_review_escalations WHERE assessment_id=NEW.assessment_id) AND NEW.stage<>'seller_clarification')
 OR EXISTS(
  SELECT 1 FROM catalog_review_escalations e WHERE e.assessment_id=NEW.assessment_id
   AND e.rowid=(SELECT e2.rowid FROM catalog_review_escalations e2 WHERE e2.assessment_id=NEW.assessment_id ORDER BY e2.created_at DESC,e2.rowid DESC LIMIT 1)
   AND e.outcome='requested' AND NEW.stage<>e.stage
 )
 OR EXISTS(
  SELECT 1 FROM catalog_review_escalations e WHERE e.assessment_id=NEW.assessment_id
   AND e.rowid=(SELECT e2.rowid FROM catalog_review_escalations e2 WHERE e2.assessment_id=NEW.assessment_id ORDER BY e2.created_at DESC,e2.rowid DESC LIMIT 1)
   AND e.stage='seller_clarification' AND e.outcome IN ('escalated','unable_to_resolve') AND NEW.stage<>'local_priest'
 )
 OR EXISTS(
  SELECT 1 FROM catalog_review_escalations e WHERE e.assessment_id=NEW.assessment_id
   AND e.rowid=(SELECT e2.rowid FROM catalog_review_escalations e2 WHERE e2.assessment_id=NEW.assessment_id ORDER BY e2.created_at DESC,e2.rowid DESC LIMIT 1)
   AND e.stage='local_priest' AND e.outcome IN ('escalated','unable_to_resolve') AND NEW.stage<>'diocesan_chancery'
 )
BEGIN SELECT RAISE(ABORT,'ESCALATION_SEQUENCE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_escalation_immutable_update BEFORE UPDATE ON catalog_review_escalations
BEGIN SELECT RAISE(ABORT,'ESCALATION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS catalog_review_escalation_immutable_delete BEFORE DELETE ON catalog_review_escalations
BEGIN SELECT RAISE(ABORT,'ESCALATION_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS catalog_review_consultation_guard BEFORE INSERT ON catalog_review_decisions
WHEN NEW.decision='approve' AND NOT EXISTS(
 SELECT 1 FROM catalog_review_escalations e
 WHERE e.assessment_id=NEW.assessment_id
  AND e.rowid=(SELECT e2.rowid FROM catalog_review_escalations e2 WHERE e2.assessment_id=NEW.assessment_id ORDER BY e2.created_at DESC,e2.rowid DESC LIMIT 1)
  AND e.stage IN ('local_priest','diocesan_chancery') AND e.outcome='cleared'
)
BEGIN SELECT RAISE(ABORT,'PRIEST_CLEARANCE_REQUIRED'); END;
