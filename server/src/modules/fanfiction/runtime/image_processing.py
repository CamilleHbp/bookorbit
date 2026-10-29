from io import BytesIO

from PIL import Image, ImageOps, features

MAX_IMAGE_BYTES = 256 * 1024
MAX_IMAGE_EDGE = 1600


def encode_webp(image, **options):
    output = BytesIO()
    image.save(output, 'WEBP', method=4, exact=True, **options)
    return output.getvalue()


def convert_image(_url, data, *_args, **_kwargs):
    with Image.open(BytesIO(data)) as source:
        # KOReader displays the first frame of animated EPUB illustrations.
        source.seek(0)
        image = ImageOps.exif_transpose(source)
        image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
        image = image.convert('RGBA' if 'A' in image.getbands() or 'transparency' in image.info else 'RGB')
    encoded = encode_webp(image, lossless=True)
    if len(encoded) <= MAX_IMAGE_BYTES:
        return encoded, 'webp', 'image/webp'

    # Retain detail before reducing dimensions, and bound encoding work per image.
    for _ in range(12):
        for quality in (90, 80, 70, 60):
            encoded = encode_webp(image, lossless=False, quality=quality)
            if len(encoded) <= MAX_IMAGE_BYTES:
                return encoded, 'webp', 'image/webp'
        image = image.resize((max(1, image.width * 3 // 4), max(1, image.height * 3 // 4)), Image.Resampling.LANCZOS)
    raise ValueError('Image could not fit the size limit')


def install_image_processing():
    from fanficfare import story

    Image.MAX_IMAGE_PIXELS = 25_000_000
    if not features.check('webp'):
        raise RuntimeError('The image runtime requires WebP support')
    story.convert_image = convert_image
