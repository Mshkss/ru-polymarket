import {probability} from './market-math.mjs';
export async function liveSnapshot(db,afterSequence=0){
 const [markets,trades]=await db.batch([
  db.prepare('SELECT id,status,outcome,q_yes,q_no,liquidity,version FROM markets ORDER BY id'),
  db.prepare(`SELECT t.rowid AS sequence,t.market_id,m.title,t.side,t.action,t.units,t.cash_cents,t.created_at,t.source,t.probability_before,t.probability_after FROM trades t JOIN markets m ON m.id=t.market_id WHERE t.rowid>? ORDER BY t.rowid DESC LIMIT 12`).bind(afterSequence)
 ]);
 return {serverTime:Date.now(),markets:markets.results.map(m=>({id:m.id,status:m.status,outcome:m.outcome,version:m.version,probability:m.status==='resolved'?(m.outcome==='yes'?1:0):probability(m)})),
  trades:trades.results.reverse().map(t=>({sequence:t.sequence,marketId:t.market_id,title:t.title,side:t.side,action:t.action,units:t.units,cashCents:t.cash_cents,createdAt:t.created_at,source:t.source,probabilityBefore:t.probability_before,probabilityAfter:t.probability_after}))};
}
