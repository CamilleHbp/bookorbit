import re
from urllib.parse import urljoin, urlsplit

from fanficfare import exceptions

from safe_transport import PolicyError


LOGIN_URL = 'https://www.scribblehub.com/login/'


def login_scribblehub(adapter):
    if adapter.getSiteDomain() != 'www.scribblehub.com':
        return
    username = adapter.getConfig('username', '')
    password = adapter.getConfig('password', '')
    if not username and not password:
        return
    if not username or not password:
        raise exceptions.FailedToLogin(LOGIN_URL, '')

    cookies = adapter.get_configuration().get_cookiejar()

    def is_login_cookie(cookie):
        return (cookie.domain.lstrip('.') in ('scribblehub.com', 'www.scribblehub.com')
                and cookie.name.startswith('wordpress_logged_in_'))

    # Validate the supplied credentials, not a session belonging to a previous login.
    for cookie in list(cookies):
        if (cookie.domain.lstrip('.') in ('scribblehub.com', 'www.scribblehub.com')
                and (is_login_cookie(cookie) or cookie.name.startswith('wordpress_sec_')
                     or re.fullmatch(r'wordpress_[a-f0-9]{32}', cookie.name))):
            cookies.clear(cookie.domain, cookie.path, cookie.name)

    def page(data):
        soup = adapter.make_soup(data)
        if ('window._cf_chl_opt' in data
                or (soup.title and 'Just a moment' in soup.title.get_text() and 'challenge-platform' in data)):
            raise exceptions.AccessDenied('ScribbleHub requires browser verification')
        return soup

    soup = page(adapter.get_request(LOGIN_URL, usecache=False))
    password_field = soup.select_one('form input[type="password"][name]')
    form = password_field.find_parent('form') if password_field else None
    if form is None:
        raise exceptions.FailedToDownload('ScribbleHub login form is unavailable')
    username_field = form.select_one('input[autocomplete="username"][name], input[name="log"], input[name="username"], input[name="user_login"]')
    if username_field is None:
        fields = form.select('input[type="text"][name], input[type="email"][name]')
        username_field = fields[0] if len(fields) == 1 else None
    if username_field is None:
        raise exceptions.FailedToDownload('ScribbleHub login form is unavailable')
    target = urljoin(LOGIN_URL, form.get('action') or LOGIN_URL)
    parsed = urlsplit(target)
    if (parsed.scheme != 'https' or parsed.netloc != 'www.scribblehub.com'
            or form.get('method', '').lower() != 'post'):
        raise PolicyError('ScribbleHub login requires a same-site HTTPS form')
    parameters = {field['name']: field.get('value', '')
                  for field in form.select('input[type="hidden"][name]:not([disabled])')}
    submit = form.select_one('input[type="submit"][name], button[type="submit"][name]')
    if submit:
        parameters[submit['name']] = submit.get('value', '')
    parameters[username_field['name']] = username
    parameters[password_field['name']] = password
    page(adapter.post_request(target, parameters, usecache=False))
    if not any(is_login_cookie(cookie) and cookie.value and not cookie.is_expired() for cookie in cookies):
        raise exceptions.FailedToLogin(LOGIN_URL, '')
