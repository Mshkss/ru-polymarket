import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Small SQLite adapter for the shared transactional market service.
class Statement {
 constructor(database,sql,params=[]){this.database=database;this.sql=sql;this.params=params;}
 bind(...params){return new Statement(this.database,this.sql,params);}
 execute(){
  const stmt=this.database.connection.prepare(this.sql);
  if(stmt.columns().length){return {success:true,results:stmt.all(...this.params)};}
  const result=stmt.run(...this.params);
  return {success:true,results:[],meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};
 }
 async all(){return this.execute();}
 async first(column){const row=this.execute().results[0]??null;return column&&row?row[column]:row;}
 async run(){return this.execute();}
}
export class SQLiteDatabase {
 constructor(path=':memory:'){
  if(path!==':memory:')mkdirSync(dirname(resolve(path)),{recursive:true,mode:0o700});
  this.connection=new DatabaseSync(path,{timeout:5000});
  this.connection.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
 }
 prepare(sql){return new Statement(this,sql);}
 async batch(statements){
  this.connection.exec('BEGIN IMMEDIATE');
  try{const results=statements.map(s=>s.execute());this.connection.exec('COMMIT');return results;}
  catch(error){this.connection.exec('ROLLBACK');throw error;}
 }
 migrate(){
  this.connection.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const dir=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(dir).filter(n=>/^\d+.*\.sql$/.test(n)).sort()){
   if(this.connection.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name))continue;
   this.connection.exec('BEGIN IMMEDIATE');
   try{this.connection.exec(readFileSync(new URL(name,dir),'utf8'));this.connection.prepare('INSERT INTO schema_migrations(name,applied_at) VALUES (?,?)').run(name,Date.now());this.connection.exec('COMMIT');}
   catch(error){this.connection.exec('ROLLBACK');throw error;}
  }
 }
 close(){this.connection.close();}
}
