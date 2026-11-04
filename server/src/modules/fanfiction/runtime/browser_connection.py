import email.parser
import http.client
import io

from safe_transport import (DownloadLimitError, MAX_RESPONSE_BYTES, PolicyError,
                            ResponseLimitError, SourceResponseError, public_addresses)


class BrowserResponse:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = email.parser.BytesParser(_class=http.client.HTTPMessage).parsebytes(headers)
        self.body = io.BytesIO(body)

    def info(self):
        return self.headers

    def getheader(self, name, default=None):
        # libcurl decodes into the bounded receive callback.
        if name.lower() == 'content-encoding':
            return 'identity'
        return self.headers.get(name, default)

    def read(self, size):
        return self.body.read(size)


class BrowserConnection:
    """Browser-compatible TLS within SafeTransport's redirect, cookie and size policies."""
    def __init__(self, host, timeout, max_bytes):
        self.host = host
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.response = None
        self.curl = None

    def request(self, method, target, body, headers):
        from curl_cffi import Curl, CurlError, CurlInfo, CurlOpt

        addresses = public_addresses(self.host)
        ips = list(dict.fromkeys(address[4][0] for address in addresses))
        resolved = ','.join('[' + ip + ']' if ':' in ip else ip for ip in ips)
        content = bytearray()
        response_headers = bytearray()
        header_bytes = 0
        failure = None

        def receive(data):
            nonlocal failure
            if len(content) + len(data) > self.max_bytes:
                failure = DownloadLimitError('Download byte budget exceeded')
                return 0
            if len(content) + len(data) > MAX_RESPONSE_BYTES:
                failure = ResponseLimitError('Response limit exceeded')
                return 0
            content.extend(data)
            return len(data)

        def receive_header(data):
            nonlocal header_bytes, failure
            header_bytes += len(data)
            if header_bytes > 65536:
                failure = ResponseLimitError('Response header limit exceeded')
                return 0
            if data.startswith(b'HTTP/'):
                response_headers.clear()
            else:
                response_headers.extend(data)
            return len(data)

        if self.curl is None:
            self.curl = Curl()
        else:
            self.curl.reset()
        curl = self.curl
        try:
            # Match the pinned curl_cffi release's Chrome profile, including its User-Agent.
            if curl.impersonate('chrome152') != 0:
                raise PolicyError('Browser HTTP profile is unavailable')
            curl.setopt(CurlOpt.URL, 'https://' + self.host + target)
            curl.setopt(CurlOpt.RESOLVE, [(self.host + ':443:' + resolved).encode()])
            curl.setopt(CurlOpt.PROXY, b'')
            curl.setopt(CurlOpt.FOLLOWLOCATION, 0)
            curl.setopt(CurlOpt.SSL_VERIFYPEER, 1)
            curl.setopt(CurlOpt.SSL_VERIFYHOST, 2)
            curl.setopt(CurlOpt.CONNECTTIMEOUT_MS, max(1, int(self.timeout * 1000)))
            curl.setopt(CurlOpt.TIMEOUT_MS, max(1, int(self.timeout * 1000)))
            curl.setopt(CurlOpt.HTTP_CONTENT_DECODING, 1)
            curl.setopt(CurlOpt.ACCEPT_ENCODING, b'gzip, deflate, br, zstd')
            curl.setopt(CurlOpt.HTTPHEADER, [f'{key}: {value}'.encode() for key, value in headers.items()
                                          if key.lower() not in ('user-agent', 'accept-encoding')])
            curl.setopt(CurlOpt.CUSTOMREQUEST, method.encode())
            if body is not None:
                curl.setopt(CurlOpt.POSTFIELDS, body)
                curl.setopt(CurlOpt.POSTFIELDSIZE, len(body))
            curl.setopt(CurlOpt.WRITEFUNCTION, receive)
            curl.setopt(CurlOpt.HEADERFUNCTION, receive_header)
            try:
                curl.perform()
            except CurlError as error:
                if failure is not None:
                    raise failure from error
                if error.code == 28:
                    raise TimeoutError('Website request timed out') from error
                raise SourceResponseError('Website request could not complete') from error
            if failure is not None:
                raise failure
            self.response = BrowserResponse(curl.getinfo(CurlInfo.RESPONSE_CODE), bytes(response_headers), bytes(content))
        except Exception:
            self.shutdown()
            raise

    def getresponse(self):
        return self.response

    def close(self):
        if self.response is not None:
            self.response.body.close()

    def shutdown(self):
        self.close()
        if self.curl is not None:
            self.curl.close()
            self.curl = None
