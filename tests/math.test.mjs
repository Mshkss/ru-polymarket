import test from 'node:test';
import assert from 'node:assert/strict';
import {probability,cost,positionLiquidationCents,tradeCash,unitsForBudget,redemptionCents} from '../lib/market-math.mjs';
const base={q_yes:0,q_no:0,liquidity:100};
test('initial probabilities, complementary prices, stable extreme quantities',()=>{
 assert.equal(probability(base),.5);
 for(const q of [-1000000000,-10000,0,10000,1000000000]){
  const p=probability({...base,q_yes:Math.max(0,q),q_no:Math.max(0,-q)});
  assert.ok(Number.isFinite(p)&&p>=0&&p<=1);
  assert.ok(Number.isFinite(cost(Math.max(0,q),Math.max(0,-q),100)));
 }
 assert.equal(redemptionCents(1000),10000);
});
test('buy moves price in its direction, price is not static unit price',()=>{
 const yes=tradeCash(base,'yes','buy',100000);
 assert.ok(yes.probabilityAfter>.73&&yes.probabilityAfter<.74);
 assert.ok(yes.cash>500000&&yes.cash<1000000);
 const no=tradeCash(base,'no','buy',100000);
 assert.ok(no.probabilityAfter<.27);
 assert.equal(no.cash,yes.cash);
});
test('budget inversion maximizes shares without overspending',()=>{
 for(const amount of [1,10,100,1000,100000,1000000])for(const side of ['yes','no']){
  const market={...base,q_yes:45000,q_no:12000};
  const units=unitsForBudget(market,side,amount);
  if(units===0){assert.ok(tradeCash(market,side,'buy',1).cash>amount);continue;}
  assert.ok(tradeCash(market,side,'buy',units).cash<=amount);
  assert.ok(tradeCash(market,side,'buy',units+1).cash>amount);
 }
});
test('round trips cannot create funds; full sets cost exactly the payout',()=>{
 for(let i=1;i<=300;i++){
  const m={...base,q_yes:i*1711,q_no:i*719};const units=i*113;const side=i%2?'yes':'no';
  const buy=tradeCash(m,side,'buy',units),after={...m,q_yes:buy.qYes,q_no:buy.qNo};
  const sell=tradeCash(after,side,'sell',units);
  assert.ok(sell.cash<=buy.cash);
  assert.equal(sell.qYes,m.q_yes);assert.equal(sell.qNo,m.q_no);
 }
 const yes=tradeCash(base,'yes','buy',10000),no=tradeCash({...base,q_yes:yes.qYes},'no','buy',10000);
 assert.ok(yes.cash+no.cash>=100000);assert.ok(yes.cash+no.cash<=100002);
});
test('rejects negative, oversized, fractional quantities and short sales',()=>{
 for(const units of [-1,0,0.5,NaN,Infinity,10000001])assert.throws(()=>tradeCash(base,'yes','buy',units));
 assert.throws(()=>tradeCash(base,'yes','sell',1000));
});

test('large holdings can be valued without removing the order execution cap',()=>{
 const market={...base,q_yes:20000000};
 assert.ok(Number.isFinite(positionLiquidationCents(market,'yes',20000000)));
 assert.throws(()=>tradeCash(market,'yes','sell',20000000));
});
