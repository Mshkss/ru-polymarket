import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {createApplication} from '../server/app.mjs';
import {provisionAdmin} from '../server/admin.mjs';
const execute=promisify(execFile);
const origin='http://test.local';
const password='a-long-test-password-42';
const folder=await mkdtemp(join(tmpdir(),'ishod-http-'));
const databasePath=join(folder,'app.sqlite');
let app,base;
async function launch(){app=await createApplication({databasePath,origin,secureCookies:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;}
async function call(path,{body,cookie,method=body?'POST':'GET',headers={}}={}){
 const res=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json',Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});
 const text=await res.text();let value;try{value=JSON.parse(text);}catch{value=text;}
 return {status:res.status,body:value,headers:res.headers,cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
const registration=email=>({email,password,displayName:'Участник'});
let aliceCookie,bobCookie,aliceId,aliceBalance;
const order=q=>({marketId:q.marketId,side:q.side,action:q.action,units:q.units,marketVersion:q.marketVersion,cashLimitCents:q.cashCents,idempotencyKey:crypto.randomUUID()});
test('standalone HTTP authentication, trading and persistent storage',async t=>{
 await launch();
 try{
 await t.test('health, static files and unauthenticated requests',async()=>{
  assert.equal((await call('/healthz')).status,200);assert.equal((await call('/healthz',{method:'HEAD'})).body,'');
  const page=await call('/');assert.equal(page.status,200);assert.ok(page.body.includes('authForm'));assert.ok(!page.body.includes('signin-with-chatgpt'));
  assert.equal((await call('/api/state')).status,401);
  assert.equal((await call('/api/state',{headers:{'oai-authenticated-user-id':'forged','oai-authenticated-user-email':'admin@test.local'}})).status,401);
  assert.equal((await call('/server/auth.mjs')).status,404);
 });
 await t.test('guests can browse every event, history and buy estimate without creating an account',async()=>{
  const catalog=await call('/api/markets');assert.equal(catalog.status,200);assert.equal(catalog.body.markets.length,12);
  assert.equal((await call('/api/session')).body.authenticated,false);
  for(const m of catalog.body.markets){
   assert.ok(!['reserve_cents','q_yes','q_no','email','balance_cents'].some(k=>k in m));
   const detail=await call('/api/markets/'+m.id);assert.equal(detail.status,200);assert.equal(detail.body.market.id,m.id);assert.ok(detail.body.market.rules.length>50);assert.ok(detail.body.market.sourceUrl.startsWith('https://'));
   const h=await call('/api/history?marketId='+m.id);assert.equal(h.status,200);assert.equal(h.body.points.length,1);assert.equal(h.body.points[0].probability,.5);
   const q=await call('/api/quote?marketId='+m.id+'&side=yes&amountCents=100000');assert.equal(q.status,200);assert.equal(q.body.marketId,m.id);assert.equal(q.body.balanceAfterCents,null);assert.ok(q.body.probabilityAfter>.5);
  }
  assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM users').first()).n,0);assert.equal((await app.db.prepare('SELECT COUNT(*) AS n FROM trades').first()).n,0);
  const font=await call('/fonts/InterVariable.woff2');assert.equal(font.status,200);assert.equal(font.headers.get('content-type'),'font/woff2');
 });
 await t.test('opening public reads does not open private data or write actions',async()=>{
  for(const endpoint of ['state','quote','trades','profile','resolve','bookmark','bootstrap']){
   const r=await call('/api/'+endpoint,endpoint==='state'?{}:{body:{},method:endpoint==='profile'?'PATCH':'POST'});assert.equal(r.status,401,endpoint);
  }
  assert.equal((await call('/api/markets/not-a-market')).status,404);assert.equal((await call('/api/history?marketId=not-a-market')).status,404);assert.equal((await call('/api/history?period=bad')).status,400);
 });
 await t.test('email registration, password hashing, cookie session, no client role escalation',async()=>{
  const a=await call('/api/auth/register',{body:{...registration('Alice@Example.test'),isAdmin:true,role:'admin',balanceCents:9999999}});assert.equal(a.status,201,JSON.stringify(a.body));aliceCookie=a.cookie;
  assert.match(a.headers.get('set-cookie'),/HttpOnly/);assert.match(a.headers.get('set-cookie'),/SameSite=Lax/);
  const state=await call('/api/bootstrap',{cookie:aliceCookie,body:{}});assert.equal(state.status,200);aliceId=state.body.user.id;assert.equal(state.body.user.email,'alice@example.test');assert.equal(state.body.user.balanceCents,1000000);assert.equal(state.body.user.isAdmin,false);
  const account=await app.db.prepare('SELECT * FROM auth_accounts WHERE user_id=?').bind(aliceId).first();assert.match(account.password_hash,/^scrypt-v1\$/);assert.ok(!account.password_hash.includes(password));assert.equal(account.role,'user');
  const session=await app.db.prepare('SELECT token_hash FROM sessions').first();assert.notEqual(session.token_hash,aliceCookie.split('=')[1]);
  assert.equal((await call('/api/resolve',{cookie:aliceCookie,body:{outcome:'yes'}})).status,403);
  assert.equal((await call('/api/auth/register',{body:registration('alice@example.test')})).status,409);
  assert.equal((await call('/api/auth/register',{body:{...registration('weak@example.test'),password:'123'}})).status,400);
  const b=await call('/api/auth/register',{body:registration('bob@example.test')});assert.equal(b.status,201);bobCookie=b.cookie;
 });
 await t.test('actual market quote, order, price history and user isolation over HTTP',async()=>{
  const q=await call('/api/quote',{cookie:aliceCookie,body:{side:'yes',action:'buy',amountCents:100000}});assert.equal(q.status,200);assert.ok(q.body.probabilityAfter>.5);assert.ok(q.body.cashCents<=100000);
  const request=order(q.body);const result=await call('/api/trades',{cookie:aliceCookie,body:request});assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal((await call('/api/trades',{cookie:aliceCookie,body:request})).body.replayed,true);
  const state=await call('/api/state',{cookie:aliceCookie});aliceBalance=state.body.user.balanceCents;assert.equal(state.body.positions.length,1);assert.equal(state.body.trades.length,1);
  const b=await call('/api/bootstrap',{cookie:bobCookie,body:{}});assert.equal(b.body.positions.length,0);assert.equal(b.body.user.balanceCents,1000000);assert.equal(b.body.markets[0].probability,state.body.markets[0].probability);
  const history=await call('/api/history',{cookie:bobCookie});assert.equal(history.body.points.length,2);
 });
 await t.test('profile persists, cross-origin writes fail, invalid payloads fail',async()=>{
  assert.equal((await call('/api/profile',{cookie:aliceCookie,method:'PATCH',body:{displayName:'Алиса'}})).status,200);
  const csrf=await call('/api/profile',{cookie:aliceCookie,method:'PATCH',body:{displayName:'Другой'},headers:{Origin:'https://evil.test'}});assert.equal(csrf.status,403);
  assert.equal((await call('/api/auth/login',{body:registration('alice@example.test'),headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await call('/api/auth/register',{body:{email:'x'.repeat(9000)}})).status,413);
  assert.equal((await call('/api/state',{cookie:aliceCookie})).body.user.displayName,'Алиса');
 });
 await t.test('database, trading history and sessions survive process restart',async()=>{
  await app.close();await launch();const state=await call('/api/state',{cookie:aliceCookie});assert.equal(state.status,200);assert.equal(state.body.user.balanceCents,aliceBalance);assert.equal(state.body.positions.length,1);assert.equal(state.body.trades.length,1);assert.equal(state.body.user.displayName,'Алиса');
 });
 await t.test('consistent live SQLite backup contains account and trades',async()=>{
  const destination=join(folder,'snapshot.sqlite');await execute(process.execPath,['server/backup.mjs',destination],{cwd:new URL('../',import.meta.url),env:{...process.env,DATABASE_PATH:databasePath}});
  const backup=new DatabaseSync(destination,{readOnly:true});try{assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM trades').get().n,1);assert.equal(backup.prepare('SELECT balance_cents FROM users WHERE id=?').get(aliceId).balance_cents,aliceBalance);}finally{backup.close();}
 });
 await t.test('a trade affects only its own event, and guests see its real history',async()=>{
  const before=(await call('/api/markets')).body.markets;const original=before.find(m=>m.id==='metro-spb-2026');const second=before.find(m=>m.id==='btc-150k-2026');
  const q=await call('/api/quote',{cookie:bobCookie,body:{marketId:second.id,side:'no',action:'buy',amountCents:75000}});assert.equal(q.status,200);
  const trade=await call('/api/trades',{cookie:bobCookie,body:order(q.body)});assert.equal(trade.status,200);
  const after=(await call('/api/markets')).body.markets;assert.equal(after.find(m=>m.id===original.id).probability,original.probability);assert.ok(after.find(m=>m.id===second.id).probability<.5);
  const history=await call('/api/history?marketId='+second.id);assert.equal(history.status,200);assert.equal(history.body.points.length,2);assert.equal(history.body.points[1].probability,trade.body.trade.probability_after);
  const b=await call('/api/state',{cookie:bobCookie});assert.equal(b.body.positions.length,1);assert.equal(b.body.positions[0].market_id,second.id);
  const a=await call('/api/state',{cookie:aliceCookie});assert.equal(a.body.positions.length,1);assert.equal(a.body.positions[0].market_id,original.id);
 });
 await t.test('password change logs out every session; logout revokes the token',async()=>{
  const second=await call('/api/auth/login',{body:registration('alice@example.test')});assert.equal(second.status,200);
  assert.equal((await call('/api/auth/password',{cookie:aliceCookie,body:{currentPassword:'wrong',newPassword:password+'new'}})).status,400);
  assert.equal((await call('/api/auth/password',{cookie:aliceCookie,body:{currentPassword:password,newPassword:password+'new'}})).status,200);
  assert.equal((await call('/api/state',{cookie:aliceCookie})).status,401);assert.equal((await call('/api/state',{cookie:second.cookie})).status,401);
  assert.equal((await call('/api/auth/login',{body:registration('alice@example.test')})).status,401);
  const login=await call('/api/auth/login',{body:{email:'alice@example.test',password:password+'new'}});assert.equal(login.status,200);aliceCookie=login.cookie;
  assert.equal((await call('/api/auth/logout',{cookie:aliceCookie,body:{}})).status,200);assert.equal((await call('/api/state',{cookie:aliceCookie})).status,401);
 });
 await t.test('admin is provisioned server-side, resets old sessions and preserves balance',async()=>{
  await provisionAdmin(app.db,{email:'alice@example.test',password:password+'admin'});
  const login=await call('/api/auth/login',{body:{email:'alice@example.test',password:password+'admin'}});assert.equal(login.status,200);
  const state=await call('/api/state',{cookie:login.cookie});assert.equal(state.body.user.isAdmin,true);assert.equal(state.body.user.balanceCents,aliceBalance);assert.equal(state.body.ledger.filter(l=>l.kind==='welcome').length,1);
  const resolution=await call('/api/resolve',{cookie:login.cookie,body:{outcome:'yes'}});assert.equal(resolution.status,200,JSON.stringify(resolution.body));
 });
 await t.test('login throttling is stored in SQLite',async()=>{
  let last;for(let i=0;i<17;i++)last=await call('/api/auth/login',{body:{email:'missing@example.test',password:'wrong'}});assert.equal(last.status,429);
 });
 }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});
test('HTTPS origin always produces secure session cookies',async()=>{
 const secure=await createApplication({origin:'https://project1.anatolii-botov.ru'});await new Promise(r=>secure.server.listen(0,'127.0.0.1',r));
 try{const response=await fetch(`http://127.0.0.1:${secure.server.address().port}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://project1.anatolii-botov.ru'},body:JSON.stringify(registration('secure@example.test'))});assert.equal(response.status,201);assert.match(response.headers.get('set-cookie'),/; Secure/);}finally{await secure.close();}
});
