import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let originalCwd;
let tmpDir;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "central-errors-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("recordIntegrationError stores a compact unread error notification", async () => {
  const { db } = await import("../src/db.js");
  const { recordIntegrationError } = await import("../src/errorAlerts.js");

  const result = recordIntegrationError({
    source: "n8n",
    workflow: "Whatsap clinica + Central de Controle",
    node: "Central - Registrar recebida",
    message: "HTTP 500 from Central",
    stack: "Error: HTTP 500\n    at Central - Registrar recebida",
    executionUrl: "https://n8n.example/execution/123",
    occurredAt: "2026-06-30T10:20:30.000-03:00",
  });

  assert.equal(result.type, "error");
  assert.equal(result.title, "🚨Erro no sistema | Felipe Melanda já foi notificado");

  const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(result.id);
  assert.equal(row.type, "error");
  assert.equal(row.read_at, null);
  assert.match(row.body, /Central - Registrar recebida/);
  assert.match(row.body, /HTTP 500 from Central/);
  assert.match(row.body, /https:\/\/n8n\.example\/execution\/123/);
  assert.ok(row.body.length <= 1200);
  db.close();
});
