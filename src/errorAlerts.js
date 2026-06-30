import { db, now } from "./db.js";

const bodyLimit = 1200;
const errorNotificationTitle = "🚨Erro no sistema | Felipe Melanda já foi notificado";

function cleanString(value, maxLength = 255) {
  return String(value || "").trim().slice(0, maxLength);
}

function compactLines(lines) {
  return lines
    .map((line) => cleanString(line, 1000))
    .filter(Boolean)
    .join("\n")
    .slice(0, bodyLimit);
}

export function formatErrorAlertMessage(event = {}) {
  const occurredAt = cleanString(event.occurredAt, 80) || now();
  const source = cleanString(event.source, 80) || "sistema";
  const workflow = cleanString(event.workflow, 180) || "Workflow desconhecido";
  const node = cleanString(event.node || event.lastNodeExecuted, 180) || "Nó não informado";
  const message = cleanString(event.message || event.error, 600) || "Erro sem descrição";
  const executionUrl = cleanString(event.executionUrl || event.url, 500);
  const stack = cleanString(event.stack, 600);

  return compactLines([
    `Data/hora: ${occurredAt}`,
    `Origem: ${source}`,
    `Workflow: ${workflow}`,
    `Nó: ${node}`,
    `Erro: ${message}`,
    executionUrl ? `Execução: ${executionUrl}` : "",
    stack ? `Detalhe: ${stack}` : "",
  ]);
}

export function recordIntegrationError(event = {}) {
  const source = cleanString(event.source, 80) || "sistema";
  const workflow = cleanString(event.workflow, 180) || "Workflow desconhecido";
  const timestamp = cleanString(event.occurredAt, 80) || now();
  const title = errorNotificationTitle;
  const body = formatErrorAlertMessage({ ...event, source, workflow, occurredAt: timestamp });
  const result = db.prepare(`
    INSERT INTO notifications (conversation_id, type, title, body, created_at)
    VALUES (NULL, 'error', ?, ?, ?)
  `).run(title, body, timestamp);

  return {
    id: Number(result.lastInsertRowid),
    type: "error",
    title,
    body,
    createdAt: timestamp,
  };
}
