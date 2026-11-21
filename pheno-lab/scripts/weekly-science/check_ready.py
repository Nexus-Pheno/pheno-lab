#!/usr/bin/env python3
"""Prepare and verify a fresh scientific publication review. No production writes or model calls."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile

import analyze_rd_snapshot
import audit_device_results
import period_scope
from referee_project_sources import project_sources
from ledger_audience import LedgerAudience, verify_manager_html, verify_inactive_followups
from manager_material_names import ManagerMaterialNames
from project_names import names_from_source, verify_project_names
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "weekly-manuscript"))
from assemble_science import aging_record_evidence, display_case_groups, display_project_text
from proposal_revision import revised_proposal, source_revisions
import bind_final_review
from import_verified_baseline import existing_directory
from replay_frozen_report import checked_file, check_published_run, record, save_new, run_science_gates
import render_report
import select_published_baseline as baseline
import shared_app_evidence


class Hold(ValueError):
    """Safe reason for retaining a draft."""


def need(condition, code):
    if not condition:
        raise Hold(code)


def now():
    return dt.datetime.now(dt.timezone.utc)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def compact(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def read_list(folder, name):
    value = json.loads(checked_file(folder, name).read_bytes())
    need(isinstance(value, list), 'INVALID_LIST_ARTIFACT')
    return value


def valid_hash(value):
    return isinstance(value, str) and bool(re.fullmatch('[0-9a-f]{64}', value))


def file_hash(folder, name):
    path = checked_file(folder, name)
    need(path.stat().st_size <= baseline.MAX_ARTIFACT_BYTES, 'CHECK_INPUT_TOO_LARGE')
    return baseline.file_sha(path)


def require_private_attestation(run):
    review = record(run, 'independent-material-science-review.json')
    # Independent requests in fresh contexts. The final referee also sees the
    # actual private material annex and evaluates how it was used in the paper.
    need(review.get('role') == 'chemist-reviewer' and review.get('provider') == 'deepseek' and
         review.get('model') == 'deepseek-v4-pro' and review.get('providerHost') == 'api.deepseek.com' and
         isinstance(review.get('completionId'), str) and bool(review['completionId']) and
         all(valid_hash(review.get(k)) for k in ('requestHash', 'outputHash', 'evidenceHash', 'inputHash')) and
         review.get('value', {}).get('decision') == 'PASS', 'PRIVATE_SCIENCE_INDEPENDENT_REVIEW_REQUIRED')
    chain = json.loads(subprocess.run(['node',Path(__file__).with_name('verify_material_receipt.mjs'),run],
                            capture_output=True,text=True,check=True,timeout=300).stdout)
    return review, chain


def prepare_source(run, prior):
    prior_meta = check_published_run(prior)
    snap = record(run, 'snapshot.json', baseline.MAX_ARTIFACT_BYTES)
    previous = record(prior, 'snapshot.json', baseline.MAX_ARTIFACT_BYTES)
    need(baseline.timestamp(previous['snapshotAt']) < baseline.timestamp(snap['snapshotAt']) and
         baseline.timestamp(previous['windowEnd']) < baseline.timestamp(snap['windowEnd']) and
         baseline.timestamp(snap['periodStart']) < baseline.timestamp(snap['windowEnd']),
         'NEW_PERIOD_AND_FRESH_CAPTURE_REQUIRED')
    prior_dossier = record(prior, 'rd-dossier-published.json', baseline.MAX_ARTIFACT_BYTES)
    scope = period_scope.derive(snap, previous, prior_dossier, prior_meta)
    # Older, already frozen rehearsals with newly measured sources used the identical default scope.
    if 'weeklyCollectionScope' in snap or scope['mode'] == 'CARRIED_FORWARD':
        need(snap.get('weeklyCollectionScope') == scope, 'WEEKLY_SELECTION_DIFFERS_FROM_VERIFIED_PRIOR_OR_CURRENT_WINDOW')
    shared_app_evidence.validate_export(snap['sharedAppEvidence'], snap, scope['requestedExperimentCodes'])
    primary = shared_app_evidence.dossier_primary_evidence(snap)
    dossier = record(run, 'rd-dossier-reviewed.json', baseline.MAX_ARTIFACT_BYTES)
    need(primary == dossier['primaryExperimentEvidence'], 'PRIMARY_EVIDENCE_DIFFERS_FROM_APP_EXPORT')
    need(baseline.timestamp(dossier['snapshotAt']) == baseline.timestamp(snap['snapshotAt']), 'SOURCE_CUTOFF_MISMATCH')
    ledger = analyze_rd_snapshot.update_ledger([prior_dossier], read_list(run, 'reviewed-updates.json'))
    need(ledger == sorted(dossier['ledgerEntries'], key=lambda e:(e['projectAlias'],e['entryId'])),
         'APPEND_ONLY_PRIOR_LEDGER_MISMATCH')
    audit = audit_device_results.audit(snap, previous)
    audit.update(currentLedgerEntries=len(ledger), previousLedgerEntries=prior_meta.get('ledgerEntries'),
                 sourceCutoff=snap['snapshotAt'], acceptedAsOf=snap['sharedAppEvidence']['asOf'])
    return snap, audit, prior_meta


def reviewer_packet(doc, snapshot, private_facts, annex, literature, audit, challenge, html_hash):
    # Send the actual complete final sections, and explicitly projected case facts.
    # Never send raw experiment narratives, recipe payloads, staff IDs or graph notation.
    reviewed = {item['experimentCode']: item for item in doc['evidenceMethodReview']['experiments']}
    contexts={case['sourceHash']:case for case in private_facts['cases']}
    rows = []
    for source in snapshot['sharedAppEvidence']['experiments']:
        code = source['experimentCode']
        if code not in reviewed:
            continue
        item = reviewed[code]
        ev = source['evidence']
        requested={}
        for contrast in item['comparisons']:
            labels=requested.setdefault(contrast['characterizationId'],set())
            labels.add(contrast['group'])
            if item['referenceGroup'] is not None:
                labels.add(item['referenceGroup'])
        arms=[]
        for char in ev['characterizations']:
            for group in char['groups']:
                if group['label'] not in requested.get(char['id'],()):
                    continue
                arms.append({'characterization':char['name'], 'group':group['label'], 'metrics':group['metrics'],
                             'deltaMean':group['deltaMean'], 'deltaBest':group['deltaBest']})
        context=contexts.get(ev['sourceHash'])
        need(isinstance(context,dict),'MISSING_CURRENT_REVIEWED_CASE_CONTEXT')
        facts={'sourceHash':ev['sourceHash'],'declaredComparisonEn':item['conditionSummaryEn'],
               'declaredComparisonZh':item['conditionSummaryZh'],'selectedReference':item['referenceGroup'],'groups':arms,
               'recordedIntent':{k:context[k] for k in ('observation','question','hypothesis','conclusion')},
               'groupLabels':context['recordedGroups'],'sourceConditions':context['conditions'],
               'actualCaptures':context['actualCaptures'],'deviceStack':context['stack']}
        rows.append({'code': code, 'sourceHash': ev['sourceHash'], 'comparisonFacts': compact(facts)})
    science = [{'name': c.get('materialName'), 'status': c.get('status'), 'conclusion': c.get('reportSafeFutureSentence'),
                'alternatives': c.get('competingExplanations'), 'controls': c.get('discriminatingControls')}
               for c in annex['materialCases']]
    references = [{'id': r['paper'], 'title': r['title'], 'doi': r['doi'], 'abstract': r.get('abstract'),
                   'applicability':r.get('applicability')} for r in literature['sources']]
    return {'challenge':challenge,'challengeSha256':sha(challenge.encode()),'contentSha256':html_hash,
            'period':{'start':snapshot['periodStart'],'end':snapshot['windowEnd'],'asOf':snapshot['sharedAppEvidence']['asOf']},
            'title':{'en':doc['titleEn'],'zh':doc['titleZh']},'abstract':{'en':doc['summaryEn'],'zh':doc['summaryZh']},
            'sections':[{'id':s['id'],'en':s['titleEn']+'\n'+s['bodyEn'],'zh':s['titleZh']+'\n'+s['bodyZh']} for s in doc['sections']],
            'sourceCases':rows,'numericAudit':compact(audit),'materialReview':compact(science),'literature':compact(references)}


def images_for_review(output):
    qa = output / 'qa'
    verified = record(qa, 'verification.json')
    pages = record(qa, 'print-pages.json')
    need(verified.get('passed') is True and pages.get('allPagesRendered') is True, 'UNVERIFIED_REPORT_LAYOUT')
    expected = {(m,l,w) for m in ('offline','app-equivalent-csp-sandbox') for l in ('en','zh') for w in (1440,1024,390,320)}
    cases = verified['cases']
    need(len(cases) == 16 and {(r['mode'],r['lang'],r['width']) for r in cases} == expected,
         'INCOMPLETE_BROWSER_COVERAGE')
    names = {f'{l}-{w}-viewport.png' for _,l,w in expected}
    for language in ('en','zh'):
        page_rows = pages['languages'][language]['pages']
        need(page_rows and len(page_rows)==verified['renderedPrintPages'][language], 'INCOMPLETE_PRINT_RENDER')
        for p in page_rows:
            need(file_hash(qa,p['image']) == p['imageSha256'], 'PRINT_IMAGE_HASH_MISMATCH')
            names.add(p['image'])
        need(file_hash(qa,language+'-print.pdf') == pages['languages'][language]['pdfSha256'], 'PRINT_PDF_HASH_MISMATCH')
    for r in cases:
        if r['mode']=='app-equivalent-csp-sandbox':
            need(r['cspViolations']==0 and r['cspConsoleErrors']==0 and r['opaqueOrigin'] and r['parentAccessBlocked'] and
                 r['storageBlocked'] and r['matchesOfflinePaintFontsGeometryAndLabels'], 'APP_SECURITY_CHECK_FAILED')
            if r['width'] in (390,1440):
                matching=list(qa.glob(f"{r['lang']}-{r['width']}-csp-chart-*.png"))
                originals=[p for p in matching if not p.stem.endswith('-right')]
                need(len(originals)==r['photographedFigures'] and r['photographedCharts']==r['chartCount'] and
                     (not r['chartCount'] or bool(originals)), 'CHART_IMAGE_MISSING')
                names.update(p.name for p in matching)
    return [{'file':'qa/'+name,'sha256':file_hash(qa,name)} for name in sorted(names)]


def preserve_or_save(path, value):
    if path.exists():
        need(record(path.parent,path.name,baseline.MAX_ARTIFACT_BYTES)==value,'EXISTING_GATE_RECEIPT_CONFLICT')
    else:
        save_new(path,value)


def prepare(run, prior, output):
    need(not output.is_symlink(), 'NEW_GATE_DIRECTORY_REQUIRED')
    started={'schemaVersion':1,'operation':'PREPARE_WEEKLY_GATE','run':str(run),'prior':str(prior)}
    if output.exists():
        existing_directory(output)
        need(record(output,'attempt.json')==started, 'NEW_GATE_DIRECTORY_REQUIRED')
        if (output/'challenge.json').exists():
            ch=record(output,'challenge.json')
            need(all(file_hash(run,n)==v for n,v in ch['inputs'].items()) and
                 all(file_hash(output,n)==v for n,v in ch['outputs'].items()) and images_for_review(output)==ch['images'],
                 'SEALED_GATE_BYTES_CHANGED')
            return {'status':'AWAITING_INDEPENDENT_REVIEWS','images':len(ch['images']),'reusedChallenge':True}
        # Preserve the incomplete attempt, including gate findings and captures.
        output.rename(output.with_name('UNPUBLISHED-incomplete-'+output.name+'-'+secrets.token_hex(8)))
    output.mkdir(mode=0o700)
    save_new(output/'attempt.json',started)
    snap, audit, prior_meta = prepare_source(run, prior)
    need(not (run/'run-result.json').exists(), 'FRESH_UNPUBLISHED_RUN_REQUIRED')
    private_review, material_chain = require_private_attestation(run)
    current_sources={c['evidence']['sourceHash'] for c in snap['sharedAppEvidence']['experiments']}
    facts=record(run,'private-scientific-facts.json',baseline.MAX_ARTIFACT_BYTES)
    need(all(c.get('sourceHash') in current_sources for c in facts['cases']), 'PRIVATE_REVIEW_SOURCE_NOT_CURRENT')
    need(baseline.timestamp(snap['sharedAppEvidence']['asOf'])<=baseline.timestamp(private_review['reviewedAt'])<=now()+dt.timedelta(minutes=1),
         'PRIVATE_PEER_REVIEW_PREDATES_CURRENT_EVIDENCE')
    doc=record(run,'report-document-publish.json',baseline.MAX_ARTIFACT_BYTES)
    if "reportingWeekStart" in doc:
        need(doc["reportingWeekStart"] == snap["periodStart"] and doc["windowStart"] == snap["windowStart"] and
             doc["windowEnd"] == snap["windowEnd"], "DISPLAYED_PERIOD_DIFFERS_FROM_SOURCE")
    previous = record(prior, "snapshot.json", baseline.MAX_ARTIFACT_BYTES)
    try:
        period_scope.verify_scope_note(doc, snap, previous)
    except ValueError as error:
        raise Hold("MISSING_OR_INCORRECT_CASE_MEASUREMENT_TIMING_NOTE") from error
    try:
        period_scope.verify_followup_timing(snap, previous, record(run, "science-public-index.private.json", baseline.MAX_ARTIFACT_BYTES),
            record(run, "project-decisions.json", baseline.MAX_ARTIFACT_BYTES), record(run, "bindings.private.json", baseline.MAX_ARTIFACT_BYTES))
    except ValueError as error:
        raise Hold("PRIOR_FOLLOWUP_LACKS_NEW_MEASUREMENTS_IN_CITED_EXPERIMENT") from error
    annex=record(run,'private-material-review.json')
    literature={'sources':read_list(run,'article-refresh.json')}
    need(all(x in doc for x in ('rdReview','decisionReview','academicReview','evidenceMethodReview','collaboratorReview','languageReview')),
         'COMPLETE_SCIENTIFIC_REVIEW_ENVELOPES_REQUIRED')
    need(doc['academicReview'].get('reportStyle')=='DECISION_LED_EXPERIMENT_REVIEW' and
         doc['decisionReview'].get('enforceVisibleDecisions') is True,'DECISION_LED_MANUSCRIPT_REQUIRED')
    names={'snapshot.json','rd-dossier-reviewed.json','reviewed-updates.json','report-document-publish.json',
           'report-publish.html','private-material-review.json','science-interpretation.json',
           'independent-material-science-review.json','private-scientific-facts.json','article-refresh.json',
           'provider-packet.json','manuscript-candidate.json','private-science-bindings.json'}
    # Legacy science receipts may have a separate reviewed literature supplement.
    # Fresh runs bind those bilingual notes via the scientific interpretation itself.
    supplement = "literature-editorial-notes.private.json"
    if (run / supplement).exists() or (run / supplement).is_symlink():
        file_hash(run, supplement)
        names.add(supplement)
    proposal_proof = {"proposal-revision.private.json", "proposal-origin-scientific-review.private.json",
                      "proposal-origin-challenge.private.json"}
    present = {name for name in proposal_proof if (run / name).exists() or (run / name).is_symlink()}
    if present:
        need(present == proposal_proof, "PROPOSAL_REVISION_REQUIRES_ORIGINAL_BOUND_REFEREE")
        for name in present:
            file_hash(run, name)
        names.update(present)
    readable_projects = record(run, "project-decisions-display.private.json", baseline.MAX_ARTIFACT_BYTES)
    need(readable_projects == display_project_text(record(run, "project-decisions.json", baseline.MAX_ARTIFACT_BYTES),
        record(run, "bindings.private.json", baseline.MAX_ARTIFACT_BYTES)["projects"]), "DISPLAY_PROJECTS_DIFFER_FROM_REVIEWED_SOURCE")
    names.add("project-decisions-display.private.json")
    project_labels = names_from_source(snap, record(run, "bindings.private.json", baseline.MAX_ARTIFACT_BYTES)["projects"],
                                       record(run, "project-decisions.json", baseline.MAX_ARTIFACT_BYTES))
    verify_project_names(doc, project_labels)
    ids = record(run, "bindings.private.json", baseline.MAX_ARTIFACT_BYTES)["cases"]
    science = record(run, "science-interpretation.json", baseline.MAX_ARTIFACT_BYTES)
    public_cases = record(run, "science-public-index.private.json", baseline.MAX_ARTIFACT_BYTES)["cases"]
    originals = {entry["experiment"]: entry["public"] for entry in science["cases"]}
    proposal_changes = source_revisions(run, science)
    for case in public_cases:
        name = case["case"]
        aging_status = aging_record_evidence(snap, ids[name])
        need(case.get("displayPublic") == revised_proposal(name, display_case_groups(originals[name], ids[name]["groups"], ids, aging_status), proposal_changes),
             "CASE_DISPLAY_DIFFERS_FROM_OFFICIAL_SCIENTIFIC_TEXT_AND_GROUP_LABELS")

    section_reviews = json.loads(subprocess.run(
        ['node', Path(__file__).with_name('verify_section_receipts.mjs'), run],
        capture_output=True, text=True, timeout=300, check=True).stdout)
    names.update(section_reviews['files'])
    names.update(material_chain['files'])
    need(set(section_reviews['completionIds']) & set(material_chain['completionIds']) ==
         {private_review['completionId'], private_review['authorCompletionId']}, 'SCIENTIFIC_ROLE_COMPLETION_REUSED')
    all_completions = sorted(set(section_reviews['completionIds']) | set(material_chain['completionIds']))
    for item in annex['inputs']:
        name=item['file']
        need(Path(name).name==name and file_hash(run,name)==item['sha256'],'PRIVATE_ANNEX_SOURCE_MISMATCH')
        names.add(name)
    inputs={n:file_hash(run,n) for n in sorted(names)}
    final_html = render_report.render(doc)
    reviewed_dossier = record(run, "rd-dossier-reviewed.json", baseline.MAX_ARTIFACT_BYTES)
    verify_manager_html(final_html, LedgerAudience(reviewed_dossier["ledgerEntries"]))
    ManagerMaterialNames(snap, readable_projects).verify(final_html)
    verify_inactive_followups(final_html, record(run, "project-decisions.json", baseline.MAX_ARTIFACT_BYTES),
        record(run, "project-decisions-review.json", baseline.MAX_ARTIFACT_BYTES),
        record(run, "science-public-index.private.json", baseline.MAX_ARTIFACT_BYTES), read_list(run, "reviewed-updates.json"))
    html_hash=sha(final_html.encode())
    need(html_hash==inputs['report-publish.html'],'FINAL_HTML_DIFFERS_FROM_REVIEWED_MANUSCRIPT')
    need(bind_final_review.is_unsigned(doc,snap['sharedAppEvidence']['asOf']), 'UNSIGNED_CURRENT_REVIEW_REQUIRED')
    gates=run_science_gates(run,prior,output)
    save_new(output/'gates.json',gates)
    need(bind_final_review.may_prepare(gates),'SUBSTANTIVE_SCIENTIFIC_GATE_FAILED')
    save_new(output/'numeric-audit.json',audit)
    subprocess.run(['node',Path(__file__).with_name('verify_report.mjs'),run/'report-publish.html',output/'qa'],
                   cwd=Path(__file__).resolve().parents[2],check=True,timeout=1800,stdout=subprocess.DEVNULL)
    secret=secrets.token_hex(32)
    fresh, _, measured = period_scope.scan_timing(snap, previous)
    timing = {code: {"inWindow": n, "firstSeenInWindow": fresh.get(code, 0)} for code,n in measured.items()}
    cases_timing = {item["experimentCode"]: timing.get(item["experimentCode"], {"inWindow": 0, "firstSeenInWindow": 0})
                    for item in doc["evidenceMethodReview"]["experiments"]}
    project_evidence = project_sources(doc, reviewed_dossier,
        record(run, "project-source-packet.private.json", baseline.MAX_ARTIFACT_BYTES),
        record(run, "project-attainment.json", baseline.MAX_ARTIFACT_BYTES),
        record(run, "project-decisions-review.json", baseline.MAX_ARTIFACT_BYTES),
        record(run, "project-decisions.json", baseline.MAX_ARTIFACT_BYTES),
        record(run, "bindings.private.json", baseline.MAX_ARTIFACT_BYTES)["projects"], timing)
    reviewer_audit = {**audit, "reviewCoverage": bind_final_review.peer_coverage(doc),
                      "baseline": {"windowEnd": previous["windowEnd"], "snapshotAt": previous["snapshotAt"],
                                   "snapshotSha256": prior_meta["snapshotSha256"], "dossierSha256": prior_meta["dossierPublishedSha256"]},
                      "caseWeeklyScans": cases_timing, "projectNames": project_labels, "projectSources": project_evidence}
    packet=reviewer_packet(doc,snap,facts,annex,literature,reviewer_audit,secret,html_hash)
    need(len(packet["numericAudit"].encode("utf-16-le")) // 2 <= 200_000, "FINAL_NUMERIC_AND_PROJECT_EVIDENCE_EXCEEDS_REVIEW_BOUND")
    packet['reviewChecks']=sorted(bind_final_review.CHECKS)
    save_new(output/'final-science-input.json',packet)
    outputs={name:file_hash(output,name) for name in ['numeric-audit.json','gates.json','final-science-input.json',
             'qa/verification.json','qa/print-pages.json']+[k+'-gate.json' for k in gates]}
    challenge={'schemaVersion':1,'challenge':secret,'createdAt':now().isoformat(),'contentSha256':html_hash,'inputs':inputs,
               'outputs':outputs,'images':images_for_review(output),'priorReportId':prior_meta['reportId'],
               'priorSnapshotSha256':prior_meta['snapshotSha256'],'priorDossierSha256':prior_meta['dossierPublishedSha256'],
               'materialPeerCompletionId':private_review['completionId'], 'priorStageCompletionIds':all_completions}
    need(all(file_hash(run,k)==v for k,v in inputs.items()),'SOURCE_CHANGED_DURING_PREPARATION')
    save_new(output/'challenge.json',challenge)
    return {'status':'AWAITING_INDEPENDENT_REVIEWS','images':len(challenge['images']),'gates':len(gates),'arithmeticChecks':audit['arithmeticChecks']}


def response_bind(receipt, challenge, challenge_hash):
    need(receipt.get('schemaVersion')==1 and receipt.get('challenge')==challenge['challenge'] and
         receipt.get('challengeSha256')==challenge_hash and receipt.get('contentSha256')==challenge['contentSha256'],
         'STALE_OR_UNBOUND_REVIEW')
    when=baseline.timestamp(receipt.get('completedAt'))
    need(baseline.timestamp(challenge['createdAt'])<=when<=now()+dt.timedelta(minutes=1),'REVIEW_TIME_OUTSIDE_CHALLENGE')


def visual_receipt(receipt, challenge):
    need(receipt.get('role')=='visual' and receipt.get('model')=='deepseek-flash','WRONG_VISUAL_REVIEWER')
    expected={i['file']:i['sha256'] for i in challenge['images']}
    ids, requests, responses, canaries, seen=set(),set(),set(),set(),set()
    for batch in receipt['batches']:
        req, res, ticket, canary=(batch.get(k) for k in ('requestHash','responseHash','responseId','canaryExpected'))
        need(valid_hash(req) and valid_hash(res) and isinstance(ticket,str) and ticket.strip() and
             req not in requests and res not in responses and ticket not in ids and
             isinstance(canary,str) and len(canary)>=4 and canary not in canaries and
             canary==batch.get('canaryReceived') and batch['images'],'VISUAL_PROVIDER_PROVENANCE_OR_CANARY_FAILED')
        requests.add(req);responses.add(res);ids.add(ticket);canaries.add(canary)
        for row in batch['images']:
            name=row['file']
            need(name not in seen and name in expected and row.get('sha256')==expected[name] and
                 row.get('decision')=='PASS' and row.get('defects')==[] and
                 len(str(row.get('observation','')).strip())>=12,'VISUAL_FINDING_OR_IMAGE_MISMATCH')
            seen.add(name)
    need(seen==set(expected) and seen,'INCOMPLETE_VISUAL_REVIEW')
    return ids


def scientific_receipt(receipt, challenge, packet):
    need(receipt.get('role')=='final-scientific' and receipt.get('provider')=='deepseek' and
         receipt.get('model')=='deepseek-v4-pro' and receipt.get('providerHost')=='api.deepseek.com' and
         type(receipt.get('completionId')) is str and bool(receipt['completionId']) and
         receipt['completionId']!=challenge['materialPeerCompletionId'] and
         receipt['completionId'] not in challenge.get('priorStageCompletionIds', []) and
         all(valid_hash(receipt.get(k)) for k in ('inputHash','requestHash','outputHash','promptHash')) and
         receipt['inputHash']==sha(compact(packet).encode()), 'UNBOUND_FINAL_SCIENTIFIC_RESPONSE')
    outcome=receipt.get('value',{})
    need(sha(compact(outcome).encode())==receipt['outputHash'] and outcome.get('challenge')==challenge['challenge'] and
         outcome.get('contentSha256')==challenge['contentSha256'] and outcome.get('decision')=='PASS' and
         isinstance(outcome.get('findings'),list) and all(x.get('severity')=='advisory' for x in outcome['findings']),
         'FINAL_SCIENTIFIC_FINDINGS_OPEN')
    for rows,key,expected,explain in [(outcome['sections'],'id',{s['id'] for s in packet['sections']},'observation'),
        (outcome['assessments'],'scope',{'numerical','science','chemistry','source','bilingual','privacy'},'evidence')]:
        need(len(rows)==len(expected) and {x[key] for x in rows}==expected and
             all(x['decision']=='PASS' and len(str(x.get(explain,'')).strip())>=12 for x in rows),'INCOMPLETE_SCIENTIFIC_REVIEW')


def verify(run,prior,output,reviews):
    ch=record(output,'challenge.json')
    digest=file_hash(output,'challenge.json')
    need(valid_hash(ch['challenge']) and ch['schemaVersion']==1,'INVALID_REVIEW_CHALLENGE')
    need(all(file_hash(run,n)==v for n,v in ch['inputs'].items()) and
         all(file_hash(output,n)==v for n,v in ch['outputs'].items()),'REVIEWED_BYTES_CHANGED')
    prior_meta=check_published_run(prior)
    need((prior_meta['reportId'],prior_meta['snapshotSha256'],prior_meta['dossierPublishedSha256'])==
         (ch['priorReportId'],ch['priorSnapshotSha256'],ch['priorDossierSha256']),'PRIOR_BASELINE_CHANGED')
    need(images_for_review(output)==ch['images'],'REVIEWED_IMAGES_CHANGED')
    science=record(reviews,'scientific-review.json',baseline.MAX_METADATA_BYTES*4)
    visual=record(reviews,'visual-review.json',baseline.MAX_METADATA_BYTES*4)
    for receipt in (science,visual):
        response_bind(receipt,ch,digest)
    scientific_receipt(science,ch,record(output,'final-science-input.json',baseline.MAX_METADATA_BYTES*2))
    responses=visual_receipt(visual,ch)
    need(science['completionId'] not in responses,'REVIEWER_CONTEXT_REUSED')
    doc=record(run,'report-document-publish.json',baseline.MAX_ARTIFACT_BYTES)
    approved=bind_final_review.attach(doc,science)
    signed=output/'report-document-reviewed.json'
    need(sha(render_report.render(approved).encode())==ch['contentSha256'],'APPROVAL_CHANGED_VISIBLE_PAPER')
    preserve_or_save(signed,approved)
    final_output=output/'approved'
    final_output.mkdir(mode=0o700,exist_ok=True)
    # Recompute on every final check, even if an earlier run finished writing receipts.
    # A crash between individual gate outputs can therefore recover without overwriting evidence.
    with tempfile.TemporaryDirectory(prefix='final-check-',dir=output) as scratch:
        fresh=Path(scratch)
        gates=run_science_gates(run,prior,fresh,signed)
        need(all(g['passed'] for g in gates.values()),'FINAL_SIGNED_SCIENTIFIC_GATE_FAILED')
        for label in gates:
            name=label+'-gate.json'
            preserve_or_save(final_output/name,record(fresh,name))
    preserve_or_save(final_output/'gates.json',gates)
    result={'status':'READY_FOR_AUTHORIZED_PUBLICATION','passed':True,'publicationPerformed':False,
            'contentSha256':ch['contentSha256'],'challengeSha256':digest,
            'signedDocumentSha256':file_hash(output,signed.name), 'finalGatesSha256':file_hash(final_output,'gates.json'),
            'verifiedArtifactHashes':ch['inputs'],'reviewHashes':{n:file_hash(reviews,n) for n in ('scientific-review.json','visual-review.json')},
            'verifiedAt':now().isoformat()}
    if (output/'ready.json').exists():
        previous=record(output,'ready.json')
        result['verifiedAt']=previous.get('verifiedAt')
    preserve_or_save(output/'ready.json',result)
    return {'status':result['status'],'contentSha256':ch['contentSha256'],'publicationPerformed':False}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('phase',choices=('prepare','verify'))
    for key in ('run','prior','output','reviews'):
        p.add_argument('--'+key,type=Path,required=key!='reviews')
    args=p.parse_args()
    os.umask(0o077)
    try:
        run,prior=existing_directory(args.run),existing_directory(args.prior)
        output=args.output.resolve()
        need(output!=run and not run.is_relative_to(output) and not output.is_relative_to(prior) and
             not prior.is_relative_to(output) and run!=prior,
             'GATE_DIRECTORY_MUST_BE_SEPARATE')
        if args.phase=='prepare':
            result=prepare(run,prior,output)
        else:
            need(args.reviews is not None,'INDEPENDENT_REVIEWS_REQUIRED')
            reviews=existing_directory(args.reviews)
            result=verify(run,prior,existing_directory(output),reviews)
    except (Hold,baseline.BaselineError) as error:
        print(json.dumps({'passed':False,'status':'HELD','errorCode':str(error),'publicationPerformed':False}))
        return 1
    except (ValueError,TypeError,OSError,KeyError,StopIteration,subprocess.SubprocessError):
        print(json.dumps({'passed':False,'status':'HELD','errorCode':'INPUT_OR_QA_CHECK_FAILED','publicationPerformed':False}))
        return 1
    print(json.dumps(result))
    return 0


if __name__=='__main__':
    sys.exit(main())
