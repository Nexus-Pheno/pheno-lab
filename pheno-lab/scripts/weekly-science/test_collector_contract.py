#!/usr/bin/env python3
"""Synthetic collector contracts only; no network, DB/COS write or real lab inputs."""
import datetime as dt
import contextlib
import io
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

BASE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('collector', BASE / 'collect_snapshot.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
UTC = dt.timezone.utc
END = dt.datetime(2026, 1, 31, tzinfo=UTC)
NODE = shutil.which('node') or 'node'

RUNNER = r"""
const vm=require('vm'), crypto=require('crypto'), fs=require('fs');
const {source,scenario}=JSON.parse(fs.readFileSync(0,'utf8'));
const d=s=>new Date(s), org='synthetic-org', materialId='synthetic-material-id';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const card={id:materialId,organizationId:org,name:'Synthetic SAM',category:'SAM',lot:'CURRENT-LOT',
  purity:'recorded',supplier:'synthetic',properties:{},archived:false,createdAt:d('2025-10-01T00:00:00Z')};
const result={id:'synthetic-result',metrics:{pce:21},source:'INSTRUMENT',metricPolicy:'BEST',
  sourceMeasurementId:'scan-new',runId:'run-1',capturedAt:d('2026-01-29T00:00:00Z'),
  characterization:{experimentId:'exp-1'}};
const makeExp=(id,code,project,group='A')=>({id,code,title:'Synthetic context',status:'COMPLETED',
  createdAt:d('2026-01-05T00:00:00Z'),updatedAt:d('2026-01-29T00:00:00Z'),
  metadata:{},observation:'',problem:'',hypothesis:'Recorded hypothesis',conclusion:'',
  submittedAt:null,approvedAt:null,submitNote:'',reviewNote:'',project,
  runs:[{id:'run-'+id.slice(-1),runNo:1,status:'CLOSED',createdAt:d('2026-01-05T00:00:00Z')}],
  steps:[{id:'step-'+id,position:0,name:'SAM coat',layer:'HTL',notes:'',environmentConditions:{humidity:'40%'},
    process:{name:'Spin',organizationId:org},equipment:null,environment:null,
    recipe:{id:'recipe-1',organizationId:org,name:'Synthetic recipe',summary:'',
      payload:{components:[{material:'Synthetic precursor',amount:'1 mol/L',role:'precursor'}],solvents:'DMF:DMSO',concentration:'1 mol/L'},
      archived:false,approvalStatus:'APPROVED',createdAt:d('2025-10-01T00:00:00Z'),updatedAt:d('2026-01-29T00:00:00Z')},
    materials:[{amount:'1 mg/mL',position:0,material:card}],
    parameters:[{name:'spin',unit:'rpm',value:'3000',source:'equipment',variations:[]}],
    executions:[{runId:'run-'+id.slice(-1),sampleId:'sample-'+id.slice(-1),actuals:{spin:'3000'},
      environmentConditions:{humidity:'39%'},capturedAt:d('2026-01-29T00:00:00Z'),note:'',flagged:false,
      materialSelections:[{parameterName:'SAM',material:card}]}]}],
  samples:[{id:'sample-'+id.slice(-1),code:'S1',variationGroup:group,note:'',results:id==='exp-1'?[result]:[]}],
  characterizations:[]});
const project={id:'project-1',organizationId:org,name:'Synthetic project',active:true,createdAt:d('2025-10-01T00:00:00Z')};
const exps=[makeExp('exp-1','E-1',project),makeExp('exp-2','E-2',null),makeExp('exp-3','E-3',project,'ERROR')];
exps[1].steps=[];exps[1].samples=[];exps[1].runs=[]; // context without any measurements
const scan=(id,date,received='2026-01-29T00:00:00Z',over={})=>({id,instrumentId:'instrument-1',uploadId:'upload-1',
  experimentId:'exp-1',sampleId:'sample-1',runId:'run-1',status:'MATCHED',condition:'LIGHT',direction:'REVERSE',
  metrics:{pce:21,voc:1.1,jsc:24,ff:79,area:0.1},settings:{speed:'0.1'},
  measuredAt:date?d(date):null,createdAt:d(received),...over});
const scans=[
  scan('scan-old','2025-12-20T00:00:00Z'),
  scan('scan-new','2026-01-29T00:00:00Z'),
  scan('scan-fallback',null),
  scan('scan-period-edge','2026-01-24T00:00:00Z','2026-01-24T00:00:00Z'),
  scan('scan-context-edge','2026-01-01T00:00:00Z'),
  scan('scan-pre-context','2025-12-31T23:59:59Z'),
  scan('scan-error','2026-01-29T00:00:00Z','2026-01-29T00:00:00Z',{experimentId:'exp-3',sampleId:'sample-3',runId:'run-3'}),
  scan('scan-unmatched','2026-01-29T00:00:00Z','2026-01-29T00:00:00Z',{status:'UNMATCHED',sampleId:null,experimentId:null}),
  scan('scan-dark','2026-01-29T00:00:00Z','2026-01-29T00:00:00Z',{condition:'DARK'}),
  scan('scan-too-old','2025-01-01T00:00:00Z'),
  scan('scan-future','2026-02-01T00:00:00Z')
];
const recipients=[{email:'reader@example.test',role:'MANAGER',active:true,pendingApproval:false,testingOnly:false,mustChangePassword:false,reportAccess:true},{email:'technician@example.test',role:'TECHNICIAN',active:true,pendingApproval:false,testingOnly:false,mustChangePassword:false,reportAccess:true}];
const operations=[];
const countModel=()=>({count:async()=>1});
const tx={
  $executeRawUnsafe:async sql=>{operations.push(sql);return 0;},
  $queryRawUnsafe:async sql=>sql.startsWith('SELECT transaction_timestamp')?[{at:d('2026-02-01T00:00:00Z')}]:[{source:'INSTRUMENT',metricPolicy:'BEST',rows:1n,samples:1n,source_linked:1n,run_linked:1n}],
  organization:{findUniqueOrThrow:async()=>({id:org,status:'ACTIVE'})},
  jvMeasurement:{count:async()=>scenario==='scan-overflow'?50001:scans.length,findMany:async()=>scans},
  experiment:{count:async({where})=>where.projectId===null?1:where.OR?exps.length:10,findMany:async()=>exps},
  sample:countModel(),run:countModel(),processStep:countModel(),stepMaterial:countModel(),stepParameter:countModel(),
  parameterVariation:countModel(),stepExecution:countModel(),executionMaterial:countModel(),
  characterization:countModel(),characterizationResult:countModel(),
  labReport:{findMany:async()=>[]},user:{findMany:async query=>{if(query.where.organizationId!==org || query.where.role || !query.where.email.in.includes('technician@example.test') || query.where.email.in.length!==5) throw Error('Recipient scope changed');return recipients;},findFirst:async query=>{
    if (!query.where.chemicalAccess || query.where.email!=='reader@example.test'||query.where.organizationId!==org) throw Error('Grant bypass');
    return scenario==='revoked'?null:{id:'synthetic-granted-actor'};}},
  material:{count:async()=>1,findMany:async()=>[{...card,smiles:'CCO',chemistry:{canonicalSmiles:'CCO',inputSha256:scenario==='stale'?hash('CCN'):hash('CCO'),
    inSamRegistry:true,engineVersion:'Synthetic',version:2,generatedAt:d('2026-01-29T00:00:00Z'),atomCount:3}}]},
  project:{count:async()=>2,findMany:async()=>[
    {...project,_count:{experiments:2}},
    {id:'project-empty',name:'No experimental records',active:true,createdAt:d('2025-10-01T00:00:00Z'),_count:{experiments:0}}
  ]}
};
let output=null,errors=[],exitCode=0;
class PrismaClient {async $transaction(fn,opts){if(opts.isolationLevel!=='RepeatableRead'||opts.timeout!==120000) throw Error('Unsafe transaction');return fn(tx);}async $disconnect(){}}
const sandbox={require:name=>name==='@prisma/client'?{PrismaClient}:name==='crypto'?crypto:require(name),
  process:{env:{REPORT_RECIPIENTS:JSON.stringify(['reader@example.test','technician@example.test','a@example.test','b@example.test','c@example.test']),REPORT_READER_EMAIL:'reader@example.test',REPORT_HISTORY_START:'2025-11-02T00:00:00Z',REPORT_WINDOW_START:'2026-01-01T00:00:00Z',
    REPORT_PERIOD_START:'2026-01-24T00:00:00Z',REPORT_WINDOW_END:'2026-01-31T00:00:00Z',APP_VERSION:'synthetic'},
    get exitCode(){return exitCode;},set exitCode(v){exitCode=v;}},
  console:{log:s=>{output=JSON.parse(s);},error:(...e)=>errors.push(e.join(' '))}};
Promise.resolve(vm.runInNewContext(source,sandbox)).then(()=>{
  console.log(JSON.stringify({snapshot:output,operations,exitCode,errors}));
}).catch(e=>{console.error(e.name);process.exitCode=1;});
"""


def run_synthetic(scenario='normal'):
    shell = (BASE / 'snapshot.sh').read_text()
    source = shell.split("node <<'NODE'\n", 1)[1].rsplit('\nNODE', 1)[0]
    completed = subprocess.run([NODE, '-e', RUNNER], input=json.dumps({'source': source, 'scenario': scenario}),
                               text=True, capture_output=True, timeout=10, check=True)
    return json.loads(completed.stdout)


class WindowContract(unittest.TestCase):
    def test_default_windows_and_existing_cli(self):
        values = collector.window_values(END - dt.timedelta(days=30), END, now=END)
        self.assertEqual(values['REPORT_PERIOD_START'], END - dt.timedelta(days=7))
        self.assertEqual(values['REPORT_HISTORY_START'], END - dt.timedelta(days=90))
        shell = (BASE / 'snapshot.sh').read_text()
        self.assertIn("[ \"$(id -un)\" = 'deploy_pheno_lab' ]", shell)
        self.assertLess(shell.index('Wrong collector identity'), shell.index('DATABASE_URL:?Missing service environment'))

    def test_reject_unbounded_or_misaligned_windows(self):
        for start, period, history in [
            (END-dt.timedelta(days=96), None, None),
            (END-dt.timedelta(days=30), END, None),
            (END-dt.timedelta(days=30), END-dt.timedelta(days=31), None),
            (END-dt.timedelta(days=30), None, END-dt.timedelta(days=367)),
            (END-dt.timedelta(days=30), None, END-dt.timedelta(days=20))]:
            with self.assertRaises(ValueError):
                collector.window_values(start, END, period, history, now=END)
        with self.assertRaises(ValueError):
            collector.window_values(END-dt.timedelta(days=30), END+dt.timedelta(minutes=2), now=END)

    def test_timezone_required(self):
        with self.assertRaises(Exception):
            collector.timestamp('2026-01-31T00:00:00')
        self.assertEqual(collector.timestamp('2026-01-31T08:00:00+08:00'), END)

    def test_private_output_and_exports_inside_local_operator_stdin(self):
        snapshot = {'schemaVersion': 1, 'readOnly': True, 'collectorIdentity': 'deploy_pheno_lab',
                    'truncated': False, 'snapshotAt': '2026-01-31T00:00:00Z',
                    'experimentSummaries': [], 'recentScans': 0, 'historyScans': 0, 'periodEligibleScans': 0,
                    'privateChemistryDefinitions': [{'smiles': 'SYNTHETIC_PRIVATE_VALUE'}]}
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'private' / 'snapshot.json'
            argv = ['collector', '--local-operator', '--start', '2026-01-01T00:00:00Z', '--end', '2026-01-31T00:00:00Z',
                    '--output', str(output)]
            argv += ['--evidence-reader-email', 'reader@example.test']
            for address in ('reader', 'technician', 'a', 'b', 'c'):
                argv.extend(['--recipient-email', address+'@example.test'])
            console = io.StringIO()
            with mock.patch('sys.argv', argv), mock.patch.object(collector.subprocess, 'run') as remote:
                remote.return_value = subprocess.CompletedProcess([], 0, json.dumps(snapshot), '')
                with contextlib.redirect_stdout(console):
                    collector.main()
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(output.parent.stat().st_mode), 0o700)
            self.assertEqual(json.loads(output.read_text()), snapshot)
            self.assertNotIn('SYNTHETIC_PRIVATE_VALUE', console.getvalue())
            self.assertEqual(remote.call_args.args[0], ['bash', '-s'])
            self.assertTrue(remote.call_args.kwargs['input'].startswith('export REPORT_HISTORY_START='))
            self.assertIn('export REPORT_PERIOD_START=', remote.call_args.kwargs['input'])

    def test_existing_snapshot_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'snapshot.json'
            output.write_text('frozen')
            argv = ['collector', '--local-operator', '--start', '2026-01-01T00:00:00Z', '--end', '2026-01-31T00:00:00Z',
                    '--output', str(output)]
            argv += ['--evidence-reader-email', 'reader@example.test']
            for address in ('reader', 'technician', 'a', 'b', 'c'):
                argv.extend(['--recipient-email', address+'@example.test'])
            with mock.patch('sys.argv', argv), mock.patch.object(collector.subprocess, 'run') as remote:
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    collector.main()
                remote.assert_not_called()
            self.assertEqual(output.read_text(), 'frozen')


class SnapshotContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run_synthetic()
        cls.snapshot = cls.result['snapshot']

    def test_only_readonly_transaction_and_disjoint_history(self):
        s = self.snapshot
        self.assertEqual(self.result['exitCode'], 0)
        self.assertEqual(self.result['operations'], ['SET TRANSACTION READ ONLY', "SET LOCAL statement_timeout='30s'"])
        self.assertTrue(s['readOnly'])
        self.assertFalse(s['truncated'])
        self.assertEqual(s['recentScans'], 7)
        self.assertEqual(s['historyScans'], 2)
        self.assertEqual(len(s['sampleMeasurements']), 4)
        self.assertEqual(len(s['historicalSampleMeasurements']), 2)
        current = {r['measurementAlias'] for r in s['sampleMeasurements']}
        history = {r['measurementAlias'] for r in s['historicalSampleMeasurements']}
        self.assertFalse(current & history)
        self.assertEqual(s['periodEligibleScans'], 3)
        self.assertEqual(s['metricUnits']['ff'], '%')

    def test_new_ingestion_is_not_new_measurement(self):
        s = self.snapshot
        old = s['historicalSampleMeasurements'][0]
        self.assertTrue(old['recentIngestion'])
        self.assertFalse(old['isPeriodEvidence'])
        self.assertEqual(old['timeBasis'], 'measured')
        self.assertEqual(s['exclusions']['effectiveDateOutsideHistory'], 2)
        self.assertEqual(s['exclusions']['futureDatedReceipt'], 1)
        self.assertEqual(s['ingestion']['receivedWithMeasurementOutsideHistory'], 1)
        fallback = [r for r in s['sampleMeasurements'] if r['timeBasis'] == 'received']
        self.assertEqual(len(fallback), 1)
        self.assertTrue(fallback[0]['isPeriodEvidence'])
        self.assertFalse(fallback[0]['measuredInPeriod'])

    def test_real_project_and_full_context_inventory(self):
        s = self.snapshot
        self.assertEqual(len(s['experimentSummaries']), 3)
        no_measurement = s['experimentSummaries'][1]
        self.assertIsNone(no_measurement['projectAlias'])
        self.assertFalse(no_measurement['project']['assigned'])
        self.assertEqual(no_measurement['samples'], [])
        empty = next(p for p in s['projectInventory'] if p.get('projectName') == 'No experimental records')
        self.assertEqual(empty['contextCount'], 0)
        self.assertEqual(empty['realExperimentCount'], 0)
        self.assertTrue(empty['assigned'])
        self.assertEqual(s['projectInventory'][-1]['label'], 'UNASSIGNED')
        self.assertIsNone(s['projectInventory'][0]['projectCode'])

    def test_material_identity_recipe_actuals_and_private_hash(self):
        s = self.snapshot
        step = s['experimentSummaries'][0]['steps'][0]
        planned = step['materials'][0]['material']
        actual = step['executions'][0]['materialSelections'][0]['material']
        definition = s['privateChemistryDefinitions'][0]
        self.assertEqual(planned['materialAlias'], actual['materialAlias'])
        self.assertEqual(actual['materialAlias'], definition['materialAlias'])
        self.assertNotEqual(planned['id'], 'synthetic-material-id')
        self.assertFalse(definition['historicalLotVerified'])
        self.assertEqual(step['parameters'][0]['unit'], 'rpm')
        self.assertEqual(step['recipe']['ingredients'][0]['amount'], '1 mol/L')
        self.assertFalse(step['recipe']['historicalActualCompositionVerified'])
        self.assertEqual(step['executions'][0]['actualsBasis'], 'RECORDED_EXECUTION_AT_CAPTURE')
        self.assertEqual(definition['hashValidation']['status'], 'MATCH')
        self.assertTrue(definition['inSamRegistry'])
        self.assertNotIn('structurePath', json.dumps(definition))
        self.assertNotIn('svg', json.dumps(definition))
        self.assertNotIn('id', s['recipientStates'][0])
        self.assertNotIn('curve', json.dumps(s))
        self.assertTrue(s['experimentSummaries'][0]['samples'][0]['results'][0]['sourceLinked'])

    def test_explicit_technician_report_recipient_retains_role_without_private_identity(self):
        state = next(r for r in self.snapshot['recipientStates'] if r['email'] == 'technician@example.test')
        self.assertEqual(state['role'], 'TECHNICIAN')
        self.assertTrue(state['reportAccess'])
        self.assertNotIn('id', state)
        self.assertNotIn('chemicalAccess', state)

    def test_current_quality_flags_and_unverified_batches(self):
        s = self.snapshot
        self.assertEqual(s['quality']['currentErrorExtra'], 1)
        self.assertEqual(s['quality']['unmatched'], 1)
        self.assertTrue(s['evidenceCaveats']['qualityCountersOverlap'])
        for row in s['sampleMeasurements'] + s['historicalSampleMeasurements']:
            self.assertTrue(row['sourceLinked'])
            self.assertEqual(row['independentBatchStatus'], 'UNVERIFIED')
            self.assertEqual(row['areaDefinition'], 'UNVERIFIED')

    def test_revoked_grant_omits_definitions(self):
        s = run_synthetic('revoked')['snapshot']
        self.assertFalse(s['chemistryAccessAvailable'])
        self.assertEqual(s['privateChemistryDefinitions'], [])

    def test_stale_chemistry_never_marked_valid(self):
        definition = run_synthetic('stale')['snapshot']['privateChemistryDefinitions'][0]
        self.assertEqual(definition['hashValidation']['status'], 'MISMATCH')
        self.assertFalse(definition['validatedDefinition'])

    def test_bound_overflow_fails_instead_of_truncates(self):
        r = run_synthetic('scan-overflow')
        self.assertEqual(r['exitCode'], 1)
        self.assertIsNone(r['snapshot'])
        self.assertIn('REPORT_BOUND_EXCEEDED', r['errors'][0])


if __name__ == '__main__':
    unittest.main()
