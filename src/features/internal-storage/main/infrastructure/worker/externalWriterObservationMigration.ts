export const EXTERNAL_WRITER_OBSERVATION_MIGRATION: {
  version: number;
  statements: readonly string[];
} = {
  version: 25,
  statements: [
    `CREATE TABLE IF NOT EXISTS external_writer_observation_checkpoints (
        deployment_id TEXT NOT NULL,
        observer_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version = 2),
        checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
        PRIMARY KEY (deployment_id, observer_id)
      )`,
    `CREATE TABLE IF NOT EXISTS external_writer_observation_retired_team_floors (
        deployment_id TEXT NOT NULL,
        observer_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        identity_checksum TEXT NOT NULL,
        tombstoned_at TEXT NOT NULL,
        writer_epoch INTEGER CHECK (writer_epoch IS NULL OR writer_epoch >= 1),
        last_observation_sequence INTEGER NOT NULL CHECK (last_observation_sequence >= 0),
        observation_watermark INTEGER NOT NULL CHECK (
          observation_watermark >= 0 AND observation_watermark <= last_observation_sequence
        ),
        PRIMARY KEY (deployment_id, observer_id, team_id),
        FOREIGN KEY (team_id) REFERENCES team_identity_records(team_id)
          ON DELETE RESTRICT ON UPDATE RESTRICT
      )`,
    `CREATE TRIGGER IF NOT EXISTS external_writer_retired_floor_no_update
       BEFORE UPDATE ON external_writer_observation_retired_team_floors
       BEGIN SELECT RAISE(ABORT, 'external-writer-observation-retired-floor-immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS external_writer_retired_floor_no_delete
       BEFORE DELETE ON external_writer_observation_retired_team_floors
       BEGIN SELECT RAISE(ABORT, 'external-writer-observation-retired-floor-immutable'); END`,
    `CREATE TABLE IF NOT EXISTS external_writer_observation_handoff_eligibility (
        deployment_id TEXT NOT NULL,
        observer_id TEXT NOT NULL,
        expected_checkpoint_revision INTEGER NOT NULL CHECK (expected_checkpoint_revision > 0),
        handoff_id TEXT NOT NULL CHECK (
          length(handoff_id) BETWEEN 1 AND 128
          AND handoff_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        ),
        protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
        checkpoint_sha256 TEXT NOT NULL CHECK (
          length(checkpoint_sha256) = 64
          AND checkpoint_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        captured_sequence INTEGER NOT NULL CHECK (captured_sequence >= 0),
        persisted_watermark INTEGER NOT NULL CHECK (persisted_watermark >= 0),
        old_catalog_token TEXT NOT NULL CHECK (
          length(old_catalog_token) = 64
          AND old_catalog_token NOT GLOB '*[^0-9a-f]*'
        ),
        target_catalog_token TEXT NOT NULL CHECK (
          length(target_catalog_token) = 64
          AND target_catalog_token NOT GLOB '*[^0-9a-f]*'
        ),
        next_registration_digest TEXT NOT NULL CHECK (
          length(next_registration_digest) = 64
          AND next_registration_digest NOT GLOB '*[^0-9a-f]*'
        ),
        candidate_digest TEXT NOT NULL CHECK (
          length(candidate_digest) = 64
          AND candidate_digest NOT GLOB '*[^0-9a-f]*'
        ),
        candidates_json TEXT NOT NULL CHECK (
          json_valid(candidates_json)
          AND json_type(candidates_json) = 'array'
          AND json_array_length(candidates_json) <= 1024
          AND length(CAST(candidates_json AS BLOB)) <= 67108864
        ),
        retained_registrations_json TEXT NOT NULL CHECK (
          json_valid(retained_registrations_json)
          AND json_type(retained_registrations_json) = 'array'
          AND json_array_length(retained_registrations_json) <= 100000
          AND length(CAST(retained_registrations_json AS BLOB)) <= 67108864
        ),
        removed_registrations_json TEXT NOT NULL CHECK (
          json_valid(removed_registrations_json)
          AND json_type(removed_registrations_json) = 'array'
          AND json_array_length(removed_registrations_json) <= 100000
          AND length(CAST(removed_registrations_json AS BLOB)) <= 67108864
        ),
        created_at TEXT NOT NULL,
        CHECK (captured_sequence = persisted_watermark),
        PRIMARY KEY (deployment_id, observer_id),
        FOREIGN KEY (deployment_id, observer_id)
          REFERENCES external_writer_observation_checkpoints(deployment_id, observer_id)
          ON DELETE CASCADE ON UPDATE RESTRICT
      )`,
    `CREATE TRIGGER IF NOT EXISTS external_writer_handoff_no_update
       BEFORE UPDATE ON external_writer_observation_handoff_eligibility
       BEGIN SELECT RAISE(ABORT, 'external-writer-observation-handoff-immutable'); END`,
  ],
};
