import json
import socket
import threading
import unittest
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from agent_desk import server, web_pages

DESK = 'http://127.0.0.1:4310'


def headers(**values):
    message = Message()
    for name, value in values.items():
        for item in value if isinstance(value, list) else [value]:
            message[name.replace('_', '-')] = item
    return message


class Site(BaseHTTPRequestHandler):
    # path -> (status, headers)
    routes = {
        '/open': (200, {}),
        '/deny': (200, {'X-Frame-Options': 'DENY'}),
        '/missing': (404, {'X-Frame-Options': 'SAMEORIGIN'}),
        '/moved': (302, {'Location': '/deny'}),
    }

    def do_GET(self):
        status, extra = self.routes.get(self.path, (200, {}))
        self.send_response(status)
        for name, value in extra.items():
            self.send_header(name, value)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def log_message(self, *args):
        pass


class FramingTests(unittest.TestCase):
    def block(self, url='https://example.com/', **values):
        return web_pages.framing_block(headers(**values), DESK, url)

    def test_pages_without_framing_headers_embed(self):
        self.assertIsNone(self.block())

    def test_x_frame_options_deny_and_sameorigin_block_the_desk(self):
        self.assertEqual(self.block(X_Frame_Options='DENY'), ('X-Frame-Options', 'DENY'))
        self.assertEqual(self.block(X_Frame_Options='sameorigin'), ('X-Frame-Options', 'SAMEORIGIN'))
        # SAMEORIGIN only lets the desk frame its own pages.
        self.assertIsNone(self.block(DESK + '/apps/x', X_Frame_Options='SAMEORIGIN'))

    def test_frame_ancestors_replaces_x_frame_options(self):
        self.assertIsNone(self.block(Content_Security_Policy="default-src 'self'; frame-ancestors *", X_Frame_Options='DENY'))
        self.assertEqual(self.block(Content_Security_Policy="frame-ancestors 'none'"), ('Content-Security-Policy', "frame-ancestors 'none'"))
        self.assertEqual(self.block(Content_Security_Policy="frame-ancestors 'self' https://github.com")[0], 'Content-Security-Policy')

    def test_frame_ancestors_sources_match_the_desk_origin(self):
        for allowed in ('http:', 'http://127.0.0.1:4310', 'http://127.0.0.1:*', '127.0.0.1:4310', "'self' http://127.0.0.1:4310"):
            self.assertIsNone(self.block('http://localhost:3000/', Content_Security_Policy='frame-ancestors ' + allowed), allowed)
        for refused in ('https:', 'http://127.0.0.1', 'http://localhost:4310', 'https://127.0.0.1:4310', '*.example.com'):
            self.assertIsNotNone(self.block('http://localhost:3000/', Content_Security_Policy='frame-ancestors ' + refused), refused)

    def test_every_policy_must_allow_framing(self):
        self.assertIsNotNone(self.block(Content_Security_Policy=['frame-ancestors *', "frame-ancestors 'none'"]))

    def test_only_web_addresses_are_accepted(self):
        self.assertEqual(web_pages.page_url(' http://localhost:3000/x '), 'http://localhost:3000/x')
        for text in ('javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'localhost:3000', '', None):
            with self.assertRaises(ValueError, msg=text):
                web_pages.page_url(text)


class CheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.site = ThreadingHTTPServer(('127.0.0.1', 0), Site)
        threading.Thread(target=cls.site.serve_forever, daemon=True).start()
        cls.base = 'http://127.0.0.1:%d' % cls.site.server_port

    @classmethod
    def tearDownClass(cls):
        cls.site.shutdown()
        cls.site.server_close()

    def test_the_desk_itself_is_never_a_pane(self):
        for url in (DESK, DESK + '/apps/review', 'http://localhost:4310/', 'http://LOCALHOST:4310', 'http://[::1]:4310/x', 'http://desk.localhost:4310/'):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, 'cannot open itself'):
                web_pages.check(url, DESK)
        # Other local ports are ordinary pages, and so is the same port on another machine.
        for url in ('http://127.0.0.1:5173/', 'http://localhost:8080/', 'http://example.com:4310/'):
            self.assertFalse(web_pages.is_desk(url, DESK), url)

    def test_reads_the_headers_of_a_live_page(self):
        self.assertEqual(web_pages.check(self.base + '/open', DESK)['embeddable'], True)
        denied = web_pages.check(self.base + '/deny', DESK)
        self.assertEqual((denied['reachable'], denied['embeddable'], denied['header']), (True, False, 'X-Frame-Options'))

    def test_error_pages_and_redirects_use_the_final_response(self):
        missing = web_pages.check(self.base + '/missing', DESK)
        self.assertEqual((missing['status'], missing['embeddable']), (404, False))
        moved = web_pages.check(self.base + '/moved', DESK)
        self.assertEqual((moved['url'], moved['embeddable']), (self.base + '/deny', False))

    def test_a_public_page_cannot_redirect_the_desk_into_the_local_network(self):
        port = urlsplit(self.base).port
        Site.routes['/inward'] = (302, {'Location': self.base + '/open'})
        Site.routes['/to-desk'] = (302, {'Location': 'http://localhost:4310/x'})
        self.addCleanup(Site.routes.pop, '/inward'); self.addCleanup(Site.routes.pop, '/to-desk')
        # Treat localhost as the public site and 127.0.0.1 as the private network behind it.
        with patch.object(web_pages, 'private', side_effect=lambda host: host == '127.0.0.1'):
            refused = web_pages.check('http://localhost:%d/inward' % port, DESK)
        self.assertEqual((refused['reachable'], refused['embeddable']), (False, None))
        self.assertIn('local address', refused['reason'])
        # A local page the user chose may redirect locally, but never to the desk.
        self.assertEqual(web_pages.check(self.base + '/inward', DESK)['url'], self.base + '/open')
        self.assertIn('local address', web_pages.check(self.base + '/to-desk', DESK)['reason'])
        for host, local in (('127.0.0.1', True), ('10.1.2.3', True), ('169.254.169.254', True), ('::1', True), ('8.8.8.8', False), ('no-such-host.invalid', False)):
            self.assertEqual(web_pages.private(host), local, host)

    def test_a_server_that_is_not_running_is_unreachable(self):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        result = web_pages.check('http://127.0.0.1:%d/' % port, DESK)
        self.assertEqual((result['reachable'], result['embeddable']), (False, None))
        self.assertIn('refused', result['reason'].lower())


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.desk = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=cls.desk.serve_forever, daemon=True).start()
        cls.base = 'http://127.0.0.1:%d' % cls.desk.server_port
        cls.site = ThreadingHTTPServer(('127.0.0.1', 0), Site)
        threading.Thread(target=cls.site.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for item in (cls.desk, cls.site):
            item.shutdown()
            item.server_close()

    def get(self, query, token=True):
        request = Request(self.base + '/api/web-pages/check?' + query, headers={'X-Agent-Desk-Terminal': server.TERMINAL_TOKEN} if token else {})
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_check_requires_the_terminal_token(self):
        self.assertEqual(self.get('url=http://example.com', token=False)[0], 403)

    def test_check_reports_framing_against_the_desk_origin(self):
        status, body = self.get('url=http://127.0.0.1:%d/deny' % self.site.server_port)
        self.assertEqual((status, body['embeddable'], body['value']), (200, False, 'DENY'))

    def test_check_rejects_non_web_addresses(self):
        self.assertEqual(self.get('url=file:///etc/passwd'), (400, {'error': 'Web pages must use an http or https address'}))


if __name__ == '__main__':
    unittest.main()
