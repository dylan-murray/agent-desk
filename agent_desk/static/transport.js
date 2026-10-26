// One connection adapter for terminal events. HTTP uses native fetch everywhere.
var deskTransport = {
  socket(url) {
    if (!window.agentDeskDesktop) return new WebSocket(url);
    const socket = {onopen: null, onmessage: null, onclose: null, onerror: null};
    const connection = window.agentDeskDesktop.stream(event => {
      if (event.type === 'open') socket.onopen?.({});
      else if (event.type === 'message') socket.onmessage?.({data: event.data});
      else if (event.type === 'close') socket.onclose?.({code: event.code || 1006});
      else if (event.type === 'error') socket.onerror?.({});
    });
    socket.send = data => connection.send(data);
    socket.close = () => connection.close();
    return socket;
  },
};
