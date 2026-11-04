import json
import unittest
from unittest.mock import MagicMock, patch

from flaresolverr_transport import FlareSolverrTransport
from safe_transport import SafeTransport, PolicyError, SourceResponseError, DownloadLimitError, ResponseLimitError, MAX_RESPONSE_BYTES

URL = 'https://www.scribblehub.com/series/747093/collide-gamer/'


class SolverTest(unittest.TestCase):
    def setUp(self):
        self.transport = FlareSolverrTransport('http://solver:8191/v1')
        self.result = {'status': 'ok', 'solution': {'status': 200, 'url': URL, 'response': '<h1>Story</h1>', 'cookies': []}}
        self.dns = patch('flaresolverr_transport.public_addresses', return_value=[])
        self.dns.start()
        self.addCleanup(self.dns.stop)

    def test_reuses_one_private_session_and_destroys_it(self):
        other = FlareSolverrTransport('http://solver:8191/v1')
        with patch.object(self.transport, 'call_solver', return_value=self.result) as call, patch.object(other, 'call_solver', return_value=self.result):
            self.assertEqual(self.transport.request('GET', URL), (200, b'<h1>Story</h1>', URL))
            session = self.transport.session
            self.transport.request('POST', URL, {'password': 'a&b'})
            self.assertEqual(call.call_args.args[0]['postData'], 'password=a%26b')
            self.assertEqual(call.call_args.args[0]['session'], session)
            other.request('GET', URL)
            self.assertNotEqual(other.session, session)
            self.assertEqual(sum(c.args[0]['cmd'] == 'sessions.create' for c in call.call_args_list), 1)
            self.transport.close()
            self.assertEqual(call.call_args.args[0], {'cmd': 'sessions.destroy', 'session': session})
            self.assertIsNone(self.transport.session)

    def test_images_and_other_sites_keep_the_pinned_transport(self):
        with patch.object(SafeTransport, '_request', return_value=(200, b'image', URL)) as direct, patch.object(self.transport, 'call_solver') as solver:
            for url in ['https://example.org/story', 'https://www.scribblehub.com/wp-content/uploads/cover.jpg']:
                self.transport.request('GET', url)
            self.assertEqual(direct.call_count, 2)
            solver.assert_not_called()

    def test_cookies_are_scoped_and_browser_expiry_is_preserved(self):
        cookie = {'name': 'session', 'value': 'private', 'domain': 'www.scribblehub.com', 'path': '/'}
        self.transport.load_cookies([cookie, {**cookie, 'name': 'other', 'domain': 'example.org'}])
        self.result['solution']['cookies'] = [{**cookie, 'expiry': 2000000000}, {**cookie, 'name': 'external', 'domain': 'example.net'}]
        with patch.object(self.transport, 'call_solver', return_value=self.result) as call:
            self.transport.request('GET', URL)
            self.assertEqual([c['name'] for c in call.call_args.args[0]['cookies']], ['session'])
        stored = self.transport.export_cookies()
        self.assertEqual(next(c for c in stored if c['name'] == 'session')['expires'], 2000000000)
        self.assertFalse(any(c['name'] == 'external' for c in stored))

    def test_rejects_cross_site_results_and_private_dns(self):
        self.result['solution']['url'] = 'https://example.org/'
        with patch.object(self.transport, 'call_solver', return_value=self.result):
            with self.assertRaises(PolicyError):
                self.transport.request('GET', URL)
        with patch('flaresolverr_transport.public_addresses', side_effect=PolicyError('Private destination')), patch.object(self.transport, 'call_solver') as call:
            with self.assertRaises(PolicyError):
                self.transport.request('GET', URL)
            call.assert_not_called()

    def test_enforces_request_and_content_budgets(self):
        self.transport.remaining_requests = 0
        with patch.object(self.transport, 'call_solver') as call:
            with self.assertRaises(DownloadLimitError):
                self.transport.request('GET', URL)
            call.assert_not_called()
        transport = FlareSolverrTransport('http://solver:8191/v1', max_bytes=2)
        with patch.object(transport, 'call_solver', return_value=self.result):
            with self.assertRaises(DownloadLimitError):
                transport.request('GET', URL)
            self.assertIsInstance(transport.failure, DownloadLimitError)

    def test_bounds_solver_response_and_does_not_echo_errors(self):
        with patch('flaresolverr_transport.SolverConnection') as connection:
            response = MagicMock(status=200)
            connection.return_value.getresponse.return_value = response
            response.read.return_value = json.dumps({'status': 'error', 'message': 'secret-password'}).encode()
            with self.assertRaises(SourceResponseError) as failure:
                self.transport.call_solver({'cmd': 'request.get'}, 5)
            self.assertNotIn('secret-password', str(failure.exception))
            response.read.return_value = b'x' * (MAX_RESPONSE_BYTES + 1)
            with self.assertRaises(ResponseLimitError):
                self.transport.call_solver({'cmd': 'request.get'}, 5)
            response.read.assert_called_with(MAX_RESPONSE_BYTES + 1)

    def test_rejects_unsafe_endpoint_configuration(self):
        for endpoint in ['file:///etc/passwd', 'http://user:secret@solver/v1', 'http://solver/v1?x=y']:
            with self.assertRaises(PolicyError):
                FlareSolverrTransport(endpoint)


if __name__ == '__main__':
    unittest.main()
