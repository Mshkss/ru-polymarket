import {createHash} from 'node:crypto';
import {executeMarketTrade} from '../lib/api.mjs';
import {probability,tradeCash,unitsForBudget,SHARE_SCALE,MAX_ORDER_UNITS} from '../lib/market-math.mjs';
const DAY=86400000;
const FUNDING_CENTS=100000000;
const MAX_STEP_UNITS=400;
const MODEL_VERSION=2;
const hash=value=>createHash('sha256').update(value).digest('hex');
const logit=p=>Math.log(p/(1-p));
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
function randomAt(seed,index,salt){
 let x=(seed^Math.imul(index|0,0x9e3779b1)^salt)>>>0;
 x=Math.imul(x^(x>>>16),0x85ebca6b);x=Math.imul(x^(x>>>13),0xc2b2ae35);return ((x^(x>>>16))>>>0)/4294967295*2-1;
}
function noise(seed,time,scale,salt){
 const position=time/scale,index=Math.floor(position),t=position-index;
 const blend=t*t*t*(t*(t*6-15)+10);
 return randomAt(seed,index,salt)*(1-blend)+randomAt(seed,index+1,salt)*blend;
}
function shape(id,elapsed){
 const seed=parseInt(hash(id).slice(0,8),16);
 const activity=.2+.8*(noise(seed,elapsed,3*3600000,71)+1)/2;
 let signal=.70*noise(seed,elapsed,28*DAY,11)+.38*noise(seed,elapsed,5*DAY,23)
  +.16*noise(seed,elapsed,20*3600000,37)+activity*(.028*noise(seed,elapsed,180000,43)+.004*noise(seed,elapsed,37000,53));
 // Occasional events have a short onset and a slow, finite decay, not a repeating sine wave.
 const block=6*3600000,current=Math.floor(elapsed/block);
 for(let i=current-3;i<=current;i++){
  if(randomAt(seed,i,101)<.76)continue;
  const onset=i*block+(.2+.65*(randomAt(seed,i,107)+1)/2)*block,age=elapsed-onset;
  if(age<0||age>3*block)continue;
  const rise=Math.min(1,age/180000),tail=Math.min(1,(3*block-age)/3600000);
  signal+=randomAt(seed,i,113)*.24*(rise*rise*(3-2*rise))*Math.exp(-age/block)*tail*tail;
 }
 return signal;
}
export function scenarioProbability(id,elapsed,anchor=.5){
 const z=logit(clamp(anchor,.01,.99))+shape(id,elapsed)-shape(id,0);
 return clamp(1/(1+Math.exp(-z)),.12,.88);
}
async function seedReferenceHistory(db,market,anchorTime,anchorProbability,replace=false){
 const exists=await db.prepare('SELECT 1 FROM scenario_history WHERE market_id=? LIMIT 1').bind(market.id).first();if(exists&&!replace)return;
 const times=new Set();
 for(const [duration,step] of [[90*DAY,3600000],[DAY,300000],[3600000,30000],[300000,5000]])for(let t=anchorTime-duration;t<anchorTime;t+=step)times.add(t);
 const rows=[...times].sort((a,b)=>a-b).map(t=>db.prepare('INSERT OR IGNORE INTO scenario_history(market_id,created_at,probability) VALUES (?,?,?)').bind(market.id,t,scenarioProbability(market.id,t-anchorTime,anchorProbability)));
 if(replace)rows.unshift(db.prepare('DELETE FROM scenario_history WHERE market_id=?').bind(market.id));
 await db.batch(rows);
}
async function initialize(db,now,intervalMs,warmupSlots){
 const markets=(await db.prepare("SELECT * FROM markets WHERE status='open' AND closes_at>?").bind(now).all()).results;
 for(const market of markets){
  const first=await db.prepare('SELECT created_at,probability FROM price_history WHERE market_id=? ORDER BY created_at,id LIMIT 1').bind(market.id).first();
  const existing=await db.prepare('SELECT * FROM market_simulation WHERE market_id=?').bind(market.id).first();
  const upgrade=Boolean(existing&&existing.model_version<MODEL_VERSION);
  await seedReferenceHistory(db,market,first?.created_at??now,first?.probability??probability(market),upgrade);
  if(existing){if(upgrade)await db.prepare('UPDATE market_simulation SET epoch_ms=?,anchor_probability=?,last_tick_ms=?,model_version=? WHERE market_id=?').bind(now,probability(market),now,MODEL_VERSION,market.id).run();continue;}
  const latest=await db.prepare('SELECT MAX(created_at) AS ts FROM price_history WHERE market_id=?').bind(market.id).first();
  const epoch=Math.max(latest.ts??now,now-warmupSlots*intervalMs),userId='system:liquidity:'+market.id;
  await db.batch([
   db.prepare('INSERT OR IGNORE INTO users(id,email,display_name,balance_cents,version,created_at) VALUES (?,?,?,?,0,?)').bind(userId,market.id+'@liquidity.invalid','Маркетмейкер',FUNDING_CENTS,now),
   db.prepare("INSERT OR IGNORE INTO ledger(id,user_id,kind,delta_cents,created_at) VALUES (?,?,'simulation_funding',?,?)").bind('funding:'+userId,userId,FUNDING_CENTS,now),
   db.prepare('INSERT OR IGNORE INTO market_simulation(market_id,user_id,epoch_ms,anchor_probability,last_tick_ms,model_version) VALUES (?,?,?,?,?,?)').bind(market.id,userId,epoch,probability(market),epoch,MODEL_VERSION)
  ]);
 }
}
async function moveToward(db,state,slot,target){
 let applied=0;
 for(let leg=0;leg<2;leg++){
  const [mr,ur,pr,latest]=await db.batch([
   db.prepare('SELECT * FROM markets WHERE id=?').bind(state.market_id),
   db.prepare('SELECT * FROM users WHERE id=?').bind(state.user_id),
   db.prepare('SELECT side,units FROM positions WHERE market_id=? AND user_id=?').bind(state.market_id,state.user_id),
   db.prepare('SELECT MAX(created_at) AS ts FROM price_history WHERE market_id=?').bind(state.market_id)
  ]);
  const market=mr.results[0],user=ur.results[0];if(!market||market.status!=='open'||market.closes_at<=Date.now())break;
  const difference=market.liquidity*SHARE_SCALE*logit(target)-(market.q_yes-market.q_no);
  if(Math.abs(difference)<2)break;
  const direction=difference>0?'yes':'no',opposite=direction==='yes'?'no':'yes';
  const owned=pr.results.find(p=>p.side===opposite)?.units??0;
  const action=owned>0?'sell':'buy',side=owned>0?opposite:direction;
  let units=Math.min(Math.floor(Math.abs(difference)),MAX_STEP_UNITS,MAX_ORDER_UNITS,owned>0?owned:MAX_ORDER_UNITS);
  if(units<1)break;
  let cash=tradeCash(market,side,action,units).cash;
  if(action==='buy'&&cash>user.balance_cents){units=Math.min(units,unitsForBudget(market,side,user.balance_cents));if(!units)break;cash=tradeCash(market,side,action,units).cash;}
  try{
   await executeMarketTrade(db,{id:user.id,email:user.email},{marketId:market.id,side,action,units,marketVersion:market.version,cashLimitCents:cash,idempotencyKey:hash(market.id+':'+slot+':'+leg)},Math.max(slot,latest.results[0]?.ts??slot),{source:'simulation'});
   applied++;
  }catch(error){if(error.status===409)break;throw error;}
 }
 return applied;
}
function scheduleFor(id,baseInterval){
 const seed=hash(id);const interval=baseInterval*(2+parseInt(seed.slice(0,8),16)%4)+parseInt(seed.slice(8,12),16)%800;
 return {interval,offset:parseInt(seed.slice(12,20),16)%interval};
}
export async function createSimulation(db,{now=Date.now(),intervalMs=2000,warmupSlots=60,autoStart=true,onError=error=>console.error('Price simulation:',error.message)}={}){
 if(!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>60000)throw new Error('Simulation interval must be between 1000 and 60000 ms');
 if(!Number.isInteger(warmupSlots)||warmupSlots<0||warmupSlots>120)throw new Error('Invalid simulation warmup');
 await initialize(db,now,intervalMs,warmupSlots);
 let running=null,stopped=false,timer;
 async function tick(at=Date.now()){
  if(stopped)return 0;if(running)return running;
  running=(async()=>{
   let trades=0;
   const states=(await db.prepare("SELECT s.* FROM market_simulation s JOIN markets m ON m.id=s.market_id WHERE m.status='open' AND m.closes_at>?").bind(at).all()).results;
   for(const state of states){
    const {interval,offset}=scheduleFor(state.market_id,intervalMs);
    const lastSlot=offset+Math.floor((at-offset)/interval)*interval;
    const earliest=Math.max(state.last_tick_ms+1,lastSlot-Math.max(0,warmupSlots-1)*interval);
    const firstSlot=offset+Math.ceil((earliest-offset)/interval)*interval;
    for(let slot=firstSlot;slot<=lastSlot;slot+=interval){
     // Claim a time slot before execution. Restarting cannot duplicate a tick.
     const result=await db.prepare('UPDATE market_simulation SET last_tick_ms=? WHERE market_id=? AND last_tick_ms<?').bind(slot,state.market_id,slot).run();
     if(result.meta.changes!==1)continue;
     trades+=await moveToward(db,state,slot,scenarioProbability(state.market_id,slot-state.epoch_ms,state.anchor_probability));
    }
   }
   return trades;
  })();
  try{return await running;}finally{running=null;}
 }
 await tick(now);
 if(autoStart){timer=setInterval(()=>{tick().catch(onError);},Math.min(200,intervalMs));timer.unref();}
 return {tick,async close(){stopped=true;clearInterval(timer);if(running)await running;}};
}
