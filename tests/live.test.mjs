import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../server/app.mjs';
import {handleApi,executeMarketTrade} from '../lib/api.mjs';
import {liveSnapshot} from '../lib/live.mjs';

async function openStream(base){
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),7000);timer.unref();
 const response=await fetch(base+'/api/stream',{signal:controller.signal});const reader=response.body.getReader();let buffer='';
 return {response,async next(predicate=()=>true){for(;;){const cut=buffer.indexOf('\n\n');if(cut>=0){const frame=buffer.slice(0,cut);buffer=buffer.slice(cut+2);const line=frame.split('\n').find(l=>l.startsWith('data: '));if(line){const value=JSON.parse(line.slice(6));if(predicate(value))return value;}continue;}const chunk=await reader.read();if(chunk.done)throw new Error('Stream ended');buffer+=new TextDecoder().decode(chunk.value);}},async close(){clearTimeout(timer);controller.abort();await reader.cancel().catch(()=>{});}};
}
test('public stream delivers actual quote changes and trades to multiple guests without account data',async t=>{
 const app=await createApplication();await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;let first,second;
 try{
 const user={id:'private-stream-user',email:'private@example.test',name:'Private name',isAdmin:false};
 await handleApi(new Request(base+'/api/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),{DB:app.db},user);
 first=await openStream(base);assert.equal(first.response.status,200);assert.match(first.response.headers.get('content-type'),/text\/event-stream/);assert.equal(first.response.headers.get('x-accel-buffering'),'no');const initial=await first.next();assert.equal(initial.markets.length,12);assert.equal(initial.trades.length,0);
 const response=await handleApi(new Request(base+'/api/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({marketId:'metro-spb-2026',side:'yes',action:'buy',amountCents:10000})}),{DB:app.db},user);const quote=await response.json();assert.equal(response.status,200);
 await executeMarketTrade(app.db,user,{...quote,marketVersion:quote.marketVersion,cashLimitCents:quote.cashCents,idempotencyKey:crypto.randomUUID()},Date.now());
 // A newly connected client must not consume the old client's pending trade.
 second=await openStream(base);const joined=await second.next();assert.equal(joined.trades.length,1);
 const changed=await first.next(value=>value.trades.length>0);assert.equal(changed.trades[0].marketId,'metro-spb-2026');assert.equal(changed.trades[0].side,'yes');assert.equal(changed.trades[0].source,'user');assert.ok(changed.markets.find(m=>m.id==='metro-spb-2026').probability>initial.markets.find(m=>m.id==='metro-spb-2026').probability);
 const publicJSON=JSON.stringify(changed);for(const privateValue of [user.id,user.email,'Private name','balance_cents','user_id','password','session'])assert.ok(!publicJSON.includes(privateValue),privateValue);
 const snapshot=await (await fetch(base+'/api/live')).json();assert.deepEqual(snapshot.trades,changed.trades);assert.equal((await liveSnapshot(app.db,snapshot.trades[0].sequence)).trades.length,0);
 await first.close();first=null;await second.close();second=null;
 const before=(await app.db.prepare('SELECT COUNT(*) AS n FROM users').first()).n;const anonymous=await fetch(base+'/api/live');assert.equal(anonymous.headers.get('set-cookie'),null);assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM users').first()).n,before);
 }finally{await first?.close();await second?.close();await app.close();}
});
