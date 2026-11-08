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
function body(req,max=MAX){return new Promise((ok,no)=>{let b='';req.on('data',c=>{b+=c;if(b.length>max){no(new Error('big'));req.destroy();}});req.on('end',()=>{try{ok(JSON.parse(b||'{}'));}catch(e){no(e);}});});}
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
// ---- Admin plan editing ----
// The admin page sends the whole plan back. The old file is kept in data/plan-backups (last 30).
const BACKUPS=path.join(DIR,'plan-backups');
function planPath(){return fs.existsSync(PLAN_FILE)?PLAN_FILE:PLAN_EXAMPLE;}
function planVersion(){try{return String(Math.floor(fs.statSync(PLAN_FILE).mtimeMs));}catch(e){return '0';}}
function checkPlan(p){
  if(!isObj(p)||!Array.isArray(p.weeks)||!p.weeks.length)return 'The plan needs a non-empty "weeks" list.';
  for(let i=0;i<p.weeks.length;i++){
    const w=p.weeks[i],n='Week '+(i+1)+': ';
    if(!isObj(w)||!isObj(w.shopping))return n+'"shopping" must be an object of sections.';
    for(const [k,items] of Object.entries(w.shopping)){
      if(!Array.isArray(items))return n+'section "'+k+'" must be a list.';
      for(const it of items)if(!Array.isArray(it)||typeof it[0]!=='string'||typeof it[1]!=='number'||!isFinite(it[1]))return n+'each item in "'+k+'" needs a name and a price.';
    }
    if(w.meals!==undefined&&!Array.isArray(w.meals))return n+'"meals" must be a list.';
    if(w.exercise!==undefined){
      if(!isObj(w.exercise))return n+'"exercise" must be an object.';
      const blocks=Array.isArray(w.exercise.days)?[w.exercise]:Object.values(w.exercise);
      for(const b of blocks)if(!isObj(b)||!Array.isArray(b.days))return n+'each exercise plan needs a "days" list.';
    }
  }
  if(p.macros!==undefined&&!isObj(p.macros))return '"macros" must be an object.';
  return '';
}
// Shopping ticks are stored by position ("<section>-<item>"), so after an edit move each tick to
// the item with the same name in that week. Ticks on items that were removed are dropped.
function remapTicks(oldPlan,newPlan){
  if(!state.shared||!isObj(state.shared.ticks))return;
  const names=w=>{const m={},sh=(w&&w.shopping)||{};Object.values(sh).forEach((items,si)=>items.forEach((it,ii)=>{m[si+'-'+ii]=it[0];}));return m;};
  const ticks={},by={},oldBy=state.shared.by||{};
  for(const [w,ids] of Object.entries(state.shared.ticks)){
    const o=names(oldPlan.weeks[w]),nw=names(newPlan.weeks[w]),byName={};
    Object.entries(nw).forEach(([id,nm])=>{if(!(nm in byName))byName[nm]=id;});
    const out=[];
    for(const id of Array.isArray(ids)?ids:[]){const nid=byName[o[id]];if(nid&&!out.includes(nid)){out.push(nid);if(oldBy[w+'|'+id])by[w+'|'+nid]=oldBy[w+'|'+id];}}
    if(out.length)ticks[w]=out;
  }
  state.shared={ticks,by};state.updated.shared=Date.now();
}
function savePlan(p){
  let old=null;
  try{old=JSON.parse(fs.readFileSync(planPath(),'utf8'));}catch(e){}
  fs.mkdirSync(BACKUPS,{recursive:true});
  if(fs.existsSync(PLAN_FILE)){
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    fs.copyFileSync(PLAN_FILE,path.join(BACKUPS,'plan-'+stamp+'.json'));
    fs.readdirSync(BACKUPS).filter(f=>/^plan-.*\.json$/.test(f)).sort().reverse().slice(30).forEach(f=>fs.unlinkSync(path.join(BACKUPS,f)));
  }
  const t=PLAN_FILE+'.tmp';fs.writeFileSync(t,JSON.stringify(p,null,1));fs.renameSync(t,PLAN_FILE);
  if(old&&Array.isArray(old.weeks)&&old.id===p.id){remapTicks(old,p);persist();}
}
function backups(){try{return fs.readdirSync(BACKUPS).filter(f=>/^plan-[0-9TZ-]+\.json$/.test(f)).sort().reverse();}catch(e){return [];}}
async function handlePlan(req,res,p,me){
  if(!p.startsWith('/api/plan'))return false;
  if(!me.admin){send(res,403,{error:'only an admin can edit the plan'});return true;}
  if(p==='/api/plan'&&req.method==='GET'){
    let plan;try{plan=JSON.parse(fs.readFileSync(planPath(),'utf8'));}catch(e){send(res,500,{error:'plan.json could not be read: '+e.message});return true;}
    send(res,200,{plan,version:planVersion(),example:!fs.existsSync(PLAN_FILE)});return true;
  }
  if(p==='/api/plan'&&req.method==='PUT'){
    const b=await body(req,8e6);
    if(b.version!==undefined&&String(b.version)!==planVersion()){send(res,409,{error:'The plan was changed somewhere else since you opened it. Reload to get the latest copy.'});return true;}
    const err=checkPlan(b.plan);if(err){send(res,400,{error:err});return true;}
    savePlan(b.plan);send(res,200,{ok:true,version:planVersion()});return true;
  }
  if(p==='/api/plan/backups'&&req.method==='GET'){send(res,200,{backups:backups()});return true;}
  if(p==='/api/plan/restore'&&req.method==='POST'){
    const b=await body(req);if(!backups().includes(b.name)){send(res,404,{error:'no such backup'});return true;}
    let plan;try{plan=JSON.parse(fs.readFileSync(path.join(BACKUPS,b.name),'utf8'));}catch(e){send(res,400,{error:'that backup could not be read'});return true;}
    savePlan(plan);send(res,200,{ok:true,version:planVersion()});return true;
  }
  send(res,404,{error:'not found'});return true;
}
const MIME={'.html':'text/html','.json':'application/json','.png':'image/png','.js':'text/javascript','.webmanifest':'application/manifest+json'};
http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x'),p=u.pathname;
  try{
    if(await auth.handle(req,res,p))return;
    let me=null;
    if(p.startsWith('/api/')){me=auth.session(req);if(!me)return send(res,401,{error:'login needed'});auth.refresh(req,res,me);}
    if(calendar.handle(req,res,p,u))return;
    if(await handlePlan(req,res,p,me))return;
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
