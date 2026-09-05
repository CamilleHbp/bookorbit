import os
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from fanficfare.adapters.adapter_test1 import TestSiteAdapter
from fanficfare_wrapper import run


def generate(directory):
    original = TestSiteAdapter.getStoryMetadataOnly
    packaged = datetime(2026, 1, 1, 12, 0, 0)

    def metadata(adapter, *args, **kwargs):
        story = original(adapter, *args, **kwargs)
        story.setMetadata('dateCreated', packaged)
        return story

    previous = os.getcwd()
    try:
        os.chdir(directory)
        with patch.object(TestSiteAdapter, 'getSiteURLPattern', return_value=r'^https?://test1\.com/?\?sid=\d+$'), patch.object(TestSiteAdapter, 'getStoryMetadataOnly', metadata):
            request = {'operation': 'download', 'url': 'https://test1.com/?sid=1', 'configuration': '[defaults]\ninclude_images: false\n'}
            run(request)
            Path('output.epub').rename('first.epub')
            packaged = datetime(2026, 2, 1, 12, 0, 0)
            run(request)
            Path('output.epub').rename('second.epub')
    finally:
        os.chdir(previous)
