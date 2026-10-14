"""Reusable OpenSSH transport, independent of cloud discovery and credentials.

Hosts may be aliases from ~/.ssh/config. Additional shell syntax is never
accepted; ProxyJump and other advanced settings belong in SSH configuration.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil


def selection(payload):
    host=payload.get('host','')
    user=payload.get('user','')
    port=payload.get('port',22)
    identity=payload.get('identity_file','')
    if not isinstance(host,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,252}',host):
        raise ValueError('Enter an SSH host or an alias from ~/.ssh/config')
    if not isinstance(user,str) or (user and not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}',user)):
        raise ValueError('Enter a valid SSH user, or leave it empty to use SSH configuration')
    try:port=int(port)
    except (ValueError,TypeError):raise ValueError('SSH port must be between 1 and 65535') from None
    if not 1<=port<=65535:raise ValueError('SSH port must be between 1 and 65535')
    if not isinstance(identity,str) or '\n' in identity or '\x00' in identity or len(identity)>4000:
        raise ValueError('Enter a local SSH identity file path')
    if identity:
        path=Path(identity).expanduser()
        if not path.is_file():raise ValueError('SSH identity file does not exist')
        identity=str(path.resolve())
    return dict(transport='ssh',host=host,user=user,port=port,identity_file=identity)


def target_identity(config):
    return 'ssh:'+hashlib.sha256(json.dumps(config,sort_keys=True).encode()).hexdigest()


def target_name(config):
    return (config['user']+'@' if config['user'] else '')+config['host']


def ssh_command(config,interactive=False):
    config=selection(config)
    executable=shutil.which('ssh')
    if not executable:raise ValueError('Install OpenSSH to connect to remote machines')
    args=[executable,'-o','ForwardAgent=no','-o','ConnectTimeout=20','-o','ServerAliveInterval=30',
          '-o','StrictHostKeyChecking=accept-new','-o','BatchMode='+('no' if interactive else 'yes')]
    # Do not override Port from an SSH alias when the default was selected.
    if config['port']!=22:args+=['-p',str(config['port'])]
    if config['user']:args+=['-l',config['user']]
    if config['identity_file']:args+=['-i',config['identity_file']]
    return [*args,'-tt' if interactive else '-T',config['host']]
