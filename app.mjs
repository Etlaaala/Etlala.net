import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import AdmZip from 'adm-zip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const MODERN_PROTOCOL = '2026-07-28';
const LEGACY_PROTOCOL = '2025-06-18';
const BRIDGE_VERSION = '4.7.0';
const ETLALA_DOMAIN = String(process.env.ETLALA_DOMAIN || 'etlaala.net').trim().toLowerCase();
const ETLALA_USERNAME = String(process.env.ETLALA_USERNAME || 'u926325448').trim();
const ETLALA_ROOT = path.resolve(process.env.ETLALA_ROOT || `/home/${ETLALA_USERNAME}/domains/${ETLALA_DOMAIN}/public_html`);
const ETLALA_BACKUP_ROOT = path.resolve(process.env.ETLALA_BACKUP_ROOT || `/home/${ETLALA_USERNAME}/domains/${ETLALA_DOMAIN}/.mcp-backups`);
const HOSTINGER_API_TOKEN = String(process.env.HOSTINGER_API_TOKEN || '').trim();
const MCP_ACCESS_TOKEN = String(process.env.MCP_ACCESS_TOKEN || '').trim();
const PORT = Number(process.env.PORT || 3000);
const MAX_WRITE_BYTES = Math.max(1, Number(process.env.ETLALA_MAX_WRITE_MB || 24)) * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = Math.max(1, Number(process.env.ETLALA_MAX_DOWNLOAD_MB || 80)) * 1024 * 1024;
const MAX_READ_BYTES = Math.max(1, Number(process.env.ETLALA_MAX_READ_MB || 8)) * 1024 * 1024;
const JSON_LIMIT = String(process.env.MCP_JSON_LIMIT || '34mb');

if (!HOSTINGER_API_TOKEN) {
  console.error('Missing required environment variable: HOSTINGER_API_TOKEN');
  process.exit(1);
}
if (!MCP_ACCESS_TOKEN || MCP_ACCESS_TOKEN.length < 24) {
  console.error('Missing or weak MCP_ACCESS_TOKEN. Use a random secret of at least 24 characters.');
  process.exit(1);
}

const upstreamPackage = JSON.parse(readFileSync(new URL('./node_modules/hostinger-api-mcp/package.json', import.meta.url), 'utf8'));
const hostingerMcpEntry = fileURLToPath(new URL('./node_modules/hostinger-api-mcp/src/servers/hosting.js', import.meta.url));

function textResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function cleanRelative(value = '.') {
  const input = String(value || '.').replace(/\\/g, '/').trim();
  if (!input || input === '.') return '.';
  if (input.includes('\0')) throw new Error('Path contains a null byte');
  if (path.posix.isAbsolute(input)) throw new Error('Absolute paths are not allowed');
  const normalized = path.posix.normalize(input);
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('Path escapes the Etlaala root');
  return normalized;
}

function resolveEtlaalaPath(relative = '.') {
  const rel = cleanRelative(relative);
  const resolved = path.resolve(ETLALA_ROOT, rel);
  const prefix = ETLALA_ROOT.endsWith(path.sep) ? ETLALA_ROOT : ETLALA_ROOT + path.sep;
  if (resolved !== ETLALA_ROOT && !resolved.startsWith(prefix)) throw new Error('Path escapes the Etlaala root');
  return { rel, resolved };
}

function relativeToRoot(absolutePath) {
  const rel = path.relative(ETLALA_ROOT, absolutePath).replace(/\\/g, '/');
  return rel || '.';
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function statPayload(filePath) {
  const st = await fs.lstat(filePath);
  const data = {
    path: relativeToRoot(filePath),
    type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other',
    size: st.size,
    mode: (st.mode & 0o777).toString(8).padStart(3, '0'),
    modified_at: st.mtime.toISOString(),
  };
  if (st.isFile()) data.sha256 = await sha256File(filePath);
  if (st.isSymbolicLink()) data.symlink_target = await fs.readlink(filePath);
  return data;
}

async function makeBackup(filePath, reason = 'change') {
  try {
    const st = await fs.lstat(filePath);
    if (!st.isFile()) return null;
    const rel = relativeToRoot(filePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.resolve(ETLALA_BACKUP_ROOT, stamp, reason, rel);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(filePath, backupPath);
    return backupPath;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    console.warn(`Backup failed for ${filePath}: ${error?.message || error}`);
    return null;
  }
}

async function atomicWrite(filePath, bytes) {
  if (bytes.length > MAX_WRITE_BYTES) throw new Error(`Write exceeds ${MAX_WRITE_BYTES} byte limit`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.mcp-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp, bytes, { mode: 0o644 });
  await fs.rename(temp, filePath);
}

async function fsSelfTest() {
  const result = {
    root: ETLALA_ROOT,
    backup_root: ETLALA_BACKUP_ROOT,
    root_exists: false,
    root_readable: false,
    root_writable: false,
    test_error: null,
  };
  try {
    const st = await fs.stat(ETLALA_ROOT);
    result.root_exists = st.isDirectory();
    await fs.readdir(ETLALA_ROOT);
    result.root_readable = true;
    const testDir = path.join(ETLALA_ROOT, '.mcp-selftest');
    const testFile = path.join(testDir, `rw-${crypto.randomUUID()}.txt`);
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(testFile, 'etlaala-mcp-rw-ok');
    const verify = await fs.readFile(testFile, 'utf8');
    if (verify !== 'etlaala-mcp-rw-ok') throw new Error('Read-after-write verification failed');
    await fs.unlink(testFile);
    try { await fs.rmdir(testDir); } catch {}
    result.root_writable = true;
  } catch (error) {
    result.test_error = error?.message || String(error);
  }
  return result;
}

function isPrivateIp(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] >= 224) return true;
    return false;
  }
  if (net.isIPv6(address)) {
    const v = address.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:');
  }
  return true;
}

async function assertPublicHttpsUrl(rawUrl) {
  const url = new URL(String(rawUrl));
  if (url.protocol !== 'https:') throw new Error('Only https URLs are allowed');
  if (url.username || url.password) throw new Error('Credentials in URLs are not allowed');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Localhost is not allowed');
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((x) => isPrivateIp(x.address))) throw new Error('Private or local network destinations are not allowed');
  return url;
}

async function fetchPublicBytes(rawUrl, maxBytes = MAX_DOWNLOAD_BYTES) {
  let current = await assertPublicHttpsUrl(rawUrl);
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await fetch(current, { redirect: 'manual', headers: { 'user-agent': 'Etlaala-Hostinger-MCP/4.7' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirect ${response.status} without Location header`);
      current = await assertPublicHttpsUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) throw new Error(`Remote file exceeds ${maxBytes} byte limit`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`Downloaded file exceeds ${maxBytes} byte limit`);
    return { bytes, final_url: current.toString(), content_type: response.headers.get('content-type') || null };
  }
  throw new Error('Too many redirects');
}

async function openUpstream(label = 'request') {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [hostingerMcpEntry],
    env: { ...process.env, HOSTINGER_API_TOKEN, DEBUG: process.env.DEBUG || 'false' },
  });
  transport.onclose = () => console.log(`[UPSTREAM ${label}] stdio closed`);
  transport.onerror = (error) => console.error(`[UPSTREAM ${label}] stdio error: ${error?.stack || error}`);
  const client = new Client({ name: `etlaala-hostinger-${label}`.slice(0, 80), version: BRIDGE_VERSION }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function withFreshUpstream(label, fn) {
  const { client, transport } = await openUpstream(label);
  try { return await fn(client); }
  finally {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
  }
}

async function loadAllToolSchemas() {
  return withFreshUpstream('schema-cache', async (client) => {
    const tools = [];
    let cursor;
    do {
      const result = cursor ? await client.listTools({ cursor }) : await client.listTools();
      tools.push(...(result.tools || []));
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  });
}

function enforceEtlaalaScope(toolName, inputArgs = {}) {
  const args = { ...inputArgs };
  const allowedDomain = (value) => {
    if (!value) return true;
    const d = String(value).trim().toLowerCase();
    return d === ETLALA_DOMAIN || d.endsWith(`.${ETLALA_DOMAIN}`);
  };
  for (const key of ['domain', 'website_domain']) {
    if (args[key] && !allowedDomain(args[key])) throw new Error(`${toolName} blocked: ${key} is outside ${ETLALA_DOMAIN}`);
  }
  if (args.username && String(args.username).trim() !== ETLALA_USERNAME) {
    throw new Error(`${toolName} blocked: username is outside ${ETLALA_USERNAME}`);
  }
  if (toolName === 'hosting_listWebsitesV1' && !args.username && !args.domain) args.username = ETLALA_USERNAME;
  return args;
}

async function callUpstreamTool(toolName, inputArgs = {}) {
  const args = enforceEtlaalaScope(toolName, inputArgs);
  const result = await withFreshUpstream(toolName, (client) => client.callTool({ name: toolName, arguments: args }));
  console.log(`[UPSTREAM] ${toolName}${result?.isError ? ' (MCP error)' : ''}`);
  return result;
}

const fsTools = [
  {
    name: 'etlaala_scope_status',
    description: 'Verify the dedicated Etlaala filesystem scope and read/write capability. Does not expose secrets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'etlaala_fs_list',
    description: 'List files and directories under the Etlaala public_html root. Paths are relative to the locked root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path under Etlaala public_html. Default: .' },
        recursive: { type: 'boolean', description: 'Recursively list child directories. Default: false' },
        max_depth: { type: 'integer', minimum: 0, maximum: 12, description: 'Maximum recursion depth. Default: 3' },
        limit: { type: 'integer', minimum: 1, maximum: 3000, description: 'Maximum entries. Default: 500' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'etlaala_fs_stat',
    description: 'Get file or directory metadata and SHA-256 for files under Etlaala public_html.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'etlaala_fs_read',
    description: 'Read a text or binary file under Etlaala public_html. Binary content is returned as base64.',
    inputSchema: {
      type: 'object', required: ['path'],
      properties: {
        path: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
        offset: { type: 'integer', minimum: 0, default: 0 },
        length: { type: 'integer', minimum: 1, description: 'Maximum bytes to return; capped by server read limit.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'etlaala_fs_write',
    description: 'Create or replace a text/binary file under Etlaala public_html using an atomic write. Existing files are backed up outside public_html when possible.',
    inputSchema: {
      type: 'object', required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'UTF-8 text or base64 data according to encoding.' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
        expected_sha256: { type: 'string', description: 'Optional optimistic-lock SHA-256 of the existing file.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'etlaala_fs_patch_text',
    description: 'Apply exact text replacements to a UTF-8 file under Etlaala public_html, with optional SHA-256 optimistic lock and automatic backup.',
    inputSchema: {
      type: 'object', required: ['path', 'replacements'],
      properties: {
        path: { type: 'string' },
        expected_sha256: { type: 'string' },
        replacements: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object', required: ['search', 'replace'],
            properties: {
              search: { type: 'string' },
              replace: { type: 'string' },
              all: { type: 'boolean', default: false },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'etlaala_fs_mkdir',
    description: 'Create a directory recursively under Etlaala public_html.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'etlaala_fs_copy',
    description: 'Copy a file under Etlaala public_html. The destination is backed up first if it exists.',
    inputSchema: {
      type: 'object', required: ['source', 'destination'],
      properties: { source: { type: 'string' }, destination: { type: 'string' }, overwrite: { type: 'boolean', default: false } },
      additionalProperties: false,
    },
  },
  {
    name: 'etlaala_fs_move',
    description: 'Move or rename a file/directory under Etlaala public_html. The destination is backed up first if it is a file.',
    inputSchema: {
      type: 'object', required: ['source', 'destination'],
      properties: { source: { type: 'string' }, destination: { type: 'string' }, overwrite: { type: 'boolean', default: false } },
      additionalProperties: false,
    },
  },
  {
    name: 'etlaala_fs_delete',
    description: 'Delete a file or directory under Etlaala public_html. A file backup is attempted first. Requires confirm=true.',
    inputSchema: {
      type: 'object', required: ['path', 'confirm'],
      properties: { path: { type: 'string' }, recursive: { type: 'boolean', default: false }, confirm: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  {
    name: 'etlaala_download_to_file',
    description: 'Download a public HTTPS URL directly into Etlaala public_html. Private/local network URLs are blocked. Useful for GitHub/Cloudflare asset transfer.',
    inputSchema: {
      type: 'object', required: ['url', 'path'],
      properties: { url: { type: 'string' }, path: { type: 'string' }, expected_sha256: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'etlaala_extract_zip',
    description: 'Extract a ZIP already stored under Etlaala public_html into a destination under the same root. Zip-slip paths are blocked. Existing files are backed up when possible.',
    inputSchema: {
      type: 'object', required: ['zip_path', 'destination'],
      properties: { zip_path: { type: 'string' }, destination: { type: 'string' }, overwrite: { type: 'boolean', default: false }, strip_single_root: { type: 'boolean', default: false } },
      additionalProperties: false,
    },
  },
];

async function listEntries(startPath, recursive, maxDepth, limit) {
  const entries = [];
  async function walk(dir, depth) {
    if (entries.length >= limit) return;
    const rows = await fs.readdir(dir, { withFileTypes: true });
    rows.sort((a, b) => a.name.localeCompare(b.name));
    for (const row of rows) {
      if (entries.length >= limit) return;
      const full = path.join(dir, row.name);
      let payload;
      try { payload = await statPayload(full); }
      catch (error) { payload = { path: relativeToRoot(full), type: 'unreadable', error: error?.message || String(error) }; }
      entries.push(payload);
      if (recursive && row.isDirectory() && depth < maxDepth) await walk(full, depth + 1);
    }
  }
  await walk(startPath, 0);
  return entries;
}

async function handleFsTool(toolName, args = {}) {
  if (toolName === 'etlaala_scope_status') {
    return textResult({
      service: 'etlaala-hostinger-mcp',
      bridge_version: BRIDGE_VERSION,
      domain: ETLALA_DOMAIN,
      username: ETLALA_USERNAME,
      hostinger_api_token_configured: Boolean(HOSTINGER_API_TOKEN),
      filesystem: await fsSelfTest(),
    });
  }
  if (toolName === 'etlaala_fs_list') {
    const { resolved } = resolveEtlaalaPath(args.path || '.');
    const recursive = Boolean(args.recursive);
    const maxDepth = Math.min(12, Math.max(0, Number(args.max_depth ?? 3)));
    const limit = Math.min(3000, Math.max(1, Number(args.limit ?? 500)));
    const entries = await listEntries(resolved, recursive, maxDepth, limit);
    return textResult({ root: ETLALA_ROOT, requested_path: args.path || '.', count: entries.length, truncated: entries.length >= limit, entries });
  }
  if (toolName === 'etlaala_fs_stat') {
    const { resolved } = resolveEtlaalaPath(args.path);
    return textResult(await statPayload(resolved));
  }
  if (toolName === 'etlaala_fs_read') {
    const { resolved, rel } = resolveEtlaalaPath(args.path);
    const st = await fs.stat(resolved);
    if (!st.isFile()) throw new Error('Requested path is not a file');
    const offset = Math.max(0, Number(args.offset || 0));
    const requestedLength = Number(args.length || MAX_READ_BYTES);
    const length = Math.min(MAX_READ_BYTES, Math.max(1, requestedLength));
    const handle = await fs.open(resolved, 'r');
    try {
      const available = Math.max(0, st.size - offset);
      const bytesToRead = Math.min(length, available);
      const buffer = Buffer.alloc(bytesToRead);
      if (bytesToRead) await handle.read(buffer, 0, bytesToRead, offset);
      const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
      return textResult({ path: rel, offset, returned_bytes: bytesToRead, file_size: st.size, eof: offset + bytesToRead >= st.size, encoding, content: buffer.toString(encoding), sha256: await sha256File(resolved) });
    } finally { await handle.close(); }
  }
  if (toolName === 'etlaala_fs_write') {
    const { resolved, rel } = resolveEtlaalaPath(args.path);
    if (args.expected_sha256) {
      const current = await sha256File(resolved);
      if (current.toLowerCase() !== String(args.expected_sha256).toLowerCase()) throw new Error('SHA-256 mismatch; file changed since it was read');
    }
    const backup = await makeBackup(resolved, 'write');
    const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
    const bytes = Buffer.from(String(args.content), encoding);
    await atomicWrite(resolved, bytes);
    return textResult({ ok: true, path: rel, size: bytes.length, sha256: await sha256File(resolved), backup: backup || null });
  }
  if (toolName === 'etlaala_fs_patch_text') {
    const { resolved, rel } = resolveEtlaalaPath(args.path);
    const original = await fs.readFile(resolved, 'utf8');
    const originalHash = await sha256File(resolved);
    if (args.expected_sha256 && originalHash.toLowerCase() !== String(args.expected_sha256).toLowerCase()) throw new Error('SHA-256 mismatch; file changed since it was read');
    let updated = original;
    const applied = [];
    for (const item of args.replacements || []) {
      const search = String(item.search);
      const replace = String(item.replace);
      if (!search) throw new Error('Replacement search string cannot be empty');
      const count = updated.split(search).length - 1;
      if (!count) throw new Error(`Search text not found: ${search.slice(0, 120)}`);
      if (item.all) updated = updated.split(search).join(replace);
      else updated = updated.replace(search, replace);
      applied.push({ search: search.slice(0, 120), matches_before: count, replaced: item.all ? count : 1 });
    }
    const bytes = Buffer.from(updated, 'utf8');
    const backup = await makeBackup(resolved, 'patch');
    await atomicWrite(resolved, bytes);
    return textResult({ ok: true, path: rel, before_sha256: originalHash, after_sha256: await sha256File(resolved), applied, backup: backup || null });
  }
  if (toolName === 'etlaala_fs_mkdir') {
    const { resolved, rel } = resolveEtlaalaPath(args.path);
    await fs.mkdir(resolved, { recursive: true });
    return textResult({ ok: true, path: rel });
  }
  if (toolName === 'etlaala_fs_copy') {
    const source = resolveEtlaalaPath(args.source);
    const destination = resolveEtlaalaPath(args.destination);
    const st = await fs.stat(source.resolved);
    if (!st.isFile()) throw new Error('Copy source must be a file');
    if (!args.overwrite) {
      try { await fs.access(destination.resolved); throw new Error('Destination already exists; set overwrite=true'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    const backup = await makeBackup(destination.resolved, 'copy-overwrite');
    await fs.mkdir(path.dirname(destination.resolved), { recursive: true });
    await fs.copyFile(source.resolved, destination.resolved);
    return textResult({ ok: true, source: source.rel, destination: destination.rel, sha256: await sha256File(destination.resolved), backup: backup || null });
  }
  if (toolName === 'etlaala_fs_move') {
    const source = resolveEtlaalaPath(args.source);
    const destination = resolveEtlaalaPath(args.destination);
    if (!args.overwrite) {
      try { await fs.access(destination.resolved); throw new Error('Destination already exists; set overwrite=true'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    } else {
      await makeBackup(destination.resolved, 'move-overwrite');
      await fs.rm(destination.resolved, { recursive: true, force: true });
    }
    await fs.mkdir(path.dirname(destination.resolved), { recursive: true });
    await fs.rename(source.resolved, destination.resolved);
    return textResult({ ok: true, source: source.rel, destination: destination.rel });
  }
  if (toolName === 'etlaala_fs_delete') {
    if (args.confirm !== true) throw new Error('Deletion requires confirm=true');
    const target = resolveEtlaalaPath(args.path);
    if (target.resolved === ETLALA_ROOT) throw new Error('Deleting the Etlaala root is blocked');
    const st = await fs.lstat(target.resolved);
    const backup = st.isFile() ? await makeBackup(target.resolved, 'delete') : null;
    if (st.isDirectory() && !args.recursive) await fs.rmdir(target.resolved);
    else await fs.rm(target.resolved, { recursive: Boolean(args.recursive), force: false });
    return textResult({ ok: true, path: target.rel, backup: backup || null });
  }
  if (toolName === 'etlaala_download_to_file') {
    const target = resolveEtlaalaPath(args.path);
    const downloaded = await fetchPublicBytes(args.url);
    if (args.expected_sha256) {
      const actual = crypto.createHash('sha256').update(downloaded.bytes).digest('hex');
      if (actual.toLowerCase() !== String(args.expected_sha256).toLowerCase()) throw new Error('Downloaded SHA-256 does not match expected_sha256');
    }
    const backup = await makeBackup(target.resolved, 'download-overwrite');
    await atomicWrite(target.resolved, downloaded.bytes);
    return textResult({ ok: true, path: target.rel, size: downloaded.bytes.length, sha256: await sha256File(target.resolved), final_url: downloaded.final_url, content_type: downloaded.content_type, backup: backup || null });
  }
  if (toolName === 'etlaala_extract_zip') {
    const source = resolveEtlaalaPath(args.zip_path);
    const destination = resolveEtlaalaPath(args.destination);
    const sourceStat = await fs.stat(source.resolved);
    if (!sourceStat.isFile()) throw new Error('zip_path must be a file');
    if (sourceStat.size > MAX_DOWNLOAD_BYTES) throw new Error(`ZIP exceeds ${MAX_DOWNLOAD_BYTES} byte limit`);
    const zip = new AdmZip(source.resolved);
    const entries = zip.getEntries();
    let prefix = '';
    if (args.strip_single_root && entries.length) {
      const roots = new Set(entries.map((entry) => String(entry.entryName).replace(/\\/g, '/').split('/').filter(Boolean)[0]).filter(Boolean));
      if (roots.size === 1) prefix = [...roots][0] + '/';
    }
    const written = [];
    for (const entry of entries) {
      let name = String(entry.entryName).replace(/\\/g, '/');
      if (prefix && name.startsWith(prefix)) name = name.slice(prefix.length);
      if (!name) continue;
      if (name.startsWith('/') || name.includes('\0')) throw new Error(`Unsafe ZIP entry: ${entry.entryName}`);
      const normalized = path.posix.normalize(name);
      if (normalized === '..' || normalized.startsWith('../')) throw new Error(`Unsafe ZIP entry: ${entry.entryName}`);
      const outPath = path.resolve(destination.resolved, normalized);
      const destinationPrefix = destination.resolved.endsWith(path.sep) ? destination.resolved : destination.resolved + path.sep;
      if (outPath !== destination.resolved && !outPath.startsWith(destinationPrefix)) throw new Error(`ZIP entry escapes destination: ${entry.entryName}`);
      if (entry.isDirectory) { await fs.mkdir(outPath, { recursive: true }); continue; }
      if (!args.overwrite) {
        try { await fs.access(outPath); throw new Error(`Destination exists: ${relativeToRoot(outPath)}`); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
      } else {
        await makeBackup(outPath, 'zip-overwrite');
      }
      const data = entry.getData();
      if (data.length > MAX_WRITE_BYTES) throw new Error(`ZIP entry exceeds per-file write limit: ${entry.entryName}`);
      await atomicWrite(outPath, data);
      written.push(relativeToRoot(outPath));
      if (written.length > 10000) throw new Error('ZIP contains too many files');
    }
    return textResult({ ok: true, zip_path: source.rel, destination: destination.rel, files_written: written.length, sample: written.slice(0, 100), stripped_single_root: Boolean(prefix) });
  }
  throw new Error(`Unknown Etlaala filesystem tool: ${toolName}`);
}

const upstreamTools = await loadAllToolSchemas();
const cachedTools = [...upstreamTools, ...fsTools];
console.log(`Using hostinger-api-mcp ${upstreamPackage.version}`);
console.log(`Cached ${upstreamTools.length} Hostinger API tools + ${fsTools.length} Etlaala filesystem tools`);

async function callTool(toolName, args = {}) {
  if (toolName.startsWith('etlaala_')) return handleFsTool(toolName, args);
  return callUpstreamTool(toolName, args);
}

let initialFsStatus = await fsSelfTest();
console.log(`[SELFTEST filesystem] exists=${initialFsStatus.root_exists} readable=${initialFsStatus.root_readable} writable=${initialFsStatus.root_writable}${initialFsStatus.test_error ? ` error=${initialFsStatus.test_error}` : ''}`);

async function hostingerSelfTest() {
  try {
    const result = await callUpstreamTool('hosting_listWebsitesV1', { domain: ETLALA_DOMAIN, per_page: 20, page: 1 });
    return { ok: !result?.isError, is_error: Boolean(result?.isError), result };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
let initialHostingerStatus = await hostingerSelfTest();
console.log(`[SELFTEST Hostinger API] ok=${initialHostingerStatus.ok}`);

function safeTokenEqual(candidate) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(MCP_ACCESS_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestToken(req) {
  const auth = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const header = req.headers['x-mcp-access-token'];
  if (typeof header === 'string' && header) return header;
  if (typeof req.query?.token === 'string' && req.query.token) return req.query.token;
  return '';
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: JSON_LIMIT }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, X-MCP-Access-Token, MCP-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id, MCP-Protocol-Version');
  next();
});

app.get('/health', async (_req, res) => {
  initialFsStatus = await fsSelfTest();
  res.json({
    status: initialFsStatus.root_writable && initialHostingerStatus.ok ? 'ok' : 'degraded',
    service: 'etlaala-hostinger-mcp',
    bridge_version: BRIDGE_VERSION,
    upstream_version: upstreamPackage.version,
    domain: ETLALA_DOMAIN,
    username: ETLALA_USERNAME,
    filesystem: initialFsStatus,
    hostinger_api: { ok: initialHostingerStatus.ok, error: initialHostingerStatus.error || null },
    upstream_tools: upstreamTools.length,
    filesystem_tools: fsTools.length,
    mcp_authentication: 'required',
  });
});

app.get('/', (_req, res) => res.json({
  name: 'Etlaala Hostinger MCP',
  version: BRIDGE_VERSION,
  domain: ETLALA_DOMAIN,
  username: ETLALA_USERNAME,
  health: '/health',
  mcp_endpoint: '/mcp',
  authentication: 'Bearer token, X-MCP-Access-Token, or ?token=',
  protocols: [MODERN_PROTOCOL, LEGACY_PROTOCOL],
  tools: cachedTools.length,
}));

app.use('/mcp', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (!safeTokenEqual(requestToken(req))) return res.status(401).json({ error: 'Unauthorized' });
  next();
});
app.options('/mcp', (_req, res) => res.sendStatus(204));

function jsonRpcResult(res, id, result, status = 200) { res.status(status).json({ jsonrpc: '2.0', id: id ?? null, result }); }
function jsonRpcError(res, id, code, message, status = 400, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  res.status(status).json({ jsonrpc: '2.0', id: id ?? null, error });
}
function requestProtocol(req) {
  const header = req.headers['mcp-protocol-version'];
  const meta = req.body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  return String(header || meta || '');
}
function isModernEnvelope(req) { return req.body?.method === 'server/discover' || requestProtocol(req) === MODERN_PROTOCOL; }

async function handleModernRequest(req, res) {
  const body = req.body || {};
  const method = body.method;
  const id = body.id ?? null;
  res.setHeader('MCP-Protocol-Version', MODERN_PROTOCOL);
  if (method === 'server/discover') return jsonRpcResult(res, id, {
    resultType: 'complete',
    supportedVersions: [MODERN_PROTOCOL],
    capabilities: { tools: {} },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Etlaala Hostinger MCP', version: BRIDGE_VERSION } },
    instructions: `Dedicated MCP for ${ETLALA_DOMAIN}. Hostinger API tools plus direct filesystem read/write/delete/download/extract tools are locked to ${ETLALA_ROOT}.`,
    ttlMs: 60000,
    cacheScope: 'private',
  });
  if (method === 'tools/list') return jsonRpcResult(res, id, { resultType: 'complete', tools: cachedTools, ttlMs: 60000, cacheScope: 'private' });
  if (method === 'tools/call') {
    const toolName = body?.params?.name;
    if (!toolName) return jsonRpcError(res, id, -32602, 'Missing tool name', 400);
    try {
      const result = await callTool(toolName, body?.params?.arguments || {});
      return jsonRpcResult(res, id, { resultType: 'complete', ...result });
    } catch (error) {
      console.error(`[MCP modern] ${toolName} failed: ${error?.stack || error}`);
      return jsonRpcError(res, id, -32603, `Tool failed: ${toolName}: ${error?.message || error}`, 500);
    }
  }
  return jsonRpcError(res, id, -32601, `Method not found: ${method}`, 404);
}

const sessions = new Map();
function createDownstreamSession() {
  const downstreamServer = new Server({ name: 'Etlaala Hostinger MCP', version: BRIDGE_VERSION }, { capabilities: { tools: {} } });
  downstreamServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: cachedTools }));
  downstreamServer.setRequestHandler(CallToolRequestSchema, async (request) => callTool(request.params.name, request.params.arguments || {}));
  let transport;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { transport, server: downstreamServer });
      console.log(`[MCP legacy] session initialized: ${sessionId}`);
    },
  });
  transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
  return { transport, server: downstreamServer };
}

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (isModernEnvelope(req)) return handleModernRequest(req, res);
  try {
    let session;
    if (typeof sessionId === 'string' && sessions.has(sessionId)) session = sessions.get(sessionId);
    else if (!sessionId && isInitializeRequest(req.body)) {
      session = createDownstreamSession();
      await session.server.connect(session.transport);
    } else return jsonRpcError(res, req.body?.id, -32000, 'Invalid or missing MCP session', 400);
    await session.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(`[HTTP] POST /mcp failed: ${error?.stack || error}`);
    if (!res.headersSent) jsonRpcError(res, req.body?.id, -32603, 'Internal MCP proxy error', 500);
  }
});

async function handleSessionRequest(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
    if (req.method === 'GET') { res.setHeader('Allow', 'POST'); res.sendStatus(405); return; }
    res.status(400).send('Invalid or missing MCP session ID');
    return;
  }
  try { await sessions.get(sessionId).transport.handleRequest(req, res); }
  catch (error) { console.error(error); if (!res.headersSent) res.sendStatus(500); }
}
app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Etlaala Hostinger MCP v${BRIDGE_VERSION} listening on 0.0.0.0:${PORT}`);
  console.log(`Locked target: ${ETLALA_DOMAIN} / ${ETLALA_USERNAME}`);
  console.log(`Filesystem root: ${ETLALA_ROOT}`);
  console.log(`Tools exposed: ${cachedTools.length}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  httpServer.close();
  for (const { transport, server } of sessions.values()) {
    try { await transport.close(); } catch {}
    try { await server.close(); } catch {}
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
