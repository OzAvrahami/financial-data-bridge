import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEvidence, economicEvent, printedMoney } from '../../../packages/bridge-core/src/application/financeContract.js';
import { syncTransactionsToFinance } from '../../../packages/bridge-core/src/application/syncTransactionsToFinance.js';
import { FinanceLedger } from '../../../packages/bridge-core/src/infrastructure/financeLedger.js';
import { buildFinancePayload } from '../../../packages/bridge-core/src/application/exportToFinanceSystem.js';
import { runFinanceExport } from '../../../packages/bridge-core/src/application/runFinanceExport.js';
import { loadAppSettings, saveAppSettings } from '../../../packages/bridge-core/src/config/appSettings.js';
import { financeContractVersion, financeV2Streams } from '../../../packages/bridge-core/src/config/financeStreams.js';
const tx = (patch={}) => ({provider:'CAL',providerAccountId:'test',accountId:'Synthetic card',dedupKey:'existing-key',
  status:'completed',merchantName:'Synthetic online',transactionDate:'2026-09-30',chargeDate:'2026-10-01',
  amount:100,currency:'USD',chargeAmount:370,chargeCurrency:'ILS',transactionType:'רגילה',
  raw:{transactionType:'רגילה',amountRaw:'$100.00',chargeAmountRaw:'₪370.00'},...patch});
const streams = [{provider:'cal',providerAccountId:'test',paymentSourceName:'Synthetic card'}];
const response = (status,data) => ({ok:status<300,status,json:async()=>data,text:async()=>JSON.stringify(data)});

test('stream selection validates exact identities without last4/name/account folding', () => {
  const config={v2Streams:streams};
  assert.equal(financeContractVersion(tx(),config),2);
  for(const patch of [{providerAccountId:'other'},{accountId:'synthetic card'},{accountId:'Synthetic card '},{provider:'MAX'}])
    assert.equal(financeContractVersion(tx(patch),config),1);
  for(const v2Streams of [null,{},[...streams,...streams],[{...streams[0],paymentSourceName:' '}],[{...streams[0],extra:1}]]) {
    assert.throws(()=>financeV2Streams({v2Streams}));
  }
  assert.throws(()=>financeV2Streams({contractVersion:2}),/Global v2/);
  assert.equal(financeContractVersion(tx({accountId:'Other 2755'}),{v2Streams:[{...streams[0],paymentSourceName:'Exact 2755'}]}),1);
});

test('one sync routes selected and unselected cards/accounts independently; sent fee stays untouched',async t=>{
  const {args,run}=await setup(t),l=await new FinanceLedger(args.ledgerDir).load('CAL','test');
  l.recordSent('already-sent-fee'); await l.save('CAL','test');
  const rows=[tx(),tx({accountId:'Another card',dedupKey:'other-card'}),
    tx({providerAccountId:'other',accountId:'Third card',dedupKey:'other-account'}),tx({accountId:'Another card',dedupKey:'already-sent-fee'})];
  const bodies=[];const result=await run(rows,async(u,i)=>{bodies.push(JSON.parse(i.body));return response(201,{id:1});});
  assert.equal(result.counts.alreadySent,1);assert.equal(bodies.length,3);
  assert.equal(bodies[0].cal_contract.version,2);assert.equal(bodies[1].cal_contract,undefined);assert.equal(bodies[2].cal_contract,undefined);
  assert.deepEqual(bodies.map(b=>b.external_id),['existing-key','other-card','other-account']);
});

test('v2 registration/unsupported rejections never downgrade after deselection or mark sent',async t=>{
  for(const code of ['cal_registration_required','cal_event_semantics_required']) {
    const {args,run}=await setup(t);const sent=[];
    const transport=async(u,i)=>{sent.push(i.body);return response(422,{error:code});};
    const first=await run([tx()],transport);args.financeConfig.v2Streams=[];
    const next=await run([tx()],transport);
    assert.equal(first.counts.failed,1);assert.equal(next.counts.failed,1);
    assert.equal(sent[0],sent[1]);assert.equal(JSON.parse(sent[1]).cal_contract.version,2);
    const ledger=await new FinanceLedger(args.ledgerDir).load('CAL','test');
    assert.equal(ledger.wasSentSuccessfully('existing-key'),false);assert.equal(ledger.lookup('existing-key').reason,code);
  }
});

test('consumer name collision across accounts stops before any ledger or delivery mutation',async t=>{
  const {args,run}=await setup(t);let calls=0;
  await assert.rejects(run([tx(),tx({providerAccountId:'other',dedupKey:'other'})],()=>{calls++;}),/stream name collision/);
  assert.equal(calls,0);await assert.rejects(readFile(join(args.ledgerDir,'CAL_test.json')),e=>e.code==='ENOENT');
});

test('selection changes cannot rewrite uncertain frozen bodies in either direction',async t=>{
  for(const selectedFirst of [true,false]) {
    const {args,run}=await setup(t);args.financeConfig.v2Streams=selectedFirst?streams:[];const sent=[];
    await run([tx()],async(u,i)=>{sent.push(i.body);throw Error('lost response');});
    args.financeConfig.v2Streams=selectedFirst?[]:streams;
    await run([tx()],async(u,i)=>{sent.push(i.body);return response(202,{financial_posted:false,observation_id:'55',disposition:'pending'});});
    assert.equal(sent[0],sent[1]);assert.equal(Boolean(JSON.parse(sent[1]).cal_contract),selectedFirst);
  }
});

test('file export wrapper preserves mixed-stream selection through the actual exporter',async t=>{
  const bodies=[];
  t.mock.method(globalThis,'fetch',async(u,i)=>{bodies.push(JSON.parse(i.body));return response(201,{id:1});});
  await runFinanceExport({execute:true,transactions:[tx(),tx({accountId:'Other card',dedupKey:'other'})],
    financeConfig:{apiUrl:'https://never-called.invalid',apiKey:'fixture',v2Streams:streams}});
  assert.equal(bodies[0].cal_contract.version,2);assert.equal(bodies[1].cal_contract,undefined);
});
async function setup(t) {
  const dir=await mkdtemp(join(tmpdir(),'bridge-v2-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const args={financeConfig:{enabled:true,v2Streams:streams,apiUrl:'https://never-called.invalid',apiKey:'fixture'},
    ledgerDir:join(dir,'ledger'),reportsDir:join(dir,'reports'),sendDelayMs:0};
  return {args,run:(rows,fetch)=>syncTransactionsToFinance({...args,consideredTransactions:rows},{fetch})};
}
test('printed money preserves decimal digits; original/billing pair and dates remain independent',()=>{
  assert.deepEqual(buildEvidence(tx()).billed,{amount:'370.00',currency:'ILS',scale:2});
  assert.deepEqual(buildEvidence(tx()).original,{amount:'100.00',currency:'USD',scale:2});
  assert.equal(printedMoney('KWD 123456789012345.123').amount,'123456789012345.123');
  assert.equal(printedMoney('12.50'),null);assert.equal(printedMoney('$12.50 ₪'),null);
  assert.equal(printedMoney('₪1,23'),null);
  assert.equal(printedMoney('12.50',{exportIls:true}).currency,'ILS');
  const p=buildFinancePayload(tx(),undefined,2);assert.equal(p.external_id,'existing-key');
  assert.equal(p.date,'2026-09-30');assert.equal(p.charge_date,'2026-10-01');
});
test('event classification uses provider type only, with unknown/refund/part explicit',()=>{
  assert.equal(economicEvent(tx()).basis,'full_purchase');
  assert.equal(economicEvent(tx({transactionType:'',raw:{}})).kind,'unknown');
  assert.equal(economicEvent(tx({transactionType:'זיכוי',raw:{transactionType:'זיכוי'}})).kind,'refund');
  const part=economicEvent(tx({transactionType:'תשלום 1 מתוך 3',raw:{transactionType:'תשלום 1 מתוך 3'}}));
  assert.equal(part.basis,'installment_part');assert.deepEqual(part.installment,{number:1,count:3,purchase_id:null});
  assert.equal(economicEvent(tx({transactionType:'תשלומים',raw:{transactionType:'תשלומים'}})).installment.number,null);
  assert.equal(economicEvent(tx({transactionType:'רגילה',raw:{transactionType:'תשלומים'}})).kind,'unknown');
});
test('payload is on disk before HTTP, lost response retries frozen content after restart',async t=>{
  const {args,run}=await setup(t);const sent=[];
  const first=await run([tx()],async(url,init)=>{
    const stored=JSON.parse(await readFile(join(args.ledgerDir,'CAL_test.json'),'utf8'));
    assert.deepEqual(stored.entries['existing-key'].frozenPayload,JSON.parse(init.body));
    sent.push(init.body);throw Error('lost response');
  });assert.equal(first.counts.failed,1);
  await run([tx({chargeAmount:999,chargeDate:'2026-11-01'})],async(url,init)=>{
    sent.push(init.body);return response(202,{financial_posted:false,observation_id:'55',disposition:'pending'});
  });assert.equal(sent[0],sent[1]);
  const r=await run([tx()],()=>{throw Error('must not resend accepted evidence');});
  assert.equal(r.rows[0].reason,'accepted_pending_review');assert.equal(r.rows[0].financialPosted,false);
  assert.equal(r.rows[0].observationId,'55');
});
test('sent legacy records never resend; uncertain legacy attempts keep legacy format; definite rejection may adopt v2',async t=>{
  const {args,run}=await setup(t);const l=await new FinanceLedger(args.ledgerDir).load('CAL','test');
  l.recordSent('sent');l.recordFailed('uncertain',{apiStatus:null});l.recordFailed('rejected',{apiStatus:422});await l.save('CAL','test');
  const sent=[];await run(['sent','uncertain','rejected'].map(dedupKey=>tx({dedupKey})),async(u,i)=>{sent.push(JSON.parse(i.body));return response(201,{id:1});});
  assert.equal(sent.length,2);assert.equal(sent[0].cal_contract,undefined);assert.equal(sent[1].cal_contract.version,2);
});
test('payload conflict stops automatic retries without changing identity or prior payload',async t=>{
  const {run}=await setup(t);await run([tx()],async()=>response(422,{error:'cal_payload_changed'}));
  const r=await run([tx()],()=>{throw Error('conflict requires review');});
  assert.equal(r.rows[0].reason,'payload_conflict_requires_review');
});
test('corrupt ledger fails closed instead of losing sent history',async t=>{
  const {args,run}=await setup(t);await run([tx()],async()=>response(201,{id:1}));
  await writeFile(join(args.ledgerDir,'CAL_test.json'),'{');
  await assert.rejects(run([tx()],()=>{throw Error('no HTTP');}),/ledger unreadable/);
});

test('contract selection is explicit, defaults to legacy and never persists a key',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-v2-settings-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const configPath=join(dir,'settings.json');
 const settings={daysBack:4,accounts:[{provider:'cal',providerAccountId:'test'}],finance:{enabled:true,apiUrl:'https://never-called.invalid',v2Streams:streams,apiKey:'must-not-persist'}};
 saveAppSettings(settings,{configPath});
 assert.deepEqual(loadAppSettings({configPath}).finance.v2Streams,streams);
 assert.equal((await readFile(configPath,'utf8')).includes('must-not-persist'),false);
 const prior=await readFile(configPath,'utf8');
 assert.throws(()=>saveAppSettings({...settings,finance:{v2Streams:[{...streams[0],paymentSourceName:' '}]}},{configPath}));
 assert.equal(await readFile(configPath,'utf8'),prior);
 delete settings.finance.v2Streams;saveAppSettings(settings,{configPath});
 assert.equal(loadAppSettings({configPath}).finance.v2Streams,undefined);
});

test('frozen legacy FX upgrades only after proven non-acceptance and unchanged envelope',async t=>{
 const {args,run}=await setup(t);args.financeConfig.v2Streams=[];
 let oldBody;await run([tx()],async(u,i)=>{oldBody=JSON.parse(i.body);return response(422,{error:'cal_supported_ils_purchase_required'});});
 args.financeConfig.v2Streams=streams;
 await run([tx()],async(u,i)=>{
  const body=JSON.parse(i.body);assert.equal(body.cal_contract.version,2);const {cal_contract,...legacy}=body;assert.deepEqual(legacy,oldBody);
  const disk=JSON.parse(await readFile(join(args.ledgerDir,'CAL_test.json'),'utf8'));
  assert.deepEqual(disk.entries['existing-key'].rejectedLegacyPayload,oldBody);
  return response(201,{id:1,financial_posted:true});
 });
 const l=new FinanceLedger(args.ledgerDir);l.freeze('changed',oldBody,'old');l.recordFailed('changed',{apiStatus:422,reason:'cal_supported_ils_purchase_required'});
 l.upgradeRejected('changed',{...oldBody,amount:999},{...oldBody,cal_contract:{version:2}},'new');
 assert.deepEqual(l.lookup('changed').frozenPayload,oldBody);
});
