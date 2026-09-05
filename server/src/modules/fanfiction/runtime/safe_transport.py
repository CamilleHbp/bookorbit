import contextvars
import http.client
import http.cookiejar
import ipaddress
import socket
import ssl
import sys
import time
import urllib.parse
import urllib.request


class PolicyError(Exception):
    pass


_connecting = contextvars.ContextVar('bookorbit_connecting', default=False)


def install_network_guard():
    def audit(event, _args):
        if event in ('os.system', 'subprocess.Popen', 'os.posix_spawn', 'os.exec'):
            raise PolicyError('Process execution is disabled')
        if event == 'socket.connect' and not _connecting.get():
            raise PolicyError('Requests must use the controlled transport')
    sys.addaudithook(audit)


def validate_url(url):
    if not isinstance(url, str) or len(url) > 4096 or any(ord(c) < 33 for c in url):
        raise PolicyError('Invalid source URL')
    parsed = urllib.parse.urlsplit(url)
    try:
        valid = parsed.scheme == 'https' and parsed.hostname and parsed.port in (None, 443)
    except ValueError:
        valid = False
    if not valid or parsed.username or parsed.password or '\\' in url or '%' in parsed.netloc:
        raise PolicyError('Only public HTTPS sources on port 443 are allowed')
    hostname = parsed.hostname.encode('idna').decode('ascii')
    if hostname.endswith('.') or hostname == 'localhost' or hostname.endswith('.localhost'):
        raise PolicyError('Local destinations are disabled')
    return parsed, hostname


def public_addresses(hostname):
    addresses = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or len(addresses) > 32:
        raise PolicyError('Invalid DNS response')
    for family, _, _, _, address in addresses:
        ip = ipaddress.ip_address(address[0])
        transitional = isinstance(ip, ipaddress.IPv6Address) and (ip.ipv4_mapped is not None or ip.sixtofour is not None or ip.teredo is not None)
        if family not in (socket.AF_INET, socket.AF_INET6) or not ip.is_global or ip.is_multicast or transitional:
            raise PolicyError('Private and local destinations are disabled')
    return addresses


class PinnedConnection(http.client.HTTPSConnection):
    def connect(self):
        addresses = public_addresses(self.host)
        last_error = None
        for family, kind, protocol, _, address in addresses:
            sock = socket.socket(family, kind, protocol)
            sock.settimeout(self.timeout)
            try:
                token = _connecting.set(True)
                try:
                    sock.connect(address)
                finally:
                    _connecting.reset(token)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
                return
            except OSError as error:
                sock.close()
                last_error = error
        raise last_error or PolicyError('No public destination is available')


class SafeTransport:
    def __init__(self, max_bytes=128 * 1024 * 1024, max_requests=10_000, timeout=600):
        self.remaining_bytes = max_bytes
        self.remaining_requests = max_requests
        self.deadline = time.monotonic() + timeout
        self.cookies = http.cookiejar.CookieJar()
        self.context = ssl.create_default_context()

    def load_cookies(self, cookies):
        if not isinstance(cookies, list) or len(cookies) > 200:
            raise PolicyError('Cookie storage limit exceeded')
        for item in cookies:
            if not isinstance(item, dict):
                raise PolicyError('Invalid profile cookie')
            name, value, domain, path = (item.get(key) for key in ('name', 'value', 'domain', 'path'))
            if not all(isinstance(part, str) for part in (name, value, domain, path)) or not name or len(name) > 256 or len(value) > 4096 or len(path) > 4096 or not path.startswith('/') or any(c in name + value + path for c in '\r\n\x00'):
                raise PolicyError('Invalid profile cookie')
            validate_url('https://' + domain.lstrip('.'))
            expires = item.get('expires')
            if expires is not None and (not isinstance(expires, int) or expires < 0):
                raise PolicyError('Invalid cookie expiry')
            self.cookies.set_cookie(http.cookiejar.Cookie(
                version=0, name=name, value=value, port=None, port_specified=False,
                domain=domain, domain_specified=True, domain_initial_dot=domain.startswith('.'),
                path=path, path_specified=True, secure=True, expires=expires,
                discard=expires is None, comment=None, comment_url=None, rest={}, rfc2109=False,
            ))

    def request(self, method, url, parameters=None, headers=None):
        if method not in ('GET', 'POST'):
            raise PolicyError('Unsupported request method')
        body = None
        if parameters is not None:
            body = parameters if isinstance(parameters, bytes) else (parameters if isinstance(parameters, str) else urllib.parse.urlencode(parameters, doseq=True)).encode('utf-8')
            if len(body) > 2 * 1024 * 1024:
                raise PolicyError('Request body limit exceeded')
        for _ in range(6):
            parsed, hostname = validate_url(url)
            if self.remaining_requests <= 0 or time.monotonic() >= self.deadline:
                raise PolicyError('Request budget exceeded')
            self.remaining_requests -= 1
            safe_headers = {'User-Agent': 'BookOrbit/FanFicFare', 'Accept-Encoding': 'identity'}
            for name, value in (headers or {}).items():
                if name.lower() in ('user-agent', 'accept') and isinstance(value, str) and len(value) < 1024 and '\r' not in value and '\n' not in value:
                    safe_headers[name] = value
            if body is not None:
                safe_headers['Content-Type'] = 'application/x-www-form-urlencoded'
            request = urllib.request.Request(url, data=body, headers=safe_headers, method=method)
            self.cookies.add_cookie_header(request)
            connection = PinnedConnection(hostname, timeout=min(20, max(0.1, self.deadline - time.monotonic())), context=self.context)
            try:
                connection.request(method, urllib.parse.urlunsplit(('', '', parsed.path or '/', parsed.query, '')), body, dict(request.header_items()))
                response = connection.getresponse()
                self.cookies.extract_cookies(response, request)
                if len(self.cookies) > 200:
                    raise PolicyError('Cookie storage limit exceeded')
                if response.status in (301, 302, 303, 307, 308):
                    target = urllib.parse.urljoin(url, response.getheader('Location') or '')
                    _, target_host = validate_url(target)
                    if body is not None and target_host != hostname:
                        raise PolicyError('Authenticated redirects cannot forward request bodies across sites')
                    if response.status in (301, 302, 303):
                        method, body = 'GET', None
                    url = target
                    continue
                if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
                    raise PolicyError('Compressed HTTP responses are disabled')
                chunks = []
                size = 0
                while True:
                    chunk = response.read(min(64 * 1024, self.remaining_bytes + 1))
                    if not chunk:
                        break
                    size += len(chunk)
                    self.remaining_bytes -= len(chunk)
                    if self.remaining_bytes < 0 or size > 16 * 1024 * 1024 or time.monotonic() >= self.deadline:
                        raise PolicyError('Download limit exceeded')
                    chunks.append(chunk)
                return response.status, b''.join(chunks), url
            finally:
                connection.close()
        raise PolicyError('Redirect limit exceeded')
