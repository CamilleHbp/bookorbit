import socket
import unittest
from unittest.mock import MagicMock, patch

from curl_cffi import CurlOpt
from browser_connection import BrowserConnection, BrowserResponse
from safe_transport import SafeTransport, PolicyError, DownloadLimitError, ResponseLimitError

URL = 'https://www.royalroad.com/account/login'
PUBLIC = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('104.18.0.1', 443))]


class BrowserConnectionTest(unittest.TestCase):
    def fake_curl(self, payload=b'page', headers=b'Set-Cookie: session=token; Path=/; Secure\r\n'):
        options = {}
        curl = MagicMock()
        curl.impersonate.return_value = 0
        curl.setopt.side_effect = options.__setitem__
        curl.getinfo.return_value = 200
        def perform():
            options[CurlOpt.HEADERFUNCTION](b'HTTP/2 200\r\n')
            options[CurlOpt.HEADERFUNCTION](headers)
            options[CurlOpt.WRITEFUNCTION](payload)
        curl.perform.side_effect = perform
        return curl, options

    def test_browser_profile_pins_dns_and_retains_cookies(self):
        curl, options = self.fake_curl()
        transport = SafeTransport()
        with patch('browser_connection.public_addresses', return_value=PUBLIC), patch('curl_cffi.Curl', return_value=curl):
            status, body, url = transport.request('POST', URL, {'password': 'literal%value'})
        self.assertEqual((status, body, url), (200, b'page', URL))
        self.assertEqual(transport.export_cookies()[0]['name'], 'session')
        self.assertEqual(options[CurlOpt.RESOLVE], [b'www.royalroad.com:443:104.18.0.1'])
        self.assertEqual(options[CurlOpt.PROXY], b'')
        self.assertEqual(options[CurlOpt.FOLLOWLOCATION], 0)
        self.assertEqual(options[CurlOpt.SSL_VERIFYPEER], 1)
        self.assertEqual(options[CurlOpt.SSL_VERIFYHOST], 2)
        self.assertEqual(options[CurlOpt.POSTFIELDS], b'password=literal%25value')
        self.assertFalse(any(header.lower().startswith(b'user-agent:') for header in options[CurlOpt.HTTPHEADER]))
        transport.close()
        curl.close.assert_called_once()

    def test_connection_is_reused_only_inside_one_transport_and_closed_afterward(self):
        curl, _ = self.fake_curl()
        transport = SafeTransport()
        with patch('browser_connection.public_addresses', return_value=PUBLIC), patch('curl_cffi.Curl', return_value=curl) as create:
            transport.request('GET', URL)
            transport.request('GET', URL)
            create.assert_called_once()
            curl.reset.assert_called_once()
            curl.close.assert_not_called()
            transport.close()
            curl.close.assert_called_once()
        self.assertFalse(transport.browser_connections)

    def test_private_dns_is_rejected_before_native_network_access(self):
        private = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]
        with patch('safe_transport.socket.getaddrinfo', return_value=private), patch('curl_cffi.Curl') as curl:
            with self.assertRaises(PolicyError):
                SafeTransport().request('GET', URL)
            curl.assert_not_called()

    def test_native_response_and_job_limits_are_enforced_while_receiving(self):
        for max_bytes, response_limit, error in [(2, 16, DownloadLimitError), (16, 2, ResponseLimitError)]:
            with self.subTest(error=error):
                curl, _ = self.fake_curl(payload=b'large')
                with patch('browser_connection.public_addresses', return_value=PUBLIC), patch('curl_cffi.Curl', return_value=curl), patch('browser_connection.MAX_RESPONSE_BYTES', response_limit):
                    with self.assertRaises(error):
                        SafeTransport(max_bytes=max_bytes).request('GET', URL)
                curl.close.assert_called_once()

    def test_browser_decoded_content_is_not_decoded_twice(self):
        curl, options = self.fake_curl(payload=b'decoded page', headers=b'Content-Encoding: br\r\n')
        with patch('browser_connection.public_addresses', return_value=PUBLIC), patch('curl_cffi.Curl', return_value=curl):
            self.assertEqual(SafeTransport().request('GET', URL)[1], b'decoded page')
        self.assertEqual(options[CurlOpt.HTTP_CONTENT_DECODING], 1)
        self.assertFalse(any(h.lower().startswith(b'accept-encoding:') for h in options[CurlOpt.HTTPHEADER]))

    def test_header_limit_is_enforced(self):
        curl, _ = self.fake_curl(headers=b'x' * 65537)
        with patch('browser_connection.public_addresses', return_value=PUBLIC), patch('curl_cffi.Curl', return_value=curl):
            with self.assertRaises(ResponseLimitError):
                SafeTransport().request('GET', URL)

    def test_cross_site_post_redirects_remain_blocked(self):
        response = BrowserResponse(307, b'Location: https://example.org/\r\n', b'')
        with patch.object(BrowserConnection, 'request'), patch.object(BrowserConnection, 'getresponse', return_value=response):
            with self.assertRaisesRegex(PolicyError, 'request bodies across sites'):
                SafeTransport().request('POST', URL, {'password': 'private'})

    def test_redirected_private_destinations_are_still_rejected(self):
        response = BrowserResponse(302, b'Location: https://127.0.0.1/\r\n', b'')
        private = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]
        with patch.object(BrowserConnection, 'request'), patch.object(BrowserConnection, 'getresponse', return_value=response), patch('safe_transport.socket.getaddrinfo', return_value=private):
            with self.assertRaises(PolicyError):
                SafeTransport().request('GET', URL)


if __name__ == '__main__':
    unittest.main()
