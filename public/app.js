'use strict';
const $=id=>document.getElementById(id);
const fmt=(n,d=2)=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:d}).format(n);
const points=c=>`${fmt(c/100)} Б`;
const date=t=>new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'}).format(new Date(t));
const shortDate=t=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',timeZone:'Europe/Moscow'}).format(new Date(t));
const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const emptyAccount={user:null,positions:[],trades:[],ledger:[],bookmarks:[]};
const titles={yes:'Да',no:'Нет'};
let data=null,market=null,side='yes',action='buy',period='all',quote=null,quoteTimer,quoteSequence=0,submitting=false,pendingTrade=null,history=[],serverTime=Date.now(),toastTimer,refreshing=false;
let category='all',searchQuery='',sortOrder='default',authMode='login',resolution=null;
async function api(path,body,method=body?'POST':'GET'){
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
 try{const res=await fetch('/api/'+path,{method,credentials:'same-origin',signal:controller.signal,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});let result;try{result=await res.json();}catch{throw new Error('Не удалось загрузить данные.');}if(!res.ok){const error=new Error(result.error||'Не удалось выполнить запрос.');error.status=res.status;error.code=result.code;throw error;}return result;}finally{clearTimeout(timeout);}
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
function showError(message){$('tradeError').textContent=message;$('tradeError').hidden=!message;}
function holding(s=side,id=market?.id){return data?.positions.find(p=>p.market_id===id&&p.side===s)?.units??0;}
function pendingStore(){if(!data?.user)return;try{const key='ishod-pending:'+data.user.id;if(pendingTrade)sessionStorage.setItem(key,JSON.stringify(pendingTrade));else sessionStorage.removeItem(key);}catch{}}
function readPending(){try{pendingTrade=data?.user?JSON.parse(sessionStorage.getItem('ishod-pending:'+data.user.id)):null;}catch{pendingTrade=null;}}
function route(){if(location.hash==='#account')return {view:'account'};if(location.hash.startsWith('#market/')){try{return {view:'detail',id:decodeURIComponent(location.hash.slice(8))};}catch{return {view:'catalog'};}}return {view:'catalog'};}
function navigate(view='catalog',id){location.hash=view==='account'?'account':view==='detail'?'market/'+encodeURIComponent(id):'markets';applyRoute();}
function applyRoute(reloadHistory=false){
 if(!data)return;const current=route();
 $('catalogPage').hidden=current.view==='detail'||(current.view==='account'&&Boolean(data.user));$('marketPage').hidden=current.view!=='detail';$('accountPage').hidden=current.view!=='account'||!data.user;
 $('marketsNav').classList.toggle('current',current.view!=='account');$('portfolioNav').classList.toggle('current',current.view==='account');
 if(current.view==='account'){if(!data.user){if(!$('authDialog').open)showAuth('login');}else renderAccount();return;}
 if(current.view==='detail'){
  const next=data.markets.find(m=>m.id===current.id);if(!next){navigate('catalog');toast('Событие не найдено');return;}
  const different=market?.id!==next.id,changed=different||market?.version!==next.version;market=next;
  if(different){quoteSequence++;clearTimeout(quoteTimer);quote=null;$('amount').value='';side='yes';action='buy';history=[];historyRequest++;$('chart').innerHTML='';$('chartTooltip').hidden=true;showError('');showTab('rules');if(pendingTrade?.marketId===market.id){side=pendingTrade.side;action=pendingTrade.action;}}
  if(changed&&quote&&quote.marketVersion!==market.version){quote=null;quoteSequence++;}
  renderMarket();if(changed||reloadHistory){loadHistory();if(Number($('amount').value)>0&&!pendingTrade&&!submitting)loadQuote();}
 }
}
window.addEventListener('hashchange',()=>applyRoute());
function renderHeader(){const user=data?.user;$('balanceButton').hidden=!user;$('profileButton').hidden=!user;$('loginButton').hidden=Boolean(user);$('registerButton').hidden=Boolean(user);if(user){$('balance').textContent=fmt(user.balanceCents/100);$('profileButton').textContent=user.displayName.slice(0,1).toUpperCase();}}
function normalize(s){return s.toLocaleLowerCase('ru').replaceAll('ё','е');}
function matches(m){return normalize(m.title+' '+m.category+' '+m.location+' '+m.topic).includes(normalize(searchQuery.trim()));}
function sparkline(values){const items=values?.length?values:[{probability:.5}];const p=items.map(x=>x.probability);let path=`M0,${(36-p[0]*32).toFixed(2)}`;for(let i=1;i<p.length;i++)path+=` H${(i/(p.length-1)*145).toFixed(2)} V${(36-p[i]*32).toFixed(2)}`;return path+' H145';}
function renderCatalog(){
 const categories=[...new Set(data.markets.map(m=>m.category))];
 $('categoryFilters').innerHTML=[['all','Все события'],...categories.map(c=>[c,c])].map(([key,label])=>`<button data-category="${escapeHtml(key)}" class="${key===category?'subnav-active':''}" aria-pressed="${key===category}">${escapeHtml(label)}</button>`).join('');
 let markets=data.markets.filter(m=>(category==='all'||m.category===category)&&matches(m));if(sortOrder==='closing')markets.sort((a,b)=>a.closes_at-b.closes_at);if(sortOrder==='newest')markets.sort((a,b)=>b.created_at-a.created_at);
 $('marketGrid').innerHTML=markets.map(m=>`<article class="market-card"><div class="market-card-top"><div class="market-icon market-color-${m.color}" aria-hidden="true">${escapeHtml(m.icon)}</div><div class="market-card-copy"><span class="market-card-category">${escapeHtml(m.category)} · ${escapeHtml(m.topic)}</span><h2><a class="market-card-title" href="#market/${encodeURIComponent(m.id)}">${escapeHtml(m.title)}</a></h2></div></div><div class="market-card-middle"><div class="market-card-probability">${fmt(m.probability*100,1)}<small>%</small><span>${m.status==='resolved'?'Итог: '+titles[m.outcome]:'Вероятность «Да»'}</span></div><svg class="mini-chart" viewBox="0 0 145 40" aria-hidden="true"><path d="${sparkline(m.history)}"/></svg></div><div class="market-card-date">${m.status==='resolved'?'<span>Событие завершено</span>':'До '+shortDate(m.closes_at)}</div><div class="market-card-actions"><a href="#market/${encodeURIComponent(m.id)}" data-open-side="yes" data-market-id="${m.id}" class="yes">Да <strong>${fmt(m.probability*100)} Б</strong></a><a href="#market/${encodeURIComponent(m.id)}" data-open-side="no" data-market-id="${m.id}" class="no">Нет <strong>${fmt((1-m.probability)*100)} Б</strong></a></div></article>`).join('');
 $('catalogEmpty').hidden=markets.length>0;
}
$('categoryFilters').onclick=e=>{const button=e.target.closest('[data-category]');if(!button)return;category=button.dataset.category;renderCatalog();navigate('catalog');};
$('marketSort').onchange=()=>{sortOrder=$('marketSort').value;renderCatalog();};
$('resetFilters').onclick=()=>{category='all';searchQuery='';$('searchInput').value='';renderCatalog();};
$('marketGrid').onclick=e=>{const a=e.target.closest('[data-open-side]');if(!a)return;e.preventDefault();navigate('detail',a.dataset.marketId);choose(a.dataset.openSide,'buy');};
function renderMarket(){
 if(!market)return;const p=market.probability;
 $('eventTitle').textContent=market.title;$('eventTopic').textContent=[market.location,market.topic].filter(Boolean).join(' · ');$('eventCategory').textContent=market.category;$('eventIcon').textContent=market.icon;$('tradeIcon').textContent=market.icon;
 const colors={blue:['#243857','#a5c5ff'],green:['#1d3f34','#83d1ac'],orange:['#483323','#f3bc7b'],red:['#482b35','#e7a1b0'],purple:['#352c51','#bba3e8'],cyan:['#1e3c49','#8acbdf'],silver:['#303841','#d0d7e2']};const color=colors[market.color]??colors.blue;const art=document.querySelector('.event-art');art.style.setProperty('--event-art-bg',color[0]);art.style.setProperty('--event-art-color',color[1]);document.querySelector('.rails').hidden=market.id!=='metro-spb-2026';
 $('tradeIcon').className='mini-metro market-color-'+market.color;$('tradeTitle').textContent=market.title;$('tradeCategory').textContent=market.category;$('eventDeadline').textContent='Завершение '+date(market.closes_at)+' МСК';$('rulesText').textContent=market.rules;$('resolutionSource').textContent=market.sourceName+' ↗';$('resolutionSource').href=market.sourceUrl;
 $('marketProbability').innerHTML=`${fmt(p*100,1)}<span>%</span>`;$('marketStatus').innerHTML=market.status==='resolved'?`Итог: ${titles[market.outcome]}`:market.tradingOpen?'<i></i>Торги открыты':'Приём заявок завершён';
 document.querySelectorAll('.outcome-probability').forEach((el,i)=>el.innerHTML=`${fmt((i?1-p:p)*100,1)}<span>%</span>`);document.querySelectorAll('.outcome-name div>span').forEach((el,i)=>el.textContent=i?market.noDescription:market.yesDescription);
 document.querySelectorAll('[data-side]').forEach(button=>{const s=button.dataset.side;button.innerHTML=`Купить ${titles[s]} <span>${fmt((s==='yes'?p:1-p)*100)} Б</span><svg><use href="#arrow"/></svg>`;button.disabled=!market.tradingOpen;});
 $('yesButton').innerHTML=`<span>Да</span><strong>${fmt(p*100)} Б</strong>`;$('noButton').innerHTML=`<span>Нет</span><strong>${fmt((1-p)*100)} Б</strong>`;$('bookmarkButton').setAttribute('aria-pressed',String(data.bookmarks.includes(market.id)));
 $('priceExplanation').textContent='Цена всей заявки зависит от её размера. Выигравшая доля погашается по 100 Б.';$('chart').setAttribute('aria-label',`Вероятность: Да ${fmt(p*100,1)}%, Нет ${fmt((1-p)*100,1)}%`);renderForm();
}
function renderForm(){
 if(!market||!data)return;const buy=action==='buy',guest=!data.user;
 $('yesButton').className='side-button'+(side==='yes'?' active-yes':'');$('noButton').className='side-button'+(side==='no'?' active-no':'');for(const s of ['yes','no'])$(s+'Button').setAttribute('aria-pressed',String(s===side));for(const a of ['buy','sell']){$(a+'Tab').classList.toggle('active',a===action);$(a+'Tab').setAttribute('aria-selected',String(a===action));}
 document.querySelector('label[for="amount"]').textContent=buy?'Сумма покупки':'Количество долей';$('amount').step=buy?'0.01':'0.001';document.querySelector('.amount-input>span').textContent=buy?'Б':'долей';$('availableBalance').textContent=guest?'':buy?`Доступно ${points(data.user.balanceCents)}`:`В наличии ${fmt(holding()/1000,3)} долей`;
 document.querySelectorAll('[data-add]').forEach((b,i)=>{const value=(buy?[100,500,1000]:[1,5,10])[i];b.dataset.add=value;b.textContent='+'+fmt(value);});
 const disabled=submitting||Boolean(pendingTrade)||!market.tradingOpen;for(const id of ['amount','yesButton','noButton','buyTab','sellTab','maxAmount'])$(id).disabled=disabled;$('sellTab').disabled=disabled||guest;$('maxAmount').hidden=guest;document.querySelectorAll('[data-add]').forEach(b=>b.disabled=disabled);
 $('shares').textContent=quote?fmt(quote.units/1000,3):'—';$('payout').textContent=quote?points(buy?quote.maxPayoutCents:quote.cashCents):'—';$('returnLabel').textContent=buy?'Выплата при выигрыше':'Вы получите';$('averagePrice').textContent=quote?`${fmt(quote.averagePriceCents/100)} Б`:'—';$('quoteCost').textContent=quote?points(quote.cashCents):'—';$('afterProbability').textContent=quote?`${fmt((side==='yes'?quote.probabilityAfter:1-quote.probabilityAfter)*100)}%`:'—';
 const submit=$('submitTrade');submit.disabled=submitting||!market.tradingOpen||(!guest&&!pendingTrade&&!quote);submit.innerHTML=submitting?'Исполняем заявку…':pendingTrade?'Проверить статус сделки':!market.tradingOpen?'Торги закрыты':guest?`Войти, чтобы купить ${titles[side]}`:`${buy?'Купить':'Продать'} ${titles[side]}<svg><use href="#arrow"/></svg>`;
}
function invalidateQuote(){quote=null;quoteSequence++;clearTimeout(quoteTimer);renderForm();}
function inputChanged(){if(pendingTrade||submitting)return;invalidateQuote();showError('');if(Number($('amount').value)>0)quoteTimer=setTimeout(loadQuote,250);}
async function loadQuote(){
 if(!market?.tradingOpen)return;const sequence=++quoteSequence,id=market.id,value=Number($('amount').value);quote=null;renderForm();if(!Number.isFinite(value)||value<=0)return;
 const amount=action==='buy'?{amountCents:Math.round(value*100)}:{units:Math.round(value*1000)};if(Math.abs(value*(action==='buy'?100:1000)-Object.values(amount)[0])>0.00001){showError(action==='buy'?'Укажите сумму с точностью до 0,01 Б.':'Укажите количество с точностью до 0,001 доли.');return;}
 try{const result=data.user?await api('quote',{marketId:id,side,action,...amount}):await api(`quote?marketId=${encodeURIComponent(id)}&side=${side}&amountCents=${amount.amountCents}`);if(sequence!==quoteSequence||market.id!==id)return;quote=result;showError('');renderForm();}catch(e){if(sequence===quoteSequence){showError(e.message);renderForm();}}
}
function choose(s,a=action){if(pendingTrade||submitting)return;side=s;action=a;$('amount').value='';invalidateQuote();showError('');}
$('yesButton').onclick=()=>choose('yes');$('noButton').onclick=()=>choose('no');$('buyTab').onclick=()=>choose(side,'buy');$('sellTab').onclick=()=>choose(side,'sell');$('amount').oninput=inputChanged;document.querySelectorAll('[data-add]').forEach(button=>button.onclick=()=>{$('amount').value=(Number($('amount').value)||0)+Number(button.dataset.add);inputChanged();});
$('maxAmount').onclick=()=>{if(!data.user)return;$('amount').value=action==='buy'?data.user.balanceCents/100:Math.min(holding(),10000000)/1000;inputChanged();};
document.querySelectorAll('[data-side]').forEach(button=>button.onclick=()=>{choose(button.dataset.side,'buy');document.querySelector('.trade-card').scrollIntoView({behavior:'smooth',block:'center'});$('amount').focus({preventScroll:true});});
$('submitTrade').onclick=async()=>{
 if(!data?.user){showAuth('login');return;}if(submitting||(!pendingTrade&&!quote))return;
 if(!pendingTrade){pendingTrade={marketId:quote.marketId,side:quote.side,action:quote.action,units:quote.units,marketVersion:quote.marketVersion,cashLimitCents:quote.cashCents,idempotencyKey:crypto.randomUUID()};pendingStore();}
 submitting=true;renderForm();showError('');
 try{const result=await api('trades',pendingTrade);pendingTrade=null;pendingStore();$('amount').value='';invalidateQuote();toast(`${result.replayed?'Сделка уже исполнена: ':''}${result.trade.action==='buy'?'Куплено':'Продано'} ${fmt(result.trade.units/1000,3)} долей «${titles[result.trade.side]}» за ${points(result.trade.cash_cents)}`);await refresh(true);}
 catch(e){if(e.status&&e.status<500){pendingTrade=null;pendingStore();showError(e.message);if(e.code==='price_changed'){await refresh(true);await loadQuote();showError('Цена изменилась. Проверьте новую котировку и подтвердите заявку ещё раз.');}if(e.status===401)showAuth('login');}else showError('Ответ не получен. Нажмите «Проверить статус сделки»: повторного списания не будет.');}finally{submitting=false;renderForm();}
};
function accountTab(tab){document.querySelectorAll('[data-account-tab]').forEach(b=>{const selected=b.dataset.accountTab===tab;b.classList.toggle('active',selected);b.setAttribute('aria-selected',String(selected));});for(const name of ['positions','trades','ledger','profile'])$('account'+name[0].toUpperCase()+name.slice(1)).hidden=name!==tab;}
document.querySelectorAll('[data-account-tab]').forEach(b=>b.onclick=()=>accountTab(b.dataset.accountTab));
function renderAccount(){
 if(!data?.user)return;const u=data.user;$('accountName').textContent=u.displayName;$('accountEmail').textContent=u.email;$('accountBalance').textContent=points(u.balanceCents);$('profileEmail').textContent=u.email;if(document.activeElement!==$('displayName'))$('displayName').value=u.displayName;
 $('accountPositions').innerHTML=data.positions.length?data.positions.map(p=>`<article class="account-position"><div class="position-top"><strong><a href="#market/${encodeURIComponent(p.market_id)}">${escapeHtml(p.title)}</a></strong><span class="position-side ${p.side}">${titles[p.side]}</span></div><div class="position-values"><div><span>Ваши доли</span><strong>${fmt(p.units/1000,3)}</strong></div><div><span>${p.status==='resolved'?'Начислено при погашении':'Оценка продажи всей позиции'}</span><strong>${points(p.status==='resolved'?p.payoutCents:p.liquidationCents)}</strong></div><div><span>${p.status==='resolved'?'Итог':'Выплата при победе'}</span><strong>${p.status==='resolved'?titles[p.outcome]:points(p.units*10)}</strong></div></div>${p.status==='open'?`<button class="outline-button" data-sell-position="${p.side}" data-market-id="${p.market_id}">Продать доли →</button>`:'<span class="settled-tag">Позиция погашена</span>'}</article>`).join(''):'<div class="account-empty"><h2>Пока нет позиций</h2><p>Выберите событие и купите доли.</p><button id="emptyMarket" class="outline-button">Перейти к событиям →</button></div>';
 $('emptyMarket')?.addEventListener('click',()=>navigate('catalog'));document.querySelectorAll('[data-sell-position]').forEach(b=>b.onclick=()=>{navigate('detail',b.dataset.marketId);choose(b.dataset.sellPosition,'sell');$('amount').value=Math.min(holding(),10000000)/1000;inputChanged();document.querySelector('.trade-card').scrollIntoView({behavior:'smooth',block:'center'});});
 $('accountTrades').innerHTML=data.trades.length?`<div class="table-scroll"><table><thead><tr><th>Дата, МСК</th><th>Событие</th><th>Операция</th><th>Доли</th><th>Сумма</th></tr></thead><tbody>${data.trades.map(t=>`<tr><td>${date(t.created_at)}</td><td class="trade-market-title"><a href="#market/${encodeURIComponent(t.market_id)}">${escapeHtml(t.title)}</a></td><td>${t.action==='buy'?'Покупка':'Продажа'} <span class="${t.side}">${titles[t.side]}</span></td><td>${fmt(t.units/1000,3)}</td><td>${points(t.cash_cents)}</td></tr>`).join('')}</tbody></table></div><p class="account-footnote">Показаны последние 200 сделок.</p>`:'<div class="account-empty"><h2>Пока нет сделок</h2><p>Покупки и продажи появятся здесь.</p></div>';
 const kinds={welcome:'Начальный баланс',buy:'Покупка долей',sell:'Продажа долей',settlement:'Погашение выигравших долей'};$('accountLedger').innerHTML=`<div class="ledger-list">${data.ledger.map(l=>`<div class="ledger-row"><div><strong>${kinds[l.kind]||escapeHtml(l.kind)}</strong><span>${date(l.created_at)} МСК</span></div><strong class="${l.delta_cents>=0?'positive':''}">${l.delta_cents>0?'+':''}${points(l.delta_cents)}</strong></div>`).join('')}</div>`;
 const open=data.markets.filter(m=>m.status==='open');$('adminPanel').hidden=!u.isAdmin||!open.length;const selected=$('resolutionMarket').value;$('resolutionMarket').innerHTML=open.map(m=>`<option value="${m.id}">${escapeHtml(m.title)}</option>`).join('');if(open.some(m=>m.id===selected))$('resolutionMarket').value=selected;
}
$('profileForm').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;try{await api('profile',{displayName:$('displayName').value},'PATCH');await refresh();toast('Профиль сохранён');}catch(error){toast(error.message);}finally{b.disabled=false;}};
$('prepareResolution').onclick=()=>{const selected=data.markets.find(m=>m.id===$('resolutionMarket').value);if(!selected)return;resolution={marketId:selected.id,outcome:$('resolutionSide').value};$('resolutionConfirm').hidden=false;$('resolutionConfirmText').textContent=`${selected.title} Итог «${titles[resolution.outcome]}». Торги закроются, победителям будут начислены выплаты. Изменить итог после подтверждения нельзя.`;$('resolutionSide').disabled=true;$('resolutionMarket').disabled=true;};
$('cancelResolution').onclick=()=>{resolution=null;$('resolutionConfirm').hidden=true;$('resolutionSide').disabled=false;$('resolutionMarket').disabled=false;};
$('resolveMarket').onclick=async()=>{if(!resolution)return;$('resolveMarket').disabled=true;try{await api('resolve',resolution);resolution=null;$('resolutionConfirm').hidden=true;await refresh(true);toast('Событие завершено. Выплаты начислены.');}catch(e){toast(e.message);}finally{$('resolveMarket').disabled=false;$('resolutionSide').disabled=false;$('resolutionMarket').disabled=false;}};
for(const id of ['portfolioNav','balanceButton','profileButton'])$(id).onclick=()=>navigate('account');for(const id of ['marketsNav','backMarkets','accountBack'])$(id).onclick=()=>{navigate('catalog');window.scrollTo({top:0,behavior:'smooth'});};
$('bookmarkButton').onclick=async()=>{if(!data?.user){showAuth('login');return;}try{const saved=!data.bookmarks.includes(market.id);await api('bookmark',{marketId:market.id,saved});await refresh();toast(saved?'Событие сохранено':'Событие удалено из сохранённых');}catch(e){toast(e.message);}};
function showTab(which){for(const key of ['rules','about']){$(key+'Content').hidden=key!==which;$(key+'Tab').classList.toggle('active',key===which);$(key+'Tab').setAttribute('aria-selected',String(key===which));}}
$('rulesTab').onclick=()=>showTab('rules');$('aboutTab').onclick=()=>showTab('about');$('howButton').onclick=()=>{showTab('about');$('aboutContent').scrollIntoView({behavior:'smooth',block:'center'});};
$('searchInput').oninput=()=>{if(!data)return;searchQuery=$('searchInput').value;renderCatalog();const q=searchQuery.trim();$('searchResults').hidden=!q;if(q){const result=data.markets.filter(matches).slice(0,6);$('searchResults').innerHTML=result.length?result.map(m=>`<a href="#market/${encodeURIComponent(m.id)}">${escapeHtml(m.title)}</a>`).join(''):'<div class="empty-search">Ничего не найдено</div>';}};
$('searchResults').onclick=e=>{if(e.target.closest('a'))$('searchResults').hidden=true;};document.addEventListener('click',e=>{if(!e.target.closest('.search-wrap'))$('searchResults').hidden=true;});document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('searchInput').focus();}if(e.key==='Escape')$('searchResults').hidden=true;});
const periodMap={'1Д':'1d','1Н':'1w','1М':'1m','3М':'3m','ВСЁ':'all'};
let historyRequest=0;
async function loadHistory(){if(!market)return;const request=++historyRequest,id=market.id;try{const result=await api(`history?marketId=${encodeURIComponent(id)}&period=${period}`);if(request!==historyRequest||market?.id!==id)return;history=result.points;serverTime=result.serverTime;drawChart();}catch(e){toast('Не удалось обновить историю цен.');}}
document.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>{period=periodMap[b.dataset.period];document.querySelectorAll('[data-period]').forEach(el=>el.classList.toggle('selected',el===b));loadHistory();});
let chartDomain={start:0,end:0};
function drawChart(){
 const svg=$('chart');if(!history.length){svg.innerHTML='';return;}
 const intervals={'1d':86400000,'1w':604800000,'1m':2592000000,'3m':7776000000};
 const end=Math.max(serverTime,history.at(-1).created_at),cutoff=intervals[period]?end-intervals[period]:history[0].created_at;
 const start=Math.min(end-60000,Math.max(history[0].created_at,cutoff));chartDomain={start,end};
 const right=785,top=16,bottom=260,x=t=>Math.max(0,Math.min(right,(t-start)/(end-start)*right)),y=p=>bottom-p*(bottom-top);
 const stepPath=invert=>{let path='';history.forEach((point,i)=>{const yy=y(invert?1-point.probability:point.probability),xx=x(point.created_at);path+=i?` H${xx.toFixed(2)} V${yy.toFixed(2)}`:`M${xx.toFixed(2)},${yy.toFixed(2)}`;});return path+` H${right}`;};
 const yes=stepPath(false),no=stepPath(true),last=history.at(-1).probability;
 let html='<defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#427dff" stop-opacity=".16"/><stop offset="100%" stop-color="#427dff" stop-opacity="0"/></linearGradient></defs>';
 for(const value of [0,25,50,75,100])html+=`<line class="grid-line" x1="0" x2="832" y1="${y(value/100)}" y2="${y(value/100)}"/><text class="axis-label" x="845" y="${y(value/100)+4}">${value}%</text>`;
 html+=`<path d="${yes} L${right},${bottom} L${x(history[0].created_at)},${bottom} Z" fill="url(#area)"/><path class="no-line" d="${no}"/><path class="yes-line" d="${yes}"/><circle cx="${right}" cy="${y(last)}" r="10" fill="#4377ff" opacity=".15"/><circle cx="${right}" cy="${y(last)}" r="4" fill="#8fb8ff"/><text x="800" y="${y(last)+4}" fill="#91b8ff" font-size="11" font-family="inherit">${fmt(last*100,1)}</text>`;
 if(Math.abs(last-.5)>.03)html+=`<text x="800" y="${y(1-last)+4}" fill="#7c729d" font-size="11" font-family="inherit">${fmt((1-last)*100,1)}</text>`;
 const span=end-start,formatter=new Intl.DateTimeFormat('ru-RU',span<172800000?{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'}:{day:'2-digit',month:'short',timeZone:'Europe/Moscow'});
 for(let i=0;i<6;i++)html+=`<text class="axis-label" x="${i/5*right}" y="290" text-anchor="${i===0?'start':i===5?'end':'middle'}">${formatter.format(new Date(start+span*i/5))}</text>`;
 html+='<line id="crosshair" x1="0" x2="0" y1="16" y2="260" stroke="#748aaa" stroke-dasharray="3 4" opacity="0"/><circle id="hoverDot" r="4" fill="#c3d8ff" opacity="0"/>';svg.innerHTML=html;
 document.querySelector('.chart-note').textContent='Время МСК';
}
$('chartContainer').onpointermove=e=>{if(!history.length)return;const r=$('chart').getBoundingClientRect(),px=Math.max(0,Math.min(785,(e.clientX-r.left)/r.width*880));const time=chartDomain.start+px/785*(chartDomain.end-chartDomain.start);let point=history[0];for(const h of history){if(h.created_at>time)break;point=h;}const cy=260-point.probability*244;$('crosshair').setAttribute('x1',px);$('crosshair').setAttribute('x2',px);$('crosshair').setAttribute('opacity','1');$('hoverDot').setAttribute('cx',px);$('hoverDot').setAttribute('cy',cy);$('hoverDot').setAttribute('opacity','1');const tip=$('chartTooltip');tip.textContent=`${date(time)} · Да ${fmt(point.probability*100,1)}%`;tip.hidden=false;tip.style.left=`${Math.max(0,Math.min(e.clientX-r.left-90,r.width-220))}px`;tip.style.top='8px';};
$('chartContainer').onpointerleave=()=>{$('chartTooltip').hidden=true;$('crosshair')?.setAttribute('opacity','0');$('hoverDot')?.setAttribute('opacity','0');};
let refreshPromise=null;
async function refresh(reloadHistory=false){
 if(refreshPromise){await refreshPromise;if(reloadHistory)return refresh(true);return;}
 refreshPromise=loadData(reloadHistory);try{await refreshPromise;}finally{refreshPromise=null;}
}
async function loadData(reloadHistory){
 refreshing=true;
 try{
  const [catalog,session]=await Promise.all([api('markets'),api('session')]);let account=emptyAccount;
  if(session.authenticated){try{account=await api(data?.user?'state':'bootstrap',data?.user?undefined:{});}catch(e){if(e.status!==401)throw e;}}
  const userChanged=data?.user?.id!==account.user?.id;data={...emptyAccount,...account,markets:catalog.markets};if(userChanged)readPending();renderHeader();renderCatalog();if(data.user)renderAccount();applyRoute(reloadHistory);$('connectionBanner').hidden=true;
 }catch(e){$('connectionBanner').hidden=false;$('connectionBanner').textContent='Не удалось обновить события. '+(data?'Проверьте подключение.':e.message);}
 finally{refreshing=false;}
}
function setAuthMode(mode){authMode=mode;$('authHeading').textContent=mode==='register'?'Создать аккаунт':'Войти в аккаунт';$('authNameField').hidden=mode!=='register';$('authName').required=mode==='register';$('authPassword').minLength=mode==='register'?10:1;$('authPassword').autocomplete=mode==='register'?'new-password':'current-password';$('authSubmit').textContent=mode==='register'?'Создать аккаунт →':'Войти →';$('authError').hidden=true;for(const m of ['login','register']){$(m+'AuthTab').classList.toggle('active',m===mode);$(m+'AuthTab').setAttribute('aria-selected',String(m===mode));}}
function showAuth(mode='login'){setAuthMode(mode);if(!$('authDialog').open)$('authDialog').showModal();}
$('loginButton').onclick=()=>showAuth('login');$('registerButton').onclick=()=>showAuth('register');$('loginAuthTab').onclick=()=>setAuthMode('login');$('registerAuthTab').onclick=()=>setAuthMode('register');$('closeAuth').onclick=()=>$('authDialog').close();
$('authDialog').addEventListener('close',()=>{if(route().view==='account'&&!data?.user)navigate('catalog');});$('authDialog').onclick=e=>{if(e.target!==$('authDialog'))return;const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();};
$('authForm').onsubmit=async e=>{e.preventDefault();$('authSubmit').disabled=true;$('authError').hidden=true;try{await api('auth/'+authMode,{email:$('authEmail').value,password:$('authPassword').value,displayName:$('authName').value});await refresh(true);if(data?.user)$('authDialog').close();else throw new Error('Не удалось войти в аккаунт. Повторите попытку.');}catch(error){$('authError').textContent=error.message;$('authError').hidden=false;}finally{$('authSubmit').disabled=false;}};
$('logoutButton').onclick=async()=>{try{await api('auth/logout',{});navigate('catalog');await refresh(true);}catch(e){toast(e.message);}};
$('passwordForm').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{await api('auth/password',{currentPassword:$('currentPassword').value,newPassword:$('newPassword').value});navigate('catalog');await refresh(true);showAuth('login');toast('Пароль изменён. Войдите снова.');}catch(error){toast(error.message);}finally{button.disabled=false;}};
refresh(true);setInterval(()=>{if(!document.hidden&&!submitting)refresh();},5000);
