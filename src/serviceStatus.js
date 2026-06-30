const defaultTimeoutMs = 1500;

function normalizeError(error) {
  if (error?.name === "AbortError") return "tempo limite excedido";
  return String(error?.message || "serviço indisponível").slice(0, 180);
}

export async function checkHttpStatus({ name, url, fetchImpl = fetch, timeoutMs = defaultTimeoutMs }) {
  if (!url) {
    return {
      status: "unknown",
      label: `${name} não configurado`,
      detail: "URL de saúde não configurada",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (response.ok || response.status < 500) {
      return {
        status: "online",
        label: `${name} online`,
        detail: `HTTP ${response.status}`,
      };
    }
    return {
      status: "offline",
      label: `${name} offline`,
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      status: "offline",
      label: `${name} offline`,
      detail: normalizeError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkServiceStatuses({
  n8nUrl,
  evolutionUrl,
  fetchImpl = fetch,
  timeoutMs = defaultTimeoutMs,
} = {}) {
  const [n8n, evolution] = await Promise.all([
    checkHttpStatus({ name: "n8n", url: n8nUrl, fetchImpl, timeoutMs }),
    checkHttpStatus({ name: "Evolution", url: evolutionUrl, fetchImpl, timeoutMs }),
  ]);
  const online = n8n.status === "online" && evolution.status === "online";

  return {
    system: {
      status: online ? "online" : "offline",
      label: online ? "Sistema online" : "Sistema offline",
      detail: online ? "n8n e Evolution online" : "Verifique n8n e Evolution",
    },
    n8n,
    evolution,
  };
}

export function serviceStatusConfig(env = process.env) {
  const evolutionBaseUrl = String(env.EVOLUTION_API_URL || "").replace(/\/$/, "");
  return {
    n8nUrl: env.N8N_HEALTH_URL || "http://n8n:5678/healthz",
    evolutionUrl: env.EVOLUTION_HEALTH_URL || evolutionBaseUrl || "http://evolution_api:8080",
    timeoutMs: Number(env.SERVICE_STATUS_TIMEOUT_MS || defaultTimeoutMs),
  };
}
