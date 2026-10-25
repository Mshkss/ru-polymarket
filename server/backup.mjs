import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname,resolve,join } from 'node:path';
const source=resolve(process.env.DATABASE_PATH??'./data/ishod.sqlite');
const destination=resolve(process.argv[2]??join(dirname(source),'backups',`ishod-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`));
if(source===destination)throw new Error('Backup destination must differ from database');
mkdirSync(dirname(destination),{recursive:true,mode:0o700});
const db=new DatabaseSync(source,{readOnly:true});
try{await backup(db,destination);chmodSync(destination,0o600);console.log(destination);}finally{db.close();}
