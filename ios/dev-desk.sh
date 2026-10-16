#!/bin/sh
# A desk for the app in the Simulator, run from this checkout: a desk on 127.0.0.1:4390 with its
# own state, and an sshd on 127.0.0.1:2298 that only takes the keys in its own authorized_keys.
# Everything it makes lives in data/ios-dev, which git ignores. The desk you work in is never
# touched; its accounts are copied once so the same agents can be launched.
#
#   ios/dev-desk.sh [up]   start both (each only if it is not running) and print the app's settings
#   ios/dev-desk.sh down   stop both
#   ios/dev-desk.sh status
#
# DESK_PORT and SSH_PORT override the ports, and AGENT_DESK_DATA_DIR the desk's state.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=$ROOT/data/ios-dev
SSHD=$DIR/sshd
# Two desks cannot share one state folder: each takes the workflow scheduler's lock.
DATA=${AGENT_DESK_DATA_DIR:-$DIR/desk}
DESK_PORT=${DESK_PORT:-4390}
SSH_PORT=${SSH_PORT:-2298}
USER_NAME=$(id -un)

if [ "$DESK_PORT" = 4310 ]; then
    echo "Port 4310 is the desk you work in; choose another DESK_PORT." >&2
    exit 1
fi

listening() {
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null
}

sshd_running() {
    [ -f "$SSHD/sshd.pid" ] && kill -0 "$(cat "$SSHD/sshd.pid")" 2>/dev/null
}

# The first interpreter that runs agent_desk: Python 3.11 or later.
find_python() {
    for candidate in ${PYTHON:-} python3.14 python3.13 python3.12 python3.11 python3; do
        path=$(command -v "$candidate" 2>/dev/null) || continue
        "$path" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null && { echo "$path"; return; }
    done
    echo "No Python 3.11 or later found; set PYTHON." >&2
    exit 1
}

# A folder holding Node 22 or later, which the desk's scripts need.
find_node() {
    for folder in "$(dirname "$(command -v node 2>/dev/null || echo /nonexistent/node)")" \
        /opt/homebrew/opt/node@24/bin /opt/homebrew/opt/node@22/bin /opt/homebrew/bin /usr/local/bin; do
        [ -x "$folder/node" ] || continue
        major=$("$folder/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
        [ "$major" -ge 22 ] && { echo "$folder"; return; }
    done
    echo "No Node 22 or later found; brew install node@22." >&2
    exit 1
}

# The command the app runs over SSH: this checkout's agent-desk, outside any agent's pane.
write_wrapper() {
    python=$(find_python)
    node=$(find_node)
    cat > "$DIR/agent-desk" <<EOF
#!/bin/sh
# Written by ios/dev-desk.sh: this checkout's agent-desk, for the Simulator app.
export PATH='$node':\$PATH PYTHONPATH='$ROOT' AGENT_DESK_DATA_DIR='$DATA'
unset AGENT_DESK_TERMINAL_ID AGENT_DESK_PANE_TOKEN AGENT_DESK_PANE_PID AGENT_DESK_URL AGENT_DESK_READOUTS_DIR
exec '$python' -m agent_desk "\$@"
EOF
    chmod +x "$DIR/agent-desk"
}

write_sshd() {
    mkdir -p "$SSHD"
    chmod 700 "$DIR" "$SSHD"
    [ -f "$SSHD/host" ] || ssh-keygen -q -t ed25519 -N '' -C agent-desk-dev -f "$SSHD/host"
    touch "$SSHD/authorized_keys"
    chmod 600 "$SSHD/authorized_keys"
    cat > "$SSHD/sshd_config" <<EOF
Port $SSH_PORT
ListenAddress 127.0.0.1
HostKey $SSHD/host
AuthorizedKeysFile $SSHD/authorized_keys
PidFile $SSHD/sshd.pid
UsePAM no
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers $USER_NAME
EOF
}

up() {
    mkdir -p "$DIR"
    write_sshd
    if sshd_running; then
        echo "sshd already running on 127.0.0.1:$SSH_PORT"
    elif [ -n "$(listening "$SSH_PORT")" ]; then
        echo "Something else is listening on $SSH_PORT; set SSH_PORT." >&2
        exit 1
    else
        /usr/sbin/sshd -f "$SSHD/sshd_config" -E "$SSHD/sshd.log"
        echo "sshd started on 127.0.0.1:$SSH_PORT"
    fi
    if [ -n "$(listening "$DESK_PORT")" ]; then
        # The wrapper the app runs must find the running desk's state, so it stays as written.
        [ -x "$DIR/agent-desk" ] || write_wrapper
        echo "desk already running on 127.0.0.1:$DESK_PORT"
    else
        if [ ! -d "$DATA" ]; then
            mkdir -p "$DATA"
            if [ -f "$ROOT/data/accounts.json" ]; then cp "$ROOT/data/accounts.json" "$DATA/"; fi
        fi
        write_wrapper
        (cd "$ROOT" && exec nohup "$DIR/agent-desk" --port "$DESK_PORT" > "$DIR/desk.log" 2>&1) &
        tries=0
        until [ -n "$(listening "$DESK_PORT")" ]; do
            tries=$((tries + 1))
            if [ "$tries" -gt 60 ]; then
                echo "The desk did not start; see $DIR/desk.log" >&2
                exit 1
            fi
            sleep 0.5
        done
        echo "desk started on 127.0.0.1:$DESK_PORT (log: data/ios-dev/desk.log)"
    fi
    cat <<EOF

Add the app's key (This iPhone's key) to $SSHD/authorized_keys,
then add a desk in the app with:
  Host                  127.0.0.1
  User                  $USER_NAME
  Advanced:
    SSH port            $SSH_PORT
    Agent Desk port     $DESK_PORT
    Agent Desk command  $DIR/agent-desk
The server key it asks you to trust should be $(ssh-keygen -lf "$SSHD/host.pub" | awk '{print $2}')
EOF
}

down() {
    if sshd_running; then
        kill "$(cat "$SSHD/sshd.pid")"
        echo "sshd stopped"
    fi
    pids=$(listening "$DESK_PORT")
    if [ -n "$pids" ]; then
        kill $pids
        echo "desk on $DESK_PORT stopped"
    fi
    # The desk's terminals live in a supervisor that outlives it, so they survive a down and up.
    # An idle one stops; one with terminals running refuses and keeps them for the next desk.
    if reply=$(PYTHONPATH=$ROOT "$(find_python)" -m agent_desk.terminal_supervisor \
        --data-dir "$DATA" --port "$DESK_PORT" --shutdown 2>&1); then
        echo "terminal supervisor stopped"
    else
        case "$reply" in
            *"No such file"* | *"Connection refused"*) ;;
            *"running sessions"*) echo "terminals still running are kept; the next up reconnects to them" ;;
            *) echo "terminal supervisor: $reply" >&2 ;;
        esac
    fi
}

status() {
    if sshd_running; then echo "sshd: running on 127.0.0.1:$SSH_PORT"; else echo "sshd: stopped"; fi
    if [ -n "$(listening "$DESK_PORT")" ]; then echo "desk: running on 127.0.0.1:$DESK_PORT"; else echo "desk: stopped"; fi
    keys=$(grep -c . "$SSHD/authorized_keys" 2>/dev/null || true)
    echo "keys: ${keys:-0} in data/ios-dev/sshd/authorized_keys"
}

case "${1:-up}" in
    up) up ;;
    down) down ;;
    status) status ;;
    *) echo "usage: ios/dev-desk.sh [up|down|status]" >&2; exit 2 ;;
esac
