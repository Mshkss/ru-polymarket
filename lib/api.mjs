import { liveSnapshot } from './live.mjs';
import { PERIOD_MS, readHistory } from './history.mjs';
import { MARKET_CATALOG, catalogById } from './catalog.mjs';
import { probability, positionLiquidationCents, tradeCash, unitsForBudget, redemptionCents, STARTING_BALANCE_CENTS, MAX_ORDER_UNITS, SHARE_SCALE } from './market-math.mjs';
const MARKET_ID='metro-spb-2026';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
class ApiError extends Error {constructor(status,message,code='request_error'){super(message);this.status=status;this.code=code;}}
const requireValue=(condition,message,status=400,code)=>{if(!condition)throw new ApiError(status,message,code);};
const statement=(db,sql,...args)=>db.prepare(sql).bind(...args);
const one=r=>r.results?.[0]??null;
const admin=(identity)=>identity?.isAdmin===true;
async function body(request){requireValue((Number(request.headers.get('content-length'))||0)<=8192,'Запрос слишком большой.',413);let value;try{const text=await request.text();requireValue(text.length<=8192,'Запрос слишком большой.',413);value=JSON.parse(text);}catch(e){if(e instanceof ApiError)throw e;throw new ApiError(400,'Некорректный JSON.');}requireValue(value&&typeof value==='object'&&!Array.isArray(value),'Ожидается объект JSON.');return value;}
export async function seedMarket(db,now=Date.now()){
 const statements=[];
 for(const market of MARKET_CATALOG){
  statements.push(statement(db,`INSERT OR IGNORE INTO markets (id,title,category,rules,status,liquidity,q_yes,q_no,version,created_at,closes_at,reserve_cents) VALUES (?,?,?,?,'open',100,0,0,0,?,?,693148)`,market.id,market.title,market.category,market.rules,now,market.closesAt));
  statements.push(statement(db,`INSERT INTO price_history (market_id,probability,market_version,created_at) SELECT id,0.5,0,created_at FROM markets WHERE id=? AND NOT EXISTS(SELECT 1 FROM price_history WHERE market_id=?)`,market.id,market.id));
 }
 await db.batch(statements);
}
function publicMarket(m,history=[]){
 const metadata=catalogById.get(m.id)??{};
 return {id:m.id,title:m.title,category:metadata.category??m.category,rules:m.rules.replace(/ Это тестовый рынок;.*$/,''),status:m.status,outcome:m.outcome,
  version:m.version,created_at:m.created_at,closes_at:m.closes_at,resolved_at:m.resolved_at,
  probability:m.status==='resolved'?(m.outcome==='yes'?1:0):probability(m),tradingOpen:isOpen(m),
  location:metadata.location??'',topic:metadata.topic??'',icon:metadata.icon??'↗',color:metadata.color??'blue',
  sourceName:metadata.sourceName??'Источник события',sourceUrl:metadata.sourceUrl??'',yesDescription:metadata.yesDescription??'Событие произойдёт',noDescription:metadata.noDescription??'Событие не произойдёт',history};
}
const historyPreviewSQL=`SELECT market_id,probability,created_at FROM (SELECT market_id,probability,created_at,id,ROW_NUMBER() OVER(PARTITION BY market_id ORDER BY created_at DESC,id DESC) AS rank FROM price_history) WHERE rank<=40 ORDER BY created_at ASC,id ASC`;
async function publicMarkets(db){
 const [rows,histories]=await db.batch([statement(db,'SELECT * FROM markets ORDER BY created_at ASC,id ASC'),statement(db,historyPreviewSQL)]);
 const groups=new Map();for(const h of histories.results){if(!groups.has(h.market_id))groups.set(h.market_id,[]);groups.get(h.market_id).push({probability:h.probability,created_at:h.created_at});}
 const order=new Map(MARKET_CATALOG.map((m,i)=>[m.id,i]));
 return rows.results.map(m=>publicMarket(m,groups.get(m.id)??[])).sort((a,b)=>(order.get(a.id)??999)-(order.get(b.id)??999));
}
async function ensureAccount(db,identity,now){
 const name=(identity.name||identity.email.split('@')[0]).slice(0,40);
 await db.batch([
  statement(db,`INSERT OR IGNORE INTO users (id,email,display_name,balance_cents,version,created_at) VALUES (?,?,?,?,0,?)`,identity.id,identity.email,name,STARTING_BALANCE_CENTS,now),
  statement(db,`INSERT OR IGNORE INTO ledger (id,user_id,kind,delta_cents,created_at) VALUES (?,?,'welcome',?,?)`,'welcome:'+identity.id,identity.id,STARTING_BALANCE_CENTS,now)
 ]);
}
async function snapshot(db,userId,marketId=MARKET_ID){
 const rows=await db.batch([
  statement(db,'SELECT * FROM markets WHERE id=?',marketId),
  statement(db,'SELECT * FROM users WHERE id=?',userId),
  statement(db,'SELECT * FROM positions WHERE market_id=? AND user_id=?',marketId,userId)
 ]);
 const market=one(rows[0]),user=one(rows[1]);requireValue(market,'Рынок не найден.',404);requireValue(user,'Войдите в аккаунт.',401);
 return {market,user,positions:rows[2].results};
}
const holding=(s,side)=>s.positions.find(p=>p.side===side)?.units??0;
const isOpen=m=>m.status==='open'&&m.closes_at>Date.now();
function quote(s,input,guest=false){
 requireValue(isOpen(s.market),'Торги по этому событию закрыты.',409,'market_closed');
 requireValue(['yes','no'].includes(input.side)&&['buy','sell'].includes(input.action),'Выберите исход и операцию.');
 let units;
 if(input.action==='buy'){
  requireValue(Number.isSafeInteger(input.amountCents)&&input.amountCents>0&&input.amountCents<=STARTING_BALANCE_CENTS*1000,'Введите корректную сумму.');
  if(!guest)requireValue(input.amountCents<=s.user.balance_cents,'Недостаточно баллов.');
  units=unitsForBudget(s.market,input.side,input.amountCents);
 }else{
  units=input.units;requireValue(Number.isSafeInteger(units)&&units>0&&units<=MAX_ORDER_UNITS,'Введите корректное количество долей.');
  requireValue(units<=holding(s,input.side),'Недостаточно долей.');
 }
 requireValue(units>0,'Сумма слишком мала для покупки 0,001 доли.');
 const result=tradeCash(s.market,input.side,input.action,units);
 return {marketId:s.market.id,side:input.side,action:input.action,units,cashCents:result.cash,marketVersion:s.market.version,
  probabilityBefore:probability(s.market),probabilityAfter:result.probabilityAfter,
  averagePriceCents:result.cash/(units/SHARE_SCALE),balanceAfterCents:s.user?s.user.balance_cents+(input.action==='buy'?-result.cash:result.cash):null,
  maxPayoutCents:input.action==='buy'?redemptionCents(units):0};
}
async function dashboard(db,identity,env){
 const rows=await db.batch([
  statement(db,'SELECT * FROM users WHERE id=?',identity.id),
  statement(db,'SELECT * FROM markets ORDER BY created_at ASC,id ASC'),
  statement(db,`SELECT p.*,m.title,m.status,m.outcome,m.q_yes,m.q_no,m.liquidity FROM positions p JOIN markets m ON m.id=p.market_id WHERE p.user_id=? AND p.units>0`,identity.id),
  statement(db,`SELECT t.*,m.title FROM trades t JOIN markets m ON m.id=t.market_id WHERE t.user_id=? ORDER BY t.created_at DESC,t.rowid DESC LIMIT 200`,identity.id),
  statement(db,'SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200',identity.id),
  statement(db,'SELECT market_id FROM bookmarks WHERE user_id=?',identity.id)
 ]);
 const user=one(rows[0]);requireValue(user,'Войдите в аккаунт.',401);
 return {user:{id:user.id,email:user.email,displayName:user.display_name,balanceCents:user.balance_cents,createdAt:user.created_at,isAdmin:admin(identity,env)},
  markets:rows[1].results.map(m=>publicMarket(m)).sort((a,b)=>MARKET_CATALOG.findIndex(m=>m.id===a.id)-MARKET_CATALOG.findIndex(m=>m.id===b.id)),
  positions:rows[2].results.map(p=>{const mark=probability(p);return {...p,markValueCents:Math.round(p.units/SHARE_SCALE*10000*(p.side==='yes'?mark:1-mark)),liquidationCents:p.status==='open'?positionLiquidationCents(p,p.side,p.units):null,payoutCents:p.status==='resolved'&&p.side===p.outcome?redemptionCents(p.units):0};}),
  trades:rows[3].results,ledger:rows[4].results,bookmarks:rows[5].results.map(b=>b.market_id)};
}
export async function executeMarketTrade(db,identity,input,now,{source='market'}={}){
 requireValue(['market','simulation'].includes(source),'Invalid trade source.');
 requireValue(typeof input.idempotencyKey==='string'&&/^[a-zA-Z0-9-]{16,80}$/.test(input.idempotencyKey),'Некорректный идентификатор заявки.');
 const id=identity.id+':'+input.idempotencyKey;
 const existing=await statement(db,'SELECT * FROM trades WHERE id=? AND user_id=?',id,identity.id).first();
 if(existing){requireValue(existing.side===input.side&&existing.action===input.action&&existing.units===input.units&&existing.market_id===(input.marketId??MARKET_ID),'Этот идентификатор уже использован для другой заявки.',409);return {trade:existing,replayed:true};}
 const s=await snapshot(db,identity.id,input.marketId??MARKET_ID);
 requireValue(isOpen(s.market),'Торги закрыты.',409,'market_closed');
 requireValue(Number.isSafeInteger(input.marketVersion)&&input.marketVersion===s.market.version,'Цена изменилась. Проверьте новую котировку.',409,'price_changed');
 requireValue(['yes','no'].includes(input.side)&&['buy','sell'].includes(input.action),'Некорректная заявка.');
 requireValue(Number.isSafeInteger(input.units)&&input.units>0&&input.units<=MAX_ORDER_UNITS,'Некорректное количество долей.');
 const result=tradeCash(s.market,input.side,input.action,input.units),buy=input.action==='buy';
 requireValue(Number.isSafeInteger(input.cashLimitCents)&&input.cashLimitCents>=0,'Некорректный лимит цены.');
 requireValue(buy?result.cash<=input.cashLimitCents:result.cash>=input.cashLimitCents,'Цена вышла за пределы заявки.',409,'price_changed');
 requireValue(buy?s.user.balance_cents>=result.cash:holding(s,input.side)>=input.units,buy?'Недостаточно баллов.':'Недостаточно долей.');
 const signedUnits=buy?input.units:-input.units,delta=buy?-result.cash:result.cash;
 const guard=crypto.randomUUID();
 try{
 await db.batch([
  statement(db,`INSERT INTO transaction_guards (id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM markets WHERE id=? AND version=? AND status='open' AND closes_at>?) AND EXISTS(SELECT 1 FROM users WHERE id=? AND version=? AND balance_cents>=?) AND ? >= ? THEN 1 ELSE 0 END`,guard,s.market.id,s.market.version,now,identity.id,s.user.version,buy?result.cash:0,buy?input.units:holding(s,input.side),input.units),
  statement(db,'UPDATE markets SET q_yes=?,q_no=?,reserve_cents=reserve_cents+?,version=version+1 WHERE id=?',result.qYes,result.qNo,-delta,s.market.id),
  statement(db,'UPDATE users SET balance_cents=balance_cents+?,version=version+1 WHERE id=?',delta,identity.id),
  statement(db,`INSERT INTO positions (user_id,market_id,side,units) VALUES (?,?,?,?) ON CONFLICT(user_id,market_id,side) DO UPDATE SET units=units+?`,identity.id,s.market.id,input.side,buy?input.units:0,signedUnits),
  statement(db,`INSERT INTO trades (id,user_id,market_id,side,action,units,cash_cents,probability_before,probability_after,market_version,created_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,id,identity.id,s.market.id,input.side,input.action,input.units,result.cash,probability(s.market),result.probabilityAfter,s.market.version+1,now,source==='simulation'?'simulation':'user'),
  statement(db,`INSERT INTO price_history (market_id,probability,market_version,created_at,source) VALUES (?,?,?,?,?)`,s.market.id,result.probabilityAfter,s.market.version+1,now,source),
  statement(db,'INSERT INTO ledger (id,user_id,market_id,kind,delta_cents,created_at) VALUES (?,?,?,?,?,?)',id,identity.id,s.market.id,input.action,delta,now),
  statement(db,'DELETE FROM transaction_guards WHERE id=?',guard)
 ]);
 }catch(e){
  const committed=await statement(db,'SELECT * FROM trades WHERE id=? AND user_id=?',id,identity.id).first();
  if(committed){requireValue(committed.side===input.side&&committed.action===input.action&&committed.units===input.units,'Конфликт заявки.',409);return {trade:committed,replayed:true};}
  if(/guard_must_pass|constraint/i.test(e.message))throw new ApiError(409,'Рынок или баланс изменились. Обновите котировку.','price_changed');
  throw e;
 }
 return {trade:await statement(db,'SELECT * FROM trades WHERE id=?',id).first(),replayed:false};
}
async function resolve(db,identity,env,input,now){
 requireValue(admin(identity,env),'Только администратор может определить исход.',403);
 requireValue(['yes','no'].includes(input.outcome),'Выберите итоговый исход.');
 const market=await statement(db,'SELECT * FROM markets WHERE id=?',input.marketId??MARKET_ID).first();requireValue(market,'Рынок не найден.',404);
 if(market.status==='resolved'){requireValue(market.outcome===input.outcome,'Итог уже определён и не может быть изменён.',409);return {resolved:true,replayed:true};}
 const guard=crypto.randomUUID();
 try{await db.batch([
  statement(db,`INSERT INTO transaction_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM markets WHERE id=? AND status='open' AND version=?) THEN 1 ELSE 0 END`,guard,market.id,market.version),
  statement(db,`UPDATE markets SET status='resolved',outcome=?,resolved_at=?,reserve_cents=reserve_cents-(SELECT COALESCE(SUM(units),0)*10 FROM positions WHERE market_id=? AND side=?),version=version+1 WHERE id=?`,input.outcome,now,market.id,input.outcome,market.id),
  statement(db,`INSERT INTO ledger(id,user_id,market_id,kind,delta_cents,created_at) SELECT 'settlement:' || market_id || ':' || user_id,user_id,market_id,'settlement',SUM(units)*10,? FROM positions WHERE market_id=? AND side=? AND units>0 GROUP BY user_id,market_id`,now,market.id,input.outcome),
  statement(db,`UPDATE users SET balance_cents=balance_cents+COALESCE((SELECT SUM(p.units)*10 FROM positions p WHERE p.user_id=users.id AND p.market_id=? AND p.side=?),0),version=version+1 WHERE id IN (SELECT user_id FROM positions WHERE market_id=? AND units>0)`,market.id,input.outcome,market.id),
  statement(db,`INSERT INTO price_history(market_id,probability,market_version,created_at) VALUES (?,?,?,?)`,market.id,input.outcome==='yes'?1:0,market.version+1,now),
  statement(db,'DELETE FROM transaction_guards WHERE id=?',guard)
 ]);}catch(e){if(/guard_must_pass|constraint/i.test(e.message))throw new ApiError(409,'Рынок изменился. Обновите страницу.');throw e;}
 return {resolved:true,replayed:false};
}
export async function handleApi(request,env,identity){
 try{
  const url=new URL(request.url),path=url.pathname.replace(/^\/api\/?/,'');
  requireValue(env.DB,'База данных недоступна.',503);
  if(request.method!=='GET'){
   const origin=request.headers.get('Origin');requireValue(!origin||origin===url.origin,'Запрос с другого сайта запрещён.',403);
   requireValue(request.headers.get('Content-Type')?.split(';')[0]==='application/json','Ожидается application/json.',415);
  }
  const db=env.DB,now=Date.now();
  if(path==='live'&&request.method==='GET')return json(await liveSnapshot(db));
  if(path==='session'&&request.method==='GET')return json({authenticated:Boolean(identity)});
  if(path==='markets'&&request.method==='GET')return json({markets:await publicMarkets(db)});
  if(path.startsWith('markets/')&&request.method==='GET'){
   const id=decodeURIComponent(path.slice(8));const market=await statement(db,'SELECT * FROM markets WHERE id=?',id).first();requireValue(market,'Событие не найдено.',404);return json({market:publicMarket(market)});
  }
  if(path==='history'&&request.method==='GET'){
   const marketId=url.searchParams.get('marketId')??MARKET_ID,period=url.searchParams.get('period')??'all';
   requireValue(await statement(db,'SELECT 1 FROM markets WHERE id=?',marketId).first(),'Событие не найдено.',404);
   requireValue(Object.hasOwn(PERIOD_MS,period),'Неизвестный период.');
   return json(await readHistory(db,marketId,period,now));
  }
  if(path==='quote'&&request.method==='GET'){
   const market=await statement(db,'SELECT * FROM markets WHERE id=?',url.searchParams.get('marketId')??MARKET_ID).first();requireValue(market,'Событие не найдено.',404);
   return json(quote({market,user:null,positions:[]},{action:'buy',side:url.searchParams.get('side'),amountCents:Number(url.searchParams.get('amountCents'))},true));
  }
  requireValue(identity?.id&&identity?.email,'Войдите в аккаунт, чтобы открыть личный кабинет.',401,'sign_in_required');
  if(path==='bootstrap'&&request.method==='POST'){await seedMarket(db,now);await ensureAccount(db,identity,now);return json(await dashboard(db,identity,env));}
  if(path==='state'&&request.method==='GET')return json(await dashboard(db,identity,env));
  if(path==='quote'&&request.method==='POST'){const input=await body(request);return json(quote(await snapshot(db,identity.id,input.marketId??MARKET_ID),input));}
  if(path==='trades'&&request.method==='POST')return json(await executeMarketTrade(db,identity,await body(request),now));
  if(path==='profile'&&request.method==='PATCH'){
   const input=await body(request);requireValue(typeof input.displayName==='string','Укажите имя.');const name=input.displayName.trim();requireValue(name.length>=2&&name.length<=40&&!/[\x00-\x1f]/.test(name),'Имя должно содержать от 2 до 40 символов.');
   await statement(db,'UPDATE users SET display_name=? WHERE id=?',name,identity.id).run();return json({saved:true});
  }
  if(path==='bookmark'&&request.method==='POST'){
   const input=await body(request);requireValue(typeof input.saved==='boolean','Некорректное значение.');
   const s=await snapshot(db,identity.id,input.marketId??MARKET_ID);
   await statement(db,input.saved?'INSERT OR IGNORE INTO bookmarks(user_id,market_id) VALUES (?,?)':'DELETE FROM bookmarks WHERE user_id=? AND market_id=?',identity.id,s.market.id).run();return json({saved:input.saved});
  }
  if(path==='resolve'&&request.method==='POST')return json(await resolve(db,identity,env,await body(request),now));
  return json({error:'Маршрут не найден.'},404);
 }catch(e){if(e instanceof ApiError)return json({error:e.message,code:e.code},e.status);console.error('API operation failed',e);return json({error:'Не удалось выполнить операцию. Повторите запрос.',code:'internal_error'},500);}
}
