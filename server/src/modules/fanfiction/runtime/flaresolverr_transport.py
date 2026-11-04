import http.client
import json
import time
import uuid
from urllib.parse import urlencode, urlsplit
from urllib.request import Request

from safe_transport import (SafeTransport, PolicyError, SourceResponseError, DownloadTimeoutError,
                            DownloadLimitError, ResponseLimitError, MAX_RESPONSE_BYTES,
                            _connecting, validate_url, public_addresses)


class SolverConnection(http.client.HTTPConnection):
    def connect(self):
        token = _connecting.set(True)
        try:
            super().connect()
        finally:
            _connecting.reset(token)


class FlareSolverrTransport(SafeTransport):
    def __init__(self, endpoint, **kwargs):
        super().__init__(**kwargs)
        self.hosts = set()
        self.session = None
        self.endpoint = urlsplit(endpoint)
        if (self.endpoint.scheme != 'http' or not self.endpoint.hostname
                or self.endpoint.username or self.endpoint.password
                or self.endpoint.path != '/v1' or self.endpoint.query or self.endpoint.fragment):
            raise PolicyError('Invalid administrator-configured solver endpoint')

    def enable_for(self, url):
        hostname = validate_url(url)[1]
        domain = hostname.removeprefix('www.')
        self.hosts = {domain, 'www.' + domain}

    def _request(self, method, url, parameters=None, headers=None):
        _, hostname = validate_url(url)
        # FanFicFare marks binary image fetches explicitly, including extensionless URLs.
        image = any(key.lower() == 'accept' and value.startswith('image/')
                    for key, value in (headers or {}).items())
        if hostname not in self.hosts or image:
            return super()._request(method, url, parameters, headers)
        if method not in ('GET', 'POST'):
            raise PolicyError('Unsupported request method')
        public_addresses(hostname)
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise DownloadTimeoutError('Download deadline exceeded')
        if self.remaining_requests <= 0:
            raise DownloadLimitError('Request budget exceeded')
        self.remaining_requests -= 1
        request = Request(url)
        self.cookies.add_cookie_header(request)
        selected = {tuple(part.strip().split('=', 1)) for part in request.get_header('Cookie', '').split(';')}
        cookies = [{'name': c.name, 'value': c.value, 'domain': c.domain, 'path': c.path}
                   for c in self.cookies if (c.name, c.value) in selected and c.domain.lstrip('.') in self.hosts]
        if self.session is None:
            session = 'bookorbit-' + str(int(time.time())) + '-' + uuid.uuid4().hex
            self.call_solver({'cmd': 'sessions.create', 'session': session}, min(30, remaining))
            self.session = session
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise DownloadTimeoutError('Download deadline exceeded')
        payload = {'cmd': 'request.' + method.lower(), 'url': url, 'cookies': cookies,
                   'session': self.session,
                   'disableMedia': True,
                   'maxTimeout': max(1, int(min(60, remaining) * 1000))}
        if method == 'POST':
            body = parameters if isinstance(parameters, str) else urlencode(parameters or {}, doseq=True)
            if len(body.encode()) > 2 * 1024 * 1024:
                raise PolicyError('Request body limit exceeded')
            payload['postData'] = body
        result = self.call_solver(payload, min(65, remaining))
        try:
            solution = result['solution']
            if result['status'] != 'ok':
                raise ValueError()
            status, text, redirected = solution['status'], solution['response'], solution['url']
            if type(status) is not int or not 100 <= status <= 599 or not isinstance(text, str):
                raise ValueError()
        except (ValueError, KeyError, TypeError) as error:
            raise SourceResponseError('Browser service could not complete the request') from error
        if validate_url(redirected)[1] not in self.hosts:
            raise PolicyError('Browser response left the requested website')
        content = text.encode('utf-8')
        self.remaining_bytes -= len(content)
        self.remaining_decoded_bytes -= len(content)
        if self.remaining_bytes < 0 or self.remaining_decoded_bytes < 0:
            raise DownloadLimitError('Download byte budget exceeded')
        incoming = solution.get('cookies', [])
        if not isinstance(incoming, list) or len(incoming) > 200:
            raise PolicyError('Invalid browser cookies')
        for cookie in incoming:
            if not isinstance(cookie, dict):
                raise PolicyError('Invalid browser cookie')
            domain = cookie.get('domain', '')
            if not isinstance(domain, str) or domain.lstrip('.') not in self.hosts:
                continue
            expiry = cookie.get('expiry', cookie.get('expires'))
            self.load_cookies([{'name': cookie.get('name'), 'value': cookie.get('value'), 'domain': domain,
                                'path': cookie.get('path', '/'), 'secure': True,
                                'expires': int(expiry) if isinstance(expiry, (int, float)) and expiry > 0 else None}])
        if len(self.cookies) > 200:
            raise PolicyError('Cookie storage limit exceeded')
        return status, content, redirected

    def call_solver(self, payload, timeout):
        connection = SolverConnection(self.endpoint.hostname, self.endpoint.port or 80, timeout=timeout)
        try:
            connection.request('POST', '/v1', json.dumps(payload), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ResponseLimitError('Solver response limit exceeded')
            if response.status != 200:
                raise SourceResponseError('Browser service could not complete the request')
            try:
                result = json.loads(raw)
                if result['status'] != 'ok':
                    raise ValueError()
                return result
            except (ValueError, KeyError, TypeError) as error:
                raise SourceResponseError('Browser service could not complete the request') from error
        finally:
            connection.close()

    def close(self):
        if self.session:
            try:
                self.call_solver({'cmd': 'sessions.destroy', 'session': self.session}, 5)
            except (OSError, PolicyError):
                pass
            self.session = None
