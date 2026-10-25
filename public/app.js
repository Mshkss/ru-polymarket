'use strict';
const $=id=>document.getElementById(id);
const fmt=(n,d=2)=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:d}).format(n);
const points=c=>`${fmt(c/100)} Б`;
const date=t=>new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'}).format(new Date(t));
const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data=null,market=null,side='yes',action='buy',period='all',quote=null,quoteTimer,quoteSequence=0,submitting=false,pendingTrade=null,history=[],serverTime=Date.now(),toastTimer,refreshing=false;
const titles={yes:'Да',no:'Нет'};
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5500);}
async function api(path,body,method=body?'POST':'GET'){
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);
 try{const res=await fetch('/api/'+path,{method,credentials:'same-origin',signal:controller.signal,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});let result;try{result=await res.json();}catch{throw new Error('Сервер вернул некорректный ответ.');}if(!res.ok){const err=new Error(result.error||'Не удалось выполнить запрос.');err.status=res.status;err.code=result.code;throw err;}return result;}finally{clearTimeout(timeout);}
}
function holding(s=side){return data?.positions.find(p=>p.market_id===market?.id&&p.side===s)?.units??0;}
function showError(message){$('tradeError').textContent=message;$('tradeError').hidden=!message;}
function pendingStore(){if(!data)return;try{const key='ishod-pending:'+data.user.id;if(pendingTrade)sessionStorage.setItem(key,JSON.stringify(pendingTrade));else sessionStorage.removeItem(key);}catch{}}
function navigate(account){location.hash=account?'account':'market';applyRoute();}
function applyRoute(){const account=location.hash==='#account';$('marketPage').hidden=account;$('accountPage').hidden=!account;$('marketsNav').classList.toggle('current',!account);$('portfolioNav').classList.toggle('current',account);if(account&&data)renderAccount();}
window.addEventListener('hashchange',applyRoute);
function renderMarket(){
 if(!data)return;
 market=data.markets[0];const p=market.status==='resolved'?(market.outcome==='yes'?1:0):market.probability;
 $('balance').textContent=fmt(data.user.balanceCents/100);$('profileButton').textContent=data.user.displayName.slice(0,1).toUpperCase();
 $('marketProbability').innerHTML=`${fmt(p*100,1)}<span>%</span>`;
 $('marketStatus').innerHTML=market.status==='resolved'?`Итог: ${titles[market.outcome]}`:market.tradingOpen?'<i></i>Торги открыты':'Приём заявок завершён';
 document.querySelectorAll('.outcome-probability').forEach((el,i)=>el.innerHTML=`${fmt((i?1-p:p)*100,1)}<span>%</span>`);
 document.querySelectorAll('[data-side]').forEach(button=>{const s=button.dataset.side;button.innerHTML=`Купить ${titles[s]} <span>${fmt((s==='yes'?p:1-p)*100,2)} Б</span><svg><use href="#arrow"/></svg>`;button.disabled=!market.tradingOpen;});
 $('yesButton').innerHTML=`<span>Да</span><strong>${fmt(p*100,2)} Б</strong>`;$('noButton').innerHTML=`<span>Нет</span><strong>${fmt((1-p)*100,2)} Б</strong>`;
 $('bookmarkButton').setAttribute('aria-pressed',String(data.bookmarks.includes(market.id)));
 $('priceExplanation').textContent='Указана цена следующей малой доли. Цена всей заявки зависит от её размера. Выигравшая доля погашается по 100 Б.';
 $('chart').setAttribute('aria-label',`Вероятность по сделкам: Да ${fmt(p*100,1)}%, Нет ${fmt((1-p)*100,1)}%`);
 renderForm();renderAccount();
}
function renderForm(){
 if(!data)return;
 const buy=action==='buy';
 $('yesButton').className='side-button'+(side==='yes'?' active-yes':'');$('noButton').className='side-button'+(side==='no'?' active-no':'');
 for(const s of ['yes','no'])$(s+'Button').setAttribute('aria-pressed',String(s===side));
 for(const a of ['buy','sell']){$(a+'Tab').classList.toggle('active',a===action);$(a+'Tab').setAttribute('aria-selected',String(a===action));}
 document.querySelector('label[for="amount"]').textContent=buy?'Сумма покупки':'Количество долей';
 $('amount').step=buy?'0.01':'0.001';document.querySelector('.amount-input>span').textContent=buy?'Б':'долей';
 $('availableBalance').textContent=buy?`Доступно ${points(data.user.balanceCents)}`:`В наличии ${fmt(holding()/1000,3)} долей`;
 document.querySelectorAll('[data-add]').forEach((b,i)=>{const value=(buy?[100,500,1000]:[1,5,10])[i];b.dataset.add=value;b.textContent='+'+fmt(value);});
 const disabled=submitting||Boolean(pendingTrade)||!market.tradingOpen;
 for(const id of ['amount','yesButton','noButton','buyTab','sellTab','maxAmount'])$(id).disabled=disabled;
 document.querySelectorAll('[data-add]').forEach(b=>b.disabled=disabled);
 $('shares').textContent=quote?fmt(quote.units/1000,3):'—';$('payout').textContent=quote?points(buy?quote.maxPayoutCents:quote.cashCents):'—';
 $('returnLabel').textContent=buy?'Выплата при выигрыше':'Вы получите';
 $('averagePrice').textContent=quote?`${fmt(quote.averagePriceCents/100)} Б`:'—';$('quoteCost').textContent=quote?points(quote.cashCents):'—';
 $('afterProbability').textContent=quote?`${fmt((side==='yes'?quote.probabilityAfter:1-quote.probabilityAfter)*100,2)}%`:'—';
 const submit=$('submitTrade');submit.disabled=submitting||(!pendingTrade&&(!quote||!market.tradingOpen));
 submit.innerHTML=submitting?'Исполняем заявку…':pendingTrade?'Проверить статус сделки':!market.tradingOpen?'Торги закрыты':`${buy?'Купить':'Продать'} ${titles[side]}<svg><use href="#arrow"/></svg>`;
}
function invalidateQuote(){quote=null;quoteSequence++;clearTimeout(quoteTimer);renderForm();}
function inputChanged(){if(pendingTrade||submitting)return;invalidateQuote();showError('');if(Number($('amount').value)>0)quoteTimer=setTimeout(loadQuote,250);}
async function loadQuote(){
 if(!data||!market.tradingOpen)return;const sequence=++quoteSequence,value=Number($('amount').value);quote=null;renderForm();
 if(!Number.isFinite(value)||value<=0)return;
 const amount=action==='buy'?{amountCents:Math.round(value*100)}:{units:Math.round(value*1000)};
 if(Math.abs(value*(action==='buy'?100:1000)-Object.values(amount)[0])>0.00001){showError(action==='buy'?'Укажите сумму с точностью до 0,01 Б.':'Укажите количество с точностью до 0,001 доли.');return;}
 try{const result=await api('quote',{marketId:market.id,side,action,...amount});if(sequence!==quoteSequence)return;quote=result;showError('');renderForm();}catch(e){if(sequence===quoteSequence){showError(e.message);renderForm();}}
}
function choose(s,a=action){if(pendingTrade||submitting)return;side=s;action=a;$('amount').value='';invalidateQuote();showError('');renderForm();}
$('yesButton').onclick=()=>choose('yes');$('noButton').onclick=()=>choose('no');$('buyTab').onclick=()=>choose(side,'buy');$('sellTab').onclick=()=>choose(side,'sell');$('amount').oninput=inputChanged;
for(const button of document.querySelectorAll('[data-add]'))button.onclick=()=>{$('amount').value=(Number($('amount').value)||0)+Number(button.dataset.add);inputChanged();};
$('maxAmount').onclick=()=>{$('amount').value=action==='buy'?data.user.balanceCents/100:Math.min(holding(),10000000)/1000;inputChanged();};
document.querySelectorAll('[data-side]').forEach(b=>b.onclick=()=>{choose(b.dataset.side,'buy');document.querySelector('.trade-card').scrollIntoView({behavior:'smooth',block:'center'});$('amount').focus({preventScroll:true});});
$('submitTrade').onclick=async()=>{
 if(submitting||(!pendingTrade&&!quote))return;
 if(!pendingTrade){pendingTrade={marketId:quote.marketId,side:quote.side,action:quote.action,units:quote.units,marketVersion:quote.marketVersion,cashLimitCents:quote.cashCents,idempotencyKey:crypto.randomUUID()};pendingStore();}
 submitting=true;renderForm();showError('');
 try{const result=await api('trades',pendingTrade);pendingTrade=null;pendingStore();$('amount').value='';invalidateQuote();toast(`${result.replayed?'Сделка уже исполнена: ':''}${result.trade.action==='buy'?'Куплено':'Продано'} ${fmt(result.trade.units/1000,3)} долей «${titles[result.trade.side]}» за ${points(result.trade.cash_cents)}`);await refresh(true);}
 catch(e){if(e.status&&e.status<500){pendingTrade=null;pendingStore();showError(e.message);if(e.code==='price_changed'){await refresh(true);await loadQuote();showError('Цена изменилась. Котировка обновлена — проверьте её и подтвердите заявку ещё раз.');}}else{showError('Ответ сервера не получен. Нажмите «Проверить статус сделки»: повторного списания не будет.');}}
 finally{submitting=false;renderForm();}
};
function accountTab(tab){document.querySelectorAll('[data-account-tab]').forEach(b=>{const selected=b.dataset.accountTab===tab;b.classList.toggle('active',selected);b.setAttribute('aria-selected',String(selected));});for(const name of ['positions','trades','ledger','profile'])$('account'+name[0].toUpperCase()+name.slice(1)).hidden=name!==tab;}
document.querySelectorAll('[data-account-tab]').forEach(b=>b.onclick=()=>accountTab(b.dataset.accountTab));
function renderAccount(){
 if(!data)return;const u=data.user;$('accountName').textContent=u.displayName;$('accountEmail').textContent=u.email;$('accountBalance').textContent=points(u.balanceCents);$('profileEmail').textContent=u.email;
 if(document.activeElement!==$('displayName'))$('displayName').value=u.displayName;
 $('accountPositions').innerHTML=data.positions.length?data.positions.map(p=>`<article class="account-position"><div class="position-top"><strong>${escapeHtml(p.title)}</strong><span class="position-side ${p.side}">${titles[p.side]}</span></div><div class="position-values"><div><span>Ваши доли</span><strong>${fmt(p.units/1000,3)}</strong></div><div><span>${p.status==='resolved'?'Начислено при погашении':'Оценка продажи всей позиции'}</span><strong>${points(p.status==='resolved'?p.payoutCents:p.liquidationCents)}</strong></div><div><span>${p.status==='resolved'?'Итог':'Выплата при победе'}</span><strong>${p.status==='resolved'?titles[p.outcome]:points(p.units*10)}</strong></div></div>${p.status==='open'?`<button class="outline-button" data-sell-position="${p.side}">Продать доли →</button>`:'<span class="settled-tag">Позиция погашена</span>'}</article>`).join(''):'<div class="account-empty"><h2>Пока нет позиций</h2><p>Купите доли тестового рынка. Здесь появятся ваши позиции и доступная сумма продажи.</p><button id="emptyMarket" class="outline-button">Перейти к рынку →</button></div>';
 $('emptyMarket')?.addEventListener('click',()=>navigate(false));
 document.querySelectorAll('[data-sell-position]').forEach(b=>b.onclick=()=>{navigate(false);choose(b.dataset.sellPosition,'sell');$('amount').value=Math.min(holding(),10000000)/1000;inputChanged();document.querySelector('.trade-card').scrollIntoView({behavior:'smooth',block:'center'});});
 $('accountTrades').innerHTML=data.trades.length?`<div class="table-scroll"><table><thead><tr><th>Дата, МСК</th><th>Операция</th><th>Доли</th><th>Сумма</th><th>Цена «Да» после</th></tr></thead><tbody>${data.trades.map(t=>`<tr><td>${date(t.created_at)}</td><td>${t.action==='buy'?'Покупка':'Продажа'} <span class="${t.side}">${titles[t.side]}</span></td><td>${fmt(t.units/1000,3)}</td><td>${points(t.cash_cents)}</td><td>${fmt(t.probability_after*100,2)}%</td></tr>`).join('')}</tbody></table></div><p class="account-footnote">Показаны последние 200 сделок. Все суммы — виртуальные баллы.</p>`:'<div class="account-empty"><h2>Вы ещё не совершали сделок</h2><p>История покупок и продаж появится здесь.</p></div>';
 const kinds={welcome:'Начальный баланс',buy:'Покупка долей',sell:'Продажа долей',settlement:'Погашение выигравших долей'};
 $('accountLedger').innerHTML=`<div class="ledger-list">${data.ledger.map(l=>`<div class="ledger-row"><div><strong>${kinds[l.kind]||escapeHtml(l.kind)}</strong><span>${date(l.created_at)} МСК</span></div><strong class="${l.delta_cents>=0?'positive':''}">${l.delta_cents>0?'+':''}${points(l.delta_cents)}</strong></div>`).join('')}</div>`;
 $('adminPanel').hidden=!u.isAdmin||market.status==='resolved';
}
$('profileForm').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{await api('profile',{displayName:$('displayName').value},'PATCH');await refresh(false);toast('Профиль сохранён');}catch(err){toast(err.message);}finally{button.disabled=false;}};
$('prepareResolution').onclick=()=>{$('resolutionConfirm').hidden=false;$('resolutionConfirmText').textContent=`Подтвердите исход «${titles[$('resolutionSide').value]}». Торги закроются, а все выигравшие доли будут оплачены. Изменить итог после подтверждения нельзя.`;$('resolutionSide').disabled=true;};
$('cancelResolution').onclick=()=>{$('resolutionConfirm').hidden=true;$('resolutionSide').disabled=false;};
$('resolveMarket').onclick=async()=>{$('resolveMarket').disabled=true;try{await api('resolve',{marketId:market.id,outcome:$('resolutionSide').value});$('resolutionConfirm').hidden=true;await refresh(true);toast('Рынок завершён. Выплаты начислены всем владельцам выигравших долей.');}catch(e){toast(e.message);}finally{$('resolveMarket').disabled=false;$('resolutionSide').disabled=false;}};
for(const id of ['portfolioNav','balanceButton','profileButton'])$(id).onclick=()=>navigate(true);
for(const id of ['marketsNav','allMarkets','backMarkets','accountBack'])$(id).onclick=()=>{navigate(false);window.scrollTo({top:0,behavior:'smooth'});};
$('bookmarkButton').onclick=async()=>{if(!data)return;try{const saved=!data.bookmarks.includes(market.id);await api('bookmark',{marketId:market.id,saved});await refresh(false);toast(saved?'Событие сохранено в аккаунте':'Событие удалено из сохранённых');}catch(e){toast(e.message);}};
function showTab(which){const rules=which==='rules';$('rulesContent').hidden=!rules;$('aboutContent').hidden=rules;for(const key of ['rules','about']){$(key+'Tab').classList.toggle('active',key===which);$(key+'Tab').setAttribute('aria-selected',String(key===which));}}
$('rulesTab').onclick=()=>showTab('rules');$('aboutTab').onclick=()=>showTab('about');$('howButton').onclick=()=>{showTab('about');$('aboutContent').scrollIntoView({behavior:'smooth',block:'center'});};
$('searchInput').oninput=()=>{const q=$('searchInput').value.trim().toLowerCase();$('searchResults').hidden=!q;if(q)$('searchResults').innerHTML=market&&market.title.toLowerCase().includes(q)?'<button id="searchEvent">'+escapeHtml(market.title)+'</button>':'Других событий пока нет';$('searchEvent')?.addEventListener('click',()=>{$('searchResults').hidden=true;$('searchInput').value='';navigate(false);});};
document.addEventListener('click',e=>{if(!e.target.closest('.search-wrap'))$('searchResults').hidden=true;});document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('searchInput').focus();}if(e.key==='Escape')$('searchResults').hidden=true;});
const periodMap={'1Д':'1d','1Н':'1w','1М':'1m','3М':'3m','ВСЁ':'all'};
let historyRequest=0;
async function loadHistory(){if(!market)return;const request=++historyRequest;try{const result=await api(`history?marketId=${encodeURIComponent(market.id)}&period=${period}`);if(request!==historyRequest)return;history=result.points;serverTime=result.serverTime;drawChart();}catch(e){toast('Не удалось обновить историю цен.');}}
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
 document.querySelector('.chart-note').textContent=market.version===0?'Сделок пока нет · начальная цена 50%':'История исполненных сделок · время МСК';
}
$('chartContainer').onpointermove=e=>{if(!history.length)return;const r=$('chart').getBoundingClientRect(),px=Math.max(0,Math.min(785,(e.clientX-r.left)/r.width*880));const time=chartDomain.start+px/785*(chartDomain.end-chartDomain.start);let point=history[0];for(const h of history){if(h.created_at>time)break;point=h;}const cy=260-point.probability*244;$('crosshair').setAttribute('x1',px);$('crosshair').setAttribute('x2',px);$('crosshair').setAttribute('opacity','1');$('hoverDot').setAttribute('cx',px);$('hoverDot').setAttribute('cy',cy);$('hoverDot').setAttribute('opacity','1');const tip=$('chartTooltip');tip.textContent=`${date(time)} · Да ${fmt(point.probability*100,1)}%`;tip.hidden=false;tip.style.left=`${Math.max(0,Math.min(e.clientX-r.left-90,r.width-220))}px`;tip.style.top='8px';};
$('chartContainer').onpointerleave=()=>{$('chartTooltip').hidden=true;$('crosshair')?.setAttribute('opacity','0');$('hoverDot')?.setAttribute('opacity','0');};
async function refresh(withHistory=false){
 if(refreshing)return;refreshing=true;
 try{const next=await api('state');const changed=market?.version!==next.markets[0]?.version;data=next;renderMarket();if(changed||withHistory){await loadHistory();if(!submitting&&!pendingTrade&&Number($('amount').value)>0)await loadQuote();}$('connectionBanner').hidden=true;}
 catch(e){$('connectionBanner').hidden=false;$('connectionBanner').textContent='Нет связи с сервером. Баланс и цены могут быть устаревшими.';if(e.status===401)$('signInPanel').hidden=false;}
 finally{refreshing=false;}
}
async function start(){
 try{data=await api('bootstrap',{});market=data.markets[0];try{pendingTrade=JSON.parse(sessionStorage.getItem('ishod-pending:'+data.user.id));}catch{}renderMarket();applyRoute();await loadHistory();$('connectionBanner').hidden=true;if(pendingTrade)showError('Есть неподтверждённая заявка. Проверьте её статус перед новой сделкой.');setInterval(()=>{if(!document.hidden&&!submitting)refresh(false);},5000);}
 catch(e){$('connectionBanner').textContent=e.message;if(e.status===401){$('signInPanel').hidden=false;$('marketPage').hidden=true;$('accountPage').hidden=true;}else{$('connectionBanner').innerHTML=escapeHtml(e.message)+' <button id="retryConnection">Повторить</button>';$('retryConnection').onclick=start;}}
}
applyRoute();start();
