import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { SQLiteDatabase } from './database.mjs';
import { hashPassword, normalizeEmail } from './auth.mjs';
import { STARTING_BALANCE_CENTS } from '../lib/market-math.mjs';
export async function provisionAdmin(db,{email,password,displayName='Администратор'}){
 email=normalizeEmail(email);
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw new Error('Некорректный email');
 if(typeof password!=='string'||password.length<10||password.length>128)throw new Error('Пароль: от 10 до 128 символов');
 const hash=await hashPassword(password),now=Date.now();const existing=await db.prepare('SELECT user_id FROM auth_accounts WHERE email=?').bind(email).first();
 if(existing){await db.batch([
  db.prepare("UPDATE auth_accounts SET password_hash=?,role='admin' WHERE user_id=?").bind(hash,existing.user_id),
  db.prepare('DELETE FROM sessions WHERE user_id=?').bind(existing.user_id)
 ]);}else{const id=randomUUID();await db.batch([
  db.prepare('INSERT INTO users(id,email,display_name,balance_cents,version,created_at) VALUES (?,?,?,?,0,?)').bind(id,email,displayName,STARTING_BALANCE_CENTS,now),
  db.prepare("INSERT INTO auth_accounts(user_id,email,password_hash,role,created_at) VALUES (?,?,?,'admin',?)").bind(id,email,hash,now),
  db.prepare("INSERT INTO ledger(id,user_id,kind,delta_cents,created_at) VALUES (?,?,'welcome',?,?)").bind('welcome:'+id,id,STARTING_BALANCE_CENTS,now)
 ]);}
}
if(import.meta.url===new URL(process.argv[1],'file:').href){
 let muted=false;const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stdout.write(chunk,encoding);callback();}});
 const rl=createInterface({input:process.stdin,output,terminal:Boolean(process.stdin.isTTY)});
 let db;
 try{
  if(!process.stdin.isTTY)throw new Error('Запустите интерактивно: docker compose exec app node server/admin.mjs');
  const email=await rl.question('Email администратора: ');
  process.stdout.write('Новый пароль (минимум 10 символов, ввод скрыт): ');muted=true;const password=await rl.question('');muted=false;process.stdout.write('\n');
  process.stdout.write('Повторите пароль: ');muted=true;const repeat=await rl.question('');muted=false;process.stdout.write('\n');
  if(password!==repeat)throw new Error('Пароли не совпадают');
  db=new SQLiteDatabase(process.env.DATABASE_PATH??'./data/ishod.sqlite');db.migrate();await provisionAdmin(db,{email,password});console.log('Администратор сохранён. Войдите с новым паролем.');
 }catch(error){console.error(error.message);process.exitCode=1;}finally{rl.close();db?.close();}
}
