"""Run a Python HTTP skill on an inherited, already-bound loopback socket."""
import argparse
import http.server
import json
import os
from pathlib import Path
import runpy
import socket
import socketserver
import sys

parser=argparse.ArgumentParser()
parser.add_argument('--instance',required=True)
parser.add_argument('--ready',required=True)
parser.add_argument('script')
parser.add_argument('args',nargs=argparse.REMAINDER)
args=parser.parse_args()
listener=socket.socket(fileno=int(os.environ.pop('AGENT_DESK_LISTEN_FD')))
address=listener.getsockname()
bind=socketserver.TCPServer.server_bind
activate=socketserver.TCPServer.server_activate
claimed=False

def server_bind(server):
    global claimed
    if not claimed and server.server_address==address:
        server.socket.close();server.socket=listener;server.server_address=address;claimed=True
    else:
        bind(server)

def server_activate(server):
    activate(server)
    if server.socket is listener:
        ready=Path(args.ready);temp=ready.with_suffix('.tmp')
        temp.write_text(json.dumps({'instance':args.instance,'port':address[1]}));os.replace(temp,ready)

def http_server_bind(server):
    # Skip http.server's socket.getfqdn lookup, which can stall for about 35 seconds where reverse DNS is slow.
    socketserver.TCPServer.server_bind(server)
    server.server_name,server.server_port=server.server_address[:2]

socketserver.TCPServer.server_bind=server_bind
http.server.HTTPServer.server_bind=http_server_bind
socketserver.TCPServer.server_activate=server_activate
sys.path.insert(0,str(Path(args.script).resolve().parent))
sys.argv=[args.script,*args.args]
if os.environ.pop('AGENT_DESK_REVIEW_BRIDGE','')=='1' and Path(args.script).name=='review_app.py':
    module=runpy.run_path(args.script,run_name='agentdesk_review_skill')
    namespace=module['main'].__globals__
    page=namespace['PAGE']
    for old,new in [('Submit feedback','Send to coordinator'),('Feedback submitted','Sent to coordinator'),('Feedback not submitted','Not sent yet'),('Save this round for the agent to retrieve; automatic delivery depends on your host','Your Agent Desk coordinator receives this feedback'),('waiting for the agent to commit, push and open it','waiting for your coordinator to arrange publication')]:page=page.replace(old,new)
    namespace['PAGE']=page.replace('</head>','<style>#codex{display:none!important}</style></head>')
    module['main']()
elif Path(args.script).name=='readme_annotate.py':
    module=runpy.run_path(args.script,run_name='agentdesk_readme_skill')
    namespace=module['main'].__globals__
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from agent_desk.readme_feedback import install
    install(namespace)
    bridge=(Path(__file__).resolve().parents[1]/'agent_desk'/'static'/'readme-feedback-frame.js').read_text()
    namespace['PAGE']=namespace['PAGE'].replace('</body>', '<script>'+bridge+'</script></body>')
    module['main']()
else:
    runpy.run_path(args.script,run_name='__main__')
