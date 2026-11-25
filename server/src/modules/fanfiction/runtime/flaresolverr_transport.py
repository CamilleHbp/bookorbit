import http.client
import json
import re
import time
import uuid
from urllib.parse import urlencode, urlsplit
from urllib.request import Request

from safe_transport import (SafeTransport, PolicyError, BrowserVerification, SourceResponseError, DownloadTimeoutError,
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
    def __init__(self, endpoint, session_id=None, **kwargs):
        super().__init__(**kwargs)
        if session_id is not None and (not isinstance(session_id, str) or not re.fullmatch(r'bookorbit-[0-9]{10}-[0-9a-f]{32}', session_id)):
            raise PolicyError('Invalid browser session identity', code='source_browser_unavailable')
        self.session_id = session_id
        self.hosts = set()
        self.session = None
        self.prefer_direct = False
        self.endpoint = urlsplit(endpoint)
        if (self.endpoint.scheme != 'http' or not self.endpoint.hostname
                or self.endpoint.username or self.endpoint.password
                or self.endpoint.path != '/v1' or self.endpoint.query or self.endpoint.fragment):
            raise PolicyError('Invalid administrator-configured solver endpoint', code='source_browser_unavailable')

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
            raise PolicyError('Unsupported request method', code='source_request_unsupported')
        if self.prefer_direct and self.session is None and method == 'GET':
            try:
                direct = super()._request(method, url, parameters, headers)
            except BrowserVerification:
                pass
            else:
                if validate_url(direct[2])[1] not in self.hosts:
                    raise PolicyError('Response left the requested website', code='source_redirect_blocked')
                if direct[0] != 403:
                    return direct
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
            session = self.session_id or 'bookorbit-' + str(int(time.time())) + '-' + uuid.uuid4().hex
            # Creation can succeed after our socket times out. Retain its identity
            # before the call so retries and cleanup do not abandon that browser.
            self.session = session
            self.call_solver({'cmd': 'sessions.create', 'session': session}, min(30, remaining))
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
                raise PolicyError('Request body limit exceeded', code='source_request_too_large')
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
            raise SourceResponseError('Browser service could not complete the request', code='source_browser_unavailable') from error
        if validate_url(redirected)[1] not in self.hosts:
            raise PolicyError('Browser response left the requested website', code='source_redirect_blocked')
        content = text.encode('utf-8')
        self.remaining_bytes -= len(content)
        self.remaining_decoded_bytes -= len(content)
        if self.remaining_bytes < 0 or self.remaining_decoded_bytes < 0:
            raise DownloadLimitError('Download byte budget exceeded')
        incoming = solution.get('cookies', [])
        if not isinstance(incoming, list) or len(incoming) > 200:
            raise PolicyError('Invalid browser cookies', code='source_session_invalid')
        for cookie in incoming:
            if not isinstance(cookie, dict):
                raise PolicyError('Invalid browser cookie', code='source_session_invalid')
            domain = cookie.get('domain', '')
            if not isinstance(domain, str) or domain.lstrip('.') not in self.hosts:
                continue
            expiry = cookie.get('expiry', cookie.get('expires'))
            self.load_cookies([{'name': cookie.get('name'), 'value': cookie.get('value'), 'domain': domain,
                                'path': cookie.get('path', '/'), 'secure': True,
                                'expires': int(expiry) if isinstance(expiry, (int, float)) and expiry > 0 else None}])
        if len(self.cookies) > 200:
            raise PolicyError('Cookie storage limit exceeded', code='source_session_invalid')
        return status, content, redirected

    def call_solver(self, payload, timeout):
        connection = SolverConnection(self.endpoint.hostname, self.endpoint.port or 80, timeout=timeout)
        try:
            connection.request('POST', '/v1', json.dumps(payload), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ResponseLimitError('Solver response limit exceeded')
            try:
                result = json.loads(raw)
            except (ValueError, UnicodeError):
                result = None
            if response.status == 200 and isinstance(result, dict) and result.get('status') == 'ok':
                return result
            # Match known service diagnostics without exposing its response body.
            message = str(result.get('message', '')).lower() if isinstance(result, dict) else ''
            if 'session not created' in message or 'error starting chrome' in message or 'chrome not reachable' in message:
                raise SourceResponseError('Browser failed to start', code='source_browser_start_failed')
            if payload.get('cmd') in ('request.get', 'request.post') and 'error solving the challenge' in message and 'timeout' in message:
                raise BrowserVerification('The website verification page did not complete')
            raise SourceResponseError('Browser service could not complete the request', code='source_browser_unavailable')
        finally:
            connection.close()

    def close(self):
        if self.session:
            try:
                self.call_solver({'cmd': 'sessions.destroy', 'session': self.session}, 5)
            except (OSError, PolicyError):
                pass
            self.session = None
        super().close()
