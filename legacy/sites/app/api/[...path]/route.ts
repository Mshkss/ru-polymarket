import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { handleApi } from '../../../lib/api.mjs';
export const dynamic='force-dynamic';
async function handler(request:Request){
 const user=await getChatGPTUser();
 return handleApi(request,env,user?{id:user.userId,email:user.email,name:user.fullName??user.email}:null);
}
export const GET=handler;
export const POST=handler;
export const PATCH=handler;
