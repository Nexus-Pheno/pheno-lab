#!/usr/bin/env python3
"""Synthetic checks for the reusable reporting helpers; no real lab fixtures."""
import copy
import datetime as dt
import importlib.util
from pathlib import Path
import unittest


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name+'.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


summary = module('summarize_snapshot')
renderer = module('render_report')
collector = module('collect_snapshot')


def row(sample, pce, **overrides):
    return {'experimentCode':'synthetic-E1','sampleAlias':sample,'runAlias':'synthetic-R1',
            'group':'A','direction':'REVERSE','condition':'LIGHT',
            'metrics':{'pce':pce,'area':1,'voc':1,'jsc':20,'ff':80},'settings':{'speed':1}} | overrides


def snapshot(rows, title='Synthetic experiment'):
    return {'snapshotAt':'2026-10-12T00:00:00Z',
            'experimentSummaries':[{'code':'synthetic-E1','title':title}], 'sampleMeasurements':rows}


class SampleAggregation(unittest.TestCase):
    def test_scans_do_not_inflate_device_weight(self):
        result = summary.summarize(snapshot([row('s1',10)]*9+[row('s2',20)]))['strata'][0]
        self.assertEqual(result['nSamples'],2)
        self.assertEqual(result['nScans'],10)
        self.assertEqual(result['metrics']['pce']['median'],15)

    def test_each_metric_has_its_own_denominator_and_units(self):
        missing = row('s2',20); missing['metrics']['voc'] = None
        result = summary.summarize(snapshot([row('s1',10),missing]))['strata'][0]
        self.assertEqual(result['metrics']['voc']['nSamples'],1)
        self.assertEqual(result['metrics']['pce']['nSamples'],2)
        self.assertEqual(result['metrics']['ff']['median'],80)

    def test_run_direction_area_and_settings_are_separate(self):
        rows = [row('s1',10),row('s2',20,runAlias='r2'),row('s3',20,direction='FORWARD'),
                row('s4',20,settings={'speed':2}),row('s5',20,metrics={'pce':20,'area':2})]
        self.assertEqual(len(summary.summarize(snapshot(rows))['strata']),5)

    def test_exclusions_and_finite_values(self):
        rows = [row('good',20),row('error',20,group='ERROR'),row('extra',20,group='EXTRA'),
                row('dark',20,condition='DARK'),row('high',51),row('low',-1),row('bool',True),row('nan',float('nan'))]
        self.assertEqual(summary.summarize(snapshot(rows))['strata'][0]['nScans'],1)
        self.assertEqual(summary.summarize(snapshot([row('s1',20)],'[test] ingestion'))['strata'],[])

    def test_missing_run_is_unverified(self):
        result=summary.summarize(snapshot([row('s1',20,runAlias=None)]))['strata'][0]
        self.assertTrue(result['missingRun'])
        self.assertFalse(result['runVerified'])


class ReportValidation(unittest.TestCase):
    def setUp(self):
        self.document={'titleEn':'Synthetic validation report','titleZh':'合成验证报告',
          'summaryEn':'Helper validation only.','summaryZh':'仅验证报告工具。',
          'generatedAt':'2026-10-12T04:00:00Z','snapshotAt':'2026-10-12T03:00:00Z',
          'windowStart':'2026-09-12T00:00:00+08:00','windowEnd':'2026-10-12T00:00:00+08:00',
          'sections':[{'id':'evidence','titleEn':'Evidence','titleZh':'证据','bodyEn':'<p>20.00% PCE; 2 samples.</p>', 'bodyZh':'<p>PCE 20.00%；2 个样品。</p>'}]}

    def test_render_preserves_both_languages_and_embeds_brand(self):
        output=renderer.render(self.document)
        self.assertIn('data:image/png;base64,',output)
        self.assertIn('PCE 20.00%；2 个样品。',output)
        self.assertIn('20.00% PCE; 2 samples.',output)
        self.assertIn('2026-10-12 11:00',output)

    def test_missing_translation_duplicate_ids_and_bad_dates_fail(self):
        for change in ('missing','duplicate','naive','reversed'):
            document=copy.deepcopy(self.document)
            if change=='missing': document['sections'][0]['bodyZh']=''
            if change=='duplicate': document['sections']*=2
            if change=='naive': document['snapshotAt']='2026-10-12T03:00:00'
            if change=='reversed': document['windowEnd']=document['windowStart']
            with self.assertRaises(ValueError): renderer.render(document)

    def test_scripts_remote_embeds_and_handlers_fail(self):
        for body in ('<script>alert(1)</script>','<img src="https://example.org/pixel">',
                     '<p onclick="x()">x</p>','<a href="javascript:x()">x</a>',
                     '<svg><image href="https://example.org/pixel"/></svg>'):
            document=copy.deepcopy(self.document);document['sections'][0]['bodyEn']=body
            with self.assertRaises(ValueError): renderer.render(document)

    def test_collector_rejects_timezone_free_timestamp(self):
        with self.assertRaises(Exception): collector.timestamp('2026-10-12T09:00:00')
        self.assertEqual(collector.timestamp('2026-10-12T09:00:00+08:00').utcoffset(),dt.timedelta(hours=8))


if __name__ == '__main__':
    unittest.main()
