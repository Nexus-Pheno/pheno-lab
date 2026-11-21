"""A fresh manuscript cannot publish on structural checks or recycled model approvals."""
import copy
import datetime as dt
import unittest
import tempfile
from pathlib import Path

import check_ready as gate
import audit_device_results as audit
import bind_final_review as bind


class GateTests(unittest.TestCase):
    def test_missing_reviewer_can_be_prepared_but_substantive_or_runtime_failures_cannot(self):
        self.assertTrue(bind.may_prepare({'x':{'passed':False,'codes':{'MISSING_CLARITY_OR_SCIENTIFIC_SCOPE_CHECK':1}}}))
        self.assertTrue(bind.may_prepare({'public':{'passed':False,'codes':{'PUBLIC_GATE_MISSING_REVIEW_TIME':1}}}))
        for codes in ({}, {'PUBLIC_GATE_INVALID_CONTENT':1},{'UNKNOWN_OR_REPEATED_PRIMARY_GROUP_COMPARISON':1}, {'UNRESOLVED_SCIENTIFIC_PEER_REVIEW_BLOCKER':1}):
            self.assertFalse(bind.may_prepare({'x':{'passed':False,'codes':codes}}))

    def test_scientific_approval_without_real_provider_response_is_rejected(self):
        with self.assertRaisesRegex(gate.Hold,'UNBOUND'):
            gate.scientific_receipt({'approved':True}, {}, {})

    def test_partial_or_failed_explicit_criteria_cannot_create_legacy_marks(self):
        rows=[{'key':k,'decision':'PASS','evidence':'A specific synthetic comparison.'} for k in bind.CHECKS]
        for mistaken in (rows[:-1],rows+[rows[0]],[dict(r,decision='BLOCK') for r in rows]):
            with self.assertRaisesRegex(ValueError,'explicit'):
                bind.attach({}, {'value':{'checks':mistaken}})

    def test_prior_signoff_or_stamp_before_challenge_is_rejected(self):
        now=dt.datetime.now(dt.timezone.utc)
        ch={'challenge':'7'*64,'contentSha256':'5'*64,'createdAt':now.isoformat()}
        receipt={'schemaVersion':1,'challenge':'7'*64,'contentSha256':'5'*64,'challengeSha256':'4'*64,
                 'completedAt':(now-dt.timedelta(seconds=1)).isoformat()}
        with self.assertRaisesRegex(gate.Hold,'TIME_OUTSIDE'):
            gate.response_bind(receipt,ch,'4'*64)
        receipt['completedAt']=now.isoformat()
        receipt['challenge']='9'*64
        with self.assertRaisesRegex(gate.Hold,'STALE_OR_UNBOUND'):
            gate.response_bind(receipt,ch,'4'*64)

    def test_visual_approval_checks_exact_pages_charts_and_correct_random_canary(self):
        file={'file':'qa/en-page-1.png','sha256':'a'*64}
        challenge={'images':[file]}
        reply={'file':file['file'],'sha256':file['sha256'],'decision':'PASS','defects':[],
               'observation':'The synthetic plot and legend are readable.'}
        batch={'requestHash':'b'*64,'responseHash':'c'*64,'responseId':'fixture-reply','canaryExpected':'290713',
               'canaryReceived':'290713','images':[reply]}
        review={'role':'visual','model':'deepseek-flash','batches':[batch]}
        self.assertEqual(gate.visual_receipt(review,challenge),{'fixture-reply'})
        held=copy.deepcopy(review)
        held['batches'][0]['images'][0].update(decision='BLOCK',defects=['A genuinely clipped axis.'])
        with self.assertRaisesRegex(gate.Hold,'UNRESOLVED_VISUAL_FINDING'):
            gate.visual_receipt(held,challenge)
        with tempfile.TemporaryDirectory() as temp:
            reviews=Path(temp)
            (reviews/'visual-findings.json').write_text('{}')
            with self.assertRaisesRegex(gate.Hold,'ORIGINAL_VISUAL_BLOCK_OMITTED'):
                gate.visual_receipt(review,challenge,reviews=reviews)

        for field, value in (('canaryReceived','000000'),('images',[]),('images',[reply,reply])):
            bad=copy.deepcopy(review);bad['batches'][0][field]=value
            with self.assertRaises(gate.Hold):
                gate.visual_receipt(bad,challenge)
        with self.assertRaisesRegex(gate.Hold,'INCOMPLETE_VISUAL_REVIEW'):
            gate.visual_receipt(review,{'images':[file,{'file':'qa/zh-page-1.png','sha256':'1'*64}]})

    def test_challenge_has_eight_viewports_all_chart_figures_and_prints_without_long_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve()
            qa=root/'qa'
            qa.mkdir(mode=0o700)
            rows=[]; pages={}; expected=set()
            def artifact(name,data=b'synthetic'):
                path=qa/name;path.write_bytes(data);path.chmod(0o600)
                return gate.file_hash(qa,name)
            for lang in ('en','zh'):
                for width in (1440,1024,390,320):
                    for mode in ('offline','app-equivalent-csp-sandbox'):
                        rows.append(dict(lang=lang,width=width,mode=mode,chartCount=2,
                            photographedCharts=2,photographedFigures=1,cspViolations=0,cspConsoleErrors=0,opaqueOrigin=True,
                            parentAccessBlocked=True,storageBlocked=True,matchesOfflinePaintFontsGeometryAndLabels=True))
                    rows[-2]['height']=700
                    name=f'{lang}-{width}.png'
                    png=bytes.fromhex('89504e470d0a1a0a0000000d49484452')+width.to_bytes(4,'big')+(700).to_bytes(4,'big')
                    rows[-2]['fullPageCapture']={'width':width,'height':700,'strips':[
                        {'name':name,'top':0,'height':700,'sha256':artifact(name,png)}]}
                    gate.check_complete_capture(qa,rows[-2])
                    broken=copy.deepcopy(rows[-2]);broken['fullPageCapture']['strips'][0]['top']=1
                    with self.assertRaisesRegex(gate.Hold,'GAP_OR_CHANGED'):
                        gate.check_complete_capture(qa,broken)
                    incomplete=copy.deepcopy(rows[-2]);incomplete['fullPageCapture']['height']=701
                    with self.assertRaisesRegex(gate.Hold,'INCOMPLETE'):
                        gate.check_complete_capture(qa,incomplete)
                    name=f'{lang}-{width}-viewport.png'; artifact(name);expected.add('qa/'+name)
                    if width in (390,1440):
                        name=f'{lang}-{width}-csp-chart-1.png'; artifact(name);expected.add('qa/'+name)
                name=f'{lang}-page-1.png'
                pages[lang]={'pdfSha256':artifact(lang+'-print.pdf'),'pages':[{'image':name,'imageSha256':artifact(name)}]}
                expected.add('qa/'+name)
            gate.save_new(qa/'verification.json',{'passed':True,'cases':rows,'renderedPrintPages':{'en':1,'zh':1}})
            gate.save_new(qa/'print-pages.json',{'allPagesRendered':True,'languages':pages})
            found={row['file'] for row in gate.images_for_review(root)}
            self.assertEqual(found,expected)
            self.assertEqual(sum(name.endswith('-viewport.png') for name in found),8)
            self.assertEqual(len(found),14)

    def test_independent_device_arithmetic_uses_each_quantity_and_denominator(self):
        self.assertEqual(audit.metric_values({'Voc (V)':'1.00','Efficiency (%)':21,'fill factor (%)':80}),
                         {'pce':21,'voc':1.0,'ff':80})
        self.assertEqual(audit.summary([]), None)
        x=audit.summary([21,23,25])
        self.assertEqual((x['mean'],x['best'],x['sd'],x['iqr'],x['n']), (23,25,2,2,3))
        self.assertIsNone(audit.summary([22])['sd'])


if __name__=='__main__':
    unittest.main()
