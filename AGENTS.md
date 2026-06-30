# Guia para agentes Codex - Central Pro-Kids

Este arquivo e o mapa operacional do projeto para agentes Codex. Use-o antes de
alterar o codigo, revisar bugs ou orientar deploy.

## Resumo rapido

A Central Pro-Kids e um painel web para acompanhar conversas de WhatsApp,
consultas e alertas vindos de um workflow n8n integrado com Evolution API.

O projeto roda em Node.js puro, sem Express. O backend serve a interface estatica,
mantem sessao com cookie assinado, valida CSRF nas rotas do dashboard, recebe
eventos do n8n por endpoints de integracao e persiste tudo em SQLite. A interface
fica em HTML/CSS/JS estatico dentro de `public/`.

## Stack e requisitos

- Runtime: Node.js `>=22.5`.
- Modulos usados: APIs nativas do Node, principalmente `node:http`,
  `node:sqlite`, `node:crypto`, `node:fs` e `fetch`.
- Banco: SQLite em `data/central.sqlite`, com WAL.
- Frontend: `public/index.html`, `public/app.js`, `public/styles.css`.
- Testes: `node --test`.
- Docker: `Dockerfile` + `docker-compose.yml`.

Nao procure `express`, `vite`, `react`, `next` ou ORM: eles nao existem neste
projeto.

## Comandos uteis

```powershell
npm.cmd start
npm.cmd run dev
npm.cmd test
docker compose up -d --build
docker compose ps
docker compose logs -f central_controle
```

No Windows, prefira `npm.cmd` quando o PowerShell bloquear scripts. Para
comportamento dependente do container ou variaveis de producao, prefira Docker
Compose em vez do host.

## Arquivos principais

- `src/server.js`: ponto de entrada HTTP. Contem roteamento, autenticacao,
  CSRF, rate limit, headers de seguranca, SSE, endpoints do dashboard,
  endpoints de integracao, upload de midia e envio via Evolution API.
- `src/db.js`: inicializa SQLite, cria tabelas, aplica pequenas migracoes e
  expoe helpers de conversa, mensagem e configuracoes.
- `src/serviceStatus.js`: verifica saude de n8n e Evolution para o indicador
  lateral do painel.
- `src/errorAlerts.js`: formata e registra alertas de erro vindos do n8n ou da
  propria Central.
- `public/index.html`: estrutura da tela de login e das abas Conversas,
  Consultas, Notificacoes e Configuracoes.
- `public/app.js`: estado do dashboard, chamadas `fetch`, renderizacao, SSE,
  troca de modo IA/manual, limpeza de dados e envio de mensagens humanas.
- `public/styles.css`: layout visual responsivo do dashboard.
- `docker-compose.yml`: servico `central_controle`, volume persistente,
  rede externa `n8n_network`, porta local e labels Traefik.
- `Dockerfile`: imagem Node Alpine que copia apenas `package.json`, `src`,
  `public` e `docker-entrypoint.sh`.
- `docker-entrypoint.sh`: ajusta permissao de `/app/data` e executa como usuario
  `node`.
- `n8n/*.json`: exports dos workflows n8n que conversam com a Central.
- `tests/*.test.js`: testes nativos do Node cobrindo seguranca, UI por busca
  textual, status dos servicos e alertas de erro.

## Modelo de dados

O banco fica em `data/central.sqlite`. Esta pasta e volume local/persistente e
nao deve ir para o Git.

Tabelas criadas em `src/db.js`:

- `conversations`: telefone, nome, instancia, modo `ai` ou `human`, motivo de
  handoff, nao lidas e ultima mensagem.
- `messages`: mensagens inbound/outbound, remetente, texto, tipo de conteudo,
  URL local de midia e `external_id` unico.
- `appointments`: solicitacoes de consulta vindas do agente.
- `notifications`: chamados, novas consultas e erros.
- `app_settings`: configuracoes globais, como `ai_enabled`.

O SQLite usa `PRAGMA journal_mode = WAL`, entao arquivos `central.sqlite-wal` e
`central.sqlite-shm` podem aparecer junto do banco.

## Fluxo principal

1. O n8n recebe eventos do WhatsApp pela Evolution API.
2. O workflow registra mensagens na Central por
   `POST /api/integrations/messages`.
3. O workflow consulta quem controla a conversa por
   `GET /api/integrations/conversations/{telefone}/control`.
4. Se a conversa estiver em modo IA, o n8n chama o agente e registra a resposta.
5. Se houver pedido de humano, o n8n chama `POST /api/integrations/handoff`.
6. O dashboard escuta `/api/events` via Server-Sent Events e atualiza a tela.
7. Quando a equipe assume uma conversa, mensagens humanas sao enviadas pela
   Evolution API em `POST /api/conversations/{id}/messages`.

## Autenticacao e seguranca

Existem dois acessos separados:

- Dashboard: login em `POST /api/login`, cookie `central_session` assinado com
  `SESSION_SECRET`, e CSRF via header `x-csrf-token` em metodos inseguros.
- n8n/integracoes: header `x-integration-key` igual a `INTEGRATION_KEY`.

Em producao, `DASHBOARD_PASSWORD`, `SESSION_SECRET` e `INTEGRATION_KEY` sao
obrigatorios e nao podem ser placeholders. Nunca leia, copie ou exponha valores
reais de `.env` em respostas ou docs.

Headers de seguranca ficam em `securityHeaders()` em `src/server.js`. Midias
externas sao bloqueadas para integracao; a Central aceita upload base64 e serve
arquivos locais autenticados em `/media/...`.

## Variaveis de ambiente importantes

Use `.env.example` como modelo. `.env` real deve ficar local.

- `PORT`, `HOST`: bind local do processo.
- `APP_URL`, `TRUST_PROXY`, `COOKIE_SECURE`: importantes atras do Traefik/HTTPS.
- `DASHBOARD_USER`, `DASHBOARD_PASSWORD`, `SESSION_SECRET`: login do painel.
- `INTEGRATION_KEY`: chave usada pelo n8n no header `x-integration-key`.
- `EVOLUTION_API_URL`: URL usada pela Central para enviar mensagens.
- `EVOLUTION_API_URL_INTERNAL`: URL usada pelo Compose dentro da rede Docker.
- `EVOLUTION_API_KEY`, `EVOLUTION_DEFAULT_INSTANCE`: envio via Evolution.
- `N8N_HEALTH_URL`, `EVOLUTION_HEALTH_URL`: indicador de status lateral.
- `ERROR_ALERT_PHONE`, `ERROR_ALERT_INSTANCE`: alertas de erro por WhatsApp.
- `MAX_BODY_BYTES`, `MAX_MEDIA_BYTES`, `MAX_TEXT_LENGTH`: limites de entrada.
- `LOGIN_RATE_LIMIT`, `INTEGRATION_RATE_LIMIT`, `EVOLUTION_TIMEOUT_MS`: limites e
  timeout.

## Docker e deploy

O caminho documentado de producao e Docker Compose.

`docker-compose.yml` define:

- servico: `central_controle`;
- container: `central_controle`;
- porta interna: `3000`;
- porta publicada padrao: `127.0.0.1:3001`;
- volume persistente: `central_controle_data` montado em `/app/data`;
- rede externa: `n8n_network`;
- labels Traefik apontando para a porta interna `3000`;
- filesystem `read_only: true`, `tmpfs: /tmp` e capabilities reduzidas.

Dentro de container, `localhost` aponta para o proprio container. Para falar com
Evolution e n8n, use nomes de servico/container na rede Docker, por exemplo
`http://evolution_api:8080` e `http://n8n:5678/healthz`.

## API do dashboard

Rotas exigem sessao valida, exceto login, sessao e integracoes.

- `GET /api/session`: estado da sessao e CSRF.
- `GET /api/events`: SSE para atualizacoes.
- `GET /api/summary`: contadores, configuracao IA/manual e saude n8n/Evolution.
- `GET /api/settings`: configuracoes globais.
- `PATCH /api/settings/ai`: liga/desliga IA global.
- `GET /api/conversations`: lista conversas com busca e filtro por modo efetivo.
- `GET /api/conversations/{id}`: conversa e mensagens, tambem zera nao lidas.
- `PATCH /api/conversations/{id}/control`: alterna `ai`/`human`.
- `POST /api/conversations/{id}/messages`: envia resposta humana via Evolution.
- `DELETE /api/conversations`: limpa conversas e mensagens.
- `GET /api/appointments`: lista consultas.
- `PATCH /api/appointments/{id}`: altera status.
- `DELETE /api/appointments`: limpa consultas.
- `GET /api/notifications`: lista notificacoes recentes.
- `POST /api/notifications/read`: marca notificacoes como lidas.
- `DELETE /api/notifications`: limpa notificacoes.

## API de integracao n8n

Todas as rotas abaixo exigem `x-integration-key`.

- `POST /api/integrations/messages`: registra texto, audio, imagem ou documento.
- `GET /api/integrations/conversations/{telefone}/control`: informa modo de
  controle efetivo para o workflow.
- `POST /api/integrations/handoff`: coloca conversa em atendimento humano e cria
  notificacao.
- `POST /api/integrations/appointments`: registra solicitacao de consulta.
- `POST /api/integrations/errors`: registra erro do workflow na Central.

## Modo IA/manual

A configuracao global fica em `app_settings.ai_enabled`.

Quando `ai_enabled` e `false`, a Central nao altera o `control_mode` salvo nas
conversas, mas passa a retornar `effective_control_mode = "human"` para todas.
Isso faz a UI e o endpoint de controle do n8n tratarem tudo como atendimento
humano sem perder o estado anterior de cada conversa.

## Midias

Midias recebidas por integracao sao salvas em `data/media/YYYY/MM/<uuid>.<ext>`.
Tipos aceitos:

- audio: OGG/Opus;
- imagem: JPEG, PNG, WebP;
- documento: PDF, DOCX.

`saveMedia()` valida tamanho, MIME e assinatura basica do arquivo. Arquivos em
`/media/...` so sao servidos para usuarios autenticados.

## Workflows n8n

`n8n/Whatsap clinica + Central de Controle.json` contem o fluxo principal com
Webhook Evolution, Redis buffer, consulta de controle na Central, agente IA,
registro de resposta, handoff humano e registro de consulta.

`n8n/Central - Error Handler.json` contem o fluxo de erro: Error Trigger,
preparacao do alerta, envio por WhatsApp e registro em
`/api/integrations/errors`.

Ao editar exports n8n, tome cuidado com chaves reais em headers ou credenciais.
Se um export tiver segredo real, sanitize antes de commitar.

## Padroes para alterar o projeto

- Identifique primeiro se a mudanca e backend, frontend, workflow n8n ou deploy.
- Para nova rota do dashboard, adicione validacao em `src/server.js`, atualize
  `public/app.js` se houver UI, e cubra com teste quando houver risco.
- Para nova rota de integracao, mantenha `validIntegration()`, limites de corpo
  e mensagens de erro claras para o n8n.
- Para novo dado persistente, altere `src/db.js` com `CREATE TABLE IF NOT EXISTS`
  ou `ensureColumn()`.
- Para nova acao de UI, atualize `index.html`, `app.js`, `styles.css` e os testes
  textuais em `tests/dashboardConversationsUi.test.js` quando aplicavel.
- Para deploy, revalide `docker-compose.yml`, volume `central_controle_data`,
  rede `n8n_network`, labels Traefik e variaveis `.env`.
- Nao apague ou sobrescreva `data/` local: ali podem estar conversas reais.

## Verificacao antes de finalizar

Rode pelo menos:

```powershell
npm.cmd test
git status --short
```

Para mudancas de Docker:

```powershell
docker compose config
docker compose up -d --build
docker compose logs -f central_controle
```

Para mudancas de workflow, importe em um n8n de teste ou valide o JSON e revise
os nos HTTP que chamam a Central.
