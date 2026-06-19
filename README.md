# Central Pró-Kids

Central de atendimento para o workflow n8n + Evolution API da clínica.

## Recursos

- Caixa de entrada com histórico das conversas.
- Alternância entre atendimento pela IA e atendimento humano.
- Envio de mensagens humanas pela Evolution API.
- Chamados e notificações quando o agente solicita uma pessoa.
- Aba de consultas com status de acompanhamento.
- Atualizações em tempo real e persistência local em SQLite.
- Login da equipe e chave separada para integração com o n8n.

## Executar

Requer Node.js 22.5 ou superior.

```powershell
Copy-Item .env.example .env
# Edite o .env.
npm.cmd start
```

Acesse `http://localhost:3000`.

Em produção, também é possível injetar as variáveis pelo Docker, servidor ou
gerenciador de processos.

## Executar com Docker

Este projeto inclui `Dockerfile` e `docker-compose.yml`. O Compose usa a rede externa
`n8n_network`, compartilhada com os containers atuais do n8n e da Evolution.

```powershell
docker compose up -d --build
```

A central fica disponível em `http://localhost:3001`.

Dentro de um container, `localhost` aponta para o próprio container. Por isso,
o Compose substitui `EVOLUTION_API_URL` por `EVOLUTION_API_URL_INTERNAL`, cujo
valor padrão é:

```text
http://evolution_api:8080
```

O arquivo `.env` continua armazenando a chave da Evolution e as senhas. Os
dados da central ficam no volume persistente `central_controle_data`.

Na VPS, ajuste no `.env`:

```text
APP_URL=https://seu-dominio.com
COOKIE_SECURE=true
TRUST_PROXY=true
EVOLUTION_API_URL_INTERNAL=http://evolution_api:8080
```

Se o container da Evolution tiver outro nome ou estiver em outra rede, troque
`EVOLUTION_API_URL_INTERNAL` pelo endereço interno correto.

No n8n, que também está na rede `n8n_network`, configure:

```text
CENTRAL_URL=http://central_controle:3000
CENTRAL_INTEGRATION_KEY=o-mesmo-valor-de-INTEGRATION_KEY
```

Para acompanhar:

```powershell
docker compose ps
docker compose logs -f central_controle
```

## Importar o workflow adaptado

O arquivo pronto para importação fica em:

`n8n/Whatsap clinica - central.json`

Crie estas variáveis no n8n antes de ativá-lo:

- `CENTRAL_URL`: URL pública da central, sem barra no final.
- `CENTRAL_INTEGRATION_KEY`: mesmo valor de `INTEGRATION_KEY`.

O workflow adaptado:

- registra mensagens recebidas e respostas da IA;
- consulta o modo da conversa antes de chamar o agente;
- não responde automaticamente quando um funcionário assumiu;
- cria chamados de atendimento humano;
- envia as solicitações de consulta para a aba Consultas.

O original não é alterado. Para regenerar a cópia:

```powershell
node scripts/build-n8n-workflow.mjs `
  "C:\Users\felip\Downloads\Whatsap clinica.json"
```

## Endpoints do n8n

Todos devem enviar o header `x-integration-key` com o mesmo valor de
`INTEGRATION_KEY`.

### Registrar mensagem

`POST /api/integrations/messages`

```json
{
  "phone": "5543999999999@s.whatsapp.net",
  "name": "Nome do paciente",
  "instance": "nome-da-instancia",
  "direction": "inbound",
  "senderType": "patient",
  "text": "Mensagem",
  "externalId": "id-unico-da-mensagem"
}
```

Para a resposta da IA, use `direction: "outbound"` e `senderType: "ai"`.

### Registrar mídia

`POST /api/integrations/messages`

Envie a mídia em base64 para a central salvar no volume Docker.

#### Áudio `.ogg`

```json
{
  "phone": "5543999999999@s.whatsapp.net",
  "name": "Nome do paciente",
  "instance": "nome-da-instancia",
  "direction": "inbound",
  "senderType": "patient",
  "contentType": "audio",
  "text": "Transcrição opcional do áudio",
  "audio": {
    "base64": "AAAA...",
    "mimeType": "audio/ogg",
    "filename": "mensagem.ogg"
  },
  "externalId": "id-unico-da-mensagem"
}
```

Também são aceitos os campos diretos `audioBase64`, `mediaBase64`,
`mediaUrl` ou `audioUrl`.

#### Imagem

Tipos aceitos: `image/jpeg`, `image/png`, `image/webp`.

```json
{
  "phone": "5543999999999@s.whatsapp.net",
  "name": "Nome do paciente",
  "instance": "nome-da-instancia",
  "direction": "inbound",
  "senderType": "patient",
  "contentType": "image",
  "text": "Legenda opcional",
  "image": {
    "base64": "AAAA...",
    "mimeType": "image/jpeg",
    "filename": "foto.jpg"
  },
  "externalId": "id-unico-da-mensagem"
}
```

Também são aceitos `imageBase64`, `imageUrl`, `mediaBase64` ou `mediaUrl`.

#### Documento

Tipos aceitos: PDF e DOCX.

```json
{
  "phone": "5543999999999@s.whatsapp.net",
  "name": "Nome do paciente",
  "instance": "nome-da-instancia",
  "direction": "inbound",
  "senderType": "patient",
  "contentType": "document",
  "text": "Legenda opcional",
  "document": {
    "base64": "AAAA...",
    "mimeType": "application/pdf",
    "filename": "resultado_exame.pdf"
  },
  "externalId": "id-unico-da-mensagem"
}
```

Também são aceitos `documentBase64`, `documentUrl`, `mediaBase64` ou
`mediaUrl`. Se enviar URL em vez de base64, ela precisa ser acessível pelo
navegador dos funcionários.

### Consultar quem controla a conversa

`GET /api/integrations/conversations/{telefone}/control`

Resposta: `{ "mode": "ai" }` ou `{ "mode": "human" }`.

### Solicitar atendimento humano

`POST /api/integrations/handoff`

```json
{
  "phone": "5543999999999@s.whatsapp.net",
  "name": "Nome do paciente",
  "instance": "nome-da-instancia",
  "reason": "Dúvida fora da base de conhecimento"
}
```

### Registrar consulta

`POST /api/integrations/appointments`

Aceita diretamente o objeto `consulta` atual ou `{ "consulta": { ... } }`.

## Segurança

Dados de saúde e identificação pessoal exigem HTTPS, senhas fortes, backups,
controle de acesso e uma política de retenção adequada à LGPD. Antes de subir
para a VPS:

- troque `DASHBOARD_PASSWORD`, `SESSION_SECRET` e `INTEGRATION_KEY`;
- use chaves longas e diferentes entre si;
- não publique `.env`, banco SQLite, volume `data/` ou exports do n8n com
  chaves reais;
- se uma chave já apareceu em export/log, rotacione a chave no `.env` e no n8n;
- coloque a central atrás de HTTPS e deixe `COOKIE_SECURE=true`;
- faça backup do volume `central_controle_data`.

SQLite atende um servidor pequeno; para múltiplas réplicas, migre a
persistência para PostgreSQL.
