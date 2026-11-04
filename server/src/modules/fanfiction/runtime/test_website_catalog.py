import unittest
from unittest.mock import patch

from controlled_config import make_configuration
from safe_transport import SafeTransport
from website_catalog import website_catalog


class WebsiteLoginTest(unittest.TestCase):
    def test_catalog_exposes_native_and_inherited_password_logins(self):
        sites = {site['id']: site for site in website_catalog()}
        for site in ('www.royalroad.com', 'www.fimfiction.net', 'archiveofourown.org',
                     'www.scribblehub.com', 'forums.spacebattles.com', 'www.giantessworld.net',
                     'voracity2.e-fic.com', 'storiesonline.net'):
            self.assertTrue(sites[site]['supportsPasswordLogin'], site)
        for site in ('www.fanfiction.net', 'www.fictionpress.com', 'fiction.live'):
            self.assertFalse(sites[site]['supportsPasswordLogin'], site)
        self.assertFalse(any(site.startswith('test') for site in sites))
        self.assertEqual(sum(site['supportsPasswordLogin'] for site in sites.values()), 60)

    def test_royalroad_native_login_submits_email_password_and_form_token(self):
        from fanficfare import adapters, exceptions
        url = 'https://www.royalroad.com/fiction/123/story'
        transport = SafeTransport()
        config = make_configuration(url, '[www.royalroad.com]\nusername: reader@example.com\npassword: private-password', transport)
        adapter = adapters.getAdapter(config, url)
        page = b'<form><input name="__RequestVerificationToken" value="csrf-token"></form>'
        login = 'https://www.royalroad.com/account/login'
        with patch.object(transport, 'request', side_effect=[(200, page, login), (200, b'Sign out', login)]) as request:
            self.assertTrue(adapter.performLogin())
            self.assertEqual(request.call_args.args[:3], ('POST', login, {
                'Email': 'reader@example.com', 'password': 'private-password', '__RequestVerificationToken': 'csrf-token',
            }))
        with patch.object(transport, 'request', side_effect=[(200, page, login), (200, b'Sign in', login)]):
            with self.assertRaises(exceptions.FailedToLogin):
                adapter.performLogin()


if __name__ == '__main__':
    unittest.main()
