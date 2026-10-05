import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from './_helpers.mjs';
import { createPng, writePng } from '../skills/design-qa/scripts/lib/png.mjs';
import { Evidence, listUnits, resolveUnit } from '../skills/design-qa/scripts/lib/worklist.mjs';
import { writeComparisonReview } from '../skills/design-qa/scripts/lib/comparison-review.mjs';
import { compareFigmaValues } from '../skills/design-qa/scripts/lib/figma-compare.mjs';
import { buildReport } from '../skills/design-qa/scripts/lib/build-report.mjs';
import { makePass, RUN_ID, LOCAL_COMMIT } from './fixtures/build-report-pass/make.mjs';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const write = (p,v) => writeFileSync(p, JSON.stringify(v));
const record = manifest => Object.fromEntries(Object.entries(manifest).filter(([,r])=>r.complete).map(([s,r])=>[s,{digest:r.digest,images:r.images.map(i=>i.path),valuesReviewed:true}]));

test('review covers both widths/heights at 1x, even identical states; no tile cap truncation', t => {
  const dir = tmpDir('comparison-review-'); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(path.join(dir,'evidence'),{recursive:true});
  writePng(path.join(dir,'evidence/app.png'),createPng(650,850));
  writePng(path.join(dir,'evidence/design.png'),createPng(620,810));
  write(path.join(dir,'evidence/compare.json'), {states:{same:{style:[{selector:'node \\| <script>',property:'color',design:'red',app:'blue',result:'FAIL'}]}}});
  const ev = new Evidence(dir);
  const states = writeComparisonReview(ev,[{id:'same',local:'same',prefix:'evidence'}],()=>({app:'evidence/app.png',design:'evidence/design.png'}),[]);
  assert.equal(states.same.images.length,4);
  assert.deepEqual(states.same.images.at(-1).rect,{x:600,y:800,w:50,h:50});
  assert.equal(ev.png(states.same.images[0].path).width,1204);
  const ledger=readFileSync(path.join(dir,states.same.valuesLedger),'utf8');
  assert.ok(ledger.includes('node ' + '\\'.repeat(3) + '| &lt;script&gt;'), ledger);
  assert.ok(!ledger.includes('<script>'));
});

test('report blocks unreviewed/omitted tiles and stale values, allows current complete review', t => {
  const root=tmpDir('comparison-gate-'); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const ws=makePass(root,{compare:{'with-data':{style:[],tokens:[],structure:[],components:[],motion:[]},empty:{style:[],tokens:[],structure:[],components:[],motion:[]}}});
  const ev=new Evidence(ws.dir);
  const states=writeComparisonReview(ev,listUnits(ev),resolveUnit,[]);
  const build = comparisons => buildReport({dir:ws.dir,doc:{findings:[],comparisons},config:read(ws.config),configDir:root,runId:RUN_ID,localCommit:LOCAL_COMMIT});
  assert.match(JSON.stringify(build({}).problems),/inspect every side-by-side tile/);
  const reviewed=record(states);
  assert.equal(build(reviewed).valid,true,JSON.stringify(build(reviewed).problems));
  reviewed['with-data'].images.pop();
  assert.match(JSON.stringify(build(reviewed).problems),/inspect every side-by-side tile/);
  const good=record(states);
  write(path.join(ws.dir,'evidence/compare.json'),{states:{}});
  assert.match(JSON.stringify(build(good).problems),/review evidence changed/);
});

const spec = { source:'rest',nodeId:'1:1',layers:[
  {id:'1:1',name:'Frame',type:'FRAME',depth:0,absoluteBoundingBox:{x:0,y:0,width:300,height:200}},
  {id:'1:2',name:'Title',type:'TEXT',depth:1,characters:'Orders',absoluteBoundingBox:{x:20,y:20,width:100,height:30},style:{fontSize:20,fontWeight:600,fontFamily:'Inter'},fills:[{type:'SOLID',color:{r:1,g:0,b:0}}]}
]};
const app = { audit:{elements:[{i:0,path:'h1',tag:'h1',own:true,text:'Orders',rect:{x:20,y:20,w:100,h:30},s:{'font-size':'24px','font-weight':'600',color:'rgb(0, 0, 255)','padding-top':'0px'}}]} };
test('Figma values compare raw code values with deltas, retain unknowns and geometry',()=>{
  const r=compareFigmaValues({state:'with-data',spec,nodeId:'1:1',app,tolerancePx:1,colorDeltaE:1.5});
  assert.equal(r.style.find(r=>r.property==='font-size').delta,4);
  assert.equal(r.style.find(r=>r.property==='color').result,'FAIL');
  assert.equal(r.style.find(r=>r.property==='padding-top').result,'CANNOT_VERIFY');
  assert.equal(r.style.find(r=>r.property==='width').result,'PASS');
});
test('MCP missing values and coincident ambiguous layers never pass',()=>{
  const missing=compareFigmaValues({state:'with-data',spec:{...spec,source:'mcp',unavailable:['fills','style']},nodeId:'1:1',app});
  assert.ok(missing.style.filter(r=>r.property==='font-size').every(r=>r.result==='CANNOT_VERIFY'));
  const noText={audit:{elements:[{...app.audit.elements[0],text:null,own:false}]}};
  const ambiguous=compareFigmaValues({state:'with-data',spec:{...spec,layers:[...spec.layers,{...spec.layers[1],id:'1:3'}]},nodeId:'1:1',app:noText});
  assert.ok(ambiguous.style.every(r=>r.result==='CANNOT_VERIFY'));
});

test('unverified value rows prevent a pixel-perfect report from PASS',t=>{
  const root=tmpDir('comparison-unknown-');t.after(()=>rmSync(root,{recursive:true,force:true}));
  const rows={style:[{elementClass:'title',index:0,selector:'h1.title',property:'font-size',design:null,app:'24px',result:'CANNOT_VERIFY'}],structure:[],tokens:[],components:[],motion:[]};
  const ws=makePass(root,{compare:{'with-data':rows,empty:rows}});
  const r=buildReport({dir:ws.dir,doc:{findings:[]},config:read(ws.config),configDir:root,runId:RUN_ID,localCommit:LOCAL_COMMIT});
  assert.equal(r.valid,true,JSON.stringify(r.problems));
  assert.notEqual(r.report.scorecard.verdict,'PASS');
  assert.ok(r.report.stateMatrix.filter(r=>['with-data','empty'].includes(r.state)).every(r=>r.result==='CANNOT_VERIFY'));
  assert.ok(r.report.meta.degradations.some(d=>d.step==='value-comparison:with-data'));
});

test('exact MCP value import retains provenance; stale/unrelated values and unknown nodes are rejected', async t=>{
  const {importFigmaValues,validateFigmaValueEvidence}=await import('../skills/design-qa/scripts/figma-values.mjs');
  const root=tmpDir('figma-values-');t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(path.join(root,'context.txt'),'Title font-size 20px font-weight 600; color/primary #ff0000');
  const row={nodeId:'1:2',property:'font-size',value:'20px',source:{file:'context.txt',snippet:'Title font-size 20px font-weight 600'}};
  const imported=importFigmaValues({...spec,source:'mcp',unavailable:['fills','style']},[row],root);
  validateFigmaValueEvidence(imported,root);
  const r=compareFigmaValues({state:'with-data',spec:imported,nodeId:'1:1',app});
  assert.equal(r.style.find(r=>r.property==='font-size').result,'FAIL');
  assert.throws(()=>importFigmaValues(spec,[{...row,nodeId:'9:9'}],root),/unknown Figma node/);
  assert.throws(()=>importFigmaValues(spec,[{...row,value:'88px'}],root),/value evidence absent/);
  assert.throws(()=>importFigmaValues(spec,[{...row,token:'color/other'}],root),/token name/);
  assert.throws(()=>importFigmaValues(spec,[{...row,source:{...row.source,file:'../context.txt'}}],root),/saved source/);
  writeFileSync(path.join(root,'context.txt'),'Title font-size 21px');
  assert.throws(()=>validateFigmaValueEvidence(imported,root),/stale/);
});
