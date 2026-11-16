import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { randomBytes, randomUUID, scrypt as scryptCallback, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(root, '.env'));

const username = process.env.COLLECTIF_USERNAME?.trim();
const password = process.env.COLLECTIF_PASSWORD;
if (!username || !password || password.length < 12 || password.startsWith('change-this-')) {
  console.error('Configure COLLECTIF_USERNAME and a unique COLLECTIF_PASSWORD (at least 12 characters) in .env before starting Collectif.');
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const appOrigin = process.env.APP_ORIGIN?.replace(/\/$/, '');
const secureCookies = appOrigin?.startsWith('https://') || process.env.NODE_ENV === 'production';
const maxUploadBytes = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 25)) * 1024 * 1024;
const dataDir = path.resolve(root, process.env.DATA_DIR || './data');
const filesDir = path.join(dataDir, 'files');
const dbFile = path.join(dataDir, 'items.json');
const staticDir = path.join(root, 'public');
const authSalt = randomBytes(16);
const authPasswordHash = scryptSync(password, authSalt, 64);
const signingKey = randomBytes(32);
const sessions = new Map();
const attempts = new Map();
let state = { items: [], shares: [] };
let writeQueue = Promise.resolve();

await fs.mkdir(filesDir, { recursive: true });
try { state = JSON.parse(await fs.readFile(dbFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; await persist(); }
if (!Array.isArray(state.items) || !Array.isArray(state.shares)) state = { items: [], shares: [] };

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of requireLines(file)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
}
function requireLines(file) { return readFileSync(file, 'utf8').split(/\r?\n/); }
function cookie(name, value, maxAge, httpOnly = true) {
  return `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Strict; Max-Age=${maxAge}${httpOnly ? '; HttpOnly' : ''}${secureCookies ? '; Secure' : ''}`;
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split(/=(.*)/s)).filter(pair => pair.length > 1).map(([k, v]) => [k, decodeURIComponent(v)]));
}
function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store', ...headers });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function json(res, status, body, headers) { send(res, status, body, 'application/json; charset=utf-8', headers); }
function fail(res, status, message) { json(res, status, { error: message }); }
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const requestOrigin = `${req.headers['x-forwarded-proto']?.split(',')[0] || 'http'}://${req.headers.host}`;
  if (appOrigin) return origin === appOrigin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return origin === requestOrigin;
}
function sessionUser(req) {
  const token = cookies(req).collectif_session;
  const record = token && sessions.get(token);
  if (!record || record.expires < Date.now()) { if (token) sessions.delete(token); return null; }
  return record.username;
}
function throttle(key, limit = 8) {
  const now = Date.now();
  let record = attempts.get(key);
  if (!record || now - record.started > 15 * 60_000) { record = { started: now, count: 0 }; attempts.set(key, record); }
  record.count += 1;
  return record.count <= limit;
}
function resetThrottle(key) { attempts.delete(key); }
async function readJson(req, limit = 128 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Requête trop volumineuse.'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Requête JSON invalide.'), { status: 400 }); }
}
async function hashPassword(value) {
  const salt = randomBytes(16);
  const hash = await scrypt(value, salt, 64);
  return { salt: salt.toString('hex'), hash: Buffer.from(hash).toString('hex') };
}
async function verifyPassword(value, encoded) {
  try {
    const expected = Buffer.from(encoded.hash, 'hex');
    const actual = Buffer.from(await scrypt(value, Buffer.from(encoded.salt, 'hex'), expected.length));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}
function persist() {
  writeQueue = writeQueue.then(async () => {
    const tmp = `${dbFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, dbFile);
  });
  return writeQueue;
}
function safeName(name) {
  const base = path.basename(String(name || 'fichier').replaceAll('\\', '/'));
  return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'fichier';
}
function itemView(item) {
  const { storageName, ...view } = item;
  const shares = state.shares.filter(share => !share.revoked && (share.itemId === item.id || share.itemIds?.includes(item.id))).map(({ token, createdAt }) => ({ token, createdAt }));
  return { ...view, hasShare: shares.length > 0, shares };
}
function findShare(token) { return state.shares.find(share => share.token === token && !share.revoked); }
function shareCookieValue(token, expires) {
  const value = `${token}.${expires}`;
  const signature = createHmac('sha256', signingKey).update(value).digest('base64url');
  return `${value}.${signature}`;
}
function hasShareAccess(req, token) {
  const value = cookies(req)[`collectif_dl_${token}`];
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== token || Number(parts[1]) < Date.now()) return false;
  const expected = createHmac('sha256', signingKey).update(`${parts[0]}.${parts[1]}`).digest();
  let actual;
  try { actual = Buffer.from(parts[2], 'base64url'); } catch { return false; }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function attachmentHeader(name) {
  const fallback = name.normalize('NFKD').replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
function sessionRequired(req, res) {
  if (sessionUser(req)) return true;
  fail(res, 401, 'Votre session a expiré. Reconnectez-vous.');
  return false;
}
async function serveDownload(res, item) {
  const textResource = ['text', 'note', 'link'].includes(item.type);
  const filename = textResource ? `${safeName(item.title || 'ressource').replace(/\.[^.]+$/, '')}.txt` : item.originalName;
  const contentType = textResource ? 'text/plain; charset=utf-8' : (item.mimeType || 'application/octet-stream');
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Disposition': attachmentHeader(filename), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  if (item.type === 'file') createReadStream(path.join(filesDir, item.storageName)).pipe(res);
  else res.end(item.content || '');
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(entries) {
  const localParts = [], centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const entry of entries) {
    const name = Buffer.from(safeName(entry.name), 'utf8');
    const content = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = deflateRawSync(content, { level: 6 });
    const crc = crc32(content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28); name.copy(local, 30);
    localParts.push(local, compressed);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt32LE(0, 36); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}
async function createBundle(items) {
  const entries = [];
  let totalBytes = 0;
  const nameCounts = new Map();
  for (const item of items) {
    let name, data;
    if (item.type === 'file') {
      name = safeName(item.originalName);
      const stat = await fs.stat(path.join(filesDir, item.storageName));
      totalBytes += stat.size;
      if (totalBytes > 200 * 1024 * 1024) throw Object.assign(new Error('Une archive groupée est limitée à 200 Mo.'), { status: 413 });
      data = await fs.readFile(path.join(filesDir, item.storageName));
    } else {
      name = `${safeName(item.title || (item.type === 'link' ? 'lien' : 'note')).replace(/\.[^.]+$/, '')}.txt`;
      data = Buffer.from(item.content || '', 'utf8');
      totalBytes += data.length;
    }
    const count = (nameCounts.get(name.toLocaleLowerCase()) || 0) + 1;
    nameCounts.set(name.toLocaleLowerCase(), count);
    if (count > 1) {
      const extension = path.extname(name);
      name = `${name.slice(0, name.length - extension.length)} (${count})${extension}`;
    }
    entries.push({ name, data });
  }
  if (totalBytes > 200 * 1024 * 1024) throw Object.assign(new Error('Une archive groupée est limitée à 200 Mo.'), { status: 413 });
  return makeZip(entries);
}
async function readDocxPreview(filePath) {
  const archive = await fs.readFile(filePath);
  const start = Math.max(0, archive.length - 65_557);
  let endOffset = -1;
  for (let i = archive.length - 22; i >= start; i--) if (archive.readUInt32LE(i) === 0x06054b50) { endOffset = i; break; }
  if (endOffset < 0) throw new Error('Document DOCX invalide.');
  const entries = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);
  let xml = null;
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Archive DOCX invalide.');
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (name === 'word/document.xml') {
      if (uncompressedSize > 2 * 1024 * 1024) throw new Error('Aperçu DOCX trop volumineux.');
      if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Archive DOCX invalide.');
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(dataStart, dataStart + compressedSize);
      if (dataStart + compressedSize > archive.length) throw new Error('Archive DOCX invalide.');
      if (method === 0) xml = compressed.toString('utf8');
      else if (method === 8) xml = inflateRawSync(compressed, { maxOutputLength: 2 * 1024 * 1024 }).toString('utf8');
      else throw new Error('Compression DOCX non prise en charge.');
      break;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (!xml) throw new Error('Contenu du document DOCX introuvable.');
  return xml.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:(br|cr)\b[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))).replace(/[ \t]+\n/g, '\n').trim().slice(0, 3200);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'GET' && pathname === '/api/session') {
      const user = sessionUser(req);
      return json(res, 200, { authenticated: Boolean(user), username: user || null });
    }
    if (req.method === 'POST' && pathname === '/api/login') {
      if (!sameOrigin(req)) return fail(res, 403, 'Origine de requête refusée.');
      const key = `login:${req.socket.remoteAddress}`;
      if (!throttle(key, 10)) return fail(res, 429, 'Trop de tentatives. Réessayez dans 15 minutes.');
      const body = await readJson(req);
      const suppliedUser = Buffer.from(String(body.username || '').trim());
      const configuredUser = Buffer.from(username);
      const userEqual = suppliedUser.length === configuredUser.length && timingSafeEqual(suppliedUser, configuredUser);
      const suppliedHash = Buffer.from(await scrypt(String(body.password || ''), authSalt, 64));
      const passwordEqual = timingSafeEqual(suppliedHash, authPasswordHash);
      if (!userEqual || !passwordEqual) return fail(res, 401, 'Identifiant ou mot de passe incorrect.');
      resetThrottle(key);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { username, expires: Date.now() + 7 * 24 * 60 * 60_000 });
      return json(res, 200, { authenticated: true, username }, { 'Set-Cookie': cookie('collectif_session', token, 7 * 24 * 60 * 60) });
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      if (!sameOrigin(req)) return fail(res, 403, 'Origine de requête refusée.');
      const token = cookies(req).collectif_session;
      if (token) sessions.delete(token);
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('collectif_session', '', 0) });
    }
    const unlockMatch = pathname.match(/^\/api\/share\/([A-Za-z0-9_-]+)\/unlock$/);
    const shareInfoMatch = pathname.match(/^\/api\/share\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && shareInfoMatch) {
      const share = findShare(shareInfoMatch[1]);
      const items = share && (share.kind === 'bundle' ? state.items.filter(candidate => share.itemIds.includes(candidate.id)) : state.items.filter(candidate => candidate.id === share.itemId));
      if (!items?.length) return fail(res, 404, 'Ce lien de partage est invalide ou a été révoqué.');
      return json(res, 200, { title: share.kind === 'bundle' ? `${items.length} ressources · archive ZIP` : items[0].title, type: share.kind === 'bundle' ? 'bundle' : items[0].type });
    }
    if (req.method === 'POST' && unlockMatch) {
      if (!sameOrigin(req)) return fail(res, 403, 'Origine de requête refusée.');
      const token = unlockMatch[1];
      const share = findShare(token);
      if (!share) return fail(res, 404, 'Ce lien de partage est invalide ou a été révoqué.');
      const key = `share:${req.socket.remoteAddress}:${token}`;
      if (!throttle(key, 8)) return fail(res, 429, 'Trop de tentatives. Réessayez dans 15 minutes.');
      const body = await readJson(req);
      if (!await verifyPassword(String(body.password || ''), share.password)) return fail(res, 401, 'Mot de passe incorrect.');
      resetThrottle(key);
      const expires = Date.now() + 15 * 60_000;
      const name = `collectif_dl_${token}`;
      return json(res, 200, { downloadUrl: `/download/${token}`, expiresIn: 900 }, { 'Set-Cookie': cookie(name, shareCookieValue(token, expires), 900) });
    }
    const downloadMatch = pathname.match(/^\/download\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && downloadMatch) {
      const token = downloadMatch[1];
      const share = findShare(token);
      if (!share) return fail(res, 404, 'Ce lien de partage est invalide ou a été révoqué.');
      if (!hasShareAccess(req, token)) return fail(res, 401, 'Saisissez le mot de passe du lien avant de télécharger.');
      if (share.kind === 'bundle') {
        const items = state.items.filter(candidate => share.itemIds.includes(candidate.id));
        if (!items.length) return fail(res, 404, 'Ces ressources n’existent plus.');
        const archive = await createBundle(items);
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': attachmentHeader('collectif-ressources.zip'), 'Content-Length': archive.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
        return res.end(archive);
      }
      const item = state.items.find(candidate => candidate.id === share.itemId);
      if (!item) return fail(res, 404, 'Cette ressource n’existe plus.');
      return await serveDownload(res, item);
    }
    const sharedPage = pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && sharedPage) return serveStatic(res, 'index.html');

    if (pathname.startsWith('/api/')) {
      if (!sameOrigin(req)) return fail(res, 403, 'Origine de requête refusée.');
      if (!sessionRequired(req, res)) return;
      if (req.method === 'GET' && pathname === '/api/items') return json(res, 200, { items: state.items.map(itemView) });
      const directDownloadRoute = pathname.match(/^\/api\/items\/([0-9a-f-]+)\/download$/i);
      if (req.method === 'GET' && directDownloadRoute) {
        const item = state.items.find(candidate => candidate.id === directDownloadRoute[1]);
        if (!item) return fail(res, 404, 'Ressource introuvable.');
        return await serveDownload(res, item);
      }
      const revokeRoute = pathname.match(/^\/api\/shares\/([A-Za-z0-9_-]+)$/);
      if (req.method === 'DELETE' && revokeRoute) {
        const share = findShare(revokeRoute[1]);
        if (!share) return fail(res, 404, 'Lien de partage introuvable.');
        share.revoked = true;
        await persist();
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/api/bundles/share') {
        const body = await readJson(req);
        const itemIds = [...new Set(Array.isArray(body.itemIds) ? body.itemIds.map(String) : [])];
        if (!itemIds.length || itemIds.length > 100) return fail(res, 400, 'Sélectionnez entre 1 et 100 ressources.');
        const selected = state.items.filter(item => itemIds.includes(item.id));
        if (selected.length !== itemIds.length) return fail(res, 404, 'Une ressource sélectionnée est introuvable.');
        const sharePassword = String(body.password || '');
        const token = randomBytes(24).toString('base64url');
        state.shares.push({ token, kind: 'bundle', itemIds, password: await hashPassword(sharePassword), createdAt: new Date().toISOString(), revoked: false });
        await persist();
        const origin = appOrigin || `${req.headers['x-forwarded-proto']?.split(',')[0] || 'http'}://${req.headers.host}`;
        return json(res, 201, { url: `${origin}/s/${token}`, token });
      }
      if (req.method === 'POST' && pathname === '/api/items') {
        const type = req.headers['content-type'] || '';
        if (type.startsWith('multipart/form-data')) {
          if (Number(req.headers['content-length'] || 0) > maxUploadBytes + 1024 * 1024) return fail(res, 413, `Le fichier dépasse la limite de ${process.env.MAX_UPLOAD_MB || 25} Mo.`);
          let received = 0;
          const limiter = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; callback(received > maxUploadBytes + 1024 * 1024 ? Object.assign(new Error('Fichier trop volumineux.'), { status: 413 }) : null, chunk); } });
          req.pipe(limiter);
          const webReq = new Request(`http://${req.headers.host}${req.url}`, { method: 'POST', headers: req.headers, body: Readable.toWeb(limiter), duplex: 'half' });
          const form = await webReq.formData();
          const upload = form.get('file');
          if (!upload || typeof upload.arrayBuffer !== 'function') return fail(res, 400, 'Choisissez un fichier à importer.');
          if (upload.size > maxUploadBytes) return fail(res, 413, `Le fichier dépasse la limite de ${process.env.MAX_UPLOAD_MB || 25} Mo.`);
          const id = randomUUID();
          const storageName = `${id}.bin`;
          await fs.writeFile(path.join(filesDir, storageName), Buffer.from(await upload.arrayBuffer()), { flag: 'wx', mode: 0o600 });
          const item = { id, type: 'file', title: safeName(upload.name), originalName: safeName(upload.name), mimeType: upload.type || 'application/octet-stream', size: upload.size, storageName, favorite: false, x: Math.random() * 35 + 8, y: Math.random() * 35 + 18, createdAt: new Date().toISOString() };
          state.items.push(item);
          await persist();
          return json(res, 201, { item: itemView(item) });
        }
        const body = await readJson(req);
        if (!['note', 'link'].includes(body.type)) return fail(res, 400, 'Type de ressource invalide.');
        const title = String(body.title || (body.type === 'note' ? 'Nouvelle note' : 'Nouveau lien')).trim().slice(0, 120);
        const content = String(body.content || '').slice(0, 20_000);
        if (!content.trim()) return fail(res, 400, 'Ajoutez un contenu avant de créer la ressource.');
        const item = { id: randomUUID(), type: body.type, title, content, favorite: false, x: Math.random() * 35 + 8, y: Math.random() * 35 + 18, createdAt: new Date().toISOString() };
        state.items.push(item);
        await persist();
        return json(res, 201, { item: itemView(item) });
      }
      const itemRoute = pathname.match(/^\/api\/items\/([0-9a-f-]+)(?:\/(share))?$/i);
      if (itemRoute && req.method === 'POST' && itemRoute[2] === 'share') {
        const item = state.items.find(candidate => candidate.id === itemRoute[1]);
        if (!item) return fail(res, 404, 'Ressource introuvable.');
        const body = await readJson(req);
        const sharePassword = String(body.password || '');
        const token = randomBytes(24).toString('base64url');
        const share = { token, kind: 'item', itemId: item.id, password: await hashPassword(sharePassword), createdAt: new Date().toISOString(), revoked: false };
        state.shares.push(share);
        await persist();
        const origin = appOrigin || `${req.headers['x-forwarded-proto']?.split(',')[0] || 'http'}://${req.headers.host}`;
        return json(res, 201, { url: `${origin}/s/${token}`, token });
      }
      const previewRoute = pathname.match(/^\/api\/items\/([0-9a-f-]+)\/preview$/i);
      if (previewRoute && req.method === 'GET') {
        const item = state.items.find(candidate => candidate.id === previewRoute[1]);
        const isImage = item?.type === 'file' && /^image\/(jpeg|png|gif|webp)$/.test(item.mimeType || '');
        const isPdf = item?.type === 'file' && (item.mimeType === 'application/pdf' || item.originalName?.toLowerCase().endsWith('.pdf'));
        if (!isImage && !isPdf) return fail(res, 404, 'Aperçu indisponible.');
        res.writeHead(200, { 'Content-Type': isPdf ? 'application/pdf' : item.mimeType, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': isPdf ? "frame-ancestors 'self'" : "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store' });
        return createReadStream(path.join(filesDir, item.storageName)).pipe(res);
      }
      const docxPreviewRoute = pathname.match(/^\/api\/items\/([0-9a-f-]+)\/preview-text$/i);
      if (docxPreviewRoute && req.method === 'GET') {
        const item = state.items.find(candidate => candidate.id === docxPreviewRoute[1]);
        if (!item || item.type !== 'file' || !item.originalName?.toLowerCase().endsWith('.docx')) return fail(res, 404, 'Aperçu DOCX indisponible.');
        try { return json(res, 200, { text: await readDocxPreview(path.join(filesDir, item.storageName)) }); }
        catch (error) { return fail(res, 422, error.message || 'Aperçu DOCX indisponible.'); }
      }
      if (itemRoute && req.method === 'PATCH' && !itemRoute[2]) {
        const item = state.items.find(candidate => candidate.id === itemRoute[1]);
        if (!item) return fail(res, 404, 'Ressource introuvable.');
        const body = await readJson(req);
        if (Object.hasOwn(body, 'x')) item.x = Math.min(90, Math.max(0, Number(body.x) || 0));
        if (Object.hasOwn(body, 'y')) item.y = Math.min(85, Math.max(0, Number(body.y) || 0));
        if (typeof body.favorite === 'boolean') item.favorite = body.favorite;
        if (['note', 'link'].includes(item.type)) {
          if (Object.hasOwn(body, 'title')) item.title = String(body.title || '').trim().slice(0, 120) || item.title;
          if (Object.hasOwn(body, 'content')) {
            const content = String(body.content || '').slice(0, 20_000);
            if (!content.trim()) return fail(res, 400, 'Ajoutez un contenu avant d’enregistrer la ressource.');
            item.content = content;
          }
        }
        await persist();
        return json(res, 200, { item: itemView(item) });
      }
      if (itemRoute && req.method === 'DELETE' && !itemRoute[2]) {
        const index = state.items.findIndex(candidate => candidate.id === itemRoute[1]);
        if (index < 0) return fail(res, 404, 'Ressource introuvable.');
        const [item] = state.items.splice(index, 1);
        for (const share of state.shares.filter(entry => entry.itemId === item.id)) share.revoked = true;
        if (item.storageName) await fs.rm(path.join(filesDir, item.storageName), { force: true });
        await persist();
        return json(res, 200, { ok: true });
      }
      return fail(res, 404, 'Route introuvable.');
    }
    if (req.method === 'GET') return serveStatic(res, pathname === '/' ? 'index.html' : pathname.slice(1));
    return fail(res, 404, 'Route introuvable.');
  } catch (error) {
    console.error(error);
    if (res.headersSent) { res.destroy(); return; }
    fail(res, error.status || 500, error.status ? error.message : 'Une erreur est survenue.');
  }
});

async function serveStatic(res, requested) {
  const safePath = path.resolve(staticDir, requested);
  if (!safePath.startsWith(`${staticDir}${path.sep}`) && safePath !== path.join(staticDir, 'index.html')) return fail(res, 404, 'Fichier introuvable.');
  let body;
  try { body = await fs.readFile(safePath); } catch { return fail(res, 404, 'Fichier introuvable.'); }
  const ext = path.extname(safePath);
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'", 'Referrer-Policy': 'same-origin' });
  res.end(body);
}

server.on('error', error => {
  if (error.code === 'EACCES') console.error(`Accès refusé sur ${host}:${port}. Essayez HOST=127.0.0.1 et, si besoin, un autre port dans .env.`);
  else if (error.code === 'EADDRINUSE') console.error(`Le port ${port} est déjà utilisé. Choisissez un autre PORT dans .env.`);
  else console.error(error);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Collectif écoute sur http://${host}:${port}${appOrigin ? ` · domaine configuré : ${appOrigin}` : ''}`));
