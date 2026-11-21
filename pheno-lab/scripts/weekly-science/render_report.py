#!/usr/bin/env python3
"""Render reviewed bilingual content as an offline Pheno HTML report."""
import base64
import argparse
import copy
import datetime as dt
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

BRAND = Path(__file__).resolve().parents[2] / 'public/brand/pheno-logo.png'
BRAND_SHA = '2aaecb9751e4d8f01467161bc70ddb82f4ce3ab818247a3bdd2d54bba14f5cea'

# The app permits hashed style blocks, not style attributes. SVG presentation
# attributes render under that policy without granting arbitrary inline CSS.
SVG_PRESENTATION_PROPERTIES = frozenset({
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
    'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
    'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'font-family',
    'font-size', 'font-style', 'font-weight', 'text-anchor', 'dominant-baseline',
    'alignment-baseline', 'shape-rendering', 'paint-order', 'vector-effect',
})
SVG_PATTERN = re.compile(r'<svg\b[\s\S]*?</svg\s*>', re.I)
ET.register_namespace('', 'http://www.w3.org/2000/svg')
ET.register_namespace('xlink', 'http://www.w3.org/1999/xlink')


def normalize_svg_styles(svg):
    """Preserve SVG geometry/content while making its paint CSP-compatible.

    Unsupported CSS fails instead of producing a partially styled figure.
    Reference URLs belong in reviewed SVG attributes (such as clip-path), never
    in CSS declarations. This function does not broaden the body validator.
    """
    if re.search(r'<!DOCTYPE|<!ENTITY', svg, re.I):
        raise ValueError('SVG declarations and entities are not allowed in report bodies.')
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as error:
        raise ValueError('Report SVG must be well-formed XML.') from error
    if root.tag not in {'svg', '{http://www.w3.org/2000/svg}svg'}:
        raise ValueError('Expected an SVG root.')
    for node in root.iter():
        if node.tag.rsplit('}', 1)[-1].lower() == 'style':
            raise ValueError('SVG style blocks require reviewed presentation attributes.')
        style = node.attrib.pop('style', None)
        if style is None:
            continue
        for declaration in style.split(';'):
            if not declaration.strip():
                continue
            if ':' not in declaration:
                raise ValueError('Malformed SVG style declaration.')
            property_name, value = declaration.split(':', 1)
            property_name, value = property_name.strip().lower(), value.strip()
            if property_name not in SVG_PRESENTATION_PROPERTIES:
                raise ValueError('Unsupported SVG presentation property: ' + property_name)
            if (not value or re.search(r'url\s*\(|expression\s*\(|@import', value, re.I)
                    or re.search(r'[\\{}<>!@\x00-\x1f]', value)):
                raise ValueError('Unsafe or unsupported SVG presentation value.')
            # Inline CSS takes precedence over an existing presentation attr;
            # later declarations take precedence over earlier ones.
            node.set(property_name, value)
    return ET.tostring(root, encoding='unicode')


def normalize_body_svg_styles(body):
    matches = list(SVG_PATTERN.finditer(body))
    if len(matches) != len(re.findall(r'<svg\b', body, re.I)):
        raise ValueError('Report SVG must have a complete closing tag.')
    return SVG_PATTERN.sub(lambda match: normalize_svg_styles(match.group(0)), body)


def normalize_document_svg_styles(document):
    """Return a copy of an existing private document with safe figure styling.

    Only bodyEn/bodyZh SVG serialization changes; source data, prose, review
    records and ledger metadata are retained. Existing artifacts stay immutable.
    """
    normalized = copy.deepcopy(document)
    sections = normalized.get('sections')
    if not isinstance(sections, list) or not sections:
        raise ValueError('The full report needs at least one bilingual section.')
    for section in sections:
        for key in ('bodyEn', 'bodyZh'):
            if not isinstance(section.get(key), str) or not section[key].strip():
                raise ValueError('Incomplete bilingual section.')
            section[key] = normalize_body_svg_styles(section[key])
            validator = BodyValidator(convert_charrefs=True)
            validator.feed(section[key])
            validator.close()
    return normalized


class BodyValidator(HTMLParser):
    def handle_starttag(self, tag, attrs):
        if tag in {'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'audio', 'video', 'foreignobject'}:
            raise ValueError('Disallowed report body element: ' + tag)
        for key, value in attrs:
            value = value or ''
            if key.startswith('on') or key in {'srcdoc', 'action', 'formaction'}:
                raise ValueError('Disallowed executable attribute.')
            if key in {'href', 'src', 'xlink:href'}:
                if not (value.startswith('#') or (tag == 'a' and key == 'href' and value.startswith('https://')) or (tag == 'img' and value.startswith('data:image/'))):
                    raise ValueError('Report assets must be embedded; reference links must use HTTPS.')
            if key == 'style' and re.search(r'url\s*\(|@import|expression\s*\(', value, re.I):
                raise ValueError('External or executable inline style.')
    handle_startendtag = handle_starttag


def date(value):
    result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Every report timestamp requires a timezone.')
    return result


def bi(en, zh, tag='span'):
    return f'<{tag} data-lang="en">{en}</{tag}><{tag} data-lang="zh" hidden>{zh}</{tag}>'


def render(document):
    document = normalize_document_svg_styles(document)
    required = ('titleEn','titleZh','summaryEn','summaryZh','generatedAt','snapshotAt','windowStart','windowEnd')
    for key in required:
        if not isinstance(document.get(key), str) or not document[key].strip():
            raise ValueError('Missing text field: ' + key)
    generated, snapshot, start, end = [date(document[k]) for k in ('generatedAt','snapshotAt','windowStart','windowEnd')]
    if not start < end <= snapshot <= generated + dt.timedelta(seconds=60):
        raise ValueError('Report dates must match a completed, ordered snapshot window.')
    sections = document.get('sections')
    if not isinstance(sections, list) or not sections:
        raise ValueError('The full report needs at least one bilingual section.')
    ids = set()
    rendered, navigation = [], []
    for index, section in enumerate(sections, 1):
        identifier = section.get('id', '')
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', identifier) or identifier in ids:
            raise ValueError('Section identifiers must be unique and valid.')
        ids.add(identifier)
        for key in ('titleEn','titleZh','bodyEn','bodyZh'):
            if not isinstance(section.get(key), str) or not section[key].strip():
                raise ValueError('Incomplete bilingual section.')
        for lang in ('En','Zh'):
            validator = BodyValidator(convert_charrefs=True)
            validator.feed(section['body'+lang])
            validator.close()
        title = bi(html.escape(section['titleEn']), html.escape(section['titleZh']))
        navigation.append(f'<a href="#{identifier}">{title}</a>')
        rendered.append(f'<section id="{identifier}"><div class="section-head"><span class="number">{index:02}</span><h2>{title}</h2></div>' +
                        bi(section['bodyEn'],section['bodyZh'],'div') + '</section>')
    art = BRAND.read_bytes()
    if hashlib.sha256(art).hexdigest() != BRAND_SHA:
        raise ValueError('Approved brand artwork has changed; confirm current canonical asset.')
    logo = 'data:image/png;base64,' + base64.b64encode(art).decode()
    css = Path(__file__).with_name('report.css').read_text()
    script = '''function setLanguage(lang){lang=lang==='zh'?'zh':'en';document.documentElement.lang=lang;document.querySelectorAll('[data-lang]').forEach(e=>e.hidden=e.dataset.lang!==lang);document.querySelectorAll('[data-set-lang]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.setLang===lang)));}document.querySelectorAll('[data-set-lang]').forEach(b=>b.addEventListener('click',()=>{setLanguage(b.dataset.setLang);history.replaceState(null,'','#lang='+b.dataset.setLang);}));let printDetails=[];window.addEventListener('beforeprint',()=>{printDetails=[...document.querySelectorAll('details')].map(d=>[d,d.open]);printDetails.forEach(([d])=>d.open=true);});window.addEventListener('afterprint',()=>{printDetails.forEach(([d,open])=>d.open=open);printDetails=[];});document.getElementById('print').addEventListener('click',()=>window.print());setLanguage(location.hash.includes('lang=zh')?'zh':'en');'''
    local = lambda v: v.astimezone(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d %H:%M')
    header = f'<div class="top"><div class="wrap bar"><img class="logo" src="{logo}" alt="Pheno"><span class="private">' + bi('INTERNAL RESEARCH REPORT','内部研究报告') + '</span><div class="controls"><button data-set-lang="en" aria-pressed="true">English</button><button data-set-lang="zh" aria-pressed="false">中文</button><button id="print">'+bi('Print / save PDF','打印 / 保存 PDF')+'</button></div></div></div>'
    hero = '<div class="hero"><div class="eyebrow">Pheno Lab</div><h1>'+bi(html.escape(document['titleEn']),html.escape(document['titleZh']))+'</h1>'+bi(html.escape(document['summaryEn']),html.escape(document['summaryZh']),'p')
    hero += '<div class="meta">'+bi('Generated','生成时间')+': '+local(generated)+' · '+bi('Snapshot','快照')+': '+local(snapshot)+' · '+bi('Window','窗口')+': '+local(start)+' → '+local(end)+' (UTC+8)</div><nav class="toc" aria-label="Report contents">'+''.join(navigation)+'</nav></div>'
    footer = '<footer><div class="wrap">'+bi('Confidential internal analysis. Proposed experiments require human authorization.','内部保密分析。实验建议需经人工授权后执行。','p')+'</div></footer>'
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>'+html.escape(document['titleEn'])+'</title><style>'+css+'</style></head><body>'+header+'<main class="wrap">'+hero+''.join(rendered)+'</main>'+footer+'<script>'+script+'</script></body></html>'


def private_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600), 'w') as stream:
        stream.write(text)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--normalize-document', action='store_true',
                        help='Write a new private JSON document with CSP-compatible SVG presentation attributes.')
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    arguments = parser.parse_args()
    source, output = arguments.source, arguments.output
    document = json.loads(source.read_text())
    if arguments.normalize_document:
        normalized = normalize_document_svg_styles(document)
        private_write(output, json.dumps(normalized, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps({'saved':str(output),'normalizedDocument':True,'sourcePreserved':True}))
        sys.exit(0)
    report = render(document)
    body = report.encode()
    if len(body) > 2_000_000:
        raise ValueError('Report exceeds the publication size limit.')
    metadata_path = output.with_suffix('.metadata.json')
    if output.exists() or metadata_path.exists():
        raise ValueError('Preserve existing report and metadata; choose a new draft path.')
    metadata = {k:document[k] for k in ('titleEn','titleZh','generatedAt','snapshotAt','windowStart','windowEnd')}
    metadata.update(contentSha256=hashlib.sha256(body).hexdigest(),contentBytes=len(body),sectionCount=len(document['sections']))
    private_write(output, report)
    private_write(metadata_path, json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'saved':str(output),'metadata':str(metadata_path),'bytes':len(body)}))
