import {liveSnapshot} from '../lib/live.mjs';
export function createLiveStream(db,{intervalMs=200}={}){
 const clients=new Set();let timer=null,running=null,closed=false,lastSignature='',sequence=0;
 const send=(res,snapshot)=>{if(res.destroyed||res.writableEnded)return;if(res.writableLength>131072){res.end();return;}res.write(`id: ${snapshot.trades.at(-1)?.sequence??sequence}\nevent: quotes\ndata: ${JSON.stringify(snapshot)}\n\n`);};
 async function poll(){
  if(closed||running||!clients.size)return;
  running=(async()=>{const snapshot=await liveSnapshot(db,sequence),signature=snapshot.markets.map(m=>m.id+':'+m.version).join('|');if(snapshot.trades.length)sequence=Math.max(sequence,...snapshot.trades.map(t=>t.sequence));
   if(signature!==lastSignature||snapshot.trades.length){lastSignature=signature;for(const client of clients)send(client,snapshot);}
   else if(Date.now()%15000<intervalMs)for(const client of clients)client.write(': heartbeat\n\n');
  })();try{await running;}catch(error){if(!closed)console.error('Market stream:',error.message);}finally{running=null;}
 }
 async function connect(req,res){
  if(closed){res.writeHead(503);res.end();return;}
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});res.flushHeaders();
  clients.add(res);res.on('close',()=>{clients.delete(res);if(!clients.size){clearInterval(timer);timer=null;}});
  try{const snapshot=await liveSnapshot(db);if(closed)return;send(res,snapshot);if(clients.size===1)sequence=Math.max(sequence,...snapshot.trades.map(t=>t.sequence),0);}catch{res.end();clients.delete(res);}
  if(!closed&&!timer&&clients.size){timer=setInterval(poll,intervalMs);timer.unref();}
 }
 return {connect,async close(){closed=true;clearInterval(timer);if(running)await running;for(const res of clients)res.end();clients.clear();}};
}
