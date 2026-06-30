import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve("data");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, "media"), { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "central.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    name TEXT,
    instance TEXT,
    control_mode TEXT NOT NULL DEFAULT 'ai' CHECK(control_mode IN ('ai', 'human')),
    handoff_reason TEXT,
    unread_count INTEGER NOT NULL DEFAULT 0,
    last_message TEXT,
    last_message_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
    sender_type TEXT NOT NULL CHECK(sender_type IN ('patient', 'ai', 'human', 'system')),
    text TEXT NOT NULL,
    external_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(external_id)
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    patient_name TEXT NOT NULL,
    age TEXT,
    phone TEXT NOT NULL,
    reason TEXT,
    preferred_date TEXT,
    doctor TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'contacted', 'confirmed', 'cancelled')),
    raw_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_conversations_updated
    ON conversations(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_appointments_created
    ON appointments(created_at DESC);

  UPDATE appointments
  SET status = 'pending', updated_at = CURRENT_TIMESTAMP
  WHERE status = 'contacted';
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("messages", "content_type", "TEXT NOT NULL DEFAULT 'text'");
ensureColumn("messages", "media_url", "TEXT");
ensureColumn("messages", "media_mime", "TEXT");
ensureColumn("messages", "media_filename", "TEXT");

export function now() {
  return new Date().toISOString();
}

export function getSetting(key, fallback = "") {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
  return row?.value ?? fallback;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, String(value), now());
}

export function isAiEnabled() {
  return getSetting("ai_enabled", "true") !== "false";
}

export function findOrCreateConversation({ phone, name, instance }) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO conversations (phone, name, instance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      name = COALESCE(NULLIF(excluded.name, ''), conversations.name),
      instance = COALESCE(NULLIF(excluded.instance, ''), conversations.instance),
      updated_at = excluded.updated_at
  `).run(phone, name || null, instance || null, timestamp, timestamp);
  return db.prepare("SELECT * FROM conversations WHERE phone = ?").get(phone);
}

export function addMessage({
  phone,
  name,
  instance,
  direction,
  senderType,
  text,
  contentType = "text",
  mediaUrl,
  mediaMime,
  mediaFilename,
  externalId,
  createdAt,
}) {
  const conversation = findOrCreateConversation({ phone, name, instance });
  const timestamp = createdAt || now();
  const mediaLabels = {
    audio: "[Áudio]",
    image: "[Imagem]",
    document: "[Documento]",
  };
  const displayText = text || mediaLabels[contentType] || "";
  const result = db.prepare(`
    INSERT OR IGNORE INTO messages
      (conversation_id, direction, sender_type, text, content_type, media_url,
       media_mime, media_filename, external_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    conversation.id,
    direction,
    senderType,
    displayText,
    contentType,
    mediaUrl || null,
    mediaMime || null,
    mediaFilename || null,
    externalId || null,
    timestamp,
  );

  if (result.changes) {
    db.prepare(`
      UPDATE conversations
      SET last_message = ?, last_message_at = ?, updated_at = ?,
          unread_count = unread_count + ?
      WHERE id = ?
    `).run(displayText, timestamp, timestamp, direction === "inbound" ? 1 : 0, conversation.id);
  }
  return { conversationId: conversation.id, inserted: Boolean(result.changes) };
}
