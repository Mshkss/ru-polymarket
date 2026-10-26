import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {SQLiteDatabase} from '../server/database.mjs';
import {handleApi,seedMarket} from '../lib/api.mjs';

// Run the actual page controller against the real public market service.
// This small DOM harness needs no browser access or third-party test runtime.
const html=await readFile(new URL('../public/market.html',import.meta.url),'utf8');
const code=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
class Element{
 constructor(tag='div',attrs=''){this.tagName=tag.toUpperCase();this.dataset={};this.hidden=/\shidden(?:[\s>]|$)/.test(' '+attrs);this.open=false;this.value='';this.textContent='';this.innerHTML='';this.disabled=false;this.attributes={};this.events={};this.className='';this.classes=new Set();this.classList={toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};this.style={setProperty(){}};}
 set innerHTML(value){this.html=value;this.htmlWrites=(this.htmlWrites??0)+1;for(const m of String(value).matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){if(Element.registry&&!Element.registry.has(m[3]))Element.registry.set(m[3],new Element(m[1],m[2]));}}
 get innerHTML(){return this.html;}
 setAttribute(key,value){this.attributes[key]=String(value);}
 addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
 showModal(){this.open=true;}
 close(){this.open=false;for(const fn of this.events.close??[])fn();}
 getBoundingClientRect(){return {left:0,right:400,top:0,bottom:500,width:880};}
 scrollIntoView(){}focus(){}
 closest(selector){if(selector.startsWith('[data-')){const name=selector.slice(6,-1).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return Object.hasOwn(this.dataset,name)?this:null;}return null;}
}
async function tick(){for(let i=0;i<8;i++)await new Promise(setImmediate);}
test('guest page keeps browsing open and authentication out of the page flow',async t=>{
 const db=new SQLiteDatabase();db.migrate();await seedMarket(db);
 const ids=new Map([...html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map(m=>[m[3],new Element(m[1],m[2])]));
 Element.registry=ids;const arrays=new Map();
 const elements=(key,count,datasetKey,values)=>{const list=Array.from({length:count},(_,i)=>{const el=new Element('button');if(datasetKey)el.dataset[datasetKey]=values[i];return el;});arrays.set(key,list);};
 elements('[data-add]',3,'add',['100','500','1000']);elements('[data-side]',2,'side',['yes','no']);elements('[data-period]',8,'period',['5m','1h','6h','1d','1w','1m','3m','all']);elements('[data-account-tab]',4,'accountTab',['positions','trades','ledger','profile']);elements('.outcome-probability',2);elements('.outcome-name div>span',2);
 const other=new Map(),windowEvents={},requests=[],timers=[],intervals=[];let hash='';
 const location={get hash(){return hash;},set hash(value){hash=value.startsWith('#')?value:'#'+value;}};
 const document={hidden:false,activeElement:null,getElementById:id=>ids.get(id)??null,querySelectorAll:key=>arrays.get(key)??[],querySelector:key=>{if(!other.has(key))other.set(key,new Element());return other.get(key);},addEventListener(){}};
 let stream;class EventSource{constructor(url){assert.equal(url,'/api/stream');stream=this;this.handlers={};}addEventListener(type,fn){this.handlers[type]=fn;}}
 const context=vm.createContext({EventSource,document,location,window:{addEventListener:(name,fn)=>windowEvents[name]=fn,scrollTo(){}},console,Intl,URL,AbortController,crypto:globalThis.crypto,sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},setInterval:fn=>{intervals.push(fn);return intervals.length;},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},fetch:async(path,options={})=>{requests.push([path,options.method??'GET']);return handleApi(new Request('http://test.local'+path,options),{DB:db},null);}});
 try{
 vm.runInContext(code,context);await tick();
 await t.test('catalog opens without a login request or modal',()=>{
  assert.equal(ids.get('catalogPage').hidden,false);assert.equal(ids.get('marketPage').hidden,true);assert.equal(ids.get('authDialog').tagName,'DIALOG');assert.equal(ids.get('authDialog').open,false);assert.ok(!requests.some(([p])=>p==='/api/bootstrap'||p==='/api/state'));
  assert.ok(ids.get('marketGrid').innerHTML.includes('metro-spb-2026'));assert.ok(ids.get('marketGrid').innerHTML.includes('btc-150k-2026'));assert.equal((ids.get('marketGrid').innerHTML.match(/class="market-card"/g)??[]).length,12);
 });
 await t.test('live quotes update existing cards, animate direction and deduplicate trade tape',async()=>{
  assert.ok(stream);const writes=ids.get('marketGrid').htmlWrites;const initial=vm.runInContext("data.markets.find(m=>m.id==='metro-spb-2026')",context);const snapshot={serverTime:Date.now(),markets:[{id:initial.id,version:initial.version+1,status:'open',probability:.53}],trades:[{sequence:1,marketId:initial.id,title:initial.title,side:'no',action:'buy',units:2500,cashCents:12000,probabilityBefore:.54,probabilityAfter:.53,createdAt:Date.now(),source:'simulation'}]};
  stream.handlers.quotes({data:JSON.stringify(snapshot)});await tick();assert.equal(ids.get('quote-'+initial.id).textContent,'53');assert.match(ids.get('change-'+initial.id).textContent,/↑/);assert.equal(ids.get('marketGrid').htmlWrites,writes);assert.match(ids.get('tradeTape').innerHTML,/Покупка/);assert.match(ids.get('tradeTape').innerHTML,/tape-no/);assert.match(ids.get('tradeTape').innerHTML,/↓ 1 п.п./);assert.match(ids.get('tradeTape').innerHTML,/53%/);assert.match(ids.get('marketHeadline').textContent,/Покупка «Нет»/);assert.equal(ids.get('authDialog').open,false);
  stream.handlers.quotes({data:JSON.stringify(snapshot)});assert.equal(vm.runInContext('tapeItems.length',context),1);
  snapshot.markets[0].version++;snapshot.markets[0].probability=.525;stream.handlers.quotes({data:JSON.stringify(snapshot)});assert.equal(ids.get('quote-'+initial.id).textContent,'52,5');assert.match(ids.get('change-'+initial.id).textContent,/↓/);assert.equal(ids.get('marketGrid').htmlWrites,writes);
  snapshot.markets[0].version--;snapshot.markets[0].probability=.9;stream.handlers.quotes({data:JSON.stringify(snapshot)});assert.equal(ids.get('quote-'+initial.id).textContent,'52,5');
  snapshot.markets[0].version+=2;snapshot.markets[0].status='resolved';snapshot.markets[0].outcome='yes';snapshot.markets[0].probability=1;stream.handlers.quotes({data:JSON.stringify(snapshot)});assert.equal(vm.runInContext("data.markets.find(m=>m.id==='metro-spb-2026').tradingOpen",context),false);
 });
 await t.test('miniature curves use cubic interpolation and preserve endpoints without overshoot',()=>{
  const path=vm.runInContext("sparkline([{created_at:0,probability:.4},{created_at:20,probability:.41},{created_at:100,probability:.405}])",context);assert.match(path,/ C/);assert.ok(!/[HV]/.test(path));assert.match(path,/145\.00,/);
  const smooth=vm.runInContext('smoothPath([{x:0,y:0},{x:1,y:10},{x:2,y:9}])',context);const curves=[...smooth.matchAll(/C([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)/g)];assert.equal(curves.length,2);for(const [i,curve] of curves.entries()){const low=i===0?0:9,high=10;for(const n of [curve[2],curve[4],curve[6]])assert.ok(Number(n)>=low&&Number(n)<=high);}
 });
 await t.test('direct event URL opens its own rules and chart for a guest',async()=>{
  location.hash='#market/btc-150k-2026';windowEvents.hashchange();await tick();assert.equal(ids.get('marketPage').hidden,false);assert.equal(ids.get('catalogPage').hidden,true);assert.match(ids.get('eventTitle').textContent,/Биткоин/);assert.match(ids.get('rulesText').textContent,/BTC-USD/);assert.match(ids.get('chart').innerHTML,/yes-line/);assert.equal(ids.get('authDialog').open,false);
 });
 await t.test('period buttons request their own data and use the full advertised time scale',async()=>{
  const periods={'5m':300000,'1h':3600000,'6h':21600000,'1d':86400000,'1w':604800000,'1m':2592000000,'3m':7776000000};
  for(const [period,duration] of Object.entries(periods)){
   arrays.get('[data-period]').find(b=>b.dataset.period===period).onclick();await tick();assert.ok(requests.some(([path])=>path.endsWith('period='+period)));assert.equal(vm.runInContext('chartDomain.end-chartDomain.start',context),duration);assert.match(ids.get('chart').innerHTML,/axis-label/);
  }
 });
 await t.test('guest can calculate a purchase, then sign-in opens only after clicking buy',async()=>{
  ids.get('amount').value='1000';ids.get('amount').oninput();for(const timer of timers.splice(0))await timer();await tick();assert.notEqual(ids.get('quoteCost').textContent,'—');assert.match(ids.get('submitTrade').innerHTML,/Войти, чтобы купить/);assert.equal(ids.get('authDialog').open,false);
  await ids.get('submitTrade').onclick();assert.equal(ids.get('authDialog').open,true);ids.get('closeAuth').onclick();assert.equal(ids.get('authDialog').open,false);assert.equal(ids.get('marketPage').hidden,false);assert.ok(!requests.some(([p])=>p==='/api/trades'));
 });
 await t.test('registration is an explicit modal and does not reappear after polling',async()=>{
  ids.get('registerButton').onclick();assert.equal(ids.get('authDialog').open,true);assert.equal(ids.get('authNameField').hidden,false);assert.match(ids.get('authHeading').textContent,/Создать/);ids.get('closeAuth').onclick();
  for(const fn of intervals)fn();await tick();assert.equal(ids.get('authDialog').open,false);assert.equal(ids.get('marketPage').hidden,false);
  ids.get('portfolioNav').onclick();assert.equal(ids.get('authDialog').open,true);ids.get('registerAuthTab').onclick();for(const fn of intervals)fn();await tick();assert.equal(ids.get('authNameField').hidden,false);assert.match(ids.get('authHeading').textContent,/Создать/);ids.get('closeAuth').onclick();assert.equal(ids.get('catalogPage').hidden,false);
 });
 await t.test('category filtering and event switching use the selected market',async()=>{
  const category=new Element('button');category.dataset.category='Криптовалюта';ids.get('categoryFilters').onclick({target:category});assert.equal(ids.get('catalogPage').hidden,false);assert.equal((ids.get('marketGrid').innerHTML.match(/class="market-card"/g)??[]).length,2);assert.ok(!ids.get('marketGrid').innerHTML.includes('metro-spb-2026'));
  const link=new Element('a');link.dataset.openSide='no';link.dataset.marketId='eth-5k-2026';ids.get('marketGrid').onclick({target:link,preventDefault(){}});await tick();assert.match(ids.get('eventTitle').textContent,/Ethereum/);assert.match(ids.get('rulesText').textContent,/ETH-USD/);assert.equal(ids.get('noButton').attributes['aria-pressed'],'true');assert.equal(ids.get('authDialog').open,false);
 });
 }finally{db.close();}
});
