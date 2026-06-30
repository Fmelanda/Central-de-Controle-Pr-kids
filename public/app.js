const state = {
  conversations: [],
  selectedId: null,
  mode: "",
  search: "",
  appointments: [],
  notifications: [],
  settings: {
    aiEnabled: true,
    manualMode: false,
  },
  csrfToken: "",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && state.csrfToken) {
    headers["x-csrf-token"] = state.csrfToken;
  }
  const response = await fetch(url, {
    ...options,
    headers,
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
  return "";
}

function effectiveControlMode(conversation) {
  return conversation.effective_control_mode || conversation.control_mode || "ai";
}

function modeLabel(mode) {
  return mode === "human" ? "Humano" : "IA";
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

function renderSystemStatus(services = {}) {
  const system = services.system || { status: "offline", label: "Sistema offline" };
  const n8n = services.n8n || { status: "unknown", label: "n8n não verificado" };
  const evolution = services.evolution || { status: "unknown", label: "Evolution não verificada" };
  const title = $("#system-status-title");
  const detail = $("#system-status-detail");
  const dot = $("#system-status-dot");
  if (!title || !detail || !dot) return;

  title.textContent = system.label;
  detail.textContent = `${n8n.label} | ${evolution.label}`;
  dot.classList.toggle("offline", system.status !== "online");
}

function renderSettings() {
  const switchInput = $("#ai-enabled-switch");
  const label = $("#ai-mode-label");
  if (!switchInput || !label) return;
  switchInput.checked = state.settings.aiEnabled;
  label.textContent = state.settings.aiEnabled ? "IA ativa" : "Modo manual";
}

async function loadSettings() {
  state.settings = await api("/api/settings");
  renderSettings();
}

async function enableDesktopNotifications() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  await Notification.requestPermission();
}

function renderEmptyChat() {
  $("#chat").className = "chat empty-state";
  $("#chat").innerHTML = `
    <div class="empty-illustration">•••</div>
    <h2>Selecione uma conversa</h2>
    <p>Escolha um paciente ao lado para visualizar o histórico e assumir o atendimento.</p>`;
}

async function loadSummary() {
  const summary = await api("/api/summary");
  $("#nav-unread").textContent = summary.unread;
  $("#nav-appointments").textContent = summary.pendingAppointments;
  $("#nav-notifications").textContent = summary.notifications;
  $("#human-unread").textContent = summary.humanUnread;
  state.settings = {
    aiEnabled: summary.aiEnabled,
    manualMode: summary.manualMode,
  };
  renderSettings();
  renderSystemStatus(summary.services);
}

function renderConversationItem(conversation) {
  const mode = effectiveControlMode(conversation);
  return `
      <button class="conversation-item ${conversation.id === state.selectedId ? "active" : ""}" data-id="${conversation.id}">
        <div class="patient-avatar">${escapeHtml(initials(conversation.name, conversation.phone))}</div>
        <div class="conversation-copy">
          <strong>${escapeHtml(conversation.name || "Paciente")}</strong>
          <p>${escapeHtml(conversation.last_message || conversation.phone)}</p>
        </div>
        <div class="conversation-meta">
          <time>${dateLabel(conversation.last_message_at)}</time>
          ${conversation.unread_count ? `<span class="unread">${conversation.unread_count}</span>` : ""}
          <span class="mode-pill ${mode}">${modeLabel(mode)}</span>
        </div>
      </button>`;
}

async function loadConversations(keepChat = true) {
  const params = new URLSearchParams({ search: state.search, mode: state.mode });
  state.conversations = await api(`/api/conversations?${params}`);
  $("#conversation-list").innerHTML = state.conversations.length
    ? state.conversations.map(renderConversationItem).join("")
    : `<div class="empty-list">Nenhuma conversa encontrada.</div>`;
  $$(".conversation-item").forEach((button) => button.addEventListener("click", () => openChat(Number(button.dataset.id))));
  if (keepChat && state.selectedId && state.conversations.some((item) => item.id === state.selectedId)) {
    await openChat(state.selectedId, false);
  } else if (keepChat && state.selectedId) {
    state.selectedId = null;
    renderEmptyChat();
  }
}

async function openChat(id, reloadList = true) {
  state.selectedId = id;
  const { conversation, messages } = await api(`/api/conversations/${id}`);
  if (reloadList) await Promise.all([loadConversations(false), loadSummary()]);
  const mode = effectiveControlMode(conversation);
  const human = mode === "human";
  const manualMode = state.settings.manualMode;
  $("#chat").className = "chat";
  $("#chat").innerHTML = `
    <header class="chat-header">
      <div class="patient-avatar">${escapeHtml(initials(conversation.name, conversation.phone))}</div>
      <div class="chat-header-copy">
        <strong>${escapeHtml(conversation.name || "Paciente")}</strong>
        <span>${escapeHtml(conversation.phone)} · ${human ? "Atendimento humano" : "Agente de IA ativo"}</span>
      </div>
      <div class="chat-header-actions">
        <span class="mode-pill ${mode}">${human ? "Humano" : "IA ativa"}</span>
        <button id="control-button" class="button ${manualMode ? "secondary" : human ? "secondary" : "warn"}" ${manualMode ? "disabled" : ""}>
          ${manualMode ? "Modo manual ativo" : human ? "Devolver para a IA" : "Assumir conversa"}
        </button>
      </div>
    </header>
    ${conversation.handoff_reason ? `<div class="handoff-banner dismissible-banner"><span><strong>Motivo do chamado:</strong> ${escapeHtml(conversation.handoff_reason)}</span><button class="banner-close" type="button" data-dismiss-banner aria-label="Fechar aviso">x</button></div>` : ""}
    ${human ? `<div class="human-control-banner dismissible-banner"><span><strong>${manualMode ? "Modo manual global ativo." : "Você está no controle desta conversa."}</strong> As mensagens abaixo serão enviadas diretamente ao WhatsApp do paciente.</span><button class="banner-close" type="button" data-dismiss-banner aria-label="Fechar aviso">x</button></div>` : ""}
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
  $$("[data-dismiss-banner]").forEach((button) => {
    button.addEventListener("click", () => button.closest(".dismissible-banner")?.remove());
  });
  if (!manualMode) {
    $("#control-button").addEventListener("click", async () => {
      await api(`/api/conversations/${id}/control`, {
        method: "PATCH",
        body: JSON.stringify({ mode: human ? "ai" : "human" }),
      });
      toast(human ? "Conversa devolvida para a IA" : "Você assumiu o atendimento");
      await Promise.all([openChat(id), loadSummary()]);
    });
  }
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

async function clearData(type, button) {
  const actions = {
    conversations: {
      endpoint: "/api/conversations",
      confirm: "Limpar todas as conversas e mensagens?",
      success: "Conversas removidas",
    },
    appointments: {
      endpoint: "/api/appointments",
      confirm: "Limpar todos os cards de consulta?",
      success: "Consultas removidas",
    },
    notifications: {
      endpoint: "/api/notifications",
      confirm: "Limpar todas as notificações?",
      success: "Notificações removidas",
    },
  };
  const action = actions[type];
  if (!action || !confirm(action.confirm)) return;

  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Limpando...";
  try {
    await api(action.endpoint, { method: "DELETE" });
    if (type === "conversations") {
      state.selectedId = null;
      renderEmptyChat();
    }
    toast(action.success);
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function updateAiSetting(enabled) {
  const switchInput = $("#ai-enabled-switch");
  const previous = { ...state.settings };
  if (switchInput) switchInput.disabled = true;
  try {
    state.settings = await api("/api/settings/ai", {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
    renderSettings();
    toast(enabled ? "IA reativada" : "Modo manual ativado");
    await refresh();
  } catch (error) {
    state.settings = previous;
    renderSettings();
    toast(error.message);
  } finally {
    if (switchInput) switchInput.disabled = false;
  }
}

async function refresh() {
  await loadSummary();
  await Promise.all([loadConversations(), loadAppointments(), loadNotifications()]);
}

function switchView(view) {
  $$(".view").forEach((node) => node.classList.add("hidden"));
  $(`#${view}-view`).classList.remove("hidden");
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $("#page-title").textContent = {
    conversations: "Conversas",
    appointments: "Consultas",
    notifications: "Notificações",
    settings: "Configurações",
  }[view];
  if (view === "appointments") loadAppointments();
  if (view === "notifications") {
    loadNotifications();
    enableDesktopNotifications();
  }
  if (view === "settings") loadSettings();
}

async function start() {
  const session = await api("/api/session").catch(() => ({ authenticated: false, authRequired: true }));
  if (!session.authenticated) {
    $("#login").classList.remove("hidden");
    return;
  }
  state.csrfToken = session.csrfToken || "";
  $("#app").classList.remove("hidden");
  await refresh();
  const events = new EventSource("/api/events");
  ["messages", "appointments", "control", "notifications", "settings"].forEach((event) => {
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
$$("[data-clear]").forEach((button) => {
  button.addEventListener("click", () => clearData(button.dataset.clear, button));
});
$("#ai-enabled-switch").addEventListener("change", (event) => {
  updateAiSetting(event.target.checked);
});
setInterval(() => {
  $("#clock").textContent = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(new Date());
}, 1000);
start();
