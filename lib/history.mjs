export const PERIOD_MS={
 '5m':5*60*1000,'1h':60*60*1000,'6h':6*60*60*1000,
 '1d':24*60*60*1000,'1w':7*24*60*60*1000,'1m':30*24*60*60*1000,'3m':90*24*60*60*1000,all:0
};
const combined=`SELECT id,created_at,probability,market_version,source,1 AS priority FROM price_history WHERE market_id=? UNION ALL SELECT 0 AS id,created_at,probability,NULL AS market_version,'scenario' AS source,0 AS priority FROM scenario_history WHERE market_id=?`;
export async function readHistory(db,marketId,period,now=Date.now()){
 if(!Object.hasOwn(PERIOD_MS,period))throw new Error('Unknown history period');
 const bounds=await db.prepare(`SELECT MIN(created_at) AS first FROM (${combined}) WHERE created_at<=?`).bind(marketId,marketId,now).first();
 const rangeStart=PERIOD_MS[period]?now-PERIOD_MS[period]:Math.min(bounds.first??now,now-60000),rangeEnd=now;
 const bucket=Math.max(1,Math.ceil((rangeEnd-rangeStart)/220));
 const rows=await db.prepare(`WITH combined AS (${combined}),inside AS (
  SELECT *,CAST((created_at-?)/? AS INTEGER) AS bucket FROM combined WHERE created_at>=? AND created_at<=?
 ),ranked AS (
  SELECT *,ROW_NUMBER() OVER(PARTITION BY bucket ORDER BY created_at DESC,priority DESC,id DESC) AS close_rank,
  ROW_NUMBER() OVER(ORDER BY created_at,id,priority) AS first_rank FROM inside
 ),chosen AS (
  SELECT id,created_at,probability,market_version,source,priority FROM ranked WHERE close_rank=1 OR first_rank=1
 ),anchor AS (
  SELECT * FROM combined WHERE created_at<? ORDER BY created_at DESC,priority DESC,id DESC LIMIT 1
 ) SELECT id,created_at,probability,market_version,source FROM (SELECT * FROM chosen UNION ALL SELECT * FROM anchor) ORDER BY created_at,priority,id`).bind(marketId,marketId,rangeStart,bucket,rangeStart,rangeEnd,rangeStart).all();
 return {points:rows.results.map(p=>({...p,market_id:marketId})),serverTime:now,rangeStart,rangeEnd,period,aggregation:'close'};
}
