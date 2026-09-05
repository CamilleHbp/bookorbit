import socket
import unittest
from unittest.mock import patch

from safe_transport import PolicyError, SafeTransport, public_addresses, validate_url


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
        for address in ['::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2002:7f00:1::', '2001::1', 'ff02::1']:
            answer = (socket.AF_INET6, socket.SOCK_STREAM, 6, '', (address, 443, 0, 0))
            with self.subTest(address=address), patch('socket.getaddrinfo', return_value=[answer]), self.assertRaises(PolicyError):
                public_addresses('example.org')

    def test_body_and_request_budgets(self):
        with self.assertRaises(PolicyError):
            SafeTransport().request('POST', 'https://example.org', b'x' * (2 * 1024 * 1024 + 1))
        with self.assertRaises(PolicyError):
            SafeTransport(max_requests=0).request('GET', 'https://example.org')


if __name__ == '__main__':
    unittest.main()
