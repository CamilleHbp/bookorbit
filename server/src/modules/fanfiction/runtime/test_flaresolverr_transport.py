import json
import unittest
from unittest.mock import MagicMock, patch

from flaresolverr_transport import FlareSolverrTransport
from safe_transport import SafeTransport, PolicyError, SourceResponseError, DownloadLimitError, ResponseLimitError, MAX_RESPONSE_BYTES

URL = 'https://www.scribblehub.com/series/747093/collide-gamer/'


class SolverTest(unittest.TestCase):
    def setUp(self):
        self.transport = FlareSolverrTransport('http://solver:8191/v1')
        self.transport.enable_for(URL)
        self.result = {'status': 'ok', 'solution': {'status': 200, 'url': URL, 'response': '<h1>Story</h1>', 'cookies': []}}
        self.dns = patch('flaresolverr_transport.public_addresses', return_value=[])
        self.dns.start()
        self.addCleanup(self.dns.stop)

    def test_reuses_one_private_session_and_destroys_it(self):
        other = FlareSolverrTransport('http://solver:8191/v1')
        other.enable_for(URL)
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
                self.transport.request('GET', url, headers={'Accept': 'image/*'} if 'scribblehub' in url else {})
            self.transport.request('GET', 'https://www.scribblehub.com/image?id=1', headers={'Accept': 'image/*'})
            self.assertEqual(direct.call_count, 3)
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
        transport.enable_for(URL)
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

    def test_other_websites_can_be_enabled_without_forwarding_unrelated_cookies(self):
        url = 'https://www.royalroad.com/fiction/123/story'
        self.transport.enable_for(url)
        self.result['solution']['url'] = url
        self.transport.load_cookies([
            {'name': 'login', 'value': 'rr', 'domain': '.royalroad.com', 'path': '/'},
            {'name': 'other', 'value': 'private', 'domain': '.scribblehub.com', 'path': '/'},
        ])
        with patch.object(self.transport, 'call_solver', return_value=self.result) as call:
            self.transport.request('GET', url)
            self.assertEqual([c['name'] for c in call.call_args.args[0]['cookies']], ['login'])

    def test_disabled_transport_does_not_use_browser(self):
        transport = FlareSolverrTransport('http://solver:8191/v1')
        with patch.object(SafeTransport, '_request', return_value=(200, b'direct', URL)), patch.object(transport, 'call_solver') as call:
            self.assertEqual(transport.request('GET', URL)[1], b'direct')
            call.assert_not_called()

    def test_configuration_precedence_and_explicit_disable(self):
        from controlled_config import make_configuration, validate_ini, merge_configuration
        for ini, enabled in [('', True), ('[defaults]\nuse_flaresolverr_proxy: false', False),
                             ('[defaults]\nuse_flaresolverr_proxy: true\n[www.scribblehub.com]\nuse_flaresolverr_proxy: false', False),
                             ('[www.scribblehub.com]\nuse_flaresolverr_proxy: false\n[overrides]\nuse_flaresolverr_proxy: true', True)]:
            with self.subTest(ini=ini):
                config = make_configuration(URL, ini, self.transport)
                self.assertEqual(bool(config.getConfig('use_flaresolverr_proxy', False)), enabled)
        other = 'https://www.royalroad.com/fiction/123/story'
        self.assertFalse(make_configuration(other, '', self.transport).getConfig('use_flaresolverr_proxy', False))
        self.assertTrue(make_configuration(other, '[www.royalroad.com]\nuse_flaresolverr_proxy: true', self.transport).getConfig('use_flaresolverr_proxy'))
        self.assertFalse(make_configuration(URL, '', SafeTransport()).getConfig('use_flaresolverr_proxy', False))
        ini = '[defaults]\nuse_flaresolverr_proxy: true'
        self.assertIn('use_flaresolverr_proxy = true', merge_configuration('', ini))
        for option in ('flaresolverr_proxy_address', 'flaresolverr_proxy_port', 'flaresolverr_proxy_protocol'):
            with self.assertRaises(PolicyError):
                validate_ini('[defaults]\n' + option + ': localhost')
        with self.assertRaises(PolicyError):
            validate_ini('[defaults]\nuse_flaresolverr_proxy: maybe')

    def test_runtime_applies_selection_before_any_adapter_request(self):
        from fanficfare_wrapper import run
        from safe_transport import ConfigurationError
        for enabled in (True, False):
            observed = []
            def adapter(configuration, url):
                observed.append(configuration.get_fetcher())
                raise RuntimeError('stop before network')
            with patch('fanficfare.adapters.getAdapter', side_effect=adapter), patch.object(FlareSolverrTransport, 'enable_for') as enable:
                with self.assertRaisesRegex(RuntimeError, 'stop before network'):
                    run({'operation': 'preview', 'url': URL, 'configuration': '[defaults]\nuse_flaresolverr_proxy: ' + str(enabled).lower(), 'flaresolverrUrl': 'http://solver:8191/v1'})
                self.assertEqual(enable.call_count, int(enabled))
                self.assertEqual(len(observed), 1)
        with self.assertRaisesRegex(ConfigurationError, 'not configured'):
            run({'operation': 'preview', 'url': URL, 'configuration': '[defaults]\nuse_flaresolverr_proxy: true'})

    def test_rejects_unsafe_endpoint_configuration(self):
        for endpoint in ['file:///etc/passwd', 'http://user:secret@solver/v1', 'http://solver/v1?x=y']:
            with self.assertRaises(PolicyError):
                FlareSolverrTransport(endpoint)


if __name__ == '__main__':
    unittest.main()
