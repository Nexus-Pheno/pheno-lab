"""A fresh manuscript cannot publish on structural checks or recycled model approvals."""
import copy
import datetime as dt
import unittest

import check_ready as gate
import audit_device_results as audit
import bind_final_review as bind


class GateTests(unittest.TestCase):
    def test_missing_reviewer_can_be_prepared_but_substantive_or_runtime_failures_cannot(self):
        self.assertTrue(bind.may_prepare({'x':{'passed':False,'codes':{'MISSING_CLARITY_OR_SCIENTIFIC_SCOPE_CHECK':1}}}))
        for codes in ({}, {'UNKNOWN_OR_REPEATED_PRIMARY_GROUP_COMPARISON':1}, {'UNRESOLVED_SCIENTIFIC_PEER_REVIEW_BLOCKER':1}):
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
        for field, value in (('canaryReceived','000000'),('images',[]),('images',[reply,reply])):
            bad=copy.deepcopy(review);bad['batches'][0][field]=value
            with self.assertRaises(gate.Hold):
                gate.visual_receipt(bad,challenge)
        with self.assertRaisesRegex(gate.Hold,'INCOMPLETE_VISUAL_REVIEW'):
            gate.visual_receipt(review,{'images':[file,{'file':'qa/zh-page-1.png','sha256':'1'*64}]})

    def test_independent_device_arithmetic_uses_each_quantity_and_denominator(self):
        self.assertEqual(audit.metric_values({'Voc (V)':'1.00','Efficiency (%)':21,'fill factor (%)':80}),
                         {'pce':21,'voc':1.0,'ff':80})
        self.assertEqual(audit.summary([]), None)
        x=audit.summary([21,23,25])
        self.assertEqual((x['mean'],x['best'],x['sd'],x['iqr'],x['n']), (23,25,2,2,3))
        self.assertIsNone(audit.summary([22])['sd'])


if __name__=='__main__':
    unittest.main()
