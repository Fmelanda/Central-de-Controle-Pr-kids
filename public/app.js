const state = {
  conversations: [],
  selectedId: null,
  mode: "",
  search: "",
  appointments: [],
  notifications: [],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Não foi possível concluir");
  return body;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]);
}

function initials(name, phone) {
  return (name || phone || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function dateLabel(value, withDate = false) {
  if (!value) return "";
  return new Intl.DateTimeFormat("pt-BR", withDate
    ? { dateStyle: "short", timeStyle: "short" }
    : { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function ageLabel(value) {
  if (!value) return "Idade não informada";
  return /\bano(s)?\b/i.test(value) ? value : `${value} anos`;
}

function fileNameLabel(message) {
  return message.media_filename || "documento";
}

function safeMediaUrl(value = "") {
  const raw = String(value).trim();
  if (!raw) return "";
  if (raw.startsWith("/media/")) return raw;
  try {
    const parsed = new URL(raw, location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
  } catch {
    return "";
  }
  return "";
}

function renderMessageContent(message) {
  const mediaUrl = safeMediaUrl(message.media_url);
  if (message.content_type === "audio" && mediaUrl) {
    return `
      <div class="audio-message">
        <audio controls preload="metadata" src="${escapeHtml(mediaUrl)}"></audio>
        <span>${escapeHtml(message.text && message.text !== "[Áudio]" ? message.text : "Áudio recebido")}</span>
      </div>`;
  }
  if (message.content_type === "image" && mediaUrl) {
    return `
      <figure class="image-message">
        <img src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(message.text || "Imagem recebida")}" loading="lazy">
        ${message.text && message.text !== "[Imagem]" ? `<figcaption>${escapeHtml(message.text)}</figcaption>` : ""}
      </figure>`;
  }
  if (message.content_type === "document" && mediaUrl) {
    return `
      <div class="document-message">
        <div class="document-icon">DOC</div>
        <div>
          <strong>${escapeHtml(fileNameLabel(message))}</strong>
          ${message.text && message.text !== "[Documento]" ? `<span>${escapeHtml(message.text)}</span>` : ""}
        </div>
        <a href="${escapeHtml(mediaUrl)}" download="${escapeHtml(fileNameLabel(message))}" target="_blank" rel="noopener">Baixar</a>
      </div>`;
  }
  return escapeHtml(message.text);
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 2800);
}

async function enableDesktopNotifications() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  await Notification.requestPermission();
}

async function loadSummary() {
  const summary = await api("/api/summary");
  $("#nav-unread").textContent = summary.unread;
  $("#nav-appointments").textContent = summary.pendingAppointments;
  $("#nav-notifications").textContent = summary.notifications;
  $("#stats").innerHTML = [
    ["◎", "Conversas não lidas", summary.unread],
    ["H", "Em atendimento humano", summary.human],
    ["□", "Consultas pendentes", summary.pendingAppointments],
    ["◇", "Novas notificações", summary.notifications],
  ].map(([icon, label, value]) => `
    <div class="stat"><div class="stat-icon">${icon}</div>
      <div><span>${label}</span><strong>${value}</strong></div>
    </div>`).join("");
}

async function loadConversations(keepChat = true) {
  const params = new URLSearchParams({ search: state.search, mode: state.mode });
  state.conversations = await api(`/api/conversations?${params}`);
  $("#conversation-list").innerHTML = state.conversations.length
    ? state.conversations.map((conversation) => `
      <button class="conversation-item ${conversation.id === state.selectedId ? "active" : ""}" data-id="${conversation.id}">
        <div class="patient-avatar">${escapeHtml(initials(conversation.name, conversation.phone))}</div>
        <div class="conversation-copy">
          <strong>${escapeHtml(conversation.name || "Paciente")}</strong>
          <p>${escapeHtml(conversation.last_message || conversation.phone)}</p>
        </div>
        <div class="conversation-meta">
          <time>${dateLabel(conversation.last_message_at)}</time>
          ${conversation.unread_count ? `<span class="unread">${conversation.unread_count}</span>` :
            `<span class="mode-pill ${conversation.control_mode}">${conversation.control_mode === "human" ? "Humano" : "IA"}</span>`}
        </div>
      </button>`).join("")
    : `<div class="empty-list">Nenhuma conversa encontrada.</div>`;
  $$(".conversation-item").forEach((button) => button.addEventListener("click", () => openChat(Number(button.dataset.id))));
  if (keepChat && state.selectedId && state.conversations.some((item) => item.id === state.selectedId)) {
    await openChat(state.selectedId, false);
  }
}

async function openChat(id, reloadList = true) {
  state.selectedId = id;
  const { conversation, messages } = await api(`/api/conversations/${id}`);
  if (reloadList) await Promise.all([loadConversations(false), loadSummary()]);
  const human = conversation.control_mode === "human";
  $("#chat").className = "chat";
  $("#chat").innerHTML = `
    <header class="chat-header">
      <div class="patient-avatar">${escapeHtml(initials(conversation.name, conversation.phone))}</div>
      <div class="chat-header-copy">
        <strong>${escapeHtml(conversation.name || "Paciente")}</strong>
        <span>${escapeHtml(conversation.phone)} · ${human ? "Atendimento humano" : "Agente de IA ativo"}</span>
      </div>
      <div class="chat-header-actions">
        <span class="mode-pill ${conversation.control_mode}">${human ? "Humano" : "IA ativa"}</span>
        <button id="control-button" class="button ${human ? "secondary" : "warn"}">
          ${human ? "Devolver para a IA" : "Assumir conversa"}
        </button>
      </div>
    </header>
    ${conversation.handoff_reason ? `<div class="handoff-banner"><strong>Motivo do chamado:</strong> ${escapeHtml(conversation.handoff_reason)}</div>` : ""}
    ${human ? `<div class="human-control-banner"><strong>Você está no controle desta conversa.</strong> As mensagens abaixo serão enviadas diretamente ao WhatsApp do paciente.</div>` : ""}
    <div id="messages" class="messages">
      ${messages.length ? messages.map((message) => `
        <div class="message ${message.direction}">
          <div class="bubble">${renderMessageContent(message)}</div>
          <div class="message-meta">${message.sender_type === "human" ? "Equipe" : message.sender_type === "ai" ? "Daniele · IA" : "Paciente"} · ${dateLabel(message.created_at)}</div>
        </div>`).join("") : `<div class="empty-list">O histórico começará a aparecer quando o n8n enviar as mensagens.</div>`}
    </div>
    <form id="composer" class="composer">
      <div class="composer-field">
        <textarea name="text" rows="1" placeholder="${human ? "Digite sua mensagem para o paciente..." : "Assuma o atendimento para responder"}" ${human ? "" : "disabled"}></textarea>
        ${human ? `<small>Enter envia · Shift + Enter quebra a linha</small>` : ""}
      </div>
      <button class="button primary" type="submit" ${human ? "" : "disabled"}>Enviar</button>
    </form>`;
  $("#messages").scrollTop = $("#messages").scrollHeight;
  $("#control-button").addEventListener("click", async () => {
    await api(`/api/conversations/${id}/control`, {
      method: "PATCH",
      body: JSON.stringify({ mode: human ? "ai" : "human" }),
    });
    toast(human ? "Conversa devolvida para a IA" : "Você assumiu o atendimento");
    await Promise.all([openChat(id), loadSummary()]);
  });
  $("#composer").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = event.currentTarget.elements.text;
    const button = event.currentTarget.querySelector("button");
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    button.disabled = true;
    button.textContent = "Enviando...";
    try {
      await api(`/api/conversations/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      input.value = "";
      toast("Mensagem enviada ao paciente");
      await openChat(id);
    } catch (error) {
      toast(error.message);
      input.disabled = false;
      button.disabled = false;
      button.textContent = "Enviar";
      input.focus();
    }
  });
  const composerInput = $("#composer textarea");
  composerInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("#composer").requestSubmit();
    }
  });
  if (human) composerInput.focus();
}

async function loadAppointments() {
  state.appointments = await api("/api/appointments");
  renderAppointments();
}

function renderAppointments() {
  const search = ($("#appointment-search")?.value || "").toLowerCase();
  const rows = state.appointments.filter((item) =>
    [item.patient_name, item.phone, item.doctor, item.reason].join(" ").toLowerCase().includes(search));
  const labels = { pending: "Pendente", confirmed: "Confirmado", cancelled: "Cancelado" };
  $("#appointment-list").innerHTML = rows.length ? rows.map((item) => `
    <article class="appointment-card">
      <header><div><h3>${escapeHtml(item.patient_name)}</h3><p>${escapeHtml(item.phone)} · ${dateLabel(item.created_at, true)}</p></div>
      <span class="status status-${item.status}">${labels[item.status] || labels.pending}</span></header>
      <div class="detail"><span>Paciente</span><strong>${escapeHtml(ageLabel(item.age))}</strong></div>
      <div class="detail"><span>Médico / especialidade</span><strong>${escapeHtml(item.doctor || "Não informado")}</strong></div>
      <div class="detail"><span>Motivo</span><strong>${escapeHtml(item.reason || "Não informado")}</strong></div>
      <div class="detail"><span>Preferência</span><strong>${escapeHtml(item.preferred_date || "Não informada")}</strong></div>
      <select class="appointment-status status-${item.status}" data-appointment="${item.id}">
        ${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${item.status === value ? "selected" : ""}>${label}</option>`).join("")}
      </select>
      ${item.conversation_id ? `<button class="appointment-chat-link" data-conversation="${item.conversation_id}">Abrir conversa <span>→</span></button>` : ""}
    </article>`).join("") : `<div class="empty-list">Nenhuma consulta encontrada.</div>`;
  $$("[data-appointment]").forEach((select) => select.addEventListener("change", async () => {
    await api(`/api/appointments/${select.dataset.appointment}`, {
      method: "PATCH", body: JSON.stringify({ status: select.value }),
    });
    toast("Status da consulta atualizado");
    await Promise.all([loadAppointments(), loadSummary()]);
  }));
  $$("[data-conversation]").forEach((button) => button.addEventListener("click", async () => {
    switchView("conversations");
    await openChat(Number(button.dataset.conversation));
  }));
}

async function loadNotifications() {
  state.notifications = await api("/api/notifications");
  $("#notification-list").innerHTML = state.notifications.length ? state.notifications.map((item) => `
    <article class="notification ${item.read_at ? "" : "unread-note"}">
      <div class="note-icon">${item.type === "handoff" ? "H" : "□"}</div>
      <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.body)}</p></div>
      <time>${dateLabel(item.created_at, true)}</time>
    </article>`).join("") : `<div class="empty-list">Nenhuma notificação.</div>`;
}

async function refresh() {
  await Promise.all([loadSummary(), loadConversations(), loadAppointments(), loadNotifications()]);
}

function switchView(view) {
  $$(".view").forEach((node) => node.classList.add("hidden"));
  $(`#${view}-view`).classList.remove("hidden");
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $("#page-title").textContent = { conversations: "Conversas", appointments: "Consultas", notifications: "Notificações" }[view];
  if (view === "appointments") loadAppointments();
  if (view === "notifications") {
    loadNotifications();
    enableDesktopNotifications();
  }
}

async function start() {
  const session = await api("/api/session").catch(() => ({ authenticated: false, authRequired: true }));
  if (!session.authenticated) {
    $("#login").classList.remove("hidden");
    return;
  }
  $("#app").classList.remove("hidden");
  await refresh();
  const events = new EventSource("/api/events");
  ["messages", "appointments", "control", "notifications"].forEach((event) => {
    events.addEventListener(event, () => refresh());
  });
  events.addEventListener("handoff", () => {
    refresh();
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Atendimento humano solicitado", {
        body: "Um paciente está aguardando a equipe na Central Pró-Kids.",
      });
    }
  });
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    location.reload();
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
});

$$("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
$$(".filter").forEach((button) => button.addEventListener("click", async () => {
  $$(".filter").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  state.mode = button.dataset.mode;
  await loadConversations(false);
}));
$("#search").addEventListener("input", async (event) => {
  state.search = event.target.value;
  await loadConversations(false);
});
$("#appointment-search").addEventListener("input", renderAppointments);
$("#mark-read").addEventListener("click", async () => {
  await api("/api/notifications/read", { method: "POST", body: "{}" });
  await Promise.all([loadNotifications(), loadSummary()]);
});
setInterval(() => {
  $("#clock").textContent = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(new Date());
}, 1000);
start();
