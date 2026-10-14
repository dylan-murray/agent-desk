"""Whether a web page will render inside an Agent Desk pane.

A browser never tells the embedding page why a cross-origin frame stayed blank: a site that
refuses framing and a server that is down both look like an error page the parent cannot
read. So the desk requests the page itself and reads the headers that decide it.
"""
import ipaddress
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

DEFAULT_PORTS = {'http': 80, 'https': 443}
# Some sites answer scripted clients differently from browsers; ask the way a browser would.
USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'


def page_url(text):
    """The http(s) URL a pane may load, or ValueError. Other schemes never reach a frame."""
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError('Enter a web address')
    parts = urlsplit(text.strip())
    if parts.scheme not in DEFAULT_PORTS or not parts.hostname:
        raise ValueError('Web pages must use an http or https address')
    return parts.geturl()


def origin_parts(url):
    parts = urlsplit(url)
    return parts.scheme, (parts.hostname or '').lower(), parts.port or DEFAULT_PORTS.get(parts.scheme)


def source_allows(source, desk, page):
    """One CSP frame-ancestors source expression against the desk's origin."""
    source = source.lower()
    scheme, host, port = desk
    if source == '*':
        return True
    if source == "'self'":
        return desk == page
    if source.endswith(':') and '/' not in source:
        return source[:-1] == scheme
    if '://' in source:
        source_scheme, source = source.split('://', 1)
        if source_scheme != scheme:
            return False
    elif page[0] != scheme and not (page[0] == 'http' and scheme == 'https'):
        return False
    source = source.split('/', 1)[0]
    source_host, _, source_port = source.partition(':')
    if source_host.startswith('*.'):
        if not host.endswith(source_host[1:]):
            return False
    elif source_host != host:
        return False
    if source_port == '*':
        return True
    return (int(source_port) if source_port.isdigit() else DEFAULT_PORTS.get(scheme)) == port


def framing_block(headers, desk_origin, final_url):
    """(header, value) that stops the desk framing this response, or None."""
    desk, page = origin_parts(desk_origin), origin_parts(final_url)
    # Each policy is enforced on its own; any one that refuses wins. With frame-ancestors
    # present, browsers ignore X-Frame-Options entirely.
    ancestors = []
    for policy in headers.get_all('Content-Security-Policy') or []:
        for directive in policy.split(';'):
            name, _, value = directive.strip().partition(' ')
            if name.lower() == 'frame-ancestors':
                ancestors.append(value.strip())
                break
    if ancestors:
        for value in ancestors:
            sources = value.split()
            if not any(source_allows(source, desk, page) for source in sources if source.lower() != "'none'"):
                return 'Content-Security-Policy', 'frame-ancestors ' + (value or "'none'")
        return None
    options = {token.strip().lower() for value in headers.get_all('X-Frame-Options') or [] for token in value.split(',')}
    if 'deny' in options or ('sameorigin' in options and desk != page):
        return 'X-Frame-Options', ', '.join(sorted(options)).upper()
    return None


LOOPBACK = ('localhost', '127.0.0.1', '::1', '0.0.0.0')


def is_desk(url, desk_origin):
    """Whether url is the desk's own address, under any of its loopback names."""
    page, desk = urlsplit(url), urlsplit(desk_origin)
    local = lambda host: host in LOOPBACK or (host or '').endswith('.localhost')
    port = lambda parts: parts.port or DEFAULT_PORTS.get(parts.scheme)
    return port(page) == port(desk) and (page.hostname == desk.hostname or local(page.hostname) and local(desk.hostname))


def private(host):
    """Whether host names this machine or a private network."""
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, None)}
    except (OSError, UnicodeError):
        return False
    return any(address.is_private or address.is_loopback or address.is_link_local or address.is_unspecified
               for address in (ipaddress.ip_address(a.split('%')[0]) for a in addresses))


class Redirects(HTTPRedirectHandler):
    """Follows redirects, except from a public page into this machine or the local network.

    The user chose the first address; a redirect is the page's choice, and could otherwise
    make the desk send requests to local services on a website's behalf.
    """

    def __init__(self, url, desk_origin):
        self.desk_origin = desk_origin
        self.local = private(urlsplit(url).hostname)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        if is_desk(newurl, self.desk_origin) or (not self.local and private(target.hostname)):
            raise URLError('The page redirects to a local address, which Agent Desk does not follow')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def check(url, desk_origin, timeout=5):
    url = page_url(url)
    # A frame on the desk's own origin could act as the desk, so it is never a pane.
    if is_desk(url, desk_origin):
        raise ValueError('Agent Desk cannot open itself in a pane')
    request = Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'text/html,*/*;q=0.8'})
    try:
        response = build_opener(Redirects(url, desk_origin)).open(request, timeout=timeout)
    except HTTPError as error:
        # An error page still renders in a frame, under the same framing rules.
        response = error
    except (URLError, socket.timeout, OSError, ValueError) as error:
        reason = getattr(error, 'reason', error)
        reason = getattr(reason, 'strerror', None) or str(reason)
        return dict(url=url, reachable=False, embeddable=None, reason=reason)
    with response:
        final = response.geturl() or url
        block = framing_block(response.headers, desk_origin, final)
        return dict(url=final, reachable=True, embeddable=block is None, status=response.status,
                    header=block[0] if block else None, value=block[1] if block else None)
