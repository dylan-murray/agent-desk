// Desktop-only file input. The CLI keeps ownership of its prompt and image rendering.
const TerminalFiles = (() => {
  const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  function quotePath(path) {
    if (typeof path !== 'string' || !path.startsWith('/') || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(path)) throw Error('File paths must be absolute and contain no control characters.');
    return "'" + path.replace(/'/g, "'\\''") + "'";
  }
  function mount({bridge, target, pane, term, available, remote, status}) {
    if (!bridge?.saveImage || !bridge?.droppedFilePath) return null;
    let tail = Promise.resolve(), pending = 0, generation = 0, disposed = false, insertion = null, notice = '', connected = false;
    const usable = () => connected && available();
    const valid = token => !disposed && token === generation && usable();
    const report = text => {if (!disposed) {notice = text;status.textContent = text;}};
    const clear = () => {if (status.textContent === notice) status.textContent = '';notice = '';};
    const unavailable = () => Error('Terminal unavailable. File input was cancelled; nothing was retried.');
    const remoteNotice = 'File input is available only in local terminals. Remote transfers are not supported.';
    function enqueue(action) {
      const token = generation;pending++;
      tail = tail.then(() => action(token)).finally(() => {if (token === generation) pending--;});
      // Keep the queue usable after a rejected operation, without retrying it.
      tail = tail.catch(error => {if (token === generation) report(error.message);});
    }
    function input(write) {
      if (disposed || !usable()) return;
      if (insertion) {
        const current = insertion;
        current.deliveries.push(write(() => valid(current.token) && !remote()));
        return;
      }
      if (!pending) return write();
      enqueue(token => {if (valid(token)) return write();});
    }
    function receive(files, screenshot) {
      if (remote()) {report(remoteNotice);return;}
      if (!usable()) {report(unavailable().message);return;}
      enqueue(async token => {
        if (!valid(token)) throw unavailable();
        if (!files.length) throw Error('Drop a file with a filesystem path or a captured image.');
        // Resolve and validate the entire drop before saving images or inserting anything.
        const entries = files.map(file => {
          const path = screenshot ? '' : bridge.droppedFilePath(file);
          if (path) {quotePath(path);return {path};}
          if (!file.type.startsWith('image/')) throw Error('This drop has no usable filesystem path.');
          if (file.size > MAX_IMAGE_BYTES) throw Error('Screenshot exceeds the 20 MiB limit.');
          return {file};
        });
        const paths = [];
        for (const entry of entries) {
          if (!valid(token)) throw unavailable();
          if (entry.path) paths.push(entry.path);
          else {
            report('Saving screenshot…');
            const bytes = new Uint8Array(await entry.file.arrayBuffer());
            if (!valid(token)) throw unavailable();
            paths.push(await bridge.saveImage(bytes));
          }
        }
        if (!valid(token) || remote()) throw unavailable();
        const text = paths.map(quotePath).join(' ') + ' ';
        // xterm emits onData synchronously here; it must precede input queued while saving.
        // Keep the generation guard and pending status until the send queue has finished.
        const current = {token, deliveries: []};insertion = current;
        try {term.paste(text);} finally {insertion = null;}
        await Promise.all(current.deliveries);
        if (!valid(token)) throw unavailable();
        clear();
      });
    }
    function paste(event) {
      const data = event.clipboardData;
      // Even whitespace is text. Leave xterm's ordinary and long-paste handling intact.
      if (!data || data.getData('text/plain') !== '') return;
      const images = Array.from(data.files || []).filter(file => file.type.startsWith('image/'));
      if (!images.length) return;
      event.preventDefault();event.stopImmediatePropagation();receive(images, true);
    }
    const fileDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files');
    const unhighlight = () => pane.classList.remove('terminal-file-target');
    function drag(event) {
      if (!fileDrag(event)) return;
      event.preventDefault();event.stopPropagation();
      const local = !remote(), ready = usable();
      event.dataTransfer.dropEffect = ready && local ? 'copy' : 'none';
      // A forbidden native drag may never emit drop, so explain the rejection now.
      if (!local) report(remoteNotice);else if (!ready) report(unavailable().message);
      pane.classList.add('terminal-file-target');
    }
    function leave(event) {if (!target.contains(event.relatedTarget)) unhighlight();}
    function drop(event) {
      unhighlight();
      if (!event.dataTransfer) return;
      event.preventDefault();event.stopImmediatePropagation();
      receive(Array.from(event.dataTransfer.files || []), false);
    }
    target.addEventListener('paste', paste, true);
    target.addEventListener('dragenter', drag);
    target.addEventListener('dragover', drag);
    target.addEventListener('dragleave', leave);
    target.addEventListener('drop', drop, true);
    const document = target.ownerDocument;
    document.addEventListener('dragend', unhighlight);
    document.addEventListener('drop', unhighlight);
    // A recovered connection must not revive work captured before the interruption.
    let revision = -1;
    const connection = state => {if (state.revision < revision) return;revision = state.revision;connected = state.connection === 'connected';if (!connected) cancel();};
    const unsubscribe = bridge.subscribe(connection);
    bridge.snapshot().then(connection).catch(() => cancel());
    function cancel() {
      if (pending) report(unavailable().message);
      generation++;tail = Promise.resolve();pending = 0;unhighlight();
    }
    return {
      input, cancel,
      dispose() {
        disposed = true;cancel();unsubscribe();
        target.removeEventListener('paste', paste, true);
        target.removeEventListener('dragenter', drag);
        target.removeEventListener('dragover', drag);
        target.removeEventListener('dragleave', leave);
        target.removeEventListener('drop', drop, true);
        document.removeEventListener('dragend', unhighlight);
        document.removeEventListener('drop', unhighlight);
      },
    };
  }
  return {mount, quotePath};
})();
if (typeof module !== 'undefined') module.exports = TerminalFiles;
