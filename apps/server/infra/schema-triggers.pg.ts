// Postgres trigger functions + triggers (batch B2). Ports every trigger in
// schema-triggers.ts's `CREATE TRIGGER IF NOT EXISTS` set (10 of them) to
// PL/pgSQL -- same trigger names, so a caller checking `pg_trigger` for a
// name (the way test/migration-006-invariants.test.ts checks
// sqlite_master today) finds the identical name on either dialect.
// `RAISE(ABORT, 'msg')` becomes `RAISE EXCEPTION 'msg'`; SQLite's
// `WHEN <cond> BEGIN ... END` trigger-level guard becomes an `IF <cond>
// THEN ... END IF;` inside the function body, since Postgres triggers have
// no WHEN-guarded body shorthand of their own for arbitrary SQL conditions
// referencing other tables (only simple NEW/OLD column comparisons, which
// several of these are not). Column-scoped triggers (`UPDATE OF col`) are
// natively supported by Postgres's own CREATE TRIGGER, unchanged.
//
// `nodes_owner_must_be_real_person` (PG_TRIGGER_NODES_OWNER_MUST_BE_REAL_PERSON)
// is exported for parity with the libsql file but, like there
// (DDL_MIGRATION_006's comment), deliberately NOT included in
// PG_BASELINE_TRIGGERS: migration 014 drops it on the libsql side and a
// fresh install never creates it in the first place -- owners may be any
// actor, the FK on owner_id already guarantees existence.

export const PG_TRIGGER_PREVENT_MULTI_PARENT_ORG = `
CREATE OR REPLACE FUNCTION prevent_multi_parent_org_fn() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.relation = 'belongs_to'
     AND (SELECT type FROM nodes WHERE id = NEW.source_id) != 'organization'
     AND (SELECT type FROM nodes WHERE id = NEW.target_id) = 'organization'
     AND EXISTS (
       SELECT 1 FROM edges e
         JOIN nodes t ON t.id = e.target_id
        WHERE e.source_id = NEW.source_id
          AND e.relation = 'belongs_to'
          AND t.type = 'organization'
     )
  THEN
    RAISE EXCEPTION 'non-organization node already belongs to an organization; disconnect the existing belongs_to edge first';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_multi_parent_org
  BEFORE INSERT ON edges
  FOR EACH ROW
  EXECUTE FUNCTION prevent_multi_parent_org_fn();
`;

export const PG_TRIGGER_PREVENT_ORPHAN_ON_EDGE_DELETE = `
CREATE OR REPLACE FUNCTION prevent_orphan_on_edge_delete_fn() RETURNS TRIGGER AS $fn$
BEGIN
  IF OLD.relation = 'belongs_to'
     AND (SELECT type FROM nodes WHERE id = OLD.source_id) != 'organization'
     AND (SELECT type FROM nodes WHERE id = OLD.target_id) = 'organization'
     AND (
       SELECT COUNT(*) FROM edges e
         JOIN nodes t ON t.id = e.target_id
        WHERE e.source_id = OLD.source_id
          AND e.relation = 'belongs_to'
          AND t.type = 'organization'
     ) <= 1
  THEN
    RAISE EXCEPTION 'cannot remove last belongs_to -> organization edge; every non-organization node must belong to exactly one organization';
  END IF;
  RETURN OLD;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_orphan_on_edge_delete
  BEFORE DELETE ON edges
  FOR EACH ROW
  EXECUTE FUNCTION prevent_orphan_on_edge_delete_fn();
`;

export const PG_TRIGGER_RESPONSIBILITIES_VALID_NODE_TYPE = `
CREATE OR REPLACE FUNCTION responsibilities_valid_node_type_fn() RETURNS TRIGGER AS $fn$
BEGIN
  IF (SELECT type FROM nodes WHERE id = NEW.node_id) NOT IN ('project','process','area') THEN
    RAISE EXCEPTION 'responsibilities can only attach to project/process/area nodes';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER responsibilities_valid_node_type
  BEFORE INSERT ON responsibilities
  FOR EACH ROW
  EXECUTE FUNCTION responsibilities_valid_node_type_fn();
`;

export const PG_TRIGGER_DATA_SOURCES_VALID_NODE_TYPE = `
CREATE OR REPLACE FUNCTION data_sources_valid_node_type_fn() RETURNS TRIGGER AS $fn$
BEGIN
  IF (SELECT type FROM nodes WHERE id = NEW.node_id) NOT IN ('project','process','area') THEN
    RAISE EXCEPTION 'data_sources can only attach to project/process/area nodes';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER data_sources_valid_node_type
  BEFORE INSERT ON data_sources
  FOR EACH ROW
  EXECUTE FUNCTION data_sources_valid_node_type_fn();
`;

export const PG_TRIGGER_TOOLS_VALID_NODE_TYPE = `
CREATE OR REPLACE FUNCTION tools_valid_node_type_fn() RETURNS TRIGGER AS $fn$
BEGIN
  IF (SELECT type FROM nodes WHERE id = NEW.node_id) NOT IN ('project','process','area') THEN
    RAISE EXCEPTION 'tools can only attach to project/process/area nodes';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER tools_valid_node_type
  BEFORE INSERT ON tools
  FOR EACH ROW
  EXECUTE FUNCTION tools_valid_node_type_fn();
`;

// Legacy, excluded from PG_BASELINE_TRIGGERS -- see file header.
export const PG_TRIGGER_NODES_OWNER_MUST_BE_REAL_PERSON = `
CREATE OR REPLACE FUNCTION nodes_owner_must_be_real_person_fn() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.owner_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM actors a
     WHERE a.id = NEW.owner_id
       AND a.type = 'person'
       AND a.user_id IS NOT NULL
       AND a.is_placeholder = 0
  ) THEN
    RAISE EXCEPTION 'owner_id must reference an actor of type=person with user_id set';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER nodes_owner_must_be_real_person
  BEFORE UPDATE OF owner_id ON nodes
  FOR EACH ROW
  EXECUTE FUNCTION nodes_owner_must_be_real_person_fn();
`;

// SQLite's own comment: "re-fires a trigger only for the specific column
// named in UPDATE OF, so updating status here does not re-enter this
// trigger" -- identically true of Postgres's column-scoped triggers.
export const PG_TRIGGER_NODES_DERIVE_STATUS_FROM_LIFECYCLE = `
CREATE OR REPLACE FUNCTION nodes_derive_status_from_lifecycle_fn() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.lifecycle_state IS NOT NULL THEN
    UPDATE nodes SET status = CASE NEW.lifecycle_state
      WHEN 'done' THEN 'completed'
      WHEN 'archived' THEN 'archived'
      WHEN 'retired' THEN 'archived'
      WHEN 'cancelled' THEN 'archived'
      WHEN 'inactive' THEN 'archived'
      ELSE 'active'
    END WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER nodes_derive_status_from_lifecycle
  AFTER UPDATE OF lifecycle_state ON nodes
  FOR EACH ROW
  EXECUTE FUNCTION nodes_derive_status_from_lifecycle_fn();
`;

export const PG_TRIGGER_NODES_VALIDATE_LIFECYCLE_STATE = `
CREATE OR REPLACE FUNCTION nodes_validate_lifecycle_state_fn() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.lifecycle_state IS NOT NULL AND (
       (NEW.type = 'organization' AND NEW.lifecycle_state NOT IN ('active','inactive','archived'))
    OR (NEW.type = 'area'         AND NEW.lifecycle_state NOT IN ('active','needs_attention','inactive','archived'))
    OR (NEW.type = 'process'      AND NEW.lifecycle_state NOT IN ('not_implemented','implementing','operating','at_risk','broken','retired'))
    OR (NEW.type = 'project'      AND NEW.lifecycle_state NOT IN ('backlog','planned','in_progress','on_hold','done','cancelled'))
    OR (NEW.type = 'principle'    AND NEW.lifecycle_state NOT IN ('active','archived'))
  ) THEN
    RAISE EXCEPTION 'invalid lifecycle_state for node type';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER nodes_validate_lifecycle_state
  BEFORE UPDATE OF lifecycle_state ON nodes
  FOR EACH ROW
  EXECUTE FUNCTION nodes_validate_lifecycle_state_fn();
`;

// One shared function backs both the INSERT and UPDATE OF sync_key
// triggers, same as the libsql pair sharing the same guard logic.
export const PG_TRIGGER_NODES_SYNC_KEY_NOT_NULL = `
CREATE OR REPLACE FUNCTION nodes_sync_key_not_null_fn() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.sync_key IS NULL OR NEW.sync_key = '' THEN
    RAISE EXCEPTION 'nodes.sync_key must be a non-empty string';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER nodes_sync_key_not_null_insert
  BEFORE INSERT ON nodes
  FOR EACH ROW
  EXECUTE FUNCTION nodes_sync_key_not_null_fn();

CREATE TRIGGER nodes_sync_key_not_null_update
  BEFORE UPDATE OF sync_key ON nodes
  FOR EACH ROW
  EXECUTE FUNCTION nodes_sync_key_not_null_fn();
`;

// Applied by infra/migrations/pg.ts as part of the pg-001 baseline --
// PG_TRIGGER_NODES_OWNER_MUST_BE_REAL_PERSON is deliberately excluded (see
// file header).
export const PG_BASELINE_TRIGGERS: string[] = [
  PG_TRIGGER_PREVENT_MULTI_PARENT_ORG,
  PG_TRIGGER_PREVENT_ORPHAN_ON_EDGE_DELETE,
  PG_TRIGGER_RESPONSIBILITIES_VALID_NODE_TYPE,
  PG_TRIGGER_DATA_SOURCES_VALID_NODE_TYPE,
  PG_TRIGGER_TOOLS_VALID_NODE_TYPE,
  PG_TRIGGER_NODES_DERIVE_STATUS_FROM_LIFECYCLE,
  PG_TRIGGER_NODES_VALIDATE_LIFECYCLE_STATE,
  PG_TRIGGER_NODES_SYNC_KEY_NOT_NULL,
];
