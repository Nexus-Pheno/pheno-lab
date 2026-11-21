#!/usr/bin/env python3
"""Render every bilingual print page locally and reject empty, missing or cropped page text."""
import argparse
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET

import select_published_baseline as selector


def local(command):
    try:
        return subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              timeout=300, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        raise ValueError('PDF_RENDER_TOOL_UNAVAILABLE_OR_FAILED') from None


def inspect(qa):
    selector.require_private(qa, directory=True)
    if sys.platform.startswith('linux'):
        # Fontconfig reports the actual repertoire of the matched system font.
        languages = local(['fc-match', '-f', '%{lang}', ':lang=zh-cn']).decode().lower().split('|')
        if not any(lang == 'zh' or lang.startswith('zh-') for lang in languages):
            raise ValueError('CHINESE_PRINT_FONT_MISSING')
    results = {}
    for language in ('en', 'zh'):
        pdf = qa / f'{language}-print.pdf'
        selector.require_private(pdf)
        prefix = qa / f'{language}-page'
        if any(qa.glob(prefix.name + '-*.png')):
            raise ValueError('PRINT_PAGE_IMAGES_ALREADY_EXIST')
        pages = ET.fromstring(local(['pdftotext', '-bbox', str(pdf), '-'])).findall('.//{*}page')
        if not pages:
            raise ValueError('NO_PRINT_PAGES')
        local(['pdftoppm', '-scale-to', '1100', '-png', str(pdf), str(prefix)])
        images = list(qa.glob(prefix.name + '-*.png'))
        if len(images) != len(pages):
            raise ValueError('PRINT_PAGE_COUNT_MISMATCH')
        by_number = {int(p.stem.rsplit('-', 1)[1]): p for p in images}
        rows = []
        for number, page in enumerate(pages, start=1):
            width, height = float(page.attrib['width']), float(page.attrib['height'])
            words = page.findall('.//{*}word')
            if not words or not any(''.join(word.itertext()).strip() for word in words):
                raise ValueError('BLANK_PRINT_PAGE')
            for word in words:
                x0, y0, x1, y1 = (float(word.attrib[k]) for k in ('xMin', 'yMin', 'xMax', 'yMax'))
                if not all(math.isfinite(v) for v in (width, height, x0, y0, x1, y1)) or not (
                    -1 <= x0 <= x1 <= width + 1 and -1 <= y0 <= y1 <= height + 1):
                    raise ValueError('PRINT_TEXT_OUTSIDE_PAGE')
            image = by_number[number]
            selector.require_private(image)
            with image.open('rb') as stream:
                header = stream.read(24)
            if header[:8] != b'\x89PNG\r\n\x1a\n' or len(header) != 24:
                raise ValueError('INVALID_PRINT_PAGE_IMAGE')
            pixels = struct.unpack('>II', header[16:24])
            if min(pixels) == 0:
                raise ValueError('INVALID_PRINT_PAGE_DIMENSIONS')
            rows.append({'page': number, 'words': len(words), 'image': image.name, 'pixels': pixels,
                         'imageSha256': selector.file_sha(image)})
        results[language] = {'pages': rows, 'pdfSha256': selector.file_sha(pdf)}
    return {'languages': results, 'allPagesRendered': True, 'visualReviewerApprovalRecorded': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('qa', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        result = inspect(args.qa)
        with (args.qa / 'print-pages.json').open('x') as output:
            json.dump(result, output, indent=2)
            output.write('\n')
    except (ValueError, OSError, KeyError, ET.ParseError):
        print('Print QA failed. Verify Poppler, Chinese fonts and every rendered page locally.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
