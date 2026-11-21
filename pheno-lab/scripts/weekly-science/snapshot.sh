set +x
set -euo pipefail
# Existing deployment shell only; this is not an elevated application runner.
[ "$(id -un)" = 'deploy_pheno_lab' ] || { printf '%s\n' 'Wrong collector identity' >&2; exit 1; }
: "${REPORT_WINDOW_START:?Missing context start}"
: "${REPORT_WINDOW_END:?Missing window end}"
: "${REPORT_PERIOD_START:?Missing period start}"
: "${REPORT_HISTORY_START:?Missing history start}"
: "${DATABASE_URL:?Missing service environment}"
node <<'NODE'
const { PrismaClient } = require('@prisma/client');
const { createHash } = require('crypto');
const db = new PrismaClient();
const start = new Date(process.env.REPORT_WINDOW_START);
const end = new Date(process.env.REPORT_WINDOW_END);
const periodStart = new Date(process.env.REPORT_PERIOD_START);
const historyStart = new Date(process.env.REPORT_HISTORY_START);
const DAY = 86400000, MAX_SCAN_ROWS = 50000, MAX_CONTEXTS = 5000;
const MAX_RELATED_ROWS = 200000;
if (![start,end,periodStart,historyStart].every(x=>Number.isFinite(+x)) ||
    !(historyStart <= start && start <= periodStart && periodStart < end) ||
    end-start > 95*DAY || end-historyStart > 366*DAY) throw new Error('Invalid reporting windows');
const alias = id => id ? createHash('sha256').update('pheno-report-alias-v1:' + id).digest('hex').slice(0,24) : null;
const hash = text => createHash('sha256').update(text).digest('hex');
const finite = x => typeof x === 'number' && Number.isFinite(x);
const between = (value, from, to=end) => value && +value >= +from && +value < +to;
const inWindow = x => between(x,start);
const inPeriod = x => between(x,periodStart);
const object = value => value && typeof value==='object' && !Array.isArray(value) ? value : {};
const metricUnits = {pce:'%',voc:'V',jsc:'mA/cm²',ff:'%',isc:'mA',pmax:'mW',vmax:'V',imax:'mA',rs:'Ω',rsh:'Ω',area:'cm²'};
const materialSelect = {id:true,organizationId:true,name:true,category:true,lot:true,purity:true,supplier:true,
  molecularWeight:true,properties:true,archived:true,createdAt:true};
const resultSelect = {id:true,metrics:true,source:true,metricPolicy:true,sourceMeasurementId:true,runId:true,
  capturedAt:true,characterization:{select:{experimentId:true}}};
function qualityCounters() {
  return {unmatched:0,ignored:0,missingMeasurementTime:0,missingPce:0,nonPositivePce:0,
    pceAbove50:0,negativeRs:0,negativeRsh:0,matchedOutsideEligibleContextOrInvalidSample:0,
    currentErrorExtra:0,titleQuarantined:0,nonLightOrUnlinked:0,eligible:0};
}
function checkBound(label, count, limit=MAX_SCAN_ROWS) {
  if (!Number.isSafeInteger(count) || count<0 || count>limit) {
    const error = new Error('Snapshot bound exceeded'); error.code='REPORT_BOUND_EXCEEDED'; throw error;
  }
  return {label,count,limit};
}
(async()=>{
  const snapshot = await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
    const org = await tx.organization.findUniqueOrThrow({where:{slug:'pheno'},select:{id:true,status:true}});
    if (org.status!=='ACTIVE') throw new Error('Organization is not active');
    const clock = await tx.$queryRawUnsafe('SELECT transaction_timestamp() AS at');
    if (end>clock[0].at) throw new Error('Reporting end is in the future');
    const base = {organizationId:org.id,isTest:false,deletedAt:null};
    const scanWhere = {organizationId:org.id,OR:[
      {measuredAt:{gte:historyStart,lt:end}},
      {measuredAt:null,createdAt:{gte:historyStart,lt:end}},
      // Late receipts can carry older scans. Count that ingestion separately;
      // outcomes outside bounded history are never silently dated as this week.
      {createdAt:{gte:start,lt:end}}
    ]};
    const bounds = [checkBound('measurementCandidates',await tx.jvMeasurement.count({where:scanWhere}))];
    const scans = await tx.jvMeasurement.findMany({where:scanWhere,orderBy:[{createdAt:'asc'},{id:'asc'}],
      take:MAX_SCAN_ROWS+1,select:{id:true,instrumentId:true,uploadId:true,experimentId:true,sampleId:true,
        runId:true,status:true,condition:true,direction:true,metrics:true,settings:true,measuredAt:true,createdAt:true}});
    checkBound('measurementRead',scans.length);
    const ids = [...new Set(scans.flatMap(s=>s.experimentId?[s.experimentId]:[]))];
    const contextWhere = {...base,OR:[{createdAt:{gte:historyStart,lt:end}},
      {updatedAt:{gte:historyStart,lt:end}},{id:{in:ids}}]};
    bounds.push(checkBound('experimentContexts',await tx.experiment.count({where:contextWhere}),MAX_CONTEXTS));
    // Related collections are bounded before any nested enumeration. Exceeding
    // a bound fails the run explicitly instead of silently truncating evidence.
    const checks = [
      ['samples',tx.sample,{experiment:contextWhere}],
      ['runs',tx.run,{experiment:contextWhere}],
      ['steps',tx.processStep,{experiment:contextWhere}],
      ['stepMaterials',tx.stepMaterial,{step:{experiment:contextWhere}}],
      ['stepParameters',tx.stepParameter,{step:{experiment:contextWhere}}],
      ['parameterVariations',tx.parameterVariation,{parameter:{step:{experiment:contextWhere}}}],
      ['executions',tx.stepExecution,{step:{experiment:contextWhere}}],
      ['executionMaterials',tx.executionMaterial,{execution:{step:{experiment:contextWhere}}}],
      ['characterizations',tx.characterization,{experiment:contextWhere}],
      ['characterizationResults',tx.characterizationResult,{OR:[{characterization:{experiment:contextWhere}},{sample:{experiment:contextWhere}}]}],
    ];
    let relatedRows=0;
    for (const [name,model,where] of checks) {
      const count=await model.count({where}); bounds.push(checkBound(name,count)); relatedRows+=count;
    }
    bounds.push(checkBound('relatedRowsTotal',relatedRows,MAX_RELATED_ROWS));
    const experiments = await tx.experiment.findMany({where:contextWhere,orderBy:[{createdAt:'desc'},{id:'asc'}],
      take:MAX_CONTEXTS+1,select:{id:true,code:true,title:true,status:true,createdAt:true,updatedAt:true,
        metadata:true,observation:true,problem:true,hypothesis:true,conclusion:true,
        submittedAt:true,approvedAt:true,submitNote:true,reviewNote:true,
        project:{select:{id:true,organizationId:true,name:true,active:true,createdAt:true}},
        runs:{orderBy:{runNo:'asc'},select:{id:true,runNo:true,status:true,createdAt:true}},
        steps:{orderBy:{position:'asc'},select:{id:true,position:true,name:true,layer:true,notes:true,
          environmentConditions:true,process:{select:{name:true,organizationId:true}},
          equipment:{select:{name:true,nickname:true,organizationId:true}},
          environment:{select:{name:true,organizationId:true}},
          recipe:{select:{id:true,organizationId:true,name:true,summary:true,payload:true,archived:true,
            approvalStatus:true,createdAt:true,updatedAt:true}},
          materials:{orderBy:{position:'asc'},select:{amount:true,position:true,material:{select:materialSelect}}},
          parameters:{orderBy:{position:'asc'},select:{name:true,unit:true,value:true,source:true,
            variations:{select:{variationGroup:true,value:true}}}},
          executions:{select:{runId:true,sampleId:true,actuals:true,environmentConditions:true,capturedAt:true,
            note:true,flagged:true,materialSelections:{select:{parameterName:true,material:{select:materialSelect}}}}}}},
        samples:{orderBy:{code:'asc'},select:{id:true,code:true,variationGroup:true,note:true,
          results:{select:resultSelect}}},
        characterizations:{orderBy:{position:'asc'},select:{id:true,name:true,settings:true,environmentConditions:true,
          sampleScope:true,notes:true,results:{where:{sampleId:null},select:resultSelect}}}
      }});
    checkBound('experimentRead',experiments.length,MAX_CONTEXTS);
    const expMap=new Map(experiments.map(e=>[e.id,e]));
    const sampleMap=new Map(experiments.flatMap(e=>e.samples.map(s=>[s.id,{...s,experimentId:e.id}])));
    const runMap=new Map(experiments.flatMap(e=>e.runs.map(r=>[r.id,e.id])));
    const quarantine=new Set(experiments.filter(e=>/^\s*\[test\]/i.test(e.title)).map(e=>e.id));
    function projectOf(e) {
      const p=e.project?.organizationId===org.id?e.project:null;
      return {projectAlias:alias(p?.id),name:p?.name??null,code:null,assigned:!!p,active:p?.active??null,
        assignmentBasis:'CURRENT_EXPLICIT_PROJECT_RELATION',metadataBasis:'CURRENT_AT_SNAPSHOT',
        projectLinkStatus:e.project&&!p?'CROSS_ORGANIZATION_EXCLUDED':p?'ASSIGNED':'UNASSIGNED'};
    }
    function materialOf(m) {
      if (!m||m.organizationId!==org.id) return {id:null,materialAlias:null,name:null,category:null,
        metadataBasis:'CROSS_ORGANIZATION_EXCLUDED'};
      const {id,organizationId,...fields}=m;
      return {...fields,id:alias(id),materialAlias:alias(id),metadataBasis:'CURRENT_AT_SNAPSHOT',
        historicalLotVerified:false};
    }
    function recipeOf(r) {
      if (!r||r.organizationId!==org.id) return null;
      const {id,organizationId,...fields}=r;
      const payload=object(r.payload);
      return {...fields,recipeAlias:alias(id),ingredients:Array.isArray(payload.components)?payload.components:[],
        ingredientLinkBasis:'RECORDED_TEXT_NOT_RELATIONAL_MATERIAL_IDS',metadataBasis:'CURRENT_AT_SNAPSHOT',
        historicalActualCompositionVerified:false};
    }
    function resultOf(r,experimentId) {
      const {id,runId,sourceMeasurementId,characterization,...fields}=r;
      return {...fields,resultAlias:alias(id),runAlias:alias(runId),sourceLinked:!!sourceMeasurementId,
        sourceMeasurementAlias:alias(sourceMeasurementId),
        sourceTier:r.source==='INSTRUMENT'?(sourceMeasurementId?'SOURCE_LINKED_INSTRUMENT_SUMMARY':'UNLINKED_INSTRUMENT_SUMMARY'):'MANUAL_OR_IMPORTED_SUMMARY',
        contextLinkStatus:characterization?.experimentId===experimentId?'SAME_EXPERIMENT':'UNVERIFIED',
        metricUnitsStatus:'SUMMARY_KEYS_REQUIRE_SOURCE_UNIT_REVIEW',independentBatchStatus:'UNVERIFIED'};
    }
    const quality=qualityCounters(),historyQuality=qualityCounters(),periodQuality=qualityCounters();
    const sampleMeasurements=[],historicalSampleMeasurements=[];
    const ingestion={receivedInContext:0,receivedInPeriod:0,receivedWithEarlierMeasurementInPeriod:0,
      receivedWithMeasurementOutsideHistory:0,receivedFutureDated:0,eligibleReceivedInPeriod:0};
    const exclusions={effectiveDateOutsideHistory:0,futureDatedReceipt:0,missingEffectiveDate:0};
    for (const scan of scans) {
      const effectiveAt=scan.measuredAt||scan.createdAt;
      const current=inWindow(effectiveAt),historic=between(effectiveAt,historyStart,start),period=inPeriod(effectiveAt);
      if (inWindow(scan.createdAt)) ingestion.receivedInContext++;
      if (inPeriod(scan.createdAt)) {
        ingestion.receivedInPeriod++;
        if (scan.measuredAt && scan.measuredAt<periodStart) ingestion.receivedWithEarlierMeasurementInPeriod++;
      }
      if (inWindow(scan.createdAt)&&scan.measuredAt<historyStart&&scan.measuredAt) ingestion.receivedWithMeasurementOutsideHistory++;
      if (inWindow(scan.createdAt)&&scan.measuredAt>=end) {ingestion.receivedFutureDated++;exclusions.futureDatedReceipt++;}
      if (!effectiveAt) {exclusions.missingEffectiveDate++;continue;}
      if (!current&&!historic) {exclusions.effectiveDateOutsideHistory++;continue;}
      const counters=[current?quality:historyQuality,...(period?[periodQuality]:[])];
      const m=object(scan.metrics),sample=sampleMap.get(scan.sampleId),experiment=expMap.get(scan.experimentId);
      const linked=scan.status==='MATCHED'&&experiment&&sample&&sample.experimentId===experiment.id;
      for (const q of counters) {
        q.unmatched+=scan.status==='UNMATCHED';q.ignored+=scan.status==='IGNORED';
        q.missingMeasurementTime+=!scan.measuredAt;q.missingPce+=!finite(m.pce);
        q.nonPositivePce+=finite(m.pce)&&m.pce<=0;q.pceAbove50+=finite(m.pce)&&m.pce>50;
        q.negativeRs+=finite(m.rs)&&m.rs<0;q.negativeRsh+=finite(m.rsh)&&m.rsh<0;
        q.matchedOutsideEligibleContextOrInvalidSample+=scan.status==='MATCHED'&&!linked;
      }
      if (!linked||scan.condition!=='LIGHT') {counters.forEach(q=>q.nonLightOrUnlinked++);continue;}
      if (['ERROR','EXTRA'].includes(sample.variationGroup)) {counters.forEach(q=>q.currentErrorExtra++);continue;}
      if (quarantine.has(experiment.id)) {counters.forEach(q=>q.titleQuarantined++);continue;}
      if (!finite(m.pce)||m.pce<0||m.pce>50) continue;
      const project=projectOf(experiment);
      const row={measurementAlias:alias(scan.id),instrumentAlias:alias(scan.instrumentId),uploadAlias:alias(scan.uploadId),
        experimentCode:experiment.code,projectAlias:project.projectAlias,projectName:project.name,projectCode:null,
        sampleAlias:alias(scan.sampleId),sampleCode:sample.code,runAlias:alias(scan.runId),
        runLinkStatus:scan.runId?(runMap.get(scan.runId)===experiment.id?'SAME_EXPERIMENT':'UNVERIFIED'):'MISSING',
        independentBatchStatus:'UNVERIFIED',sourceLinked:true,sourceTier:'SOURCE_LINKED_INSTRUMENT_SCAN',
        group:sample.variationGroup,direction:scan.direction,condition:scan.condition,metrics:m,settings:scan.settings,
        measuredAt:scan.measuredAt,receivedAt:scan.createdAt,effectiveAt,timeBasis:scan.measuredAt?'measured':'received',
        measuredInPeriod:!!scan.measuredAt&&inPeriod(scan.measuredAt),receivedInPeriod:inPeriod(scan.createdAt),
        isPeriodEvidence:period,recentIngestion:inPeriod(scan.createdAt),
        areaDefinition:'UNVERIFIED',currentFlagBasis:'CURRENT_AT_SNAPSHOT'};
      (current?sampleMeasurements:historicalSampleMeasurements).push(row);
      counters.forEach(q=>q.eligible++);
      if (inPeriod(scan.createdAt)) ingestion.eligibleReceivedInPeriod++;
    }
    const sources=await tx.$queryRawUnsafe(`SELECT z.source,z."metricPolicy",count(*) AS rows,
      count(DISTINCT z."sampleId") AS samples,count(*) FILTER(WHERE z."sourceMeasurementId" IS NOT NULL) AS source_linked,
      count(*) FILTER(WHERE z."runId" IS NOT NULL) AS run_linked FROM "CharacterizationResult" z
      JOIN "Characterization" c ON c.id=z."characterizationId" JOIN "Experiment" e ON e.id=c."experimentId"
      WHERE e."organizationId"=$1 AND NOT e."isTest" AND e."deletedAt" IS NULL GROUP BY 1,2`,org.id);
    const reportMetadata=await tx.labReport.findMany({where:{organizationId:org.id,
      publicationKey:{startsWith:'materials-process-'}},orderBy:{publishedAt:'desc'},take:12,
      select:{id:true,publicationKey:true,titleEn:true,titleZh:true,generatedAt:true,publishedAt:true,contentSha256:true,contentBytes:true}});
    const emails=JSON.parse(process.env.REPORT_RECIPIENTS);
    if (!Array.isArray(emails)||emails.length!==5||new Set(emails).size!==5||!emails.includes(process.env.REPORT_READER_EMAIL))
      throw new Error('Invalid reporting roster');
    const recipients=await tx.user.findMany({where:{organizationId:org.id,email:{in:emails}},
      select:{email:true,role:true,active:true,pendingApproval:true,testingOnly:true,mustChangePassword:true,reportAccess:true}});
    const chemistryActor=await tx.user.findFirst({where:{organizationId:org.id,email:process.env.REPORT_READER_EMAIL,
      chemicalAccess:true,active:true,pendingApproval:false,testingOnly:false,mustChangePassword:false,
      role:{in:['ADMIN','MANAGER']}},select:{id:true}});
    let privateChemistryDefinitions=[];
    if (chemistryActor) {
      const chemistryWhere={organizationId:org.id,archived:false};
      bounds.push(checkBound('privateMaterialDefinitions',await tx.material.count({where:chemistryWhere}),10000));
      const materials=await tx.material.findMany({where:chemistryWhere,take:10001,orderBy:{id:'asc'},
        select:{...materialSelect,smiles:true,chemistry:{select:{canonicalSmiles:true,inputSha256:true,inSamRegistry:true,
          engineVersion:true,version:true,generatedAt:true,atomCount:true}}}});
      checkBound('privateMaterialDefinitionRead',materials.length,10000);
      privateChemistryDefinitions=materials.map(m=>{
        const definition=typeof m.smiles==='string'?m.smiles:'';
        const currentInputSha256=hash(definition);
        const status=!definition?'NO_DEFINITION':!m.chemistry?'NO_EVIDENCE':
          m.chemistry.inputSha256===currentInputSha256?'MATCH':'MISMATCH';
        const {smiles,chemistry,...card}=m;
        return {...materialOf(card),smiles:definition,chemistry,
          inSamRegistry:!!chemistry?.inSamRegistry,
          hashValidation:{status,currentInputSha256,evidenceInputSha256:chemistry?.inputSha256??null},
          validatedDefinition:status==='MATCH',historicalLotVerified:false,
          definitionBasis:'CURRENT_DEFINITION_NOT_HISTORICAL_LOT_PROOF'};
      });
    }
    bounds.push(checkBound('organizationProjects',await tx.project.count({where:{organizationId:org.id}}),MAX_CONTEXTS));
    const projects=await tx.project.findMany({where:{organizationId:org.id},take:MAX_CONTEXTS+1,
      orderBy:{name:'asc'},select:{id:true,name:true,active:true,createdAt:true,
        _count:{select:{experiments:{where:base}}}}});
    checkBound('organizationProjectRead',projects.length,MAX_CONTEXTS);
    const summaries=experiments.map(e=>{
      const project=projectOf(e);
      return {code:e.code,title:e.title,status:e.status,createdAt:e.createdAt,updatedAt:e.updatedAt,
        newInWindow:inWindow(e.createdAt),updatedInWindow:inWindow(e.updatedAt),
        newInPeriod:inPeriod(e.createdAt),updatedInPeriod:inPeriod(e.updatedAt),
        projectAlias:project.projectAlias,projectName:project.name,projectCode:null,project,
        metadataBasis:'CURRENT_AT_SNAPSHOT',qualityReview:quarantine.has(e.id),
        observation:e.observation,problem:e.problem,hypothesis:e.hypothesis,conclusion:e.conclusion,
        metadata:e.metadata,submittedAt:e.submittedAt,approvedAt:e.approvedAt,submitNote:e.submitNote,reviewNote:e.reviewNote,
        runs:e.runs.map(({id,...r})=>({...r,runAlias:alias(id),independentBatchStatus:'UNVERIFIED'})),
        steps:e.steps.map(({id,recipe,materials,executions,process,equipment,environment,...s})=>({...s,stepAlias:alias(id),
          process:process?.organizationId===org.id?{name:process.name}:null,
          equipment:equipment?.organizationId===org.id?{name:equipment.name,nickname:equipment.nickname}:null,
          environment:environment?.organizationId===org.id?{name:environment.name}:null,
          recipe:recipeOf(recipe),materials:materials.map(x=>({...x,material:materialOf(x.material)})),
          metadataBasis:'CURRENT_PLAN_AT_SNAPSHOT',executions:executions.map(({runId,sampleId,materialSelections,...x})=>({...x,
            runAlias:alias(runId),sampleAlias:alias(sampleId),actualsBasis:'RECORDED_EXECUTION_AT_CAPTURE',
            materialSelections:materialSelections.map(m=>({...m,material:materialOf(m.material)}))}))})),
        characterizations:e.characterizations.map(({id,results,...c})=>({...c,characterizationAlias:alias(id),
          unassignedSampleResults:results.map(r=>resultOf(r,e.id))})),
        samples:e.samples.map(({id,results,...s})=>({...s,sampleAlias:alias(id),currentFlagBasis:'CURRENT_AT_SNAPSHOT',
          results:results.map(r=>resultOf(r,e.id))}))};
    });
    const projectContexts=projects.map(p=>({projectAlias:alias(p.id),projectName:p.name,projectCode:null,
      active:p.active,createdAt:p.createdAt,assigned:true,contextCount:summaries.filter(e=>e.projectAlias===alias(p.id)).length,
      realExperimentCount:p._count.experiments,metadataBasis:'CURRENT_AT_SNAPSHOT'}));
    projectContexts.push({projectAlias:null,projectName:null,projectCode:null,assigned:false,
      label:'UNASSIGNED',contextCount:summaries.filter(e=>e.projectAlias===null).length,
      realExperimentCount:await tx.experiment.count({where:{...base,projectId:null}})});
    return {schemaVersion:1,readOnly:true,collectorIdentity:'deploy_pheno_lab',truncated:false,
      snapshotAt:clock[0].at,windowStart:start,contextStart:start,windowEnd:end,periodStart,historyStart,
      release:process.env.APP_VERSION,recentScans:scans.filter(s=>inWindow(s.measuredAt||s.createdAt)).length,
      historyScans:scans.filter(s=>between(s.measuredAt||s.createdAt,historyStart,start)).length,
      periodScans:scans.filter(s=>inPeriod(s.measuredAt||s.createdAt)).length,
      scannedCandidates:scans.length,periodEligibleScans:periodQuality.eligible,quality,historyQuality,periodQuality,
      ingestion,exclusions,bounds,metricUnits,metricUnitBasis:'src/lib/instruments/types.ts normalized scan contract',
      totalRealActiveRecords:await tx.experiment.count({where:base}),
      newExperiments:experiments.filter(e=>inWindow(e.createdAt)).length,
      updatedExperiments:experiments.filter(e=>inWindow(e.updatedAt)).length,
      newPeriodExperiments:experiments.filter(e=>inPeriod(e.createdAt)).length,
      updatedPeriodExperiments:experiments.filter(e=>inPeriod(e.updatedAt)).length,
      experimentSummaries:summaries,sampleMeasurements,historicalSampleMeasurements,projectContexts,projectInventory:projectContexts,
      historicalResultSources:sources,reportMetadata,recipientStates:recipients,
      chemistryAccessAvailable:!!chemistryActor,privateChemistryDefinitions,
      chemistryClassification:'PRIVATE_CHEMISTRY_DO_NOT_PUBLISH',
      evidenceCaveats:{historicalInterval:'historicalSampleMeasurements [historyStart,contextStart); sampleMeasurements [contextStart,windowEnd)',
        historyCompleteWithinBounds:true,qualityCountersOverlap:true,independentManufacturingBatches:'UNVERIFIED',
        metadata:'Plans, project membership, sample flags, material cards and chemistry are current at snapshotAt; not historical reconstruction.',
        actuals:'Recorded execution actuals/conditions remain distinct from current plans; recipe payload is not captured actual composition.',
        chemistry:'Hash-valid graph definitions do not prove historical lot, purity, supplied identity or causal performance.',
        lateReceipt:'A new receipt is ingestion activity, not new manufacture; older-than-history or future-dated outcomes are counted but excluded.'}};
  },{isolationLevel:'RepeatableRead',timeout:120000});
  console.log(JSON.stringify(snapshot,(_,v)=>typeof v==='bigint'?Number(v):v));
})().catch(e=>{console.error('Read-only report snapshot failed:',e.code||e.name);process.exitCode=1;}).finally(()=>db.$disconnect());
NODE
