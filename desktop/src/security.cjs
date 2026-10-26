'use strict';
const path = require('node:path');
const fs = require('node:fs');
const ORIGIN = 'agent-desk://app';
const MAX_BODY = 4 * 1024 * 1024;
function trustedFrame(event, windows) {
  const frame = event.senderFrame;
  return !!frame && !!event.sender && windows.has(event.sender.id) && frame === event.sender.mainFrame &&
    /^agent-desk:\/\/app\/(?:index\.html|inbox-document\.html|startup\.html)?(?:[?#].*)?$/.test(frame.url);
}
function assetPath(root, url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'agent-desk:' || parsed.hostname !== 'app' || parsed.username || parsed.password || parsed.port) throw Error('Invalid app origin');
  let relative = decodeURIComponent(parsed.pathname);
  if (/[\\\0]/.test(relative) || relative.split('/').includes('..')) throw Error('Invalid asset path');
  relative = relative === '/' ? 'index.html' : relative.slice(1);
  const candidate = fs.realpathSync(path.join(root, relative));
  const base = fs.realpathSync(root);
  if (!candidate.startsWith(base + path.sep) || !fs.statSync(candidate).isFile()) throw Error('Asset outside package');
  return candidate;
}
function externalURL(value) {
  try { const url = new URL(value);return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function toolCSP(value) {
  const rules=String(value || '').split(';').map(rule=>rule.trim()).filter(rule=>rule && !/^frame-ancestors(?:\s|$)/i.test(rule));
  return [...rules, 'frame-ancestors agent-desk://app'].join('; ');
}
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src agent-tool: http: https:; media-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'none'";
module.exports = {ORIGIN, MAX_BODY, trustedFrame, assetPath, externalURL, toolCSP, CSP};
