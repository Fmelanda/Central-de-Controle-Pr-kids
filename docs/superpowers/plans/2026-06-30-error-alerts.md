# Error Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add non-silent error reporting for the n8n clinic workflow and the Central dashboard.

**Architecture:** n8n gets a dedicated Error Trigger workflow that sends a WhatsApp alert to the administrator and posts a compact error event into the Central. The Central exposes `POST /api/integrations/errors`, stores the event as a notification of type `error`, and uses the same notification stream already used by handoff and appointment events.

**Tech Stack:** Node.js 22, `node:test`, SQLite through `node:sqlite`, n8n workflow JSON, Evolution API n8n node.

---

### Task 1: Central Error Notification Helper

**Files:**
- Create: `tests/errorAlerts.test.js`
- Create: `src/errorAlerts.js`

- [x] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "central-errors-"));
  process.chdir(tmpDir);
});

afterEach(() => {
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
  assert.equal(result.title, "Erro no n8n: Whatsap clinica + Central de Controle");

  const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(result.id);
  assert.equal(row.type, "error");
  assert.equal(row.read_at, null);
  assert.match(row.body, /Central - Registrar recebida/);
  assert.match(row.body, /HTTP 500 from Central/);
  assert.match(row.body, /https:\/\/n8n\.example\/execution\/123/);
  assert.ok(row.body.length <= 1200);
  db.close();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/errorAlerts.test.js`

Expected: FAIL with `Cannot find module '../src/errorAlerts.js'`.

- [x] **Step 3: Implement `recordIntegrationError`**

Create `src/errorAlerts.js` with input cleanup, title/body formatting, truncation, SQLite insert, and return metadata.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/errorAlerts.test.js`

Expected: PASS.

### Task 2: Central Integration Endpoint

**Files:**
- Modify: `src/server.js`
- Modify: `README.md`

- [x] **Step 1: Add endpoint**

Import `recordIntegrationError`, add `POST /api/integrations/errors`, require `source` and `message`, insert notification, emit `notifications`, and return `201`.

- [x] **Step 2: Document endpoint**

Add README section showing payload and n8n use.

- [x] **Step 3: Validate syntax**

Run: `node --check src/server.js`

Expected: exit 0.

### Task 3: n8n Error Handler Workflow

**Files:**
- Create: `n8n/Central - Error Handler.json`

- [x] **Step 1: Create workflow JSON**

Workflow nodes: `Error Trigger`, `Preparar alerta`, `Enviar alerta WhatsApp`, `Central - Registrar erro`.

- [x] **Step 2: Validate workflow JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('n8n/Central - Error Handler.json','utf8')); console.log('ok')"`

Expected: `ok`.

### Task 4: Final Verification

**Files:**
- All changed files.

- [x] **Step 1: Run tests**

Run: `npm test`

Expected: all tests pass.

- [x] **Step 2: Inspect workflow**

Confirm the workflow contains the administrator WhatsApp number `13467926991@s.whatsapp.net`, uses `CENTRAL_INTEGRATION_KEY`, and posts to `/api/integrations/errors`.
