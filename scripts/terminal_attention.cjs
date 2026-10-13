// Headless attention readers for clients without a browser, such as the iOS app.
// Each terminal is replayed into the vendored xterm, and the browser's own
// terminalApprovalPrompt() reads its screen, so both clients agree on what needs you.
// stdin, one JSON object per line: {op:'size'|'output'|'forget', id, cols, rows, data, truncated}.
// stdout: {id, approval} whenever a terminal's approval prompt changes.
global.self = global;
const {Terminal} = require('../agent_desk/static/vendor/xterm.js');
const {terminalApprovalPrompt} = require('../agent_desk/static/terminal-attention.js');

const readers = new Map();
function reader(id, cols=80, rows=24) {
  let found = readers.get(id);
  if (!found) {
    // No onData handler: this observer never answers terminal queries or sends input.
    found = {term: new Terminal({cols, rows, scrollback: 0, allowProposedApi: true}), approval: null};
    readers.set(id, found);
  }
  return found;
}
function report(id, found) {
  const approval = terminalApprovalPrompt(found.term);
  if (approval === found.approval) return;
  found.approval = approval;
  process.stdout.write(JSON.stringify({id, approval}) + '\n');
}

let chain = Promise.resolve();
require('readline').createInterface({input: process.stdin}).on('line', line => {
  chain = chain.then(async () => {
    const message = JSON.parse(line);
    if (message.op === 'forget') {
      readers.get(message.id)?.term.dispose();
      readers.delete(message.id);
      return;
    }
    const found = reader(message.id, message.cols, message.rows);
    if (message.op === 'size' && (found.term.cols !== message.cols || found.term.rows !== message.rows)) {
      found.term.resize(message.cols, message.rows);
    }
    if (message.op === 'output') {
      if (message.truncated) found.term.reset();
      await new Promise(resolve => found.term.write(Buffer.from(message.data, 'base64'), resolve));
    }
    report(message.id, found);
  }).catch(error => { process.stderr.write(String(error) + '\n'); process.exit(1); });
}).on('close', () => chain.finally(() => process.exit(0)));
