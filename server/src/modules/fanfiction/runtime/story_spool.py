"""Ephemeral story payloads kept in the operation's disk-backed workspace."""
from functools import partial
import hashlib


class ImageInfo(dict):
    def __getitem__(self, key):
        value = super().__getitem__(key)
        return value() if key == 'data' and isinstance(value, partial) else value

    def get(self, key, default=None):
        return self[key] if key in self else default


class StorySpool:
    def __init__(self, file):
        self.file = file
        self.images = {}

    def write(self, data):
        offset = self.file.seek(0, 2)
        self.file.write(data)
        return partial(self.read, offset, len(data))

    def read(self, offset, length):
        self.file.seek(offset)
        return self.file.read(length)

    def image(self, data):
        digest = hashlib.sha256(data).digest()
        if digest not in self.images:
            self.images[digest] = self.write(data)
        return self.images[digest]

    def image_info(self, info):
        return ImageInfo(info, data=self.image(info['data']))

    def body(self, body):
        return partial(self.parse_body, self.write(body.encode()))

    @staticmethod
    def parse_body(read):
        from fanficfare.epubutils import make_soup
        return make_soup(read().decode('utf-8')).body
