-- Orch Supabase Schema
-- Run this in the Supabase SQL Editor to create all tables

-- Tasks (replaces orch-tasks.json)
CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  repo TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  output TEXT,
  pid INTEGER,
  machine_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);

-- Realtime: let orch wake up its task processor on INSERT/UPDATE events instead of
-- polling every 5 seconds. Safe to re-run — adding an existing table is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'tasks'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE tasks';
  END IF;
END $$;

-- Helper function for migration (reset sequence after importing existing IDs)
CREATE OR REPLACE FUNCTION setval_tasks_id(val BIGINT)
RETURNS void AS $$
BEGIN
  PERFORM setval('tasks_id_seq', val);
END;
$$ LANGUAGE plpgsql;

-- Videoscans (replaces videoscans/*.json metadata)
CREATE TABLE IF NOT EXISTS videoscans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  scan_date TIMESTAMPTZ NOT NULL,
  pages_scanned INTEGER NOT NULL DEFAULT 0,
  pages_with_video INTEGER NOT NULL DEFAULT 0,
  unique_players INTEGER NOT NULL DEFAULT 0,
  player_summary JSONB NOT NULL DEFAULT '{}',
  details JSONB NOT NULL DEFAULT '[]',
  scan_state JSONB NOT NULL DEFAULT '{}',
  has_report BOOLEAN NOT NULL DEFAULT false,
  has_pdf BOOLEAN NOT NULL DEFAULT false,
  can_resume BOOLEAN NOT NULL DEFAULT false,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_videoscans_domain ON videoscans(domain);

-- Feedback (replaces .orch-feedback.json)
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  action_id TEXT,
  action_title TEXT,
  action_task_type TEXT,
  source_type TEXT,
  source_id TEXT,
  reason TEXT,
  chat_context TEXT,
  processed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Notifications (replaces notification-log.jsonl)
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

-- Settings (per-machine, replaces .orch-settings.json)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, machine_id)
);

-- Orchestrator rules (singleton, replaces .orch-rules.md)
CREATE TABLE IF NOT EXISTS orchestrator_rules (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
