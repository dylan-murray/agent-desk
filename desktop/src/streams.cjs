'use strict';
const net = require('node:net');
const {MessageChannelMain} = require('electron');
const WebSocket = require('ws');
const {ORIGIN} = require('./security.cjs');
function openStream(backend, frame, id, onDisconnect = () => {}) {
  const {port1, port2} = new MessageChannelMain();
  const ws = new WebSocket('ws://app/api/terminals/stream', {
    createConnection: () => net.createConnection(backend.socket), origin: ORIGIN,
    headers: {Host: 'app', 'X-Agent-Desk-Terminal': backend.record.user_token}, maxPayload: 1024 * 1024,
  });
  let closed = false, sequence = 0, bytes = 0;
  const pending = new Map();
  const deliver = value => {if (!closed) port1.postMessage(value);};
  const close = () => {if (closed) return;closed = true;ws.terminate();port1.close();};
  port1.on('close', close);
  port1.on('message', ({data}) => {
    if (data && Number.isSafeInteger(data.ack) && pending.has(data.ack)) {
      bytes -= pending.get(data.ack);pending.delete(data.ack);
      if (pending.size < 32 && bytes < 512 * 1024 && ws.isPaused) ws.resume();
    } else if (typeof data?.message === 'string' && Buffer.byteLength(data.message) <= 128 * 1024 && ws.readyState === WebSocket.OPEN) {
      try {
        const message = JSON.parse(data.message);
        // Authentication is owned by the main process; no user token crosses preload.
        if (message.type === 'auth') return;
        if (!['subscribe', 'unsubscribe', 'input', 'resize'].includes(message.type)) throw Error('Unknown stream operation');
        ws.send(JSON.stringify(message));
      } catch {close();}
    } else close();
  });
  port1.start();frame.postMessage('desk:stream-port', id, [port2]);
  ws.on('open', () => {ws.send(JSON.stringify({type: 'auth', token: backend.record.user_token}));deliver({type: 'open'});});
  ws.on('message', data => {
    const text = data.toString();const seq = ++sequence;const size = Buffer.byteLength(text);
    pending.set(seq, size);bytes += size;
    if (bytes > 8 * 1024 * 1024) {deliver({type: 'close', code: 1013});close();return;}
    deliver({type: 'message', data: text, seq});
    if (pending.size >= 64 || bytes >= 1024 * 1024) ws.pause();
  });
  ws.on('close', code => {if (!closed) onDisconnect();deliver({type: 'close', code});close();});
  ws.on('error', () => {if (!closed) onDisconnect();deliver({type: 'error'});deliver({type: 'close', code: 1006});close();});
  return close;
}
module.exports = {openStream};
