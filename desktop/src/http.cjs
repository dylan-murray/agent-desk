'use strict';
const http = require('node:http');
const {Readable} = require('node:stream');
const {randomBytes} = require('node:crypto');
const {ORIGIN, trustedFrame} = require('./security.cjs');

function applicationRoute(url) {return url.protocol + '//' + url.host === ORIGIN && !url.username && !url.password && (url.pathname.startsWith('/api/') || url.pathname === '/config.js');}

// Chromium supplies the frame and initiator. Never authorize from Origin/Referer
// headers supplied by a renderer. The proof only crosses main-process handlers.
function applicationAuthority(windows) {
  const proof = randomBytes(32).toString('hex');
  return {
    authorize(details, headers) {
      const clean = {...headers};
      for (const key of Object.keys(clean)) if (key.toLowerCase() === 'x-agent-desk-app-bridge') delete clean[key];
      if (!applicationRoute(new URL(details.url))) return clean;
      if (details.initiatorOrigin !== ORIGIN || !trustedFrame({sender: details.webContents, senderFrame: details.frame}, windows)) return null;
      return {...clean, 'X-Agent-Desk-App-Bridge': proof};
    },
    accepts(request) {return request.headers.get('x-agent-desk-app-bridge') === proof;},
  };
}

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
async function forward(request, backend) {
  if (!backend.record) backend.loadRecord();
  const url = new URL(request.url), headers = {};
  const connectionHeaders = new Set((request.headers.get('connection') || '').toLowerCase().split(',').map(key => key.trim()));
  for (const [key, value] of request.headers) {
    if (hopHeaders.has(key) || connectionHeaders.has(key) || key.startsWith('sec-') || ['host', 'origin', 'referer', 'content-length', 'x-agent-desk-app-bridge', 'x-agent-desk-terminal'].includes(key)) continue;
    headers[key] = value;
  }
  Object.assign(headers, {Host: 'app', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'X-Agent-Desk-Terminal': backend.record.user_token});
  // The existing Python HTTP server uses Content-Length, not chunked uploads.
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
  if (body) headers['Content-Length'] = body.length;
  return new Promise((resolve, reject) => {
    const req = http.request({socketPath: backend.socket, path: url.pathname + url.search, method: request.method, headers}, res => {
      const result = new Headers();
      const connectionHeaders = new Set(String(res.headers.connection || '').toLowerCase().split(',').map(key => key.trim()));
      for (const [key, value] of Object.entries(res.headers)) {
        if (value != null && !hopHeaders.has(key) && !connectionHeaders.has(key) && !['set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials'].includes(key)) result.set(key, String(value));
      }
      // Backends cannot redirect the authenticated request outside this origin.
      if (res.headers.location) {
        const target = new URL(res.headers.location, request.url);
        if (!applicationRoute(target)) {res.destroy();resolve(new Response('Redirect refused', {status: 403}));return;}
        result.set('location', target.href);
      }
      result.set('cache-control', 'no-store');
      result.set('cross-origin-resource-policy', 'same-origin');
      const empty = request.method === 'HEAD' || [204, 205, 304].includes(res.statusCode);
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res), {status: res.statusCode, headers: result}));
    });
    const abort = () => req.destroy(Error('Request cancelled'));
    request.signal.addEventListener('abort', abort, {once: true});
    req.on('close', () => request.signal.removeEventListener('abort', abort));
    req.on('error', reject);
    if (request.signal.aborted) {abort();return;}
    req.end(body);
  });
}
module.exports = {applicationRoute, applicationAuthority, forward};
