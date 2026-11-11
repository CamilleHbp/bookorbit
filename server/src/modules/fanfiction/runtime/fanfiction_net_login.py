import time
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup
from fanficfare import exceptions

from safe_transport import PolicyError, SafeTransport


HOST = 'www.fanfiction.net'
LOGIN_URL = 'https://www.fanfiction.net/login.php'


def login_page(transport, method, url, parameters=None):
    status, content, final_url = transport.request(method, url, parameters)
    if status >= 400:
        raise exceptions.HTTPErrorFFF(url, status, 'FanFiction.net sign-in request failed', b'')
    if urlsplit(final_url).netloc != HOST:
        raise PolicyError('FanFiction.net sign-in left the website')
    page = BeautifulSoup(content, 'html.parser')
    if page.select_one('.g-recaptcha, .h-captcha, .cf-turnstile, [name="cf-turnstile-response"], [name="g-recaptcha-response"]'):
        raise exceptions.AccessDenied('FanFiction.net requires browser verification')
    return page, final_url


def login_fanfiction_net(adapter, story_transport):
    if adapter.getSiteDomain() != HOST:
        return
    email = adapter.getConfig('username', '')
    password = adapter.getConfig('password', '')
    if not email and not password:
        return
    if not email or not password:
        raise exceptions.FailedToLogin(LOGIN_URL, '')

    # Use a fresh direct session so a previous account cannot validate new credentials.
    login = SafeTransport(max_bytes=4 * 1024 * 1024, max_requests=12,
                          timeout=min(30, story_transport.deadline - time.monotonic()))
    try:
        page, base = login_page(login, 'GET', LOGIN_URL)
        field = page.select_one('form input[type="password"][name]:not([disabled])')
        form = field.find_parent('form') if field else None
        if form is None:
            raise exceptions.FailedToDownload('FanFiction.net sign-in form is unavailable')
        emails = form.select('input[type="email"][name], input[autocomplete="username"][name], input[type="text"][name]')
        if (len(emails) != 1 or form.get('method', '').lower() != 'post'
                or len(form.select('input[type="password"]')) != 1 or field.get('autocomplete') == 'new-password'):
            raise exceptions.FailedToDownload('FanFiction.net sign-in form is unsupported')
        target = urljoin(base, form.get('action') or base)
        parsed = urlsplit(target)
        if parsed.scheme != 'https' or parsed.netloc != HOST:
            raise PolicyError('FanFiction.net credentials require the original HTTPS host')
        if parsed.path.rstrip('/') not in ('/login.php', '/login'):
            raise exceptions.FailedToDownload('FanFiction.net sign-in action is unsupported')
        values = {item['name']: item.get('value', '') for item in form.select('input[type="hidden"][name]:not([disabled])')}
        submit = form.select_one('input[type="submit"][name], button[type="submit"][name]')
        if submit:
            values[submit['name']] = submit.get('value', '')
        values[emails[0]['name']] = email
        values[field['name']] = password
        result, _ = login_page(login, 'POST', target, values)
        cookies = [cookie for cookie in login.export_cookies()
                   if cookie['domain'].lstrip('.') in ('fanfiction.net', HOST)]
        if not cookies or not result.select_one('a[href*="logout"], a[href*="signout"]'):
            raise exceptions.FailedToLogin(LOGIN_URL, '')
        for old in list(story_transport.cookies):
            if old.domain.lstrip('.') in ('fanfiction.net', HOST):
                story_transport.cookies.clear(old.domain, old.path, old.name)
        story_transport.load_cookies(cookies)
    finally:
        login.close()
