#!/usr/bin/env python3
"""Obtain additional evidence for a real mobile viewport fold. Never publish or overwrite an original verdict."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import re
import subprocess

from check_ready import file_hash, need, record, response_bind, save_new, visual_receipt, existing_directory

HERE = Path(__file__).resolve().parent
APP = HERE.parents[1]
MOBILE = re.compile(r'qa/(?:en|zh)-(?:320|390)-viewport\.png\Z')


def assemble(work, gate, reviews):
    need(gate == work/'gate' and reviews == work/'reviews', 'PRIVATE_RUN_LAYOUT_REQUIRED')
    challenge = record(gate, 'challenge.json')
    digest = file_hash(gate, 'challenge.json')
    findings = record(reviews, 'visual-findings.json')
    images = challenge['images']
    need(findings.get('decision') == 'BLOCK' and findings.get('challengeSha256') == digest and
         findings.get('contentSha256') == challenge['contentSha256'] and findings.get('challenge') == challenge['challenge']
         and findings.get('inspectedImages') == len(images) and findings['blocked'], 'ORIGINAL_COMPLETE_VISUAL_BLOCK_REQUIRED')
    names = []
    for page in findings['blocked']:
        name = page['file']
        need(MOBILE.fullmatch(name) and page['decision'] == 'BLOCK' and len(page['defects']) == 1 and
             name not in names, 'INELIGIBLE_VISUAL_FINDING')
        names.append(name)
    batches = []
    for start in range(0,len(images),3):
        batch = record(reviews, f'vision-batch-{start}.json')
        clarification = f'vision-clarification-{start}.json'
        if (reviews/clarification).exists():
            need(all(x['decision']=='PASS' for x in batch['images']) and
                 any(x['defects'] for x in batch['images']), 'ORIGINAL_BLOCK_CANNOT_BE_REPLACED')
            batch = record(reviews,clarification)
        need(batch['challengeSha256']==digest and
             [(x['file'],x['sha256']) for x in batch['images']]==[(x['file'],x['sha256']) for x in images[start:start+3]],
             'ORIGINAL_BATCH_SCOPE_MISMATCH')
        batches.append(batch)
    held = [dict(x,requestHash=b['requestHash'],responseHash=b['responseHash'],responseId=b['responseId'])
            for b in batches for x in b['images'] if x['decision']=='BLOCK']
    need(held==findings['blocked'],'ORIGINAL_BLOCKED_PAGES_CHANGED')
    output = reviews/'visual-review.json'
    if output.exists():
        previous = record(reviews,output.name)
        response_bind(previous,challenge,digest)
        visual_receipt(previous,challenge,gate,reviews,{})
        return
    receipts = {}
    for name in names:
        stem=Path(name).stem
        evidence='boundary-evidence-'+stem+'.json'
        reviewed='boundary-review-'+stem+'.json'
        if not (reviews/evidence).exists():
            subprocess.run(['node', HERE/'verify_report.mjs', work/'report-publish.html',gate/'qa',
                            '--viewport-boundary',reviews,name],cwd=APP,check=True,timeout=180)
        if not (reviews/reviewed).exists():
            subprocess.run([APP/'node_modules/.bin/tsx',HERE.parent/'weekly-runner/vision-boundary.ts',
                            gate,reviews,name],cwd=APP,check=True,timeout=360)
        receipts[name]={'evidenceSha256':file_hash(reviews,evidence),'reviewSha256':file_hash(reviews,reviewed)}
    proposed={'schemaVersion':1,'role':'visual','model':'deepseek-flash','challenge':challenge['challenge'],
              'challengeSha256':digest,'contentSha256':challenge['contentSha256'],'batches':batches,
              'boundaryAdjudications':receipts,'completedAt':datetime.now(timezone.utc).isoformat()}
    response_bind(proposed,challenge,digest)
    visual_receipt(proposed,challenge,gate,reviews,{})
    save_new(output,proposed)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('run','gate','reviews'):
        parser.add_argument(name,type=Path)
    a=parser.parse_args()
    try:
        assemble(*(existing_directory(path) for path in (a.run,a.gate,a.reviews)))
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError):
        raise SystemExit('Visual review remains held. Inspect the retained original finding and supplemental evidence.')
