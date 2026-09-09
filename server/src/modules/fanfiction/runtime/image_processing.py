from io import BytesIO

from PIL import Image


def install_image_processing():
    from fanficfare import story

    Image.MAX_IMAGE_PIXELS = 25_000_000
    if getattr(story.convert_image, '_bookorbit', False):
        return
    convert = story.convert_image

    def convert_image(url, data, *args, **kwargs):
        # The pinned converter handles RGBA transparency but cannot save LA as JPEG.
        with Image.open(BytesIO(data)) as image:
            if image.mode == 'LA':
                output = BytesIO()
                image.convert('RGBA').save(output, 'PNG')
                data = output.getvalue()
        return convert(url, data, *args, **kwargs)

    convert_image._bookorbit = True
    story.convert_image = convert_image
