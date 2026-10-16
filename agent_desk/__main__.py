"""Start Agent Desk with ``python -m agent_desk``, or run one of its client commands."""
import sys

# Clients of a running desk, used by the iOS app. They must not import the server,
# which opens the desk's databases as it loads.
CLIENT_COMMANDS = ('attach', 'mobile')


def main():
    if sys.argv[1:2] and sys.argv[1] in CLIENT_COMMANDS:
        from agent_desk import mobile
        sys.exit(mobile.main())
    from agent_desk.server import main as serve
    serve()


if __name__ == "__main__":
    main()
