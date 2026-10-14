"""Local context retrieval and optional cached source analysis for native workers."""
import argparse
import json
import sys
from urllib.request import Request, urlopen
try:
    from .agent_control import DeskClient
except ImportError:
    from agent_control import DeskClient


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--desk',default='http://127.0.0.1:4310');parser.add_argument('--coordinator',required=True)
    commands=parser.add_subparsers(dest='command',required=True)
    search=commands.add_parser('search');search.add_argument('query');search.add_argument('--offset',type=int,default=0)
    read=commands.add_parser('read');read.add_argument('reference');read.add_argument('--offset',type=int,default=0)
    analyze=commands.add_parser('analyze');analyze.add_argument('--question',required=True);analyze.add_argument('--paths',nargs='+',required=True)
    args=parser.parse_args()
    try:
        client=DeskClient(args.desk)
        if args.command=='analyze':
            # Analysis can outlast the short timeout used for ordinary UI requests.
            client.request('/api/coordinators/context',{'id':args.coordinator})
            payload={'id':args.coordinator,'question':args.question,'paths':args.paths}
            req=Request(client.desk+'/api/coordinators/analyze',data=json.dumps(payload).encode(),headers={'X-Agent-Desk-Terminal':client.token,'Content-Type':'application/json'})
            with urlopen(req,timeout=250) as response:result=json.load(response)
        else:
            payload={'id':args.coordinator,'offset':args.offset,'query':args.query} if args.command=='search' else {'id':args.coordinator,'offset':args.offset,'reference':args.reference}
            result=client.request('/api/coordinators/retrieve',payload)
        print(json.dumps(result,ensure_ascii=False));return 0
    except (ValueError,OSError) as error:
        print(json.dumps({'error':str(error),'hint':'If the reader is disabled or unavailable, use targeted local source reads.'}),file=sys.stderr);return 1

if __name__=='__main__':sys.exit(main())
