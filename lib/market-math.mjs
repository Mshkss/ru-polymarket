// LMSR, two mutually exclusive outcomes. Payout: 100 points per share.
// Cash is integer hundredths of a point; shares are integer thousandths.
export const SHARE_SCALE = 1000;
export const PAYOUT_CENTS = 10000;
export const STARTING_BALANCE_CENTS = 1000000;
export const MAX_ORDER_UNITS = 10000000;
export function probability(market) {
  const z = (market.q_yes - market.q_no) / SHARE_SCALE / market.liquidity;
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}
export function cost(qYes, qNo, b) {
  const a = qYes / SHARE_SCALE / b, c = qNo / SHARE_SCALE / b;
  const max = Math.max(a,c);
  return PAYOUT_CENTS * b * (max + Math.log1p(Math.exp(-Math.abs(a-c))));
}
export function tradeCash(market, side, action, units) {
  if (!['yes','no'].includes(side) || !['buy','sell'].includes(action)) throw new Error('Invalid order');
  if (!Number.isSafeInteger(units) || units <= 0 || units > MAX_ORDER_UNITS) throw new Error('Invalid quantity');
  const delta = action === 'buy' ? units : -units;
  const qYes = market.q_yes + (side === 'yes' ? delta : 0);
  const qNo = market.q_no + (side === 'no' ? delta : 0);
  if (qYes < 0 || qNo < 0) throw new Error('Negative supply');
  const before = cost(market.q_yes,market.q_no,market.liquidity);
  const after = cost(qYes,qNo,market.liquidity);
  const raw = action === 'buy' ? after - before : before - after;
  // Conservative rounding prevents profitable buy/sell loops caused by rounding.
  const cash = action === 'buy' ? Math.max(1,Math.ceil(raw - 1e-7)) : Math.max(0,Math.floor(raw + 1e-7));
  return {cash, qYes, qNo, probabilityAfter:probability({...market,q_yes:qYes,q_no:qNo})};
}
export function unitsForBudget(market, side, budgetCents) {
  if (!Number.isSafeInteger(budgetCents) || budgetCents < 1) return 0;
  let lo=0,hi=MAX_ORDER_UNITS;
  while(lo<hi){const mid=Math.floor((lo+hi+1)/2);if(tradeCash(market,side,'buy',mid).cash<=budgetCents)lo=mid;else hi=mid-1;}
  return lo;
}
export function redemptionCents(units){if(!Number.isSafeInteger(units)||units<0)throw new Error('Invalid holding');return units*(PAYOUT_CENTS/SHARE_SCALE);}

// Read-only valuation of the entire holding. Execution remains capped by MAX_ORDER_UNITS.
export function positionLiquidationCents(market, side, units) {
  if (!['yes','no'].includes(side) || !Number.isSafeInteger(units) || units < 0 || units > market[side === 'yes' ? 'q_yes' : 'q_no']) throw new Error('Invalid position');
  const afterYes=market.q_yes-(side==='yes'?units:0),afterNo=market.q_no-(side==='no'?units:0);
  return Math.max(0,Math.floor(cost(market.q_yes,market.q_no,market.liquidity)-cost(afterYes,afterNo,market.liquidity)+1e-7));
}
