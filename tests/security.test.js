import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const serverPath = path.join(repoRoot, "src", "server.js");
const children = new Set();

afterEach(async () => {
  await Promise.all([...children].map(stopServer));
});

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "central-security-"));
}

async function startServer(env = {}) {
  const port = await getOpenPort();
  const cwd = tmpCwd();
  const child = spawn(process.execPath, [serverPath], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      APP_URL: "https://central.example",
      DASHBOARD_USER: "admin",
      DASHBOARD_PASSWORD: "senha-forte-para-teste",
      SESSION_SECRET: "s".repeat(32),
      INTEGRATION_KEY: "i".repeat(32),
      EVOLUTION_API_KEY: "e".repeat(32),
      EVOLUTION_DEFAULT_INSTANCE: "main",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.port = port;
  child.cwd = cwd;
  children.add(child);
  await waitForServer(child);
  return child;
}

async function waitForServer(child) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${child.port}/api/session`);
      if (response.status === 401 || response.ok) return;
    } catch {
      await delay(50);
    }
  }
  throw new Error("server did not start in time");
}

async function stopServer(child) {
  if (!children.has(child)) return;
  children.delete(child);
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  fs.rmSync(child.cwd, { recursive: true, force: true });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.end(request));
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

async function login(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "admin", password: "senha-forte-para-teste" }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

test("malformed Host header returns an error without crashing the server", async () => {
  const child = await startServer();

  const response = await rawRequest(
    child.port,
    "GET /api/session HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n",
  );
  assert.match(response, /^HTTP\/1\.1 400 /);

  await delay(100);
  assert.equal(child.exitCode, null);
});

test("production rejects placeholder integration keys from examples", async () => {
  const port = await getOpenPort();
  const cwd = tmpCwd();
  const child = spawn(process.execPath, [serverPath], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      DASHBOARD_PASSWORD: "senha-forte-para-teste",
      SESSION_SECRET: "s".repeat(32),
      INTEGRATION_KEY: "troque-por-outra-chave-longa-e-aleatoria",
      EVOLUTION_API_KEY: "e".repeat(32),
      EVOLUTION_DEFAULT_INSTANCE: "main",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.cwd = cwd;
  children.add(child);

  const exitCode = await waitForExit(child);
  assert.notEqual(exitCode, null);
  assert.notEqual(exitCode, 0);
});

test("unsafe dashboard routes require a csrf token", async () => {
  const child = await startServer();
  const cookie = await login(child.port);

  const rejected = await fetch(`http://127.0.0.1:${child.port}/api/conversations`, {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(rejected.status, 403);

  const session = await fetch(`http://127.0.0.1:${child.port}/api/session`, {
    headers: { cookie },
  });
  const { csrfToken } = await session.json();
  assert.match(csrfToken, /^[a-f0-9]{64}$/);

  const accepted = await fetch(`http://127.0.0.1:${child.port}/api/conversations`, {
    method: "DELETE",
    headers: { cookie, "x-csrf-token": csrfToken },
  });
  assert.equal(accepted.status, 200);
});

test("integration media must be uploaded instead of linked to remote URLs", async () => {
  const child = await startServer();
  const response = await fetch(`http://127.0.0.1:${child.port}/api/integrations/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-integration-key": "i".repeat(32),
    },
    body: JSON.stringify({
      phone: "5511999999999",
      direction: "inbound",
      contentType: "image",
      imageUrl: "https://example.com/patient.jpg",
    }),
  });

  assert.equal(response.status, 400);
});
