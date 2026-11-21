"""Project only the authorized scientific context for selected weekly cases."""
import argparse
from collections import Counter, defaultdict
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
from prepare import read, save, date


def scientific_text(value):
    if value is None:
        return ''
    if not isinstance(value,str):
        value=json.dumps(value,ensure_ascii=False,separators=(',',':'))
    # Scientific narratives may incidentally quote contact info or internal IDs.
    value=re.sub(r'https?://\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?<!\w)c[a-z0-9]{22,30}(?!\w)|(?<!\d)1[3-9]\d{9}(?!\d)','[redacted]',value)
    if len(value)>12000:
        raise ValueError('Scientific context exceeds the per-field bound; review case scope')
    return value


def reviewed_article(article):
    return {'id':article['paper'],'doi':article['doi'],'title':article['title'],
            'abstract':scientific_text(re.sub('<[^>]*>',' ',article['abstract']))}


def build(root):
    snapshot=read(root/'snapshot.json')
    packet=read(root/'provider-packet.json')
    bindings=read(root/'bindings.private.json')
    articles=read(root/'article-refresh.json')
    desc=read(root/'private-chemistry-descriptors.json')
    if date(desc['snapshotAt'])!=date(snapshot['snapshotAt']) or not desc['chemistryAccessAvailable'] or not snapshot['chemistryAccessAvailable']:
        raise ValueError('Fresh authorized private chemistry context missing')
    descmap={x['materialAlias']:x for x in desc['materials']}
    definitions={m['materialAlias']:m for m in snapshot['privateChemistryDefinitions']}
    summaries={e['code']:e for e in snapshot['experimentSummaries']}
    app={e['experimentCode']:e['evidence'] for e in snapshot['sharedAppEvidence']['experiments']}
    cases=[]
    case_bindings={}
    for row in packet['cases']:
        bind=bindings['cases'][row['id']]
        s=summaries[bind['code']]
        e=app[bind['code']]
        if e['sourceHash']!=bind['sourceHash']:
            raise ValueError('Private scientific source binding changed')
        labels={label:alias for alias,label in bind['groups'].items()}
        conditions=[]
        for c in e['conditions']:
            for label,actual in c['actualByGroup'].items():
                if label not in labels: continue
                counts=Counter((scientific_text(x['value']),bool(x.get('retrospective')),bool(x.get('flagged'))) for x in actual['records'])
                conditions.append({'name':scientific_text(c['parameterName']), 'unit':scientific_text(c.get('unit')),
                    'step':scientific_text(c.get('process')), 'layer':scientific_text(c.get('layer')),'group':labels[label],
                    'planned':scientific_text((c.get('plannedValues') or {}).get(label)),
                    'recorded':[{'value':v,'retrospective':r,'flagged':f,'count':n} for (v,r,f),n in counts.items()],
                    'plannedDevices':actual['nPlannedSamples'],'recordedDevices':actual['nRecordedSamples'],'status':actual['status']})
        association=defaultdict(set)
        name_matches=defaultdict(set)
        for ma,definition in definitions.items():
            name_matches[definition['name']].add(ma)
        def link_material(material,basis):
            if isinstance(material,dict):
                ident=material.get('materialAlias')
                if ident in definitions: association[ident].add(basis)
            elif isinstance(material,str) and len(name_matches.get(material,()))==1:
                alias=next(iter(name_matches[material]))
                association[alias].add('exact-mention-only')
        recipes={}
        for step in s['steps']:
            for selection in step.get('materials',[]):
                link_material(selection.get('material'),'selected-in-plan')
            for execution in step.get('executions',[]):
                for selection in execution.get('materialSelections',[]):
                    link_material(selection.get('material'),'selected-in-execution')
            r=step.get('recipe')
            if not r: continue
            rid=r['recipeAlias']
            if rid in recipes: continue
            payload=r.get('payload') or {}
            ingredients=[]
            for ing in r['ingredients']:
                mat=ing.get('material')
                link_material(mat,'recipe-ingredient')
                name=mat.get('name') if isinstance(mat,dict) else mat
                if name: ingredients.append({'name':scientific_text(name),'role':scientific_text(ing.get('role')),'amount':scientific_text(ing.get('amount'))})
            recipes[rid]={'id':'R'+str(len(recipes)+1),'name':scientific_text(r['name']),'current':True,
                'solvents':scientific_text(payload.get('solvents')),'context':scientific_text(payload.get('composition')),
                'ingredients':ingredients}
        text=' '.join(scientific_text(s.get(k)) for k in ('title','observation','problem','hypothesis','conclusion'))
        search=text+' '+json.dumps(conditions,ensure_ascii=False)
        for name,aliases in name_matches.items():
            if not name or len(name)<3 or len(aliases)!=1: continue
            if re.search(r'(?<![a-zA-Z0-9-])'+re.escape(name)+r'(?![a-zA-Z0-9-])',search):
                association[next(iter(aliases))].add('exact-mention-only')
        materials=[]
        mat_ids={}
        for ma,assoc in sorted(association.items()):
            m=definitions[ma]
            graph=None
            chem=m.get('chemistry') or {}
            descriptor=descmap.get(ma) or {}
            if m.get('validatedDefinition') and (m.get('hashValidation') or {}).get('status')=='MATCH':
                raw=m['smiles']
                if hashlib.sha256(raw.encode()).hexdigest()!=chem['inputSha256'] or descriptor.get('status')!='VALIDATED_CURRENT_GRAPH' or descriptor.get('name')!=m['name'] or descriptor.get('definitionVersion')!=chem['version'] or date(descriptor['generatedAt'])!=date(chem['generatedAt']):
                    raise ValueError('Case-specific graph/descriptor binding mismatch')
                graph={'input':raw,'hash':chem['inputSha256'],'version':chem['version'],'generatedAt':chem['generatedAt'],
                    'descriptor':descriptor['descriptors'],'motifs':descriptor['motifCounts']}
            ident='M'+str(len(materials)+1)
            mat_ids[ident]=ma
            materials.append({'id':ident,'name':m['name'],'category':scientific_text(m.get('category')),
                'association':sorted(assoc),'graph':graph})
        test=(s.get('metadata') or {}).get('testPlan') or {}
        prospective=[{'group':labels[g['label']],'declaredControl':g.get('isControl')} for g in test.get('groups',[]) if g.get('label') in labels] if isinstance(test,dict) else []
        cases.append({'experiment':row['id'],'sourceHash':e['sourceHash'],'title':scientific_text(s['title']),
            'observation':scientific_text(s.get('observation')),'question':scientific_text(s.get('problem')),'hypothesis':scientific_text(s.get('hypothesis')),
            'conclusion':scientific_text(s.get('conclusion')),'testPlan':scientific_text(prospective),
            'conditions':conditions,'recipes':list(recipes.values()),'actualCaptures':any(st.get('executions') for st in s['steps']),
            'materials':materials,'recordedGroups':[{'id':alias,'label':label} for label,alias in labels.items()]})
        case_bindings[row['id']]={'materials':mat_ids,'recipes':{v['id']:k for k,v in recipes.items()}}
    dossier=read(root/'rd-dossier.json')
    historical=dossier['ledgerEntries']
    followups=[]
    for case in cases:
        case_id=case['experiment']
        code=bindings['cases'][case_id]['code']
        matched=[r for r in historical if code in r.get('evidenceIdentifiers',[])]
        # Keep the full append-only ledger in the dossier. Only the most recent
        # source-linked hypotheses of each current case enter the bounded packet.
        ordered=sorted(matched,key=lambda r:((r.get('history') or [{}])[-1].get('reviewedAt') or '',r['entryId']),reverse=True)
        lookup={}
        for item in ordered[:12]:
            key='H'+str(len(followups)+1)
            followups.append({'id':key,'experiment':case_id,'statement':scientific_text(item['statement']),
                'status':item['status'],'revision':item['revision']})
            lookup[key]={'entryId':item['entryId'],'expectedRevision':item['revision']}
        case_bindings[case_id]['ledger']=lookup
        case_bindings[case_id]['omittedSourceLinkedPriorEntries']=max(0,len(matched)-12)
    return {'cases':cases,'articles':[reviewed_article(a) for a in articles],'followupRecords':followups},case_bindings


def main(root):
    facts,bindings=build(root)
    save(root/'private-scientific-facts.json',facts)
    save(root/'private-science-bindings.json',bindings)
    print('Prepared bounded scientific facts for '+str(len(facts['cases']))+' cases. Raw accounts and sample records excluded.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run',type=Path)
    main(parser.parse_args().run.resolve())
