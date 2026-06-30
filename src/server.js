import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { addMessage, db, findOrCreateConversation, isAiEnabled, now, setSetting } from "./db.js";
import { formatErrorAlertMessage, recordIntegrationError } from "./errorAlerts.js";
import { checkServiceStatuses, serviceStatusConfig } from "./serviceStatus.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const isProduction = process.env.NODE_ENV === "production";
const publicDir = path.resolve("public");
const mediaDir = path.resolve("data", "media");
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 15 * 1024 * 1024);
const maxMediaBytes = Number(process.env.MAX_MEDIA_BYTES || 8 * 1024 * 1024);
const maxTextLength = Number(process.env.MAX_TEXT_LENGTH || 4000);
const loginRateLimit = Number(process.env.LOGIN_RATE_LIMIT || 10);
const integrationRateLimit = Number(process.env.INTEGRATION_RATE_LIMIT || 600);
const clients = new Set();
const loginAttempts = new Map();
const integrationAttempts = new Map();
const allowedContentTypes = new Set(["text", "audio", "image", "document"]);
const allowedDirections = new Set(["inbound", "outbound"]);
const allowedSenderTypes = new Set(["patient", "ai", "human", "system"]);
const mediaLabels = {
  audio: "[Áudio]",
  image: "[Imagem]",
  document: "[Documento]",
};
const placeholderSecrets = new Set([
  "desenvolvimento-local",
  "troque-esta-senha",
  "troque-por-uma-chave-longa-e-aleatoria",
  "troque-por-outra-chave-longa-e-aleatoria",
  "changeme",
  "change-me",
  "password",
  "senha",
]);
const mediaTypes = {
  audio: {
    defaultMime: "audio/ogg",
    defaultExtension: ".ogg",
    allowedMimes: new Set(["audio/ogg", "audio/opus", "application/ogg"]),
    extensions: new Map([
      ["audio/ogg", ".ogg"],
      ["audio/opus", ".ogg"],
      ["application/ogg", ".ogg"],
    ]),
  },
  image: {
    defaultMime: "image/jpeg",
    defaultExtension: ".jpg",
    allowedMimes: new Set(["image/jpeg", "image/png", "image/webp"]),
    extensions: new Map([
      ["image/jpeg", ".jpg"],
      ["image/png", ".png"],
      ["image/webp", ".webp"],
    ]),
  },
  document: {
    defaultMime: "application/pdf",
    defaultExtension: ".pdf",
    allowedMimes: new Set([
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]),
    extensions: new Map([
      ["application/pdf", ".pdf"],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
    ]),
  },
};

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function securityHeaders(headers = {}) {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob: http: https:",
      "media-src 'self' http: https:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    ...headers,
  };
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, securityHeaders({
    "content-type": "application/json; charset=utf-8",
    ...headers,
  }));
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        if (!settled) {
          settled = true;
          reject(httpError(413, "Payload muito grande"));
        }
        return;
      }
      if (!settled) chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const data = Buffer.concat(chunks).toString("utf8");
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(httpError(400, "JSON inválido"));
      }
    });

    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function emit(event, payload = {}) {
  const packet = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(packet);
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((part) => {
        const index = part.indexOf("=");
        const key = index === -1 ? part.trim() : part.slice(0, index).trim();
        const value = index === -1 ? "" : part.slice(index + 1);
        return [key, decodeURIComponent(value || "")];
      })
      .filter(([key]) => key),
  );
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sessionSecret() {
  return process.env.SESSION_SECRET || "desenvolvimento-local";
}

function sessionToken() {
  const expiry = Date.now() + 12 * 60 * 60 * 1000;
  const payload = String(expiry);
  const signature = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

function validSession(req) {
  if (!process.env.DASHBOARD_PASSWORD) return !isProduction;
  const [expiry, signature] = (cookies(req).central_session || "").split(".");
  if (!expiry || Number(expiry) < Date.now() || !signature) return false;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(expiry).digest("hex");
  return safeEqual(signature, expected);
}

function csrfToken(req) {
  const session = cookies(req).central_session;
  if (!session) return "";
  return crypto.createHmac("sha256", sessionSecret()).update(`csrf:${session}`).digest("hex");
}

function unsafeDashboardMethod(req) {
  return !["GET", "HEAD", "OPTIONS"].includes(req.method);
}

function validCsrf(req) {
  if (!unsafeDashboardMethod(req)) return true;
  return safeEqual(req.headers["x-csrf-token"], csrfToken(req));
}

function validIntegration(req) {
  const expected = process.env.INTEGRATION_KEY;
  if (!expected) return !isProduction;
  return safeEqual(req.headers["x-integration-key"], expected);
}

function cookieAttributes() {
  const secure = process.env.COOKIE_SECURE === "true" ||
    (process.env.APP_URL || "").startsWith("https://");
  return `HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`;
}

function clientIp(req) {
  if (process.env.TRUST_PROXY === "true" && req.headers["x-forwarded-for"]) {
    return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function rateLimit(req, res, store, limit, windowMs) {
  if (!limit || limit < 1) return false;
  const timestamp = Date.now();
  if (store.size > 2000) {
    for (const [key, entry] of store) {
      if (entry.resetAt <= timestamp) store.delete(key);
    }
  }

  const key = `${clientIp(req)}:${req.method}:${req.url.split("?")[0]}`;
  const entry = store.get(key);
  if (!entry || entry.resetAt <= timestamp) {
    store.set(key, { count: 1, resetAt: timestamp + windowMs });
    return false;
  }

  entry.count += 1;
  if (entry.count <= limit) return false;

  const retryAfter = Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000));
  sendJson(res, 429, { error: "Muitas tentativas. Tente novamente em instantes." }, {
    "retry-after": String(retryAfter),
  });
  return true;
}

function resolveInside(root, relativePath) {
  const cleanInput = String(relativePath || "").replace(/^[/\\]+/, "");
  let decoded;
  try {
    decoded = decodeURIComponent(cleanInput);
  } catch {
    return null;
  }
  const file = path.resolve(root, decoded);
  const relative = path.relative(root, file);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) return null;
  return file;
}

function isReadableFile(file) {
  try {
    return Boolean(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = resolveInside(publicDir, requested);
  if (!isReadableFile(file)) return false;

  const extension = path.extname(file).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  res.writeHead(200, securityHeaders({
    "content-type": types[extension] || "application/octet-stream",
    "cache-control": [".html", ".css", ".js"].includes(extension)
      ? "no-store"
      : "public, max-age=3600",
  }));
  fs.createReadStream(file).pipe(res);
  return true;
}

function serveMedia(req, res, pathname) {
  if (!validSession(req)) {
    sendJson(res, 401, { error: "Não autenticado" });
    return true;
  }
  const relative = pathname.replace(/^\/media\//, "");
  const file = resolveInside(mediaDir, relative);
  if (!isReadableFile(file)) {
    sendJson(res, 404, { error: "Arquivo não encontrado" });
    return true;
  }

  const extension = path.extname(file).toLowerCase();
  const types = {
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  const disposition = extension === ".pdf" || extension === ".docx"
    ? `attachment; filename="${path.basename(file).replaceAll('"', "")}"`
    : "inline";
  res.writeHead(200, securityHeaders({
    "content-type": types[extension] || "application/octet-stream",
    "content-disposition": disposition,
    "cache-control": "private, max-age=3600",
  }));
  fs.createReadStream(file).pipe(res);
  return true;
}

function inferContentType(body) {
  const explicit = body.contentType || body.messageType;
  if (explicit) {
    const normalized = String(explicit).toLowerCase();
    if (normalized.includes("audio")) return "audio";
    if (normalized.includes("image")) return "image";
    if (normalized.includes("document")) return "document";
    if (normalized.includes("text") || normalized.includes("conversation")) return "text";
    return normalized;
  }
  if (body.audio || body.audioBase64 || body.audioUrl) return "audio";
  if (body.image || body.imageBase64 || body.imageUrl) return "image";
  if (body.document || body.documentBase64 || body.documentUrl) return "document";
  if (body.mediaBase64 || body.mediaUrl) {
    const mime = normalizeMime(body.mediaMime || body.mimeType || "");
    if (mime.startsWith("image/")) return "image";
    if (mime === "application/pdf" || mime.includes("wordprocessingml")) return "document";
    if (mime.startsWith("audio/") || mime === "application/ogg") return "audio";
  }
  return "text";
}

function mediaPayload(body, contentType) {
  const payload = body[contentType] || body.media || {};
  return payload && typeof payload === "object" ? payload : { base64: payload };
}

function mediaFilename(input, fallback) {
  const filename = path.basename(String(input || fallback)).replace(/[^\w.\-() ]/g, "_");
  return (filename || fallback).slice(0, 140);
}

function normalizeMime(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function safeMediaUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/media/")) return raw;
  throw httpError(400, "URL de midia externa nao permitida. Envie a midia em base64.");
}

function decodeBase64Media(input) {
  let raw = String(input || "").trim();
  let mimeFromDataUrl = "";
  const match = raw.match(/^data:([^;]+);base64,(.*)$/is);
  if (match) {
    mimeFromDataUrl = normalizeMime(match[1]);
    raw = match[2];
  }

  const cleanBase64 = raw.replace(/\s/g, "");
  if (!cleanBase64 || cleanBase64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64)) {
    throw httpError(400, "Mídia base64 inválida");
  }

  const estimatedBytes = Math.ceil((cleanBase64.length * 3) / 4);
  if (estimatedBytes > maxMediaBytes) {
    throw httpError(413, `Mídia muito grande. Limite atual: ${maxMediaBytes} bytes`);
  }

  const bytes = Buffer.from(cleanBase64, "base64");
  if (!bytes.length || bytes.length > maxMediaBytes) {
    throw httpError(400, "Mídia vazia ou inválida");
  }
  return { bytes, mimeFromDataUrl };
}

function assertMediaSignature(contentType, mimeType, bytes) {
  if (contentType === "audio" && bytes.toString("ascii", 0, 4) !== "OggS") {
    throw httpError(400, "Arquivo de áudio inválido. Envie OGG/Opus.");
  }
  if (mimeType === "image/jpeg" && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    throw httpError(400, "Imagem JPEG inválida");
  }
  if (mimeType === "image/png") {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!bytes.subarray(0, png.length).equals(png)) throw httpError(400, "Imagem PNG inválida");
  }
  if (mimeType === "image/webp") {
    const isWebp = bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";
    if (!isWebp) throw httpError(400, "Imagem WebP inválida");
  }
  if (mimeType === "application/pdf" && bytes.toString("ascii", 0, 4) !== "%PDF") {
    throw httpError(400, "PDF inválido");
  }
  if (mimeType.includes("wordprocessingml") && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw httpError(400, "DOCX inválido");
  }
}

function saveMedia(body, contentType) {
  const config = mediaTypes[contentType];
  if (!config) return {};
  const media = mediaPayload(body, contentType);
  const base64Input =
    body[`${contentType}Base64`] ||
    body.mediaBase64 ||
    media.base64;
  const mediaUrl =
    body[`${contentType}Url`] ||
    body.mediaUrl ||
    media.url;

  if (mediaUrl && !base64Input) {
    const mimeType = normalizeMime(
      body.mediaMime ||
      body.mimeType ||
      media.mimeType ||
      config.defaultMime,
    );
    if (!config.allowedMimes.has(mimeType)) {
      throw httpError(400, `Tipo de mídia não permitido: ${mimeType}`);
    }
    return {
      mediaUrl: safeMediaUrl(mediaUrl),
      mediaMime: mimeType,
      mediaFilename: mediaFilename(media.filename, `arquivo${config.defaultExtension}`),
    };
  }
  if (!base64Input) return {};

  const { bytes, mimeFromDataUrl } = decodeBase64Media(base64Input);
  const mimeType = normalizeMime(
    body.mediaMime ||
    body.mimeType ||
    media.mimeType ||
    mimeFromDataUrl ||
    config.defaultMime,
  );
  if (!config.allowedMimes.has(mimeType)) {
    throw httpError(400, `Tipo de mídia não permitido: ${mimeType}`);
  }
  assertMediaSignature(contentType, mimeType, bytes);

  const extension = config.extensions.get(mimeType) || config.defaultExtension;
  const date = new Date();
  const folder = path.join(
    mediaDir,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
  );
  fs.mkdirSync(folder, { recursive: true });
  const filename = `${crypto.randomUUID()}${extension}`;
  const file = path.join(folder, filename);
  fs.writeFileSync(file, bytes, { flag: "wx" });
  const relative = path.relative(mediaDir, file).replaceAll(path.sep, "/");
  return {
    mediaUrl: `/media/${relative}`,
    mediaMime: mimeType,
    mediaFilename: mediaFilename(media.filename, filename),
  };
}

function cleanString(value, maxLength = 255) {
  return String(value || "").trim().slice(0, maxLength);
}

function textOrEmpty(value) {
  const text = String(value || "");
  if (text.length > maxTextLength) {
    throw httpError(413, `Texto muito grande. Limite atual: ${maxTextLength} caracteres`);
  }
  return text;
}

function normalizePhone(phone) {
  return String(phone || "").replace(/@(s\.whatsapp\.net|c\.us)$/i, "");
}

async function sendEvolutionMessage(conversation, text) {
  const baseUrl = (process.env.EVOLUTION_API_URL || "").replace(/\/$/, "");
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instance = conversation.instance || process.env.EVOLUTION_DEFAULT_INSTANCE;
  if (!baseUrl || !apiKey || !instance) {
    throw new Error("Configure EVOLUTION_API_URL, EVOLUTION_API_KEY e a instância");
  }

  const timeoutMs = Number(process.env.EVOLUTION_TIMEOUT_MS || 15000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${baseUrl}/message/sendText/${encodeURIComponent(instance)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", apikey: apiKey },
        body: JSON.stringify({ number: normalizePhone(conversation.phone), text }),
        signal: controller.signal,
      },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.message || `Evolution API respondeu ${response.status}`);
    }
    return result;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Evolution API demorou para responder");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function notifyAdminAboutServerError(error, req) {
  const phone = process.env.ERROR_ALERT_PHONE;
  if (!phone) return;

  const event = {
    source: "central",
    workflow: "Central de Controle",
    node: `${req.method} ${String(req.url || "/").split("?")[0]}`,
    message: error.message || "Erro interno",
    stack: isProduction ? "" : error.stack,
    occurredAt: now(),
  };

  try {
    await sendEvolutionMessage({
      phone,
      instance: process.env.ERROR_ALERT_INSTANCE || process.env.EVOLUTION_DEFAULT_INSTANCE,
    }, `🚨 Erro na Central\n\n${formatErrorAlertMessage(event)}`);
  } catch (alertError) {
    console.warn("[alerta] Falha ao enviar alerta de erro no WhatsApp:", alertError.message);
  }
}

function requireFields(body, fields) {
  return fields.filter((field) => body[field] === undefined || body[field] === "");
}

function responseMessage(contentType, text) {
  return text || mediaLabels[contentType] || "";
}

function settingsPayload() {
  const aiEnabled = isAiEnabled();
  return {
    aiEnabled,
    manualMode: !aiEnabled,
  };
}

function effectiveControlMode(controlMode, settings = settingsPayload()) {
  return settings.aiEnabled ? controlMode || "ai" : "human";
}

function withEffectiveControlMode(conversation, settings = settingsPayload()) {
  if (!conversation) return conversation;
  return {
    ...conversation,
    effective_control_mode: effectiveControlMode(conversation.control_mode, settings),
  };
}

async function handleIntegration(req, res, pathname) {
  if (rateLimit(req, res, integrationAttempts, integrationRateLimit, 60 * 1000)) return;
  if (!validIntegration(req)) return sendJson(res, 401, { error: "Chave de integração inválida" });

  const controlMatch = pathname.match(/^\/api\/integrations\/conversations\/(.+)\/control$/);
  if (req.method === "GET" && controlMatch) {
    const phone = decodeURIComponent(controlMatch[1]);
    const conversation = db.prepare(
      "SELECT id, phone, control_mode, handoff_reason FROM conversations WHERE phone = ?",
    ).get(phone);
    const settings = settingsPayload();
    const effectiveConversation = withEffectiveControlMode(conversation, settings);
    return sendJson(res, 200, {
      exists: Boolean(effectiveConversation),
      mode: effectiveControlMode(effectiveConversation?.control_mode, settings),
      ...settings,
      conversation: effectiveConversation,
    });
  }

  const body = await readBody(req);

  if (req.method === "POST" && pathname === "/api/integrations/errors") {
    const missing = requireFields(body, ["source", "message"]);
    if (missing.length) return sendJson(res, 400, { error: `Campos obrigatórios: ${missing.join(", ")}` });

    const notification = recordIntegrationError(body);
    emit("notifications", { notificationId: notification.id, type: "error" });
    return sendJson(res, 201, notification);
  }

  if (req.method === "POST" && pathname === "/api/integrations/messages") {
    const missing = requireFields(body, ["phone", "direction"]);
    if (missing.length) return sendJson(res, 400, { error: `Campos obrigatórios: ${missing.join(", ")}` });

    const phone = cleanString(body.phone, 100);
    const direction = cleanString(body.direction, 20);
    if (!allowedDirections.has(direction)) return sendJson(res, 400, { error: "Direção inválida" });

    const contentType = inferContentType(body);
    if (!allowedContentTypes.has(contentType)) return sendJson(res, 400, { error: "Tipo de conteúdo inválido" });

    const text = textOrEmpty(body.text);
    const hasText = text !== "";
    if (contentType === "text" && !hasText) return sendJson(res, 400, { error: "Campo obrigatório: text" });

    const senderType = cleanString(
      body.senderType || (direction === "inbound" ? "patient" : "ai"),
      20,
    );
    if (!allowedSenderTypes.has(senderType)) return sendJson(res, 400, { error: "Remetente inválido" });

    const media = saveMedia(body, contentType);
    if (contentType !== "text" && !media.mediaUrl) {
      return sendJson(res, 400, { error: "Envie a mídia em base64 ou uma URL válida" });
    }

    const result = addMessage({
      phone,
      name: cleanString(body.name, 140),
      instance: cleanString(body.instance, 100),
      direction,
      senderType,
      text: responseMessage(contentType, text),
      contentType,
      mediaUrl: media.mediaUrl,
      mediaMime: media.mediaMime,
      mediaFilename: media.mediaFilename,
      externalId: cleanString(body.externalId, 180),
      createdAt: body.createdAt,
    });
    emit("messages", result);
    return sendJson(res, 201, result);
  }

  if (req.method === "POST" && pathname === "/api/integrations/handoff") {
    const missing = requireFields(body, ["phone"]);
    if (missing.length) return sendJson(res, 400, { error: "Campo obrigatório: phone" });
    const conversation = findOrCreateConversation({
      phone: cleanString(body.phone, 100),
      name: cleanString(body.name, 140),
      instance: cleanString(body.instance, 100),
    });
    const reason = cleanString(body.reason, 500) || "O agente solicitou atendimento humano";
    db.prepare(`
      UPDATE conversations SET control_mode = 'human', handoff_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(reason, now(), conversation.id);
    db.prepare(`
      INSERT INTO notifications (conversation_id, type, title, body, created_at)
      VALUES (?, 'handoff', 'Atendimento humano solicitado', ?, ?)
    `).run(conversation.id, `${body.name || body.phone}: ${reason}`.slice(0, 700), now());
    emit("handoff", { conversationId: conversation.id });
    return sendJson(res, 201, { conversationId: conversation.id, mode: "human" });
  }

  if (req.method === "POST" && pathname === "/api/integrations/appointments") {
    const appointment = body.consulta || body;
    const missing = requireFields(appointment, ["nome", "telefone"]);
    if (missing.length) return sendJson(res, 400, { error: `Campos obrigatórios: ${missing.join(", ")}` });
    const phone = cleanString(appointment.telefone, 100);
    const conversation = db.prepare("SELECT * FROM conversations WHERE phone = ?")
      .get(phone) || findOrCreateConversation({
        phone,
        name: cleanString(appointment.nome, 140),
        instance: cleanString(body.instance, 100),
      });
    const timestamp = now();
    const result = db.prepare(`
      INSERT INTO appointments
        (conversation_id, patient_name, age, phone, reason, preferred_date, doctor,
         raw_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversation.id,
      cleanString(appointment.nome, 140),
      cleanString(appointment.idade, 50) || null,
      phone,
      cleanString(appointment.motivo, 500) || null,
      cleanString(appointment.data, 160) || null,
      cleanString(appointment.medico, 160) || null,
      JSON.stringify(body).slice(0, 20000),
      timestamp,
      timestamp,
    );
    db.prepare(`
      INSERT INTO notifications (conversation_id, type, title, body, created_at)
      VALUES (?, 'appointment', 'Nova solicitação de consulta', ?, ?)
    `).run(conversation.id, `${appointment.nome} solicitou uma consulta`.slice(0, 500), timestamp);
    emit("appointments", { appointmentId: Number(result.lastInsertRowid) });
    return sendJson(res, 201, { id: Number(result.lastInsertRowid) });
  }

  return sendJson(res, 404, { error: "Endpoint não encontrado" });
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (pathname.startsWith("/api/integrations/")) {
    return handleIntegration(req, res, pathname);
  }

  if (req.method === "POST" && pathname === "/api/login") {
    if (rateLimit(req, res, loginAttempts, loginRateLimit, 15 * 60 * 1000)) return;
    const body = await readBody(req);
    const validUser = safeEqual(body.user, process.env.DASHBOARD_USER || "admin");
    const validPassword = process.env.DASHBOARD_PASSWORD
      ? safeEqual(body.password, process.env.DASHBOARD_PASSWORD)
      : !isProduction;
    if (!validUser || !validPassword) return sendJson(res, 401, { error: "Usuário ou senha incorretos" });
    return sendJson(res, 200, { ok: true }, {
      "set-cookie": `central_session=${sessionToken()}; ${cookieAttributes()}`,
    });
  }

  if (req.method === "GET" && pathname === "/api/session") {
    const authenticated = validSession(req);
    return sendJson(res, authenticated ? 200 : 401, {
      authenticated,
      authRequired: Boolean(process.env.DASHBOARD_PASSWORD),
      csrfToken: authenticated ? csrfToken(req) : undefined,
    });
  }

  if (!validSession(req)) return sendJson(res, 401, { error: "Não autenticado" });

  if (!validCsrf(req)) return sendJson(res, 403, { error: "Token de seguranca invalido" });

  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, securityHeaders({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    }));
    res.write("event: connected\ndata: {}\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "GET" && pathname === "/api/summary") {
    const services = await checkServiceStatuses(serviceStatusConfig());
    const settings = settingsPayload();
    const human = settings.aiEnabled
      ? db.prepare("SELECT COUNT(*) total FROM conversations WHERE control_mode = 'human'").get().total
      : db.prepare("SELECT COUNT(*) total FROM conversations").get().total;
    const humanUnread = settings.aiEnabled
      ? db.prepare("SELECT COUNT(*) total FROM conversations WHERE control_mode = 'human' AND unread_count > 0").get().total
      : db.prepare("SELECT COUNT(*) total FROM conversations WHERE unread_count > 0").get().total;
    return sendJson(res, 200, {
      human,
      humanUnread,
      unread: db.prepare("SELECT COALESCE(SUM(unread_count), 0) total FROM conversations").get().total,
      pendingAppointments: db.prepare("SELECT COUNT(*) total FROM appointments WHERE status = 'pending'").get().total,
      notifications: db.prepare("SELECT COUNT(*) total FROM notifications WHERE read_at IS NULL").get().total,
      ...settings,
      services,
    });
  }

  if (req.method === "GET" && pathname === "/api/settings") {
    return sendJson(res, 200, settingsPayload());
  }

  if (req.method === "PATCH" && pathname === "/api/settings/ai") {
    const body = await readBody(req);
    if (typeof body.enabled !== "boolean") {
      return sendJson(res, 400, { error: "Campo obrigatorio: enabled booleano" });
    }
    setSetting("ai_enabled", body.enabled ? "true" : "false");
    const settings = settingsPayload();
    emit("settings", settings);
    return sendJson(res, 200, settings);
  }

  if (req.method === "DELETE" && pathname === "/api/conversations") {
    const result = db.prepare("DELETE FROM conversations").run();
    emit("messages", {});
    emit("notifications", {});
    return sendJson(res, 200, { ok: true, deleted: result.changes });
  }

  if (req.method === "DELETE" && pathname === "/api/appointments") {
    const result = db.prepare("DELETE FROM appointments").run();
    emit("appointments", {});
    return sendJson(res, 200, { ok: true, deleted: result.changes });
  }

  if (req.method === "DELETE" && pathname === "/api/notifications") {
    const result = db.prepare("DELETE FROM notifications").run();
    emit("notifications", {});
    return sendJson(res, 200, { ok: true, deleted: result.changes });
  }

  if (req.method === "GET" && pathname === "/api/conversations") {
    const search = `%${url.searchParams.get("search") || ""}%`;
    const mode = url.searchParams.get("mode");
    const settings = settingsPayload();
    const rows = db.prepare(`
      SELECT * FROM conversations
      WHERE COALESCE(name, '') LIKE ? OR phone LIKE ?
      ORDER BY COALESCE(last_message_at, updated_at) DESC
    `).all(search, search)
      .map((conversation) => withEffectiveControlMode(conversation, settings))
      .filter((conversation) =>
        mode && ["ai", "human"].includes(mode)
          ? conversation.effective_control_mode === mode
          : true);
    return sendJson(res, 200, rows);
  }

  const conversationMatch = pathname.match(/^\/api\/conversations\/(\d+)$/);
  if (req.method === "GET" && conversationMatch) {
    const id = Number(conversationMatch[1]);
    const conversation = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
    if (!conversation) return sendJson(res, 404, { error: "Conversa não encontrada" });
    db.prepare("UPDATE conversations SET unread_count = 0 WHERE id = ?").run(id);
    const messages = db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at",
    ).all(id);
    return sendJson(res, 200, { conversation: withEffectiveControlMode(conversation), messages });
  }

  const controlMatch = pathname.match(/^\/api\/conversations\/(\d+)\/control$/);
  if (req.method === "PATCH" && controlMatch) {
    const body = await readBody(req);
    if (!["ai", "human"].includes(body.mode)) return sendJson(res, 400, { error: "Modo inválido" });
    const id = Number(controlMatch[1]);
    const result = db.prepare(`
      UPDATE conversations SET control_mode = ?, handoff_reason = NULL, updated_at = ?
      WHERE id = ?
    `).run(body.mode, now(), id);
    if (!result.changes) return sendJson(res, 404, { error: "Conversa não encontrada" });
    const effectiveMode = effectiveControlMode(body.mode);
    emit("control", { conversationId: id, mode: body.mode, effectiveMode });
    return sendJson(res, 200, { id, mode: body.mode, effectiveMode });
  }

  const messageMatch = pathname.match(/^\/api\/conversations\/(\d+)\/messages$/);
  if (req.method === "POST" && messageMatch) {
    const body = await readBody(req);
    const text = textOrEmpty(body.text).trim();
    if (!text) return sendJson(res, 400, { error: "Digite uma mensagem" });
    const id = Number(messageMatch[1]);
    const conversation = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
    if (!conversation) return sendJson(res, 404, { error: "Conversa não encontrada" });
    if (effectiveControlMode(conversation.control_mode) !== "human") {
      return sendJson(res, 409, { error: "Assuma o atendimento antes de enviar uma mensagem" });
    }
    try {
      const evolution = await sendEvolutionMessage(conversation, text);
      const externalId = evolution?.key?.id || evolution?.message?.key?.id;
      addMessage({
        phone: conversation.phone,
        name: conversation.name,
        instance: conversation.instance,
        direction: "outbound",
        senderType: "human",
        text,
        externalId,
      });
      emit("messages", { conversationId: id });
      return sendJson(res, 201, { ok: true });
    } catch (error) {
      return sendJson(res, 502, { error: error.message });
    }
  }

  if (req.method === "GET" && pathname === "/api/appointments") {
    const rows = db.prepare(`
      SELECT a.*, c.name conversation_name
      FROM appointments a LEFT JOIN conversations c ON c.id = a.conversation_id
      ORDER BY a.created_at DESC
    `).all();
    return sendJson(res, 200, rows);
  }

  const appointmentMatch = pathname.match(/^\/api\/appointments\/(\d+)$/);
  if (req.method === "PATCH" && appointmentMatch) {
    const body = await readBody(req);
    if (!["pending", "confirmed", "cancelled"].includes(body.status)) {
      return sendJson(res, 400, { error: "Status inválido" });
    }
    const result = db.prepare("UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?")
      .run(body.status, now(), Number(appointmentMatch[1]));
    if (!result.changes) return sendJson(res, 404, { error: "Consulta não encontrada" });
    emit("appointments", { appointmentId: Number(appointmentMatch[1]) });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/api/notifications") {
    return sendJson(res, 200, db.prepare(`
      SELECT n.*, c.name, c.phone FROM notifications n
      LEFT JOIN conversations c ON c.id = n.conversation_id
      ORDER BY n.created_at DESC LIMIT 30
    `).all());
  }

  if (req.method === "POST" && pathname === "/api/notifications/read") {
    db.prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL").run(now());
    emit("notifications", {});
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "Endpoint não encontrado" });
}

function configProblems() {
  const required = ["DASHBOARD_PASSWORD", "SESSION_SECRET", "INTEGRATION_KEY"];
  return required.filter((name) => {
    const value = String(process.env[name] || "").trim();
    const normalized = value.toLowerCase();
    return !value || placeholderSecrets.has(normalized) || normalized.startsWith("troque-por-");
  });
}

function warnWeakConfig() {
  const weakHints = [
    ["DASHBOARD_PASSWORD", 10],
    ["SESSION_SECRET", 32],
    ["INTEGRATION_KEY", 24],
  ].filter(([name, minLength]) => String(process.env[name] || "").length < minLength);

  for (const [name, minLength] of weakHints) {
    console.warn(`[segurança] ${name} deveria ter pelo menos ${minLength} caracteres.`);
  }
}

function assertProductionConfig() {
  const problems = configProblems();
  if (isProduction && problems.length) {
    throw new Error(`Configuração obrigatória ausente ou insegura em produção: ${problems.join(", ")}`);
  }
  if (!isProduction && problems.length) {
    console.warn(`[segurança] Configuração ausente/insegura: ${problems.join(", ")}.`);
  }
  warnWeakConfig();
}

const server = http.createServer(async (req, res) => {
  const rawPathname = String(req.url || "/").split("?")[0] || "/";
  let url;
  try {
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      throw httpError(400, "Requisicao invalida");
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (rawPathname.startsWith("/media/")) return serveMedia(req, res, rawPathname);
    if (req.method !== "GET") return sendJson(res, 405, { error: "Método não permitido" });
    if (!serveStatic(res, url.pathname)) {
      if (path.extname(url.pathname)) return sendJson(res, 404, { error: "Arquivo não encontrado" });
      serveStatic(res, "/");
    }
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    if (statusCode >= 500) {
      console.error(error);
      if (url?.pathname !== "/api/integrations/errors") {
        try {
          const notification = recordIntegrationError({
            source: "central",
            workflow: "Central de Controle",
            node: `${req.method} ${url?.pathname || rawPathname}`,
            message: error.message || "Erro interno",
            stack: isProduction ? "" : error.stack,
            occurredAt: now(),
          });
          emit("notifications", { notificationId: notification.id, type: "error" });
        } catch (notifyError) {
          console.warn("[alerta] Falha ao registrar erro na Central:", notifyError.message);
        }
        void notifyAdminAboutServerError(error, req);
      }
    }
    if (!res.headersSent) {
      sendJson(res, statusCode, {
        error: statusCode >= 500 && isProduction
          ? "Erro interno"
          : error.message || "Erro interno",
      });
    } else {
      res.end();
    }
  }
});

assertProductionConfig();
server.listen(PORT, HOST, () => {
  console.log(`Central Pró-Kids em http://${HOST}:${PORT}`);
});
