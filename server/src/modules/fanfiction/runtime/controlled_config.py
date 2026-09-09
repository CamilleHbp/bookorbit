import configparser
import io
from pathlib import Path

from safe_transport import ConfigurationError, PolicyError

SAFE_OPTIONS = frozenset('''
username password is_adult user_agent include_images include_titlepage include_tocpage
include_subject_tags extratags extra_valid_entries extra_titlepage_entries titlepage_entries
replace_metadata add_to_replace_metadata add_to_extra_valid_entries add_to_extra_titlepage_entries
add_to_extratags add_to_include_subject_tags keep_summary_html keep_html_attrs keep_empty_tags
remove_tags replace_tags_with_spans remove_class_chapter strip_chapter_numbers add_chapter_numbers
chapter_title_strip_pattern chapter_title_def_pattern chapter_title_add_pattern
mark_new_chapters output_css sort_ships sort_ships_splits collect_series
always_login adult_view authors_are_multi author include_author_notes
dedup_img_files include_appendices legend_spoilers show_spoiler_tags show_timestamps show_nsfw_cover_images
'''.split())

MASK = '********'


def merge_configuration(previous, incoming=None, edits=None, redact=False):
    old = configparser.ConfigParser(interpolation=None, strict=True)
    old.read_string(validate_ini(previous))
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    parser.read_string(validate_ini(previous if incoming is None else incoming))
    for section in parser.sections():
        if parser.get(section, 'password', fallback=None) == MASK:
            parser.set(section, 'password', old.get(section, 'password', fallback=''))
    if edits is not None:
        if not isinstance(edits, dict) or set(edits) - {'section', 'username', 'password', 'isAdult'}:
            raise ConfigurationError('Invalid structured configuration edit')
        section = edits.get('section', 'defaults')
        if not isinstance(section, str) or not section or len(section) > 255 or any(c in section for c in '\r\n[]'):
            raise ConfigurationError('Invalid configuration section')
        if not parser.has_section(section):
            parser.add_section(section)
        for field, option in [('username', 'username'), ('password', 'password'), ('isAdult', 'is_adult')]:
            if field not in edits or field == 'password' and edits[field] == MASK:
                continue
            value = edits[field]
            if field == 'isAdult':
                if not isinstance(value, bool):
                    raise ConfigurationError('Invalid adult-content preference')
                value = 'true' if value else 'false'
            if not isinstance(value, str) or len(value) > 4096 or '\n' in value or '\r' in value:
                raise ConfigurationError('Invalid configuration value')
            parser.set(section, option, value)
    if redact:
        for section in parser.sections():
            if parser.get(section, 'password', fallback=''):
                parser.set(section, 'password', MASK)
    output = io.StringIO()
    parser.write(output)
    return validate_ini(output.getvalue())


def validate_ini(text):
    if not isinstance(text, str) or len(text.encode('utf-8')) > 65536:
        raise ConfigurationError('Configuration limit exceeded')
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    try:
        parser.read_string(text)
    except configparser.Error as error:
        raise ConfigurationError('Invalid configuration syntax') from error
    if parser.defaults() or len(parser.sections()) > 100:
        raise ConfigurationError('Use explicit configuration sections')
    for section in parser.sections():
        if len(section) > 4096:
            raise ConfigurationError('Invalid configuration section')
        for option, value in parser.items(section, raw=True):
            if option not in SAFE_OPTIONS or len(value) > 16384:
                raise ConfigurationError('Unsupported advanced configuration option: ' + option)
    return text


def make_configuration(url, ini, transport):
    import fanficfare
    from fanficfare import adapters, exceptions
    from fanficfare.configurable import Configuration
    from fanficfare.fetchers.base_fetcher import Fetcher, FetcherResponse

    class ControlledFetcher(Fetcher):
        def get_cookiejar(self, filename=None, mozilla=False):
            if filename:
                raise PolicyError('Cookie files are disabled')
            transport.cookies.autosave = False
            return transport.cookies

        def set_cookiejar(self, cookiejar):
            raise PolicyError('Cookie storage must use the managed profile')

        def request(self, method, url, headers=None, parameters=None):
            status, content, redirected = transport.request(method, url, parameters, headers)
            if status >= 400:
                raise exceptions.HTTPErrorFFF(url, status, 'Source request failed', content)
            return FetcherResponse(content, redirected)

    class ControlledConfiguration(Configuration):
        def get_fetcher(self, make_new=False):
            if self.fetcher is None:
                self.fetcher = ControlledFetcher(self.getConfig, self.getConfigList)
            return self.fetcher

        def _read_file_opener(self, _filename):
            raise PolicyError('Configuration file references are disabled')

        def set_sleep_override(self, _value):
            return None

    configuration = ControlledConfiguration(adapters.getConfigSectionsFor(url), 'epub')
    with (Path(fanficfare.__file__).parent / 'defaults.ini').open(encoding='utf-8') as defaults:
        configuration.read_file(defaults)
    configuration.read_file(io.StringIO('[defaults]\ninclude_images: true\n[fiction.live]\ndedup_img_files: true\ninclude_appendices: true\nlegend_spoilers: true\nshow_nsfw_cover_images: true\n'))
    configuration.read_file(io.StringIO(validate_ini(ini)))
    if not configuration.has_section('overrides'):
        configuration.add_section('overrides')
    overrides = {
        'force_https': 'true', 'use_browser_cache': 'false', 'use_basic_cache': 'false',
        'use_flaresolverr_proxy': 'false', 'use_nsapa_proxy': 'false', 'use_cloudscraper': 'false',
        'zip_output': 'false', 'make_directories': 'false', 'continue_on_chapter_error': 'false',
        'do_update_hook': 'false', 'pre_process_cmd': '', 'post_process_cmd': '',
        'output_filename': 'output.epub', 'always_overwrite': 'true',
    }
    for key, value in overrides.items():
        configuration.set('overrides', key, value)
    configuration.reset_cached_config()
    return configuration
