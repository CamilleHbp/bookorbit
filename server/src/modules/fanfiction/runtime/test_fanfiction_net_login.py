import unittest
from unittest.mock import patch

from fanficfare import adapters, exceptions

from controlled_config import make_configuration
from fanfiction_net_login import HOST, LOGIN_URL, login_fanfiction_net
from safe_transport import PolicyError, SafeTransport


FORM = b'<form method="post"><input type="hidden" name="token" value="csrf"><input type="email" name="email"><input type="password" name="pass"></form>'


class FanFictionLoginTest(unittest.TestCase):
    def setUp(self):
        self.story = SafeTransport()
        self.addCleanup(self.story.close)
        self.url = 'https://www.fanfiction.net/s/123/1/'
        self.ini = '[www.fanfiction.net]\nusername: reader@example.org\npassword: ex%ample'

    def run_login(self, ini):
        adapter = adapters.getAdapter(make_configuration(self.url, ini, self.story), self.url)
        login_fanfiction_net(adapter, self.story)

    def test_credentials_are_optional(self):
        with patch.object(SafeTransport, 'request') as request:
            self.run_login('')
            request.assert_not_called()

    def test_form_session_used_by_story_transport(self):
        def respond(login, method, url, values):
            self.assertEqual(url, LOGIN_URL)
            if method == 'GET':
                return 200, FORM, LOGIN_URL
            self.assertEqual(values, {'token': 'csrf', 'email': 'reader@example.org', 'pass': 'ex%ample'})
            login.load_cookies([{'name': 'session', 'value': 'example', 'domain': HOST, 'path': '/', 'secure': True}])
            return 200, b'<a href="/logout.php">Log out</a>', LOGIN_URL

        with patch.object(SafeTransport, 'request', respond):
            self.run_login(self.ini)
        self.assertEqual([cookie.value for cookie in self.story.cookies], ['example'])

    def test_blocked_or_foreign_form_never_receives_credentials(self):
        for status, page, error in (
            (403, b'Denied', exceptions.HTTPErrorFFF),
            (200, FORM + b'<div class="cf-turnstile"></div>', exceptions.AccessDenied),
            (200, FORM.replace(b'<form ', b'<form action="https://other.example/" '), PolicyError),
        ):
            with self.subTest(status=status, error=error), patch.object(SafeTransport, 'request', return_value=(status, page, LOGIN_URL)) as request:
                with self.assertRaises(error):
                    self.run_login(self.ini)
                self.assertEqual(request.call_count, 1)

    def test_returning_to_login_does_not_establish_a_session(self):
        with patch.object(SafeTransport, 'request', return_value=(200, FORM, LOGIN_URL)):
            with self.assertRaises(exceptions.FailedToLogin):
                self.run_login(self.ini)
        self.assertEqual(list(self.story.cookies), [])
