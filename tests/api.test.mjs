import test from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteDatabase} from '../server/database.mjs';
import {handleApi} from '../lib/api.mjs';
const A={id:'test-alice',email:'alice@example.test',name:'Alice',isAdmin:true},B={id:'test-bob',email:'bob@example.test',name:'Bob'};
const mid='metro-spb-2026';
const db=new SQLiteDatabase();db.migrate();
const env={DB:db};
async function call(path,user=A,input,method=input?'POST':'GET'){
 const req=new Request('https://test.local/api/'+path,{method,headers:input?{'Content-Type':'application/json','Origin':'https://test.local'}:{},body:input?JSON.stringify(input):undefined});
 const res=await handleApi(req,env,user);return {status:res.status,...await res.json()};
}
async function reset(){await db.batch(['transaction_guards','bookmarks','ledger','trades','positions','price_history','users','markets'].map(table=>db.prepare(`DELETE FROM ${table}`)));await call('bootstrap',A,{});await call('bootstrap',B,{});}
async function quote(user,side,amount=100000){const q=await call('quote',user,{side,action:'buy',amountCents:amount});assert.equal(q.status,200,JSON.stringify(q));return q;}
const order=q=>({marketId:mid,side:q.side,action:q.action,units:q.units,marketVersion:q.marketVersion,cashLimitCents:q.cashCents,idempotencyKey:crypto.randomUUID()});
async function invariants(){
 const market=await db.prepare('SELECT * FROM markets WHERE id=?').bind(mid).first();
 const holdings=await db.prepare('SELECT side,SUM(units) AS units FROM positions GROUP BY side').all();
 for(const side of ['yes','no'])assert.equal(market[side==='yes'?'q_yes':'q_no'],holdings.results.find(p=>p.side===side)?.units??0);
 const users=await db.prepare('SELECT * FROM users').all();
 for(const u of users.results){const l=await db.prepare('SELECT SUM(delta_cents) AS total FROM ledger WHERE user_id=?').bind(u.id).first();assert.equal(u.balance_cents,l.total);assert.ok(u.balance_cents>=0);}
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM transaction_guards').first()).n,0);
 const system=await db.prepare("SELECT SUM(delta_cents) AS net FROM ledger WHERE kind != 'welcome'").first();
 assert.equal(market.reserve_cents,693148-(system.net??0));assert.ok(market.reserve_cents>=0);
}
test('SQLite-backed market integration',async t=>{
 try{
 await t.test('separate accounts, initial credit once, real price and history, portfolio persistence',async()=>{
  await reset();const initial=await call('bootstrap',A,{});assert.equal(initial.user.balanceCents,1000000);assert.equal(initial.user.isAdmin,true);assert.equal(initial.markets[0].probability,.5);
  const q=await quote(A,'yes');const trade=await call('trades',A,order(q));assert.equal(trade.status,200,JSON.stringify(trade));
  const alice=await call('state',A),bob=await call('state',B);assert.equal(alice.positions[0].units,q.units);assert.equal(bob.positions.length,0);assert.equal(bob.user.balanceCents,1000000);assert.ok(bob.markets[0].probability>.5);
  assert.equal(alice.user.balanceCents,1000000-q.cashCents);
  const fresh=await call('bootstrap',A,{});assert.equal(fresh.user.balanceCents,alice.user.balanceCents);
  const h=await call('history',B);assert.equal(h.points.length,2);assert.equal(h.points[1].probability,trade.trade.probability_after);
  const before=bob.markets[0].probability;const qB=await quote(B,'no');await call('trades',B,order(qB));assert.ok((await call('state',A)).markets[0].probability<before);
  await invariants();
 });
 await t.test('idempotent retries and simultaneous duplicate submission charge only once',async()=>{
  await reset();const q=await quote(A,'yes'),o=order(q);const results=await Promise.all([call('trades',A,o),call('trades',A,o)]);assert.ok(results.every(r=>r.status===200),JSON.stringify(results));
  const again=await call('trades',A,o);assert.equal(again.replayed,true);assert.equal((await call('state',A)).trades.length,1);assert.equal((await call('history',A)).points.length,2);await invariants();
 });
 await t.test('simultaneous users: one stale quote is rejected without partial updates',async()=>{
  await reset();const qa=await quote(A,'yes'),qb=await quote(B,'no');const results=await Promise.all([call('trades',A,order(qa)),call('trades',B,order(qb))]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const state=await call('state',A);assert.equal(state.markets[0].version,1);assert.equal((await call('history',A)).points.length,2);await invariants();
 });
 await t.test('selling holdings restores state, cannot sell someone else’s shares or overdraw',async()=>{
  await reset();const q=await quote(A,'yes');await call('trades',A,order(q));
  const noHolding=await call('quote',B,{side:'yes',action:'sell',units:q.units});assert.equal(noHolding.status,400);
  const sq=await call('quote',A,{side:'yes',action:'sell',units:q.units});assert.equal(sq.status,200);const sale=await call('trades',A,order(sq));assert.equal(sale.status,200,JSON.stringify(sale));
  const s=await call('state',A);assert.equal(s.positions.length,0);assert.equal(s.markets[0].probability,.5);assert.ok(s.user.balanceCents<=1000000&&s.user.balanceCents>=999998);
  assert.equal((await call('quote',A,{side:'yes',action:'buy',amountCents:2000000})).status,400);
  const invalid=await call('trades',B,{...order(q),units:-100});assert.notEqual(invalid.status,200);await invariants();
 });
 await t.test('server ignores forged balances and identities; protected profile and cross-origin writes',async()=>{
  await reset();assert.equal((await call('state',null)).status,401);
  assert.equal((await call('profile',A,{displayName:'Алиса',balanceCents:999999999,id:B.id},'PATCH')).status,200);
  assert.equal((await call('state',A)).user.displayName,'Алиса');assert.equal((await call('state',A)).user.balanceCents,1000000);assert.equal((await call('state',B)).user.displayName,'Bob');
  const response=await handleApi(new Request('https://test.local/api/profile',{method:'PATCH',headers:{'Content-Type':'application/json',Origin:'https://evil.test'},body:JSON.stringify({displayName:'Hacker'})}),env,A);assert.equal(response.status,403);
  await call('bookmark',A,{saved:true});assert.equal((await call('state',A)).bookmarks.length,1);assert.equal((await call('state',B)).bookmarks.length,0);await invariants();
 });
 await t.test('settlement pays winners once, losers receive zero, market cannot reopen',async()=>{
  await reset();const qa=await quote(A,'yes');await call('trades',A,order(qa));const qb=await quote(B,'no');await call('trades',B,order(qb));
  const beforeA=(await call('state',A)).user.balanceCents,beforeB=(await call('state',B)).user.balanceCents;
  assert.equal((await call('resolve',B,{outcome:'yes'})).status,403);
  assert.equal((await call('resolve',A,{outcome:'yes'})).status,200);
  const winner=await call('state',A),loser=await call('state',B);assert.equal(winner.user.balanceCents,beforeA+qa.units*10);assert.equal(loser.user.balanceCents,beforeB);assert.equal(winner.markets[0].status,'resolved');
  assert.equal((await call('resolve',A,{outcome:'yes'})).replayed,true);assert.equal((await call('state',A)).user.balanceCents,winner.user.balanceCents);
  assert.equal((await call('resolve',A,{outcome:'no'})).status,409);assert.equal((await call('quote',A,{side:'no',action:'buy',amountCents:10000})).status,409);
  const h=await call('history',A);assert.equal(h.points.at(-1).probability,1);await invariants();
 });
 await t.test('expired market rejects new orders and settlement races cannot lose funds',async()=>{
  await reset();const q=await quote(A,'yes'),o=order(q);const responses=await Promise.all([call('trades',A,o),call('resolve',A,{outcome:'yes'})]);
  assert.ok(responses.every(r=>[200,409].includes(r.status)),JSON.stringify(responses));
  let s=await call('state',A);if(s.markets[0].status==='open')await call('resolve',A,{outcome:'yes'});
  s=await call('state',A);const trade=s.trades[0];assert.equal(s.user.balanceCents,trade?1000000-trade.cash_cents+trade.units*10:1000000);await invariants();
  await reset();await db.prepare('UPDATE markets SET closes_at=0 WHERE id=?').bind(mid).run();assert.equal((await call('quote',A,{side:'yes',action:'buy',amountCents:1000})).status,409);
 });
 }finally{db.close();}
});
