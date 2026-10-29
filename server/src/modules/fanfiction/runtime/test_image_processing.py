from io import BytesIO
import unittest
from unittest.mock import patch

from PIL import Image

from image_processing import MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, convert_image, install_image_processing


def source_bytes(image, format='PNG', **options):
    output = BytesIO()
    image.save(output, format, **options)
    return output.getvalue()


class ImageProcessingTest(unittest.TestCase):
    def test_small_illustrations_use_lossless_webp_without_upscaling(self):
        source = Image.new('RGB', (90, 140), (21, 102, 203))
        encoded, extension, mime = convert_image('', source_bytes(source))
        self.assertEqual((extension, mime), ('webp', 'image/webp'))
        self.assertIn(b'VP8L', encoded[:32])
        with Image.open(BytesIO(encoded)) as result:
            self.assertEqual(result.size, source.size)
            self.assertEqual(result.convert('RGB').tobytes(), source.tobytes())

    def test_transparency_is_preserved_including_grayscale_and_palette_images(self):
        palette = Image.new('P', (40, 60))
        palette.putpalette([255, 0, 0] + [0, 0, 0] * 255)
        palette.info['transparency'] = 0
        for source in [Image.new('RGBA', (40, 60), (31, 72, 101, 128)), Image.new('LA', (40, 60), (100, 80)), palette]:
            with self.subTest(mode=source.mode):
                encoded, _, _ = convert_image('', source_bytes(source))
                with Image.open(BytesIO(encoded)) as result:
                    self.assertEqual(result.convert('RGBA').tobytes(), source.convert('RGBA').tobytes())

    def test_large_landscape_and_portrait_images_keep_their_aspect_ratio(self):
        for size in [(3600, 2400), (2400, 3600)]:
            with self.subTest(size=size):
                encoded, _, _ = convert_image('', source_bytes(Image.new('RGB', size, 'white')))
                with Image.open(BytesIO(encoded)) as result:
                    self.assertEqual(max(result.size), MAX_IMAGE_EDGE)
                    self.assertAlmostEqual(result.width / result.height, size[0] / size[1], delta=0.002)
                self.assertLessEqual(len(encoded), MAX_IMAGE_BYTES)
                self.assertIn(b'VP8L', encoded[:32])

    def test_dense_images_fall_back_to_lossy_encoding_with_a_hard_byte_limit(self):
        source = Image.effect_noise((1600, 1600), 100).convert('RGB')
        encoded, _, _ = convert_image('', source_bytes(source))
        self.assertLessEqual(len(encoded), MAX_IMAGE_BYTES)
        self.assertNotIn(b'VP8L', encoded[:32])
        with Image.open(BytesIO(encoded)) as result:
            self.assertEqual(result.format, 'WEBP')
            self.assertLessEqual(max(result.size), MAX_IMAGE_EDGE)
            self.assertGreater(min(result.size), 600)

    def test_applies_exif_orientation_before_removing_metadata(self):
        source = Image.new('RGB', (80, 140), 'red')
        exif = Image.Exif()
        exif[274] = 6
        encoded, _, _ = convert_image('', source_bytes(source, 'JPEG', exif=exif))
        with Image.open(BytesIO(encoded)) as result:
            self.assertEqual(result.size, (140, 80))
            self.assertNotIn(274, result.getexif())

    def test_animation_uses_the_first_frame(self):
        first = Image.new('RGB', (80, 140), 'red')
        second = Image.new('RGB', (80, 140), 'blue')
        encoded, _, _ = convert_image('', source_bytes(first, 'GIF', save_all=True, append_images=[second], duration=100, loop=0))
        with Image.open(BytesIO(encoded)) as result:
            self.assertEqual(result.n_frames, 1)
            self.assertEqual(result.convert('RGB').getpixel((0, 0)), (255, 0, 0))

    def test_health_setup_requires_webp_encoding_support(self):
        with patch('image_processing.features.check', return_value=False), self.assertRaisesRegex(RuntimeError, 'WebP support'):
            install_image_processing()


if __name__ == '__main__':
    unittest.main()
