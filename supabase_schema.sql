-- Supabase Schema DDL for Fingerprint API

-- 1. Configuration/Settings table
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 2. Operators table
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. System Layers table
CREATE TABLE IF NOT EXISTS system_layers (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  metric TEXT NOT NULL,
  description TEXT NOT NULL
);

-- 4. Enrolled Cards table
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  serial TEXT UNIQUE NOT NULL,
  template_format TEXT NOT NULL DEFAULT 'ISO 19794-2',
  minutiae_count INTEGER NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  status TEXT NOT NULL DEFAULT 'active',
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  revocation_reason TEXT
);

-- 5. Audit Logs table (Foreign key relation to cards.id)
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  type TEXT NOT NULL,
  card_id TEXT REFERENCES cards(id) ON DELETE SET NULL,
  holder TEXT,
  details TEXT NOT NULL,
  raw_metrics JSONB DEFAULT '{}'::jsonb,
  receipt JSONB DEFAULT '{}'::jsonb,
  minutiae_map_points JSONB DEFAULT '[]'::jsonb,
  pad_score NUMERIC
);

-- 6. Unlocked Sessions table
CREATE TABLE IF NOT EXISTS unlocked_sessions (
  token TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

-- 7. Enrollment Sessions table
CREATE TABLE IF NOT EXISTS enrollment_sessions (
  id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  card_serial TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 1,
  captures JSONB DEFAULT '[]'::jsonb,
  minutiae_count INTEGER,
  template_hash TEXT,
  status TEXT NOT NULL DEFAULT 'started',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
