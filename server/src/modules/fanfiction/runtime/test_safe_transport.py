import gzip
import io
from email.message import Message
from unittest.mock import MagicMock
import zlib
import socket
import unittest
import urllib.request
from unittest.mock import patch

from safe_transport import PolicyError, DownloadLimitError, DownloadTimeoutError, ResponseLimitError, SafeTransport, public_addresses, validate_url


class TransportPolicyTest(unittest.TestCase):
    def test_unsafe_urls(self):
        for url in ['http://example.org', 'file:///etc/passwd', 'https://localhost', 'https://x.localhost', 'https://a:b@example.org', 'https://example.org:80', 'https://example.org:bad', 'https://example.org./', 'https://example.org/\n', 'https://example.org\\@localhost', 'https://[fe80::1%25eth0]']:
            with self.subTest(url=url), self.assertRaises(PolicyError):
                validate_url(url)

    def test_public_https(self):
        _, host = validate_url('https://archiveofourown.org/works/123')
        self.assertEqual(host, 'archiveofourown.org')

    def test_all_dns_answers_must_be_public(self):
        public = (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))
        for address in ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '100.64.0.1']:
            private = (socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 443))
            with self.subTest(address=address), patch('socket.getaddrinfo', return_value=[public, private]), self.assertRaises(PolicyError):
                public_addresses('example.org')

    def test_ipv6_local_and_transition_addresses(self):
        for address in ['::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2002:7f00:1::', '2001::1', 'ff02::1', '64:ff9b::7f00:1', '64:ff9b:1::a00:1']:
            answer = (socket.AF_INET6, socket.SOCK_STREAM, 6, '', (address, 443, 0, 0))
            with self.subTest(address=address), patch('socket.getaddrinfo', return_value=[answer]), self.assertRaises(PolicyError):
                public_addresses('example.org')

    def test_body_and_request_budgets(self):
        with self.assertRaises(PolicyError):
            SafeTransport().request('POST', 'https://example.org', b'x' * (2 * 1024 * 1024 + 1))
        with self.assertRaises(PolicyError):
            SafeTransport(max_requests=0).request('GET', 'https://example.org')


class FakeResponse:
    def __init__(self, data, encoding='identity', status=200, headers=None, chunk_size=7):
        self.body = io.BytesIO(data)
        self.status = status
        self.headers = Message()
        self.headers['Content-Encoding'] = encoding
        for key, value in (headers or {}).items():
            self.headers[key] = value
        self.chunk_size = chunk_size

    def info(self):
        return self.headers

    def getheader(self, key, default=None):
        return self.headers.get(key, default)

    def read(self, size):
        return self.body.read(min(size, self.chunk_size))


class HttpResponseTest(unittest.TestCase):
    def request(self, response, transport=None, **kwargs):
        connection = MagicMock()
        connection.getresponse.return_value = response
        with patch('safe_transport.PinnedConnection', return_value=connection):
            try:
                return (transport or SafeTransport()).request('GET', 'https://example.org/story', **kwargs)
            finally:
                connection.close.assert_called_once()

    def test_decodes_streaming_responses_and_preserves_unicode(self):
        text = ('A café\u00a0故事\n' * 100).encode('utf-8')
        for encoding, encoded in [('identity', text), ('gzip', gzip.compress(text)), ('deflate', zlib.compress(text))]:
            with self.subTest(encoding=encoding):
                status, result, url = self.request(FakeResponse(encoded, encoding))
                self.assertEqual((status, result, url), (200, text, 'https://example.org/story'))

    def test_expansion_limit_is_applied_before_allocating_unbounded_output(self):
        compressed = gzip.compress(b'x' * (128 * 1024))
        with patch('safe_transport.MAX_RESPONSE_BYTES', 1024), self.assertRaisesRegex(ResponseLimitError, 'Expanded'):
            self.request(FakeResponse(compressed, 'gzip', chunk_size=65536))

    def test_total_decoded_budget_applies_across_requests(self):
        transport = SafeTransport(max_bytes=1500)
        compressed = gzip.compress(b'x' * 1000)
        self.request(FakeResponse(compressed, 'gzip'), transport)
        with self.assertRaisesRegex(DownloadLimitError, 'Expanded'):
            self.request(FakeResponse(compressed, 'gzip'), transport)

    def test_wire_budget_is_independent_of_expanded_budget(self):
        with self.assertRaisesRegex(DownloadLimitError, 'Download limit'):
            self.request(FakeResponse(b'x' * 101), SafeTransport(max_bytes=100))

    def test_exhausted_budget_cannot_be_ignored_by_image_error_handling(self):
        transport = SafeTransport(max_bytes=100)
        with self.assertRaises(DownloadLimitError):
            self.request(FakeResponse(b'x' * 101), transport)
        with patch('safe_transport.PinnedConnection') as connection, self.assertRaises(DownloadLimitError):
            transport.request('GET', 'https://example.org/next-chapter')
        connection.assert_not_called()
        self.assertIsInstance(transport.failure, DownloadLimitError)

    def test_malformed_truncated_and_trailing_compressed_data_are_rejected(self):
        compressed = gzip.compress(b'A complete chapter')
        for value in [b'invalid gzip', compressed[:-1], compressed + b'junk', compressed + compressed]:
            with self.subTest(value=value), self.assertRaises(PolicyError):
                self.request(FakeResponse(value, 'gzip'))

    def test_unsupported_encoding_and_multiple_encodings_are_rejected(self):
        for encoding in ['br', 'gzip, gzip', 'gzip, deflate']:
            with self.subTest(encoding=encoding), self.assertRaisesRegex(PolicyError, 'Unsupported'):
                self.request(FakeResponse(b'data', encoding))

    def test_deadline_is_checked_while_reading(self):
        transport = SafeTransport()
        response = FakeResponse(b'data')
        read = response.read
        def expire(size):
            transport.deadline = 0
            return read(size)
        response.read = expire
        with self.assertRaisesRegex(DownloadTimeoutError, 'Download deadline'):
            self.request(response, transport)

    def test_unsafe_redirect_is_rejected_before_fetching_it(self):
        with self.assertRaises(PolicyError):
            self.request(FakeResponse(b'', status=302, headers={'Location': 'https://localhost/private'}))

    def test_authentication_status_reaches_the_pinned_adapter(self):
        for status in [401, 403]:
            self.assertEqual(self.request(FakeResponse(gzip.compress(b'Denied'), 'gzip', status=status))[:2], (status, b'Denied'))

    def test_renews_and_deletes_cookies_without_widening_host_scope(self):
        transport = SafeTransport()
        self.request(FakeResponse(b'', headers={'Set-Cookie': 'session=renewed; Path=/; Secure'}), transport)
        saved = transport.export_cookies()
        self.assertEqual(saved, [{'name': 'session', 'value': 'renewed', 'domain': 'example.org', 'path': '/', 'secure': True, 'hostOnly': True}])
        restored = SafeTransport()
        restored.load_cookies(saved)
        for host, expected in [('example.org', 'session=renewed'), ('sub.example.org', None), ('unrelated.org', None)]:
            request = urllib.request.Request('https://' + host + '/')
            restored.cookies.add_cookie_header(request)
            self.assertEqual(request.get_header('Cookie'), expected)
        self.request(FakeResponse(b'', headers={'Set-Cookie': 'session=; Path=/; Max-Age=0'}), restored)
        self.assertEqual(restored.export_cookies(), [])

    def test_domain_cookie_scope_survives_export_and_unrelated_cookies_are_rejected(self):
        transport = SafeTransport()
        self.request(FakeResponse(b'', headers={'Set-Cookie': 'session=renewed; Domain=example.org; Path=/'}), transport)
        self.request(FakeResponse(b'', headers={'Set-Cookie': 'other=secret; Domain=unrelated.org; Path=/'}), transport)
        saved = transport.export_cookies()
        self.assertEqual(len(saved), 1)
        self.assertFalse(saved[0]['hostOnly'])
        restored = SafeTransport()
        restored.load_cookies(saved)
        request = urllib.request.Request('https://sub.example.org/')
        restored.cookies.add_cookie_header(request)
        self.assertEqual(request.get_header('Cookie'), 'session=renewed')

    def test_response_cookies_cannot_exceed_persistent_value_limits(self):
        transport = SafeTransport()
        self.request(FakeResponse(b'', headers={'Set-Cookie': 'session=' + 'x' * 4097 + '; Path=/'}), transport)
        with self.assertRaises(PolicyError):
            transport.export_cookies()


if __name__ == '__main__':
    unittest.main()
