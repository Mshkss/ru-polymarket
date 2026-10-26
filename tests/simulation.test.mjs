import test from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteDatabase} from '../server/database.mjs';
import {createSimulation,scenarioProbability} from '../server/simulation.mjs';
import {PERIOD_MS,readHistory} from '../lib/history.mjs';
import {seedMarket,executeMarketTrade,handleApi} from '../lib/api.mjs';
const mid='metro-spb-2026';
async function conservation(db){
 const users=(await db.prepare('SELECT * FROM users').all()).results;
 for(const user of users){const row=await db.prepare('SELECT SUM(delta_cents) AS total FROM ledger WHERE user_id=?').bind(user.id).first();assert.equal(user.balance_cents,row.total);assert.ok(user.balance_cents>=0);}
 for(const market of (await db.prepare('SELECT * FROM markets').all()).results){
  const holdings=(await db.prepare('SELECT side,SUM(units) AS units FROM positions WHERE market_id=? GROUP BY side').bind(market.id).all()).results;
  for(const side of ['yes','no'])assert.equal(market[side==='yes'?'q_yes':'q_no'],holdings.find(p=>p.side===side)?.units??0);
  const row=await db.prepare('SELECT SUM(delta_cents) AS total FROM ledger WHERE market_id=?').bind(market.id).first();assert.equal(market.reserve_cents,693148-(row.total??0));assert.ok(market.reserve_cents>=0);
 }
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM transaction_guards').first()).n,0);
}
test('price scenario is deterministic, bounded and moves in both directions',()=>{
 for(const id of [mid,'btc-150k-2026']){
  const points=Array.from({length:121},(_,i)=>scenarioProbability(id,i*5000));
  assert.equal(points[0],.5);assert.deepEqual(points,Array.from({length:121},(_,i)=>scenarioProbability(id,i*5000)));
  assert.ok(points.every(p=>p>=.12&&p<=.88));assert.ok(points.some((p,i)=>i>0&&p>points[i-1]+.00001));assert.ok(points.some((p,i)=>i>0&&p<points[i-1]-.00001));
 }
 for(const id of [mid,'btc-150k-2026']){const steps=Array.from({length:361},(_,i)=>scenarioProbability(id,i*5000));assert.ok(Math.max(...steps.slice(1).map((p,i)=>Math.abs(p-steps[i])))<.001,'No artificial multi-point jumps every five seconds');}
 assert.notEqual(scenarioProbability(mid,123000),scenarioProbability('btc-150k-2026',123000));
});
test('scripted trading and period history preserve market accounting',async t=>{
 const db=new SQLiteDatabase();db.migrate();const now=Date.now()-60000;await seedMarket(db,now-600000);
 let simulator=await createSimulation(db,{now,autoStart:false});
 try{
 await t.test('startup provides modeled history and actual funded up/down trades',async()=>{
  const generated=await db.prepare('SELECT COUNT(*) AS n FROM scenario_history').first();assert.ok(generated.n>20000);
  const trades=await db.prepare("SELECT COUNT(*) AS n FROM trades WHERE source='simulation'").first();assert.ok(trades.n>100);
  const moves=(await db.prepare("SELECT probability_before,probability_after FROM trades WHERE source='simulation' AND market_id=? ORDER BY created_at,rowid").bind(mid).all()).results;
  assert.ok(moves.some(p=>p.probability_after>p.probability_before));assert.ok(moves.some(p=>p.probability_after<p.probability_before));
  const leak=await db.prepare("SELECT COUNT(*) AS n FROM trades t JOIN auth_accounts a ON a.user_id=t.user_id WHERE t.source='simulation'").first();assert.equal(leak.n,0);
  const first=await db.prepare('SELECT MIN(created_at) AS ts FROM price_history WHERE market_id=?').bind(mid).first();const reference=await db.prepare('SELECT MAX(created_at) AS ts FROM scenario_history WHERE market_id=?').bind(mid).first();assert.ok(reference.ts<first.ts);
  await conservation(db);
 });
 await t.test('markets trade on independent schedules rather than a shared tick',async()=>{
  const rows=(await db.prepare("SELECT market_id,created_at FROM trades WHERE source='simulation' ORDER BY created_at").all()).results;
  const latest=new Map();for(const row of rows)latest.set(row.market_id,row.created_at);assert.equal(latest.size,12);assert.ok(new Set(latest.values()).size>=10,'Markets should have different last update times');
  const groups=new Map();for(const row of rows){const key=Math.floor(row.created_at/1000);if(!groups.has(key))groups.set(key,new Set());groups.get(key).add(row.market_id);}assert.ok(Math.max(...[...groups.values()].map(set=>set.size))<8,'No synchronized all-market bursts');
 });
 await t.test('every period has exact bounds, chronological samples and full long-range coverage',async()=>{
  for(const [period,duration] of Object.entries(PERIOD_MS)){
   const result=await readHistory(db,mid,period,now);assert.equal(result.rangeEnd,now);if(duration)assert.equal(result.rangeEnd-result.rangeStart,duration);
   assert.ok(result.points.length>2,period);assert.ok(result.points.length<=650,period+': '+result.points.length);assert.ok(result.points.every(p=>p.created_at<=now));
   assert.ok(result.points.every((p,i)=>i===0||p.created_at>=result.points[i-1].created_at));assert.ok(result.points.every(p=>p.probability>=0&&p.probability<=1));
   assert.ok(result.points.every(p=>['market','scenario','simulation'].includes(p.source)));
   if(['1m','3m','all'].includes(period)){assert.ok(result.points[0].created_at<=result.rangeStart+3600000);assert.ok(result.points.at(-1).created_at>=now-10000);}
  }
  const range=await readHistory(db,mid,'3m',now);
  const extrema=await db.prepare(`SELECT MIN(probability) AS low,MAX(probability) AS high FROM (SELECT probability,created_at FROM price_history WHERE market_id=? UNION ALL SELECT probability,created_at FROM scenario_history WHERE market_id=?) WHERE created_at>=? AND created_at<=?`).bind(mid,mid,now-PERIOD_MS['3m'],now).first();
  assert.equal(range.aggregation,'close');assert.ok(range.points.length<=223);assert.ok(Math.min(...range.points.filter(p=>p.created_at>=range.rangeStart).map(p=>p.probability))>=extrema.low);assert.ok(Math.max(...range.points.map(p=>p.probability))<=extrema.high);
 });
 await t.test('a processed time slot and a restart cannot duplicate trades or funding',async()=>{
  const before=await db.prepare('SELECT COUNT(*) AS n FROM trades').first(),refs=await db.prepare('SELECT COUNT(*) AS n FROM scenario_history').first();assert.equal(await simulator.tick(now),0);
  await simulator.close();simulator=await createSimulation(db,{now,autoStart:false});assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM trades').first()).n,before.n);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM scenario_history').first()).n,refs.n);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind='simulation_funding'").first()).n,12);await conservation(db);
 });
 await t.test('upgrading the motion model preserves cash, holdings and actual price history',async()=>{
  const users=await db.prepare('SELECT * FROM users ORDER BY id').all(),positions=await db.prepare('SELECT * FROM positions ORDER BY user_id,market_id,side').all(),actual=await db.prepare('SELECT * FROM price_history ORDER BY id').all();
  await db.prepare('UPDATE market_simulation SET model_version=1').run();await simulator.close();simulator=await createSimulation(db,{now,autoStart:false});
  assert.deepEqual(await db.prepare('SELECT * FROM users ORDER BY id').all(),users);assert.deepEqual(await db.prepare('SELECT * FROM positions ORDER BY user_id,market_id,side').all(),positions);assert.deepEqual(await db.prepare('SELECT * FROM price_history ORDER BY id').all(),actual);assert.equal((await db.prepare('SELECT MIN(model_version) AS version FROM market_simulation').first()).version,2);await conservation(db);
 });
 await t.test('scripted activity does not modify human cash or positions',async()=>{
  const user={id:'human-simulation-check',email:'human@example.test',name:'Человек',isAdmin:true};const response=await handleApi(new Request('http://test.local/api/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),{DB:db},user);assert.equal(response.status,200);
  const quoteResponse=await handleApi(new Request('http://test.local/api/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({marketId:mid,side:'yes',action:'buy',amountCents:100000})}),{DB:db},user);const quote=await quoteResponse.json();assert.equal(quoteResponse.status,200);
  await executeMarketTrade(db,user,{marketId:mid,side:'yes',action:'buy',units:quote.units,marketVersion:quote.marketVersion,cashLimitCents:quote.cashCents,idempotencyKey:crypto.randomUUID()},Date.now());
  const before=await db.prepare('SELECT balance_cents FROM users WHERE id=?').bind(user.id).first();const holding=await db.prepare('SELECT units FROM positions WHERE user_id=? AND market_id=? AND side=?').bind(user.id,mid,'yes').first();
  assert.ok(await simulator.tick(Date.now())>0);assert.equal((await db.prepare('SELECT balance_cents FROM users WHERE id=?').bind(user.id).first()).balance_cents,before.balance_cents);assert.equal((await db.prepare('SELECT units FROM positions WHERE user_id=? AND market_id=? AND side=?').bind(user.id,mid,'yes').first()).units,holding.units);
  const tape=(await db.prepare('SELECT created_at FROM price_history WHERE market_id=? ORDER BY id').bind(mid).all()).results;assert.ok(tape.every((p,i)=>i===0||p.created_at>=tape[i-1].created_at),'A delayed script tick must not be backdated ahead of a human trade');await conservation(db);
 });
 await t.test('closed and expired markets stop moving; settlement remains funded',async()=>{
  const user={id:'human-simulation-check',email:'human@example.test',isAdmin:true};const result=await handleApi(new Request('http://test.local/api/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({marketId:mid,outcome:'yes'})}),{DB:db},user);assert.equal(result.status,200);
  const before=await db.prepare('SELECT version,q_yes,q_no FROM markets WHERE id=?').bind(mid).first();await db.prepare('UPDATE markets SET closes_at=? WHERE id=?').bind(Date.now()-1,'btc-150k-2026').run();const expired=await db.prepare('SELECT version FROM markets WHERE id=?').bind('btc-150k-2026').first();
  await simulator.tick(Date.now()+30000);assert.deepEqual(await db.prepare('SELECT version,q_yes,q_no FROM markets WHERE id=?').bind(mid).first(),before);assert.equal((await db.prepare('SELECT version FROM markets WHERE id=?').bind('btc-150k-2026').first()).version,expired.version);await conservation(db);
 });
 }finally{await simulator.close();db.close();}
});
