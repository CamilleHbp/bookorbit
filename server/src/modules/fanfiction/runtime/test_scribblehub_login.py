import unittest
from unittest.mock import patch

from fanficfare import adapters, exceptions

from controlled_config import make_configuration, merge_configuration
from fanficfare_wrapper import execute_request, failure_code
from safe_transport import PolicyError, SafeTransport
from scribblehub_login import LOGIN_URL, login_scribblehub


FORM = '''<form method="post" action="/login/">
<input type="text" name="log"><input type="password" name="pwd">
<input type="hidden" name="nonce" value="csrf-token">
<input type="submit" name="wp-submit" value="Login">
</form><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'''
STORY_URL = 'https://www.scribblehub.com/series/123/story/'


class ScribbleHubLoginTest(unittest.TestCase):
    def setUp(self):
        self.transport = SafeTransport()
        ini = merge_configuration('', edits={'section': 'www.scribblehub.com', 'username': 'reader', 'password': 'secret&password'})
        self.adapter = adapters.getAdapter(make_configuration(STORY_URL, ini, self.transport), STORY_URL)

    def add_session(self, domain='www.scribblehub.com', expires=None):
        self.transport.load_cookies([{'name': 'wordpress_logged_in_test', 'value': 'session', 'domain': domain,
                                     'path': '/', 'secure': True, 'expires': expires}])

    def test_posts_form_fields_and_retains_new_session_for_story_requests(self):
        def request(method, url, parameters=None, headers=None):
            if method == 'GET':
                self.assertEqual(url, LOGIN_URL)
                return 200, FORM.encode(), url
            self.assertEqual(url, LOGIN_URL)
            self.assertEqual(parameters, {'log': 'reader', 'pwd': 'secret&password', 'nonce': 'csrf-token', 'wp-submit': 'Login'})
            self.add_session()
            return 200, b'<a href="/logout/">Logout</a>', url

        with patch.object(self.transport, 'request', side_effect=request) as network:
            login_scribblehub(self.adapter)
        self.assertEqual(network.call_count, 2)
        self.assertEqual(self.transport.export_cookies()[0]['name'], 'wordpress_logged_in_test')

    def test_stale_cookies_cannot_make_rejected_credentials_look_successful(self):
        self.add_session()
        with patch.object(self.transport, 'request', return_value=(200, FORM.encode(), LOGIN_URL)):
            with self.assertRaises(exceptions.FailedToLogin) as failure:
                login_scribblehub(self.adapter)
        self.assertEqual(failure_code(failure.exception), 'authentication_required')
        self.assertNotIn('reader', str(failure.exception))
        self.assertNotIn('secret&password', str(failure.exception))

    def test_wrapper_authenticates_before_metadata_and_returns_session_cookies(self):
        calls = []

        def request(transport, method, url, parameters=None, headers=None):
            calls.append(method)
            if method == 'POST':
                transport.load_cookies([{'name': 'wordpress_logged_in_test', 'value': 'session',
                                         'domain': 'www.scribblehub.com', 'path': '/', 'secure': True}])
            return 200, FORM.encode(), url

        def metadata(adapter, get_cover=True):
            self.assertEqual(calls, ['GET', 'POST'])
            return adapter.story

        with patch.object(SafeTransport, 'request', request), patch.object(type(self.adapter), 'getStoryMetadataOnly', metadata), patch('fanficfare_wrapper.story_preview', return_value={'canonicalUrl': STORY_URL, 'chapterCount': 1}):
            result = execute_request({'operation': 'preview', 'url': STORY_URL,
                                      'configuration': '[www.scribblehub.com]\nusername: reader\npassword: secret'})
        self.assertTrue(result['ok'])
        self.assertEqual(result['cookies'][0]['name'], 'wordpress_logged_in_test')

    def test_removes_old_authentication_cookies_but_preserves_other_cookies(self):
        names = ['wordpress_logged_in_test', 'wordpress_sec_test', 'wordpress_' + 'a' * 32, 'wordpress_test_cookie', 'cf_clearance']
        self.transport.load_cookies([{'name': name, 'value': 'old', 'domain': 'www.scribblehub.com', 'path': '/', 'secure': True} for name in names])
        with patch.object(self.transport, 'request', return_value=(200, FORM.encode(), LOGIN_URL)):
            with self.assertRaises(exceptions.FailedToLogin):
                login_scribblehub(self.adapter)
        self.assertEqual({cookie.name for cookie in self.transport.cookies}, {'wordpress_test_cookie', 'cf_clearance'})

    def test_unrelated_or_expired_cookies_do_not_prove_login(self):
        for domain, expires in [('example.org', None), ('www.scribblehub.com', 1)]:
            with self.subTest(domain=domain):
                def request(method, url, parameters=None, headers=None):
                    if method == 'POST':
                        self.add_session(domain, expires)
                    return 200, FORM.encode(), url
                with patch.object(self.transport, 'request', side_effect=request):
                    with self.assertRaises(exceptions.FailedToLogin):
                        login_scribblehub(self.adapter)

    def test_only_posts_credentials_to_scribblehub_over_https(self):
        for target in ['https://evil.example/login', 'http://www.scribblehub.com/login/', 'https://www.scribblehub.com:444/login/']:
            with self.subTest(target=target):
                form = FORM.replace('action="/login/"', f'action="{target}"')
                with patch.object(self.transport, 'request', return_value=(200, form.encode(), LOGIN_URL)) as network:
                    with self.assertRaises(PolicyError):
                        login_scribblehub(self.adapter)
                    self.assertEqual(network.call_count, 1)

    def test_never_submits_passwords_in_get_forms(self):
        with patch.object(self.transport, 'request', return_value=(200, FORM.replace('method="post"', 'method="get"').encode(), LOGIN_URL)) as network:
            with self.assertRaises(PolicyError):
                login_scribblehub(self.adapter)
            self.assertEqual(network.call_count, 1)

    def test_verification_pages_are_not_reported_as_bad_passwords(self):
        for status, html in [(403, b'Forbidden'), (200, b'<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/test"></script>'), (200, b'<script>window._cf_chl_opt = {};</script>')]:
            with self.subTest(status=status):
                with patch.object(self.transport, 'request', return_value=(status, html, LOGIN_URL)) as network:
                    with self.assertRaises(Exception) as failure:
                        login_scribblehub(self.adapter)
                    self.assertEqual(failure_code(failure.exception), 'access_denied')
                    self.assertEqual(network.call_count, 1)

    def test_cookie_only_and_anonymous_imports_do_not_attempt_login(self):
        adapter = adapters.getAdapter(make_configuration(STORY_URL, '', self.transport), STORY_URL)
        self.add_session()
        with patch.object(self.transport, 'request') as network:
            login_scribblehub(adapter)
            network.assert_not_called()
        self.assertEqual(len(self.transport.export_cookies()), 1)

    def test_partial_credentials_fail_without_a_network_request(self):
        for credentials in ['username: reader', 'password: secret']:
            adapter = adapters.getAdapter(make_configuration(STORY_URL, '[www.scribblehub.com]\n' + credentials, self.transport), STORY_URL)
            with patch.object(self.transport, 'request') as network:
                with self.assertRaises(exceptions.FailedToLogin):
                    login_scribblehub(adapter)
                network.assert_not_called()

    def test_other_sites_keep_their_existing_login_behavior(self):
        url = 'https://archiveofourown.org/works/123'
        adapter = adapters.getAdapter(make_configuration(url, '[defaults]\nusername: reader\npassword: secret', self.transport), url)
        with patch.object(self.transport, 'request') as network:
            login_scribblehub(adapter)
            network.assert_not_called()


if __name__ == '__main__':
    unittest.main()
