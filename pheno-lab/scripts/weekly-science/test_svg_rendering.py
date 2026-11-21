#!/usr/bin/env python3
"""Synthetic SVG/CSP regression checks; no real laboratory fixture data."""
import copy
import importlib.util
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('render_report', Path(__file__).with_name('render_report.py'))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


def chart():
    return '''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100" role="img" aria-label="Synthetic metric plot">
<title>Synthetic plot</title><defs><clipPath id="clip"><rect x="1" y="1" width="198" height="98"/></clipPath><path id="point" d="M 0 1 L 1 0 L 0 -1 z"/></defs>
<path d="M 0 100 L 200 100 L 200 0 L 0 0 z" style="fill: #ffffff"/>
<g clip-path="url(#clip)"><path d="M 20 30 L 80 30" style="fill: none; stroke: #2c6674; stroke-width: 2.4; stroke-linecap: square; stroke-linejoin: miter; stroke-opacity: 0.66"/>
<use xlink:href="#point" x="40" y="30" style="fill: #2c6674; stroke: #ffffff; stroke-width: 0.5; fill-opacity: 0.66"/>
<text x="50" y="90" style="font-size: 10px; font-family: 'Arial Unicode MS'; text-anchor: middle; fill: #243331; font-weight: 700; opacity: 0.8">Synthetic median 12.34% · 合成</text></g></svg>'''


def document():
    return {'titleEn':'Synthetic SVG report','titleZh':'合成 SVG 报告',
            'summaryEn':'Renderer regression.','summaryZh':'渲染回归验证。',
            'generatedAt':'2026-10-13T04:00:00Z','snapshotAt':'2026-10-13T03:00:00Z',
            'windowStart':'2026-10-06T00:00:00Z','windowEnd':'2026-10-13T02:00:00Z',
            'sections':[{'id':'plot','titleEn':'Plot','titleZh':'图表',
                         'bodyEn':'<p>Unchanged text.</p><figure>'+chart()+'</figure>',
                         'bodyZh':'<p>不变文字。</p><figure>'+chart()+'</figure>'}],
            'academicReview':{'checks':['preserved']}, 'rdReview':{'sourceIds':['synthetic-1']}}


class SvgRendering(unittest.TestCase):
    def test_compact_chart_layout_is_opt_in_for_new_reports(self):
        legacy = document()
        rule = 'figure.weekly-device-pce svg{'
        self.assertNotIn(rule, renderer.render(legacy))
        case = legacy['sections'][0]
        for key in ('bodyEn', 'bodyZh'):
            case[key] = case[key].replace('<figure>', '<figure class="weekly-device-pce">')
        self.assertIn(rule, renderer.render(legacy))

    def test_paint_and_text_become_presentation_attributes(self):
        value = renderer.normalize_svg_styles(chart())
        root = ET.fromstring(value)
        self.assertFalse(any('style' in node.attrib for node in root.iter()))
        white = next(node for node in root.iter() if node.get('fill') == '#ffffff')
        self.assertEqual(white.get('d'), 'M 0 100 L 200 100 L 200 0 L 0 0 z')
        line = next(node for node in root.iter() if node.get('stroke-width') == '2.4')
        self.assertEqual(line.get('stroke'), '#2c6674')
        self.assertEqual(line.get('fill'), 'none')
        text = next(node for node in root.iter() if node.tag.endswith('text'))
        self.assertEqual(text.get('font-family'), "'Arial Unicode MS'")
        self.assertEqual(text.get('text-anchor'), 'middle')
        self.assertEqual(text.text, 'Synthetic median 12.34% · 合成')

    def test_geometry_links_clipping_and_accessibility_are_preserved(self):
        root = ET.fromstring(renderer.normalize_svg_styles(chart()))
        self.assertEqual(root.get('viewBox'), '0 0 200 100')
        self.assertEqual(root.get('aria-label'), 'Synthetic metric plot')
        self.assertEqual(next(node for node in root.iter() if node.tag.endswith('use')).get('{http://www.w3.org/1999/xlink}href'), '#point')
        self.assertEqual(next(node for node in root.iter() if node.get('clip-path')).get('clip-path'), 'url(#clip)')

    def test_inline_css_and_later_declarations_keep_precedence(self):
        root = ET.fromstring(renderer.normalize_svg_styles('<svg><path fill="blue" style="fill: white; fill: red"/></svg>'))
        self.assertEqual(root[0].get('fill'), 'red')

    def test_unsupported_properties_fail_without_partial_conversion(self):
        for value in ('background: white', 'display: none', '--paint: red', 'transform: rotate(1deg)'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                renderer.normalize_svg_styles('<svg><path style="fill: white; '+value+'"/></svg>')

    def test_unsafe_or_unsupported_values_fail(self):
        for value in ('url(https://example.org/paint)', 'url(#paint)', 'red !important',
                      'expression(alert(1))', '@import x', r'\75rl(x)', ''):
            with self.subTest(value=value), self.assertRaises(ValueError):
                renderer.normalize_svg_styles('<svg><path style="fill: '+value+'"/></svg>')

    def test_malformed_declarations_and_xml_fail(self):
        for svg in ('<svg><path style="fill"/></svg>', '<svg><path></svg>', '<svg><path style="fill:"/></svg>'):
            with self.subTest(svg=svg), self.assertRaises(ValueError):
                renderer.normalize_svg_styles(svg)

    def test_dtd_and_inline_svg_style_blocks_fail(self):
        for svg in ('<!DOCTYPE svg [<!ENTITY x "value">]><svg/>',
                    '<svg><style>path{fill:white}</style></svg>'):
            with self.subTest(svg=svg), self.assertRaises(ValueError):
                renderer.normalize_svg_styles(svg)

    def test_repeated_normalization_is_idempotent(self):
        result = renderer.normalize_svg_styles(chart())
        self.assertEqual(renderer.normalize_svg_styles(result), result)

    def test_multiple_inline_figures_preserve_surrounding_body(self):
        body = '<p>Before</p>'+chart()+'<p>Between</p>'+chart()+'<p>After</p>'
        result = renderer.normalize_body_svg_styles(body)
        self.assertEqual(result.count('<svg'), 2)
        for part in ('<p>Before</p>', '<p>Between</p>', '<p>After</p>'):
            self.assertIn(part, result)
        self.assertNotIn('style=', result)

    def test_unclosed_svg_fails(self):
        with self.assertRaises(ValueError):
            renderer.normalize_body_svg_styles('<p>Text</p><svg><path/>')

    def test_normalized_document_retains_private_review_and_original_input(self):
        original = document()
        before = copy.deepcopy(original)
        result = renderer.normalize_document_svg_styles(original)
        self.assertEqual(original, before)
        self.assertEqual(result['academicReview'], before['academicReview'])
        self.assertEqual(result['rdReview'], before['rdReview'])
        self.assertNotIn('style=', result['sections'][0]['bodyEn'])
        self.assertIn('style=', original['sections'][0]['bodyEn'])

    def test_document_conversion_retains_executable_body_rejection(self):
        for body in ('<svg><path onclick="x()"/></svg>', '<svg><image href="https://example.org/pixel"/></svg>',
                     '<svg><foreignObject>remote</foreignObject></svg>'):
            value = document()
            value['sections'][0]['bodyEn'] = body
            with self.subTest(body=body), self.assertRaises(ValueError):
                renderer.normalize_document_svg_styles(value)

    def test_render_uses_attribute_figures_without_exposing_private_review(self):
        result = renderer.render(document())
        self.assertIn('fill="#ffffff"', result)
        self.assertIn('stroke="#2c6674"', result)
        self.assertNotIn('style="', result)
        self.assertNotIn('synthetic-1', result)


if __name__ == '__main__':
    unittest.main()
