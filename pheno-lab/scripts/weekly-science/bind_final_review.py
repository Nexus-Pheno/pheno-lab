"""Attach explicitly approved per-criterion findings to private review metadata only."""
import copy
import validate_academic_report as academic
import validate_collaborator_report as collaborator
import validate_decision_report as decision
import validate_language_review as language
import validate_rd_document as public

FAMILIES={'academicReview':academic.PEER_CHECKS,'decisionReview':decision.PEER_CHECKS,
          'collaboratorReview':collaborator.PEER_CHECKS,'languageReview':language.CHECKS}
CHECKS=set().union(*FAMILIES.values(),public.MARKS,{'privacyProjectionReviewed'})
PENDING_ERRORS={
    'MISSING_EXPLICIT_REVIEW_MARKS','MISSING_REVIEWER','MISSING_REVIEW_TIME',
    'MISSING_INDEPENDENT_SCIENTIFIC_PEER_REVIEW','SCIENTIFIC_REVIEWER_NOT_INDEPENDENT',
    'SCIENTIFIC_PEER_REVIEW_NOT_APPROVED_OR_EVIDENCED','INVALID_SCIENTIFIC_PEER_REVIEW_TIME',
    'SCIENTIFIC_PEER_REVIEW_DOES_NOT_COVER_ALL_CASES','INCOMPLETE_SCIENTIFIC_PEER_REVIEW_CHECKS',
    'MISSING_SCIENTIFIC_REVIEW_CONCERN_RECORD','MISSING_APPROVED_INDEPENDENT_DECISION_REVIEW',
    'INCOMPLETE_DECISION_SCIENTIFIC_REVIEW_CHECKS','INDEPENDENT_DECISION_REVIEW_HAS_COVERAGE_GAPS',
    'INVALID_DECISION_REVIEW_TIME','MISSING_DECISION_REVIEW_CONCERN_RECORD',
    'MISSING_APPROVED_INDEPENDENT_COLLABORATOR_REVIEW','INCOMPLETE_COLLABORATOR_PEER_CHECKS',
    'INCOMPLETE_COLLABORATOR_PEER_COVERAGE','INVALID_COLLABORATOR_PEER_TIME',
    'MISSING_ACTUAL_INDEPENDENT_LANGUAGE_SCOPE_REVIEW','INVALID_LANGUAGE_REVIEW_TIME',
    'INCOMPLETE_LANGUAGE_REVIEW_COVERAGE','MISSING_CLARITY_OR_SCIENTIFIC_SCOPE_CHECK',
    'MISSING_LANGUAGE_SCOPE_REVIEW_CONCERNS','PRIMARY_POPULATION_OR_DISCLOSURE_POLICY_NOT_EXPLICIT'}


def peer_coverage(doc):
    a,d,c,l=(doc[k] for k in FAMILIES)
    def ids(rows, key):
        return sorted({r[key] for r in rows})
    return {'academicReview':{'reviewedCaseIds':ids(a['coreCases'],'id')},
            'decisionReview':{'reviewedProjectAliases':ids(d['projectReviews'],'projectAlias'),
                              'reviewedExperimentCodes':ids(d['selectedExperiments'],'experimentCode'),
                              'reviewedCauseIds':ids(d['causeReviews'],'id'),'reviewedActionIds':ids(d['validationActions'],'id')},
            'collaboratorReview':{'reviewedCardIds':ids(c['materialCards'],'id'),
                'reviewedExperimentCodes':sorted(set(ids(c['contextReviews'],'experimentCode')) |
                                        {code for card in c['materialCards'] for code in card['sourceExperimentCodes']})},
            'languageReview':{'reviewedExperimentCodes':ids(l['experiments'],'experimentCode')}}


def is_unsigned(doc, as_of):
    for family in FAMILIES:
        peer=doc[family].get('peerReview') or {}
        if (peer.get('status') not in (None,'PENDING','PENDING_REVIEW','PENDING_INDEPENDENT_REVIEW') or
            peer.get('independent') is True or any(v is True for v in (peer.get('checks') or {}).values()) or
            peer.get('concerns') or peer.get('sourceReference')):
            return False
    ev=doc['evidenceMethodReview']
    # The canonical primary validator uses one error code for five conditions.
    # Independently check the four scientific fields before deferring its sole unsigned mark.
    return (not any(v is True for v in (doc['rdReview'].get('reviewMarks') or {}).values()) and
            ev.get('privacyProjectionReviewed') is not True and
            ev.get('selectionScope')=='EXPERIMENT_CURRENT_ACCEPTED_RESULTS_AT_SNAPSHOT' and
            ev.get('primaryEvidenceAsOf')==as_of and ev.get('legacyPeriodPanelsRole')=='SECONDARY_SCAN_MEDIAN_ROBUSTNESS_AND_PERIOD_TRACE' and
            ev.get('conditionDisclosurePolicy')=='NAMED_MATERIAL_DOSE_CARRIER_PROCESS_ONLY')


def may_prepare(gates):
    return all(g['passed'] or bool(g['codes']) and set(g['codes']) <= PENDING_ERRORS for g in gates.values())


def attach(document, receipt):
    doc=copy.deepcopy(document)
    actual=receipt['value']['checks']
    if (len(actual)!=len(CHECKS) or {c['key'] for c in actual}!=CHECKS or
        any(c.get('decision')!='PASS' or len(str(c.get('evidence','')).strip())<12 for c in actual)):
        raise ValueError('Incomplete explicit independent findings')
    checks={c['key']:c['decision']=='PASS' for c in actual}
    coverage=peer_coverage(doc)
    identity='Independent DeepSeek scientific referee '+receipt['completionId']
    source='Final referee request '+receipt['requestHash']+'; response '+receipt['outputHash']
    stamp=receipt['completedAt']
    concerns=[{'severity':'ADVISORY','issue':f['issue'],'resolved':False} for f in receipt['value']['findings']]
    for name,keys in FAMILIES.items():
        doc[name]['peerReview']={'reviewer':identity,'reviewedAt':stamp,'independent':True,
            'sourceReference':source,'status':'APPROVED','concerns':concerns,
            'checks':{k:checks[k] for k in sorted(keys)},**coverage[name]}
    doc['rdReview'].update(reviewedBy=identity,reviewedAt=stamp,reviewMarks={k:checks[k] for k in sorted(public.MARKS)})
    doc['evidenceMethodReview']['privacyProjectionReviewed']=checks['privacyProjectionReviewed']
    return doc
