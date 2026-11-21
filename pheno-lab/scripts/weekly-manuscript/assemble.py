"""Assemble the reviewed public candidate for local scientific and privacy review.
This command has no publisher, never marks a legacy gate approved and accepts no SQL.
"""
import argparse
import datetime as dt
import hashlib
from html import escape
import json
from pathlib import Path
import re
from prepare import read, save


def canonical(value):
    # Manuscript objects contain strings, arrays and null only; matches the TS canonical hash.
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',',':'), sort_keys=True).encode()).hexdigest()


def paragraph(value):
    return '<p>'+escape(value)+'</p>'


def table(headers, rows):
    head='<thead><tr>'+''.join('<th>'+escape(x)+'</th>' for x in headers)+'</tr></thead>'
    body='<tbody>'+''.join('<tr>'+''.join('<td>'+escape(str(x))+'</td>' for x in row)+'</tr>' for row in rows)+'</tbody>'
    return '<table>'+head+body+'</table>'


def subsection(title, text):
    return '<h3>'+escape(title)+'</h3>'+paragraph(text)


def section(key,en,zh,body):
    return {'id':key,'titleEn':en,'titleZh':zh,'bodyEn':body['en'],'bodyZh':body['zh']}


def assemble(root):
    manuscript=read(root/'manuscript-candidate.json')
    packet=read(root/'provider-packet.json')
    bindings=read(root/'bindings.private.json')
    review=read(root/'public-model-review.json')
    snapshot=read(root/'snapshot.json')
    if review['role']!='reviewer' or review['reviewedManuscriptHash']!=canonical(manuscript) or review['value']['decision']!='PASS' or any(f['severity']=='blocking' for f in review['value']['findings']):
        raise ValueError('Candidate lacks matching public peer review')
    sections=[section('priorities','Priorities','研发重点',{
        lang:'<ol>'+''.join('<li>'+escape(item[lang])+'</li>' for item in manuscript['priorities'])+'</ol>' for lang in ('en','zh')})]
    body={}
    for lang in ('en','zh'):
        zh=lang=='zh'
        rows=[[m['project'], m['judgment'][lang], p['measuredScans'], p['olderReceipts']] for p,m in zip(packet['projects'],manuscript['projects'],strict=True)]
        body[lang]=table(['项目','当前判断','本周测试扫描数','本周收到的历史扫描数'] if zh else ['Project','Current judgment','Scans measured this week','Older scans received this week'],rows)
    sections.append(section('projects','Project decisions','各项目当前判断',body))
    sections.append(section('methods','How results were selected','结果选取口径',{
        'en':paragraph('The app selected one accepted complete result per physical device and characterization. Each group table gives the mean, best result and sample standard deviation separately. The device results are cumulative at '+packet['period']['acceptedAsOf']+'. The counts above refer to the weekly window. A missing statistic is shown as a dash.'),
        'zh':paragraph('应用按实物器件和测试项目各选取一条已接受、指标完整的结果。下表分别列出均值、最高值和样本标准差。器件数据累计至 '+packet['period']['acceptedAsOf']+'。上表扫描数按本周统计，缺失的统计量用横线表示。')}))
    for source,case in zip(packet['cases'],manuscript['cases'],strict=True):
        if source['id'] != case['experiment']:
            raise ValueError('Case binding differs')
        b=bindings['cases'][source['id']]
        code=b['code']
        # Do not turn arbitrary legacy names into shared visible text.
        if not re.fullmatch(r'[A-Z0-9-]{2,80}',code,re.I):
            code=source['id']
        char=next(c for c in source['characterizations'] if c['id']==case['characterization'])
        fields=[('result','Observed result','实验结果'),('judgment','Current judgment','当前判断'),('keyIssue','Key question','当前问题'),('nextStep','Next test','下一步验证')]
        body={}
        for lang in ('en','zh'):
            zh=lang=='zh'
            text=''.join(subsection(hz if zh else he,case[k][lang]) for k,he,hz in fields)
            metrics=[]
            for g in char['groups']:
                for metric,unit in [('pce','PCE (%)'),('voc','Voc (V)'),('jsc','Jsc (mA/cm²)'),('ff','FF (%)')]:
                    stats=g['stats'].get(metric)
                    if not stats: continue
                    values=[stats.get(k) for k in ('mean','best','sd')]
                    metrics.append([g['id'],unit,stats['n'],*['—' if v is None else f'{v:.3f}'.rstrip('0').rstrip('.') for v in values]])
            text+=table(['组别','指标','器件数','平均','最高','标准差'] if zh else ['Arm','Quantity','Devices','Mean','Best','SD'],metrics)
            body[lang]=text
        sections.append(section('case-'+case['experiment'].lower(),code+' · device comparison',code+' · 器件对比',body))
        body={}
        for lang in ('en','zh'):
            zh=lang=='zh'
            text=''.join(subsection(hz if zh else he,case[k][lang]) for k,he,hz in [('mechanism','Working hypothesis','目前假设'),('alternative','Competing explanation','其他可能原因'),('discriminator','Discriminating measurement','区分两种解释的测量')])
            rows=[[tag,case[key]['mean'][lang],case[key]['highest'][lang],case[key]['spread'][lang],case[key]['action'][lang]] for key,tag in (
                ('positive','符合预期' if zh else 'Expected signature'),('negative','预期未出现' if zh else 'Signature absent'),('mixed','结果不一致或测量无效' if zh else 'Mixed or invalid'))]
            text+=table(['假设检验','平均效率','最高效率','器件间差异','后续决策'] if zh else ['Outcome','Mean PCE','Highest PCE','Device spread','Decision'],rows)
            if case['papers']:
                cites={m['paper']:m for m in read(root/'article-refresh.json')}
                text+='<ul>'+''.join('<li>'+escape(cites[k]['title'])+' · DOI '+escape(cites[k]['doi'])+'</li>' for k in case['papers'])+'</ul>'
            body[lang]=text
        sections.append(section('test-'+case['experiment'].lower(),code+' · competing explanations and decisions',code+' · 原因及验证方法',body))
    window=packet['period']
    title_date=window['end'][:10]
    document={'titleEn':f'Weekly R&D decisions · {title_date} · review draft','titleZh':f'每周研发决策 · {title_date} · 待审核',
        'summaryEn':'Private working draft for research review. Experiment names, actual conditions and chemical interpretation require a source check before distribution.',
        'summaryZh':'科研复核用草稿。发送前须核对实验名称、实际工艺条件和材料机理解释。','generatedAt':dt.datetime.now(dt.timezone.utc).isoformat(),
        'snapshotAt':snapshot['snapshotAt'],'windowStart':window['start'],'windowEnd':window['end'],'sections':sections}
    save(root/'report-document-candidate.json',document)
    requests=[]
    for case in manuscript['cases']:
        ex=bindings['cases'][case['experiment']]
        requests.append({'sourceHash':ex['sourceHash'],'experimentCode':ex['code'],'characterizationId':ex['characterizations'][case['characterization']],
            'selectedReference':ex['groups'].get(case['reference']), 'comparedGroup':ex['groups'][case['comparator']],
            'needs':['Read actual experiment design and intent plus actual-versus-plan execution for these groups.',
            'Review exact in-scope chemical graph and lot/date evidence locally; compare registered identity against actual use.',
            'Verify permitted condition names/units, material-specific mechanism, applicability and alternative against current public literature.',
            'Reconcile period history, previous project decisions and prior ledger with true new source aliases.']})
    save(root/'scientific-review-requests.private.json',{'publicManuscriptHash':canonical(manuscript),
        'status':'PENDING_SOURCE_AND_PRIVATE_REVIEW','cases':requests,
        'remaining':['Source-bound private molecular annex, scientific numeric audit, full academic/decision/language/collaborator/source gates',
            'Review actual final bilingual document after private source interpretation and label substitution',
            'Render final document; inspect each chart and print page, mobile/desktop/offline CSP checks']})
    print('Private bilingual review candidate prepared. Full scientific/chemistry acceptance is pending.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run',type=Path)
    assemble(parser.parse_args().run.resolve())
