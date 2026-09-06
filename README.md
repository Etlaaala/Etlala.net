# Etlaala Hostinger MCP v4.7

Dedicated single-account bridge for `etlaala.net`.

It exposes two independent control layers:

1. Every tool provided by `hostinger-api-mcp` using one dedicated `HOSTINGER_API_TOKEN`.
2. Direct filesystem tools locked to Etlaala `public_html`, so file read/write/edit/delete can still work even if a Hostinger account-level API route is unreliable.

## Hostinger Web App settings

- Framework: Other
- Node.js: 24.x
- Root directory: `./`
- Entry file: `server.cjs`
- Start command: `npm start`

## Required environment variables

```text
HOSTINGER_API_TOKEN=<dedicated Etlaala Hostinger API token>
MCP_ACCESS_TOKEN=<random secret at least 24 characters>
ETLALA_DOMAIN=etlaala.net
ETLALA_USERNAME=u926325448
ETLALA_ROOT=/home/u926325448/domains/etlaala.net/public_html
ETLALA_BACKUP_ROOT=/home/u926325448/domains/etlaala.net/.mcp-backups
```

Optional limits:

```text
ETLALA_MAX_WRITE_MB=24
ETLALA_MAX_DOWNLOAD_MB=80
ETLALA_MAX_READ_MB=8
MCP_JSON_LIMIT=34mb
```

## Endpoints

- Health: `https://<web-app-host>/health`
- MCP with Bearer auth: `https://<web-app-host>/mcp`
- MCP fallback for clients without custom headers: `https://<web-app-host>/mcp?token=<MCP_ACCESS_TOKEN>`

Do not share or screenshot either token.

## First verification

Open `/health`. A fully healthy installation should show:

- `status: "ok"`
- `filesystem.root_exists: true`
- `filesystem.root_readable: true`
- `filesystem.root_writable: true`
- `hostinger_api.ok: true`

Then call the MCP tool `etlaala_scope_status` and run a create/read/patch/delete test file under `public_html`.
