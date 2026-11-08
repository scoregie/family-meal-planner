// Cookie login for the shopping list. No dependencies.
// Logins come from env vars named LOGIN_<USERNAME>=<hash> (make a hash with hash-password.js).
// Usernames are not case-sensitive. Changing someone's password logs them out everywhere.
const crypto=require('crypto'),fs=require('fs'),path=require('path');
const DIR=process.env.DATA_DIR||'/data';
// Stay logged in for 400 days (the most browsers allow), renewed each day the app is opened,
// so people stay logged in unless they log out or do not open the app for over a year.
const COOKIE='sl_session',MAX_AGE=400*864e5,RENEW_AFTER=864e5;
const SCRYPT={N:16384,r:8,p:1};

const USERS={};
for(const [k,v] of Object.entries(process.env)){
  const m=k.match(/^LOGIN_([A-Za-z0-9_]+)$/);
  if(m&&v&&v.trim())USERS[m[1].toLowerCase()]=v.trim().replace(/^'(.*)'$/,'$1');
}

// Roles: ADMIN_USERS=admin,... can see and edit everyone's meal and exercise ticks.
// Each login ticks as a person in the app: PERSON_<USERNAME>=alex (default: the username itself).
const ADMINS=String(process.env.ADMIN_USERS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
function who(user){
  return {user,admin:ADMINS.includes(user),person:String(process.env['PERSON_'+user.toUpperCase()]||user).trim().toLowerCase()};
}

function loadSecret(){
  if(process.env.SESSION_SECRET)return process.env.SESSION_SECRET;
  const f=path.join(DIR,'session-secret');
  try{const s=fs.readFileSync(f,'utf8').trim();if(s)return s;}catch(e){}
  const s=crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(DIR,{recursive:true});fs.writeFileSync(f,s,{mode:0o600});return s;
}
const SECRET=loadSecret();

function hash(pw){
  const salt=crypto.randomBytes(16),h=crypto.scryptSync(String(pw),salt,32,SCRYPT);
  return 'scrypt.'+salt.toString('base64url')+'.'+h.toString('base64url');
}
function verify(pw,stored){
  const p=String(stored||'').split('.');
  if(p.length!==3||p[0]!=='scrypt')return false;
  const want=Buffer.from(p[2],'base64url');if(!want.length)return false;
  const got=crypto.scryptSync(String(pw),Buffer.from(p[1],'base64url'),want.length,SCRYPT);
  return crypto.timingSafeEqual(got,want);
}
const DUMMY=hash(crypto.randomBytes(12).toString('hex'));   // keeps timing the same for unknown usernames
function checkLogin(user,pw){
  user=String(user||'').trim().toLowerCase();
  const ok=verify(pw,USERS[user]||DUMMY);
  return ok&&USERS[user]?user:null;
}

const sign=(s,user)=>crypto.createHmac('sha256',SECRET).update(s+'|'+USERS[user]).digest('base64url');
function makeToken(user){const b=user+'.'+(Date.now()+MAX_AGE);return b+'.'+sign(b,user);}
function readToken(t){
  const p=String(t||'').split('.');
  if(p.length!==3||!USERS[p[0]])return null;
  const b=p[0]+'.'+p[1],want=Buffer.from(sign(b,p[0])),got=Buffer.from(p[2]);
  if(want.length!==got.length||!crypto.timingSafeEqual(want,got))return null;
  const exp=+p[1];return exp>Date.now()?Object.assign(who(p[0]),{exp}):null;
}
function cookies(req){
  const o={};
  (req.headers.cookie||'').split(';').forEach(c=>{const i=c.indexOf('=');if(i>0)o[c.slice(0,i).trim()]=c.slice(i+1).trim();});
  return o;
}
const session=req=>readToken(cookies(req)[COOKIE]);
const isHttps=req=>String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';
function cookieFor(req,user){
  return COOKIE+'='+(user?makeToken(user):'')+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+
    (user?MAX_AGE/1000:0)+(isHttps(req)?'; Secure':'');
}
// Renew the cookie once a day while the app is used.
function refresh(req,res,s){if(s&&s.exp-Date.now()<MAX_AGE-RENEW_AFTER)res.setHeader('Set-Cookie',cookieFor(req,s.user));}

// Slow down password guessing: 10 wrong tries per address per 15 minutes.
const fails=new Map(),WINDOW=15*60e3,LIMIT=10;
const clientIp=req=>String(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket.remoteAddress||'?';
function recent(k){const now=Date.now(),a=(fails.get(k)||[]).filter(t=>now-t<WINDOW);if(a.length)fails.set(k,a);else fails.delete(k);return a;}

function safeNext(n){
  n=String(n||'');
  if(!n.startsWith('/')||n.startsWith('//')||n.startsWith('/\\')||/^\/(login|auth)\b/.test(n))return '/';
  return n;
}
function readForm(req){
  return new Promise((ok,no)=>{let b='';req.on('data',c=>{b+=c;if(b.length>4096){no(new Error('big'));req.destroy();}});
    req.on('end',()=>ok(new URLSearchParams(b)));});
}
function redirect(res,loc,cookie){
  const h={Location:loc,'Cache-Control':'no-store'};if(cookie)h['Set-Cookie']=cookie;
  res.writeHead(303,h);res.end();
}
const json=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};

// Handles /auth/*. Returns true if it answered the request.
async function handle(req,res,p){
  if(p==='/auth/check'){                      // Caddy asks this before serving any protected file
    const s=session(req);
    if(s){res.writeHead(200,{'X-Auth-User':s.user,'Cache-Control':'no-store'});res.end('ok');return true;}
    const uri=String(req.headers['x-forwarded-uri']||'/');
    if(uri.startsWith('/api/'))json(res,401,{error:'login needed'});
    else{res.writeHead(302,{Location:'/login?next='+encodeURIComponent(safeNext(uri)),'Cache-Control':'no-store'});res.end();}
    return true;
  }
  if(p==='/auth/login'&&req.method==='POST'){
    const f=await readForm(req),next=safeNext(f.get('next')),q='&next='+encodeURIComponent(next),ip=clientIp(req);
    if(recent(ip).length>=LIMIT){redirect(res,'/login?e=locked'+q);return true;}
    const user=checkLogin(f.get('username'),f.get('password')||'');
    if(!user){fails.set(ip,recent(ip).concat(Date.now()));redirect(res,'/login?e=1'+q);return true;}
    fails.delete(ip);redirect(res,next,cookieFor(req,user));return true;
  }
  if(p==='/auth/logout'){redirect(res,'/login?out=1',cookieFor(req,null));return true;}
  if(p==='/auth/me'){const s=session(req);refresh(req,res,s);s?json(res,200,{user:s.user,person:s.person,admin:s.admin}):json(res,401,{error:'login needed'});return true;}
  if(p.startsWith('/auth/')){json(res,404,{error:'not found'});return true;}
  return false;
}

module.exports={handle,session,refresh,hash,users:()=>Object.keys(USERS)};
