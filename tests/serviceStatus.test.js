import assert from "node:assert/strict";
import { test } from "node:test";
import { checkServiceStatuses } from "../src/serviceStatus.js";

test("checkServiceStatuses reports system offline when n8n cannot be reached", async () => {
  const status = await checkServiceStatuses({
    n8nUrl: "http://n8n:5678/healthz",
    evolutionUrl: "http://evolution_api:8080",
    fetchImpl: async (url) => {
      if (url.includes("n8n")) throw new Error("connect ECONNREFUSED");
      return { ok: true, status: 200 };
    },
  });

  assert.equal(status.system.status, "offline");
  assert.deepEqual(status.n8n, {
    status: "offline",
    label: "n8n offline",
    detail: "connect ECONNREFUSED",
  });
  assert.equal(status.evolution.status, "online");
});

test("checkServiceStatuses reports system online only when n8n and Evolution respond", async () => {
  const status = await checkServiceStatuses({
    n8nUrl: "http://n8n:5678/healthz",
    evolutionUrl: "http://evolution_api:8080",
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });

  assert.deepEqual(status.system, {
    status: "online",
    label: "Sistema online",
    detail: "n8n e Evolution online",
  });
  assert.deepEqual(status.n8n, {
    status: "online",
    label: "n8n online",
    detail: "HTTP 200",
  });
  assert.deepEqual(status.evolution, {
    status: "online",
    label: "Evolution online",
    detail: "HTTP 200",
  });
});

test("checkServiceStatuses treats non-5xx HTTP responses as online reachability", async () => {
  const status = await checkServiceStatuses({
    n8nUrl: "http://n8n:5678/healthz",
    evolutionUrl: "http://evolution_api:8080",
    fetchImpl: async (url) => url.includes("evolution")
      ? { ok: false, status: 401 }
      : { ok: true, status: 200 },
  });

  assert.equal(status.system.status, "online");
  assert.deepEqual(status.evolution, {
    status: "online",
    label: "Evolution online",
    detail: "HTTP 401",
  });
});
