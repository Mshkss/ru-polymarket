import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { SQLiteDatabase } from './database.mjs';
import { identify, register, login, logout, changePassword, HttpError } from './auth.mjs';
import { handleApi, seedMarket } from '../lib/api.mjs';
const headers={
 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
 'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY',
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};
const json=(object,status=200,extra={})=>new Response(JSON.stringify(object),{status,headers:{...headers,...extra}});
const files=new Map([
 ['/', ['market.html','text/html; charset=utf-8']],['/market.html',['market.html','text/html; charset=utf-8']],
 ['/app.js',['app.js','text/javascript; charset=utf-8']],['/styles.css',['styles.css','text/css; charset=utf-8']],['/favicon.svg',['favicon.svg','image/svg+xml']]
]);
async function payload(req){
 const chunks=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>8192)throw new HttpError(413,'Запрос слишком большой.');chunks.push(chunk);}
 return Buffer.concat(chunks);
}
async function readJson(request){try{const b=await request.json();if(!b||typeof b!=='object'||Array.isArray(b))throw new Error();return b;}catch{throw new HttpError(400,'Некорректный JSON.');}}
export async function createApplication({databasePath=':memory:',origin='http://localhost:3000',secureCookies=new URL(origin).protocol==='https:',trustProxy=false}={}){
 const appOrigin=new URL(origin);if(!['http:','https:'].includes(appOrigin.protocol)||appOrigin.origin!==origin)throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path or trailing slash');
 const db=new SQLiteDatabase(databasePath);db.migrate();await seedMarket(db);
 const server=createServer(async(req,res)=>{
  let response;
  try{
   const url=new URL(req.url,'http://internal');
   if(url.pathname==='/healthz'&&['GET','HEAD'].includes(req.method)){
    db.connection.prepare('SELECT 1').get();response=json({ok:true});
   }else if(url.pathname.startsWith('/api/')){
    if(!['GET','POST','PATCH'].includes(req.method))throw new HttpError(405,'Метод не поддерживается.');
    const write=req.method!=='GET';
    if(write){
     if(req.headers.origin&&req.headers.origin!==origin)throw new HttpError(403,'Запрос с другого сайта запрещён.');
     if((req.headers['content-type']??'').split(';')[0]!=='application/json')throw new HttpError(415,'Ожидается application/json.');
     if(Number(req.headers['content-length']??0)>8192)throw new HttpError(413,'Запрос слишком большой.');
    }
    const content=write?await payload(req):undefined;
    const request=new Request(origin+url.pathname+url.search,{method:req.method,headers:req.headers,body:content});
    const ip=trustProxy&&req.headers['x-real-ip']?String(req.headers['x-real-ip']).slice(0,100):req.socket.remoteAddress;
    const identity=await identify(db,request);
    const authPath=url.pathname.replace('/api/auth/','');
    if(url.pathname.startsWith('/api/auth/')){
     if(authPath==='register'&&req.method==='POST'){
      const result=await register(db,await readJson(request),ip,secureCookies);response=json({registered:true},201,{'Set-Cookie':result.cookie});
     }else if(authPath==='login'&&req.method==='POST'){
      const result=await login(db,await readJson(request),ip,secureCookies);response=json({signedIn:true},200,{'Set-Cookie':result.cookie});
     }else if(authPath==='logout'&&req.method==='POST')response=json({signedOut:true},200,{'Set-Cookie':await logout(db,request,secureCookies)});
     else if(authPath==='password'&&req.method==='POST'){
      await changePassword(db,identity,await readJson(request));response=json({changed:true,signedOut:true},200,{'Set-Cookie':await logout(db,request,secureCookies)});
     }else response=json({error:'Маршрут не найден.'},404);
    }else response=await handleApi(request,{DB:db},identity);
   }else if(files.has(url.pathname)&&['GET','HEAD'].includes(req.method)){
    const [filename,type]=files.get(url.pathname);response=new Response(await readFile(new URL('../public/'+filename,import.meta.url)),{headers:{...headers,'Content-Type':type,'Cache-Control':type.startsWith('text/html')?'no-store':'no-cache'}});
   }else response=json({error:'Страница не найдена.'},404);
  }catch(error){
   if(error instanceof HttpError)response=json({error:error.message},error.status);
   else{console.error('Request failed:',error.message);response=json({error:'Ошибка сервера. Повторите запрос.'},500);}
  }
  try{
   for(const [key,value] of Object.entries(headers))if(!response.headers.has(key))response.headers.set(key,value);
   res.writeHead(response.status,Object.fromEntries(response.headers));
   if(req.method==='HEAD')res.end();else res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.destroy();}
 });
 server.requestTimeout=20000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
 return {server,db,close:()=>new Promise((resolve,reject)=>server.close(error=>{db.close();error?reject(error):resolve();}))};
}
