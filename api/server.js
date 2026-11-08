// Tiny tick-sync API. No dependencies. Stores everything in one JSON file.
const http=require('http'),fs=require('fs'),path=require('path'),auth=require('./auth'),calendar=require('./calendar');
const DIR=process.env.DATA_DIR||'/data',FILE=path.join(DIR,'state.json');
const STATIC=process.env.STATIC_DIR||'';          // only used for local testing
const PORT=+process.env.PORT||3000,MAX=1e6;
// People come from the plan's "people" block (falls back to PEOPLE=a,b,c in .env).
const PLAN_FILE=process.env.PLAN_FILE||'/site/plan.json',PLAN_EXAMPLE=PLAN_FILE.replace(/plan\.json$/,'plan.example.json');
const ukey=n=>String(n||'').toLowerCase().replace(/[^a-z0-9]+/g,'-');
let peopleCache={f:'',m:0,list:[]};
function people(){
  try{
    const f=fs.existsSync(PLAN_FILE)?PLAN_FILE:PLAN_EXAMPLE,m=fs.statSync(f).mtimeMs;
    if(f!==peopleCache.f||m!==peopleCache.m){const pp=JSON.parse(fs.readFileSync(f,'utf8')).people||{};
      peopleCache={f,m,list:Object.values(pp).filter(v=>v&&typeof v==='object'&&v.name).map(v=>ukey(v.name))};}
    if(peopleCache.list.length)return peopleCache.list;
  }catch(e){}
  return String(process.env.PEOPLE||'').split(',').map(ukey).filter(Boolean);
}
let state={users:{},shared:null,have:null,updated:{},epoch:0};
try{state=Object.assign(state,JSON.parse(fs.readFileSync(FILE,'utf8')));}catch(e){}
function persist(){fs.mkdirSync(DIR,{recursive:true});const t=FILE+'.tmp';fs.writeFileSync(t,JSON.stringify(state));fs.renameSync(t,FILE);}
function send(res,code,obj){res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
function body(req){return new Promise((ok,no)=>{let b='';req.on('data',c=>{b+=c;if(b.length>MAX){no(new Error('big'));req.destroy();}});req.on('end',()=>{try{ok(JSON.parse(b||'{}'));}catch(e){no(e);}});});}
const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);
function cleanRatings(r){
  const out={};if(!isObj(r))return out;
  for(const [w,meals] of Object.entries(r).slice(0,100)){if(!isObj(meals))continue;const o={};
    for(const [id,v] of Object.entries(meals).slice(0,200)){if(!isObj(v)||id.length>80)continue;
      const sc=Number.isInteger(v.s)&&v.s>=1&&v.s<=10?v.s:undefined,n=typeof v.n==='string'?v.n.slice(0,1000):'';
      if(sc||n.trim())o[id]=Object.assign(sc?{s:sc}:{},n.trim()?{n}:{},typeof v.t==='string'&&v.t?{t:v.t.slice(0,300)}:{});}
    if(Object.keys(o).length)out[w]=o;}
  return out;
}
const MIME={'.html':'text/html','.json':'application/json','.png':'image/png','.js':'text/javascript','.webmanifest':'application/manifest+json'};
http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x'),p=u.pathname;
  try{
    if(await auth.handle(req,res,p))return;
    let me=null;
    if(p.startsWith('/api/')){me=auth.session(req);if(!me)return send(res,401,{error:'login needed'});auth.refresh(req,res,me);}
    if(calendar.handle(req,res,p,u))return;
    if(p==='/api/state'&&req.method==='GET'){
      if(me.admin)return send(res,200,state);
      // Everyone sees the shared shopping list; meal and exercise ticks only for their own person.
      const own=k=>k===me.person||k==='shared',pick=(o,f)=>Object.fromEntries(Object.entries(o||{}).filter(([k])=>f(k)));
      return send(res,200,Object.assign({},state,{users:pick(state.users,k=>k===me.person),updated:pick(state.updated,own)}));
    }
    let m=p.match(/^\/api\/user\/([a-z0-9-]+)$/);
    if(m&&req.method==='PUT'){
      if(!people().includes(m[1]))return send(res,404,{error:'unknown user'});
      if(!me.admin&&m[1]!==me.person)return send(res,403,{error:'you can only change your own ticks'});
      const b=await body(req);if(!isObj(b.ex)||!isObj(b.eaten))return send(res,400,{error:'bad body'});
      // Meal ratings: {week:{"Day|Meal":{s:1-10,n:"note"}}}. Older pages that do not send them keep what is saved.
      const old=(state.users[m[1]]||{}).ratings||{};
      state.users[m[1]]={ex:b.ex,eaten:b.eaten,ratings:'ratings' in b?cleanRatings(b.ratings):old};
      state.updated[m[1]]=Date.now();persist();return send(res,200,{ok:true});
    }
    if(p==='/api/shared'&&req.method==='PUT'){
      const b=await body(req);if(!isObj(b.ticks))return send(res,400,{error:'bad body'});
      // Remember who ticked each shopping item and when ("<week>|<item id>" -> {who,at}).
      const prev=(state.shared&&state.shared.ticks)||{},by=Object.assign({},(state.shared&&state.shared.by)||{}),keep=new Set(),now=Date.now();
      for(const w of Object.keys(b.ticks)){
        const ids=Array.isArray(b.ticks[w])?b.ticks[w]:[],old=new Set(prev[w]||[]);
        for(const id of ids){const k=w+'|'+id;keep.add(k);if(!old.has(id))by[k]={who:me.person,at:now};}
      }
      for(const k of Object.keys(by))if(!keep.has(k))delete by[k];
      state.shared={ticks:b.ticks,by};state.updated.shared=now;persist();return send(res,200,{ok:true,by});
    }
    if(p==='/api/have'&&req.method==='PUT'){
      const b=await body(req);if(!Array.isArray(b.have))return send(res,400,{error:'bad body'});
      state.have=b.have.filter(x=>typeof x==='string').slice(0,2000);persist();return send(res,200,{ok:true});
    }
    if(p==='/api/reset'&&req.method==='POST'){if(!me.admin)return send(res,403,{error:'only an admin can reset'});state={users:{},shared:null,have:[],updated:{},epoch:Date.now()};persist();return send(res,200,{ok:true});}
    if(p.startsWith('/api/'))return send(res,404,{error:'not found'});
    if(STATIC){let f=path.join(STATIC,p==='/'?'index.html':p);if(!f.startsWith(path.resolve(STATIC)))return send(res,403,{});
      fs.readFile(f,(e,d)=>{if(e)return send(res,404,{});res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(d);});return;}
    send(res,404,{error:'not found'});
  }catch(e){send(res,400,{error:String(e.message||e)});}
}).listen(PORT,()=>console.log('tick API on',PORT,'logins:',auth.users().join(', ')||'NONE - add LOGIN_<NAME> lines to .env'));
