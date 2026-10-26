import { createApplication } from './app.mjs';
const port=Number(process.env.PORT??3000);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
const origin=process.env.APP_ORIGIN??`http://localhost:${port}`;
const config={databasePath:process.env.DATABASE_PATH??'./data/ishod.sqlite',origin,
 secureCookies:process.env.COOKIE_SECURE===undefined?new URL(origin).protocol==='https:':process.env.COOKIE_SECURE==='true',trustProxy:process.env.TRUST_PROXY==='true',simulation:process.env.SIMULATION_ENABLED!=='false'};
const app=await createApplication(config);
app.server.listen(port,process.env.HOST??'0.0.0.0',()=>console.log(`Исход запущен: ${origin} (port ${port})`));
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(stopping)return;stopping=true;try{await app.close();process.exitCode=0;}catch(error){console.error(error.message);process.exitCode=1;}});
