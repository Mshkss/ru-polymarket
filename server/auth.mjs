import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { STARTING_BALANCE_CENTS } from '../lib/market-math.mjs';
const scrypt=promisify(scryptCallback);
const cookieName='ishod_session';
const sessionLifetime=14*24*60*60*1000;
const rateWindow=15*60*1000;
const hashToken=token=>createHash('sha256').update(token).digest('hex');
const options={N:16384,r:8,p:1,maxmem:64*1024*1024};
export class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
const check=(ok,message,status=400)=>{if(!ok)throw new HttpError(status,message);};
export function normalizeEmail(value){return typeof value==='string'?value.trim().toLowerCase():'';}
export async function hashPassword(password){const salt=randomBytes(16).toString('hex');const key=await scrypt(password,salt,64,options);return `scrypt-v1$${salt}$${key.toString('hex')}`;}
export async function verifyPassword(password,stored){
 const [version,salt,hex]=stored.split('$');if(version!=='scrypt-v1'||!salt||!hex)return false;
 const expected=Buffer.from(hex,'hex'),actual=await scrypt(password,salt,64,options);
 return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
const dummyHash='scrypt-v1$00000000000000000000000000000000$'+'00'.repeat(64);
function tokenFromRequest(request){const cookie=request.headers.get('cookie')??'';const value=cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);return value&&/^[a-f0-9]{64}$/.test(value)?value:null;}
export function sessionCookie(token,secure,maxAge=sessionLifetime/1000){return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?'; Secure':''}`;}
export async function identify(db,request,now=Date.now()){
 const token=tokenFromRequest(request);if(!token)return null;
 const user=await db.prepare('SELECT u.id,u.email,u.display_name,a.role FROM sessions s JOIN users u ON u.id=s.user_id JOIN auth_accounts a ON a.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').bind(hashToken(token),now).first();
 return user?{id:user.id,email:user.email,name:user.display_name,isAdmin:user.role==='admin'}:null;
}
async function session(db,userId,secure){
 const now=Date.now(),token=randomBytes(32).toString('hex');
 await db.batch([
 db.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now),
 db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').bind(hashToken(token),userId,now,now+sessionLifetime)
 ]);
 return sessionCookie(token,secure);
}
async function rateLimit(db,scope,max){
 const now=Date.now();
 await db.batch([
 db.prepare('DELETE FROM auth_attempts WHERE expires_at<=?').bind(now),
 db.prepare(`INSERT INTO auth_attempts(scope,count,expires_at) VALUES (?,1,?) ON CONFLICT(scope) DO UPDATE SET count=count+1`).bind(scope,now+rateWindow)
 ]);
 const row=await db.prepare('SELECT count FROM auth_attempts WHERE scope=?').bind(scope).first();check(row.count<=max,'Слишком много попыток. Попробуйте через 15 минут.',429);
}
export async function register(db,input,ip,secure){
 await rateLimit(db,'registration:'+ip,10);
 const email=normalizeEmail(input.email),name=typeof input.displayName==='string'?input.displayName.trim():'';
 check(email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Укажите корректный email.');
 check(name.length>=2&&name.length<=40&&!/[\x00-\x1f]/.test(name),'Имя должно содержать от 2 до 40 символов.');
 check(typeof input.password==='string'&&input.password.length>=10&&input.password.length<=128,'Пароль должен содержать от 10 до 128 символов.');
 check(!await db.prepare('SELECT user_id FROM auth_accounts WHERE email=?').bind(email).first(),'Этот email уже зарегистрирован. Войдите в аккаунт.',409);
 const passwordHash=await hashPassword(input.password),id=randomUUID(),now=Date.now();
 try{await db.batch([
 db.prepare('INSERT INTO users(id,email,display_name,balance_cents,version,created_at) VALUES (?,?,?,?,0,?)').bind(id,email,name,STARTING_BALANCE_CENTS,now),
 db.prepare('INSERT INTO auth_accounts(user_id,email,password_hash,created_at) VALUES (?,?,?,?)').bind(id,email,passwordHash,now),
 db.prepare("INSERT INTO ledger(id,user_id,kind,delta_cents,created_at) VALUES (?,?,'welcome',?,?)").bind('welcome:'+id,id,STARTING_BALANCE_CENTS,now)
 ]);}catch(e){if(/unique/i.test(e.message))throw new HttpError(409,'Этот email уже зарегистрирован.');throw e;}
 return {cookie:await session(db,id,secure),user:{id,email,displayName:name}};
}
export async function login(db,input,ip,secure){
 const email=normalizeEmail(input.email);
 check(email.length>0&&email.length<=254&&typeof input.password==='string'&&input.password.length<=128,'Неверный email или пароль.',401);
 await rateLimit(db,'login-ip:'+ip,60);await rateLimit(db,'login-email:'+hashToken(email),15);
 const account=await db.prepare('SELECT * FROM auth_accounts WHERE email=?').bind(email).first();
 const valid=await verifyPassword(input.password,account?.password_hash??dummyHash);
 check(account&&valid,'Неверный email или пароль.',401);
 return {cookie:await session(db,account.user_id,secure)};
}
export async function logout(db,request,secure){const token=tokenFromRequest(request);if(token)await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(hashToken(token)).run();return sessionCookie('',secure,0);}
export async function changePassword(db,identity,input){
 check(identity,'Войдите в аккаунт.',401);check(typeof input.currentPassword==='string'&&input.currentPassword.length<=128&&typeof input.newPassword==='string'&&input.newPassword.length>=10&&input.newPassword.length<=128,'Новый пароль должен содержать от 10 до 128 символов.');
 const account=await db.prepare('SELECT password_hash FROM auth_accounts WHERE user_id=?').bind(identity.id).first();
 check(account&&await verifyPassword(input.currentPassword,account.password_hash),'Текущий пароль неверен.',400);
 const next=await hashPassword(input.newPassword);
 await db.batch([db.prepare('UPDATE auth_accounts SET password_hash=? WHERE user_id=?').bind(next,identity.id),db.prepare('DELETE FROM sessions WHERE user_id=?').bind(identity.id)]);
}
