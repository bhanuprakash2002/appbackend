-- =============================================
-- Schema for twilio-backend PostgreSQL Database
-- Run this file once to set up all tables
-- Usage: psql -U <user> -d <dbname> -f schema.sql
-- =============================================


-- 1. Users table
CREATE TABLE IF NOT EXISTS app_user (
  id            SERIAL PRIMARY KEY,
  phone_e164    TEXT NOT NULL UNIQUE,
  is_verified   BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- 2. Sessions table (JWT + refresh tokens)
CREATE TABLE IF NOT EXISTS session (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  device_id           TEXT NOT NULL,
  jti                 TEXT NOT NULL,
  refresh_token_hash  TEXT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked             BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, device_id)
);


-- 3. FCM registry (Firebase push notification tokens)
CREATE TABLE IF NOT EXISTS fcm_registry (
  phone_e164    TEXT NOT NULL UNIQUE,
  identity      TEXT,
  fcm_token     TEXT NOT NULL,
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fcm_identity ON fcm_registry (identity);


-- 4. Chat messages (AES-256-GCM encrypted)
CREATE TABLE IF NOT EXISTS chat_messages (
  id              TEXT PRIMARY KEY,
  from_identity   TEXT NOT NULL,
  to_identity     TEXT NOT NULL,
  original_text   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted         BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_chat_from ON chat_messages (from_identity);
CREATE INDEX IF NOT EXISTS idx_chat_to   ON chat_messages (to_identity);


-- 5. Deleted messages (per-user soft delete)
CREATE TABLE IF NOT EXISTS deleted_messages (
  message_id  TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  UNIQUE (message_id)
);


-- 6. Active calls (real-time call state)
CREATE TABLE IF NOT EXISTS active_calls (
  caller_identity   TEXT NOT NULL,
  callee_identity   TEXT NOT NULL,
  call_sid          TEXT,
  status            TEXT NOT NULL DEFAULT 'INITIATED',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (caller_identity, callee_identity)
);


-- 7. Call history (permanent log)
CREATE TABLE IF NOT EXISTS call_history (
  id                TEXT PRIMARY KEY,
  caller_identity   TEXT NOT NULL,
  callee_identity   TEXT NOT NULL,
  call_type         TEXT NOT NULL CHECK (call_type IN ('AUDIO', 'VIDEO')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  duration_seconds  NUMERIC,
  deleted_by        TEXT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_call_history_caller ON call_history (caller_identity);
CREATE INDEX IF NOT EXISTS idx_call_history_callee ON call_history (callee_identity);


-- 8. User language preferences
CREATE TABLE IF NOT EXISTS user_language_prefs (
  identity        TEXT PRIMARY KEY,
  preferred_lang  TEXT NOT NULL DEFAULT 'en',
  voice_gender    TEXT NOT NULL DEFAULT 'female',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
