-- Future SQLite design only. The application currently uses JSON + Markdown.
-- Apply to a new database, never automatically to the live volume.
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;

CREATE TABLE league (
    id TEXT PRIMARY KEY NOT NULL,              -- internal UUID; not a Yahoo ID
    provider TEXT NOT NULL DEFAULT 'yahoo',
    external_key TEXT,
    sport TEXT NOT NULL DEFAULT 'nba',
    display_name TEXT,
    UNIQUE (provider, external_key)
);

CREATE TABLE season (
    id TEXT PRIMARY KEY NOT NULL,
    league_id TEXT NOT NULL REFERENCES league(id),
    label TEXT NOT NULL,
    external_game_key TEXT,
    external_league_key TEXT,
    scoring_timezone TEXT,                    -- unknown stays NULL
    UNIQUE (league_id, label),
    UNIQUE (external_league_key)
);

CREATE TABLE fantasy_team (
    id TEXT PRIMARY KEY NOT NULL,
    season_id TEXT NOT NULL REFERENCES season(id),
    external_key TEXT,
    display_name TEXT NOT NULL,
    identity_status TEXT NOT NULL CHECK (identity_status IN ('provisional', 'verified')),
    UNIQUE (season_id, external_key),
    UNIQUE (id, season_id)
);

CREATE TABLE player (
    id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL DEFAULT 'yahoo',
    external_key TEXT,
    display_name TEXT NOT NULL,
    identity_status TEXT NOT NULL CHECK (identity_status IN ('provisional', 'verified')),
    UNIQUE (provider, external_key)
);

-- Exact original file bytes stay on the volume. These rows are their manifest.
CREATE TABLE evidence_record (
    id TEXT PRIMARY KEY NOT NULL,              -- retain current Store record ID
    legacy_snapshot_id TEXT,
    record_kind TEXT NOT NULL,
    record_schema_version INTEGER NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    ingested_at TEXT NOT NULL,                 -- UTC RFC3339, real import time
    source_type TEXT NOT NULL,
    source_url TEXT,                           -- redact tokens / sensitive query data
    supersedes_id TEXT REFERENCES evidence_record(id),
    CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

CREATE TRIGGER evidence_record_no_update BEFORE UPDATE ON evidence_record
BEGIN SELECT RAISE(ABORT, 'Evidence is immutable; append a corrected record'); END;
CREATE TRIGGER evidence_record_no_delete BEFORE DELETE ON evidence_record
BEGIN SELECT RAISE(ABORT, 'Evidence is immutable'); END;

-- A single snapshot may contain different periods and coverage for each table.
CREATE TABLE observation (
    id TEXT PRIMARY KEY NOT NULL,
    evidence_id TEXT NOT NULL REFERENCES evidence_record(id),
    source_locator TEXT NOT NULL,              -- e.g. /payload/teams/0/stats
    season_id TEXT NOT NULL REFERENCES season(id),
    scope TEXT NOT NULL,                       -- roster, matchup_totals, waiver_stats...
    observed_at TEXT,                          -- exact instant only when known
    observed_date TEXT,                        -- source/local date without invented time
    observed_timezone TEXT,
    time_precision TEXT NOT NULL CHECK (time_precision IN ('instant', 'date', 'unknown')),
    period_kind TEXT NOT NULL CHECK (period_kind IN ('day', 'week', 'season', 'range', 'unknown')),
    period_start TEXT,
    period_end TEXT,
    fantasy_week INTEGER CHECK (fantasy_week > 0),
    value_kind TEXT NOT NULL CHECK (value_kind IN ('actual', 'projection', 'unknown')),
    aggregation_basis TEXT NOT NULL CHECK (aggregation_basis IN ('total', 'per_game', 'per_minute', 'not_applicable', 'unknown')),
    coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial', 'unknown')),
    finality TEXT NOT NULL CHECK (finality IN ('live', 'provisional', 'final', 'unknown')),
    validation_status TEXT NOT NULL CHECK (validation_status IN ('verified', 'unverified', 'rejected')),
    coverage_note TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    normalized_at TEXT NOT NULL,
    UNIQUE (evidence_id, source_locator, parser_version),
    UNIQUE (id, season_id),
    CHECK (period_start IS NULL OR period_end IS NULL OR period_start <= period_end),
    CHECK (time_precision <> 'instant' OR observed_at IS NOT NULL),
    CHECK (time_precision <> 'date' OR observed_date IS NOT NULL),
    CHECK (time_precision <> 'unknown' OR observed_at IS NULL)
);
CREATE INDEX observation_history ON observation(season_id, scope, observed_at, observed_date);

CREATE TABLE league_settings (
    observation_id TEXT PRIMARY KEY NOT NULL REFERENCES observation(id),
    categories_json TEXT NOT NULL CHECK (json_valid(categories_json)),
    roster_slots_json TEXT NOT NULL CHECK (json_valid(roster_slots_json)),
    acquisition_limit INTEGER CHECK (acquisition_limit >= 0),
    acquisition_period TEXT,                   -- week, season, etc., exactly as verified
    lineup_lock_rule TEXT,
    waiver_rule TEXT,
    settings_json TEXT NOT NULL CHECK (json_valid(settings_json))
);

-- Membership/lineup observations do not imply an add/drop event occurred.
CREATE TABLE roster_entry (
    id TEXT PRIMARY KEY NOT NULL,
    observation_id TEXT NOT NULL,
    season_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    player_id TEXT NOT NULL REFERENCES player(id),
    scoring_date TEXT,                         -- NULL if source doesn't establish a date
    slot TEXT,                                -- provider slot; NULL if not observed
    slot_order INTEGER CHECK (slot_order >= 0),
    lineup_state TEXT NOT NULL CHECK (lineup_state IN ('active', 'bench', 'injured_list', 'unknown')),
    game_state TEXT NOT NULL CHECK (game_state IN ('off', 'scheduled', 'live', 'final', 'unknown')),
    eligible_positions_json TEXT CHECK (eligible_positions_json IS NULL OR json_valid(eligible_positions_json)),
    nba_team_as_shown TEXT,
    injury_flag TEXT,
    FOREIGN KEY (observation_id, season_id) REFERENCES observation(id, season_id),
    FOREIGN KEY (team_id, season_id) REFERENCES fantasy_team(id, season_id)
);
CREATE UNIQUE INDEX roster_entry_once ON roster_entry(observation_id, team_id, player_id, coalesce(scoring_date, ''));
CREATE INDEX roster_player_history ON roster_entry(player_id, scoring_date);

-- Fixed category columns are deliberately simple for this basketball MVP.
-- Decimal values are allowed for averages/projections. NULL != zero.
CREATE TABLE stat_observation (
    id TEXT PRIMARY KEY NOT NULL,
    observation_id TEXT NOT NULL,
    season_id TEXT NOT NULL,
    team_id TEXT,
    player_id TEXT REFERENCES player(id),
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('team', 'player')),
    gp REAL CHECK (gp >= 0),
    minutes REAL CHECK (minutes >= 0),
    fgm REAL CHECK (fgm >= 0),
    fga REAL CHECK (fga >= 0),
    ftm REAL CHECK (ftm >= 0),
    fta REAL CHECK (fta >= 0),
    fg_pct_displayed REAL CHECK (fg_pct_displayed BETWEEN 0 AND 1),
    ft_pct_displayed REAL CHECK (ft_pct_displayed BETWEEN 0 AND 1),
    three_pm REAL CHECK (three_pm >= 0),
    pts REAL CHECK (pts >= 0),
    oreb REAL CHECK (oreb >= 0),
    reb REAL CHECK (reb >= 0),
    ast REAL CHECK (ast >= 0),
    stl REAL CHECK (stl >= 0),
    blk REAL CHECK (blk >= 0),
    FOREIGN KEY (observation_id, season_id) REFERENCES observation(id, season_id),
    FOREIGN KEY (team_id, season_id) REFERENCES fantasy_team(id, season_id),
    CHECK ((subject_kind = 'team' AND team_id IS NOT NULL AND player_id IS NULL)
        OR (subject_kind = 'player' AND player_id IS NOT NULL)),
    CHECK (fgm IS NULL OR fga IS NULL OR fgm <= fga),
    CHECK (ftm IS NULL OR fta IS NULL OR ftm <= fta),
    CHECK (oreb IS NULL OR reb IS NULL OR oreb <= reb),
    UNIQUE (id, season_id, team_id, subject_kind)
);
CREATE UNIQUE INDEX stat_team_once ON stat_observation(observation_id, team_id) WHERE subject_kind = 'team';
CREATE UNIQUE INDEX stat_player_once ON stat_observation(observation_id, player_id) WHERE subject_kind = 'player';

CREATE TABLE matchup (
    id TEXT PRIMARY KEY NOT NULL,
    season_id TEXT NOT NULL REFERENCES season(id),
    fantasy_week INTEGER NOT NULL CHECK (fantasy_week > 0),
    team_a_id TEXT NOT NULL,
    team_b_id TEXT NOT NULL,
    external_key TEXT,
    FOREIGN KEY (team_a_id, season_id) REFERENCES fantasy_team(id, season_id),
    FOREIGN KEY (team_b_id, season_id) REFERENCES fantasy_team(id, season_id),
    CHECK (team_a_id < team_b_id),               -- canonical internal-ID ordering
    UNIQUE (season_id, fantasy_week, team_a_id, team_b_id),
    UNIQUE (id, season_id)
);

CREATE TABLE matchup_observation (
    observation_id TEXT NOT NULL,
    season_id TEXT NOT NULL,
    matchup_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    stat_observation_id TEXT NOT NULL,
    stat_subject_kind TEXT NOT NULL DEFAULT 'team' CHECK (stat_subject_kind = 'team'),
    categories_won INTEGER CHECK (categories_won >= 0),
    games_played INTEGER CHECK (games_played >= 0),
    games_remaining_displayed INTEGER CHECK (games_remaining_displayed >= 0),
    PRIMARY KEY (observation_id, matchup_id, team_id),
    FOREIGN KEY (observation_id, season_id) REFERENCES observation(id, season_id),
    FOREIGN KEY (matchup_id, season_id) REFERENCES matchup(id, season_id),
    FOREIGN KEY (stat_observation_id, season_id, team_id, stat_subject_kind) REFERENCES stat_observation(id, season_id, team_id, subject_kind),
    FOREIGN KEY (team_id, season_id) REFERENCES fantasy_team(id, season_id)
);

CREATE TABLE availability_observation (
    observation_id TEXT NOT NULL REFERENCES observation(id),
    player_id TEXT NOT NULL REFERENCES player(id),
    status TEXT NOT NULL CHECK (status IN ('free_agent', 'waivers', 'rostered', 'unknown')),
    waiver_clear_at TEXT,
    waiver_clear_date TEXT,
    add_effective_date TEXT,
    displayed_status TEXT NOT NULL,
    PRIMARY KEY (observation_id, player_id)
);

-- An event exists only when occurrence is confirmed by a transaction record.
-- Observing a new roster member alone belongs in transaction_observation.
CREATE TABLE transaction_event (
    id TEXT PRIMARY KEY NOT NULL,
    season_id TEXT NOT NULL REFERENCES season(id),
    external_key TEXT,
    event_kind TEXT NOT NULL CHECK (event_kind IN ('add', 'drop', 'add_drop', 'trade', 'waiver_claim', 'other')),
    event_time TEXT,
    event_date TEXT,
    event_timezone TEXT,
    time_precision TEXT NOT NULL CHECK (time_precision IN ('instant', 'date', 'unknown')),
    effective_date TEXT,
    confirmed_by_observation_id TEXT NOT NULL,
    confirmation_note TEXT NOT NULL,
    UNIQUE (season_id, external_key),
    UNIQUE (id, season_id),
    FOREIGN KEY (confirmed_by_observation_id, season_id) REFERENCES observation(id, season_id),
    CHECK (time_precision <> 'instant' OR event_time IS NOT NULL),
    CHECK (time_precision <> 'date' OR event_date IS NOT NULL),
    CHECK (time_precision <> 'unknown' OR event_time IS NULL)
);

CREATE TABLE transaction_player (
    transaction_id TEXT NOT NULL,
    season_id TEXT NOT NULL,
    player_id TEXT NOT NULL REFERENCES player(id),
    from_team_id TEXT,
    to_team_id TEXT,
    PRIMARY KEY (transaction_id, player_id),
    FOREIGN KEY (transaction_id, season_id) REFERENCES transaction_event(id, season_id),
    FOREIGN KEY (from_team_id, season_id) REFERENCES fantasy_team(id, season_id),
    FOREIGN KEY (to_team_id, season_id) REFERENCES fantasy_team(id, season_id),
    CHECK (from_team_id IS NOT NULL OR to_team_id IS NOT NULL),
    CHECK (from_team_id IS NULL OR to_team_id IS NULL OR from_team_id <> to_team_id)
);

CREATE TABLE transaction_observation (
    id TEXT PRIMARY KEY NOT NULL,
    observation_id TEXT NOT NULL REFERENCES observation(id),
    source_row_key TEXT NOT NULL,
    event_id TEXT REFERENCES transaction_event(id),
    evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('history_entry', 'roster_difference', 'offer')),
    status_as_shown TEXT NOT NULL,
    displayed_time_text TEXT,
    details_json TEXT NOT NULL CHECK (json_valid(details_json)),
    UNIQUE (observation_id, source_row_key)
);

CREATE TABLE document (
    id TEXT PRIMARY KEY NOT NULL,
    document_kind TEXT NOT NULL CHECK (document_kind IN ('report', 'knowledge_note', 'prompt')),
    title TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    created_at TEXT NOT NULL,
    supersedes_id TEXT REFERENCES document(id),
    UNIQUE (relative_path, sha256)
);
CREATE TABLE document_evidence (
    document_id TEXT NOT NULL REFERENCES document(id),
    evidence_id TEXT NOT NULL REFERENCES evidence_record(id),
    source_locator TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (document_id, evidence_id, source_locator)
);

-- Advice is immutable and never doubles as an execution record.
CREATE TABLE decision (
    id TEXT PRIMARY KEY NOT NULL,
    evidence_id TEXT NOT NULL UNIQUE REFERENCES evidence_record(id),
    created_at TEXT NOT NULL,
    task TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('provider_call', 'manual_import')),
    requested_model TEXT,
    served_model TEXT,
    prompt_document_id TEXT REFERENCES document(id),
    prompt_hash TEXT CHECK (prompt_hash IS NULL OR length(prompt_hash) = 64),
    input_hash TEXT CHECK (input_hash IS NULL OR length(input_hash) = 64),
    previous_decision_id TEXT REFERENCES decision(id),
    recommendation_status TEXT NOT NULL CHECK (recommendation_status IN ('proposed', 'rejected', 'superseded', 'unknown')),
    provenance_note TEXT NOT NULL,
    CHECK (origin <> 'provider_call' OR
        (requested_model IS NOT NULL AND prompt_hash IS NOT NULL AND input_hash IS NOT NULL AND prompt_document_id IS NOT NULL))
);
CREATE TABLE decision_input (
    decision_id TEXT NOT NULL REFERENCES decision(id),
    evidence_id TEXT NOT NULL REFERENCES evidence_record(id),
    PRIMARY KEY (decision_id, evidence_id)
);
CREATE TABLE action_execution (
    id TEXT PRIMARY KEY NOT NULL,
    decision_id TEXT REFERENCES decision(id),
    evidence_id TEXT NOT NULL REFERENCES evidence_record(id),
    action_kind TEXT NOT NULL,
    authorized_at TEXT,
    authorization_reference TEXT NOT NULL,
    attempted_at TEXT NOT NULL,
    confirmed_at TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('attempted', 'confirmed', 'failed', 'unknown')),
    external_transaction_id TEXT REFERENCES transaction_event(id),
    CHECK (outcome <> 'confirmed' OR confirmed_at IS NOT NULL)
);
