// Per-person file uploads (Lose It exports, Apple Health, blood tests, photos). No dependencies.
//
// Files are kept in plain folders so they are easy to find on the server:
//   data/uploads/<person>/<category>/<YYYY-MM-DD> <original name>
//   e.g. data/uploads/alex/blood-tests/2026-11-08 Blood results.pdf
//
// Everyone sees only their own files. Admins can see, add and delete anyone's.
const fs=require('fs'),path=require('path');
const DIR=process.env.DATA_DIR||'/data',ROOT=path.join(DIR,'uploads');
const MAX=2*1024*1024*1024;   // 2 GB: Apple Health exports can be large

// Folder name, label shown on the page, and the file types each one takes.
const CATEGORIES=[
  {id:'lose-it',label:'Lose It',hint:'Exports from Lose It (Settings → Export data), usually CSV or zip.',ext:['csv','zip','xlsx','txt','pdf']},
  {id:'apple-health',label:'Apple Health',hint:'Health app → your picture → Export All Health Data (a zip), or a summary.',ext:['zip','xml','csv','pdf','json','txt']},
  {id:'blood-tests',label:'Blood tests',hint:'Pathology results as a PDF or a photo.',ext:['pdf','jpg','jpeg','png','heic','txt']},
  {id:'photos',label:'Photos',hint:'Progress photos, meals or food labels.',ext:['jpg','jpeg','png','heic','webp']},
  {id:'other',label:'Other',hint:'Anything else that helps with the plan.',ext:['pdf','csv','zip','xlsx','txt','json','xml','jpg','jpeg','png','heic','webp','docx']},
];
const CAT=Object.fromEntries(CATEGORIES.map(c=>[c.id,c]));
// Shown inline in the browser; everything else downloads as a file (never run as a page).
const INLINE={pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',txt:'text/plain; charset=utf-8',csv:'text/plain; charset=utf-8'};

const README=`Uploaded files, one folder per person, then one per type:

  uploads/<person>/<type>/<date uploaded> <original file name>

  e.g. uploads/alex/blood-tests/2026-11-08 Blood results.pdf

Types:
${CATEGORIES.map(c=>'  '+c.id.padEnd(13)+c.label+': '+c.hint).join('\n')}

People upload these from the app (account menu → My files). Each person sees
only their own files there; admins can see everyone's. Files can also be added
or removed here directly. The app just lists what is in these folders.
`;
// Makes every person's folders up front, so the layout is easy to see on the server.
let made='';
function ensureRoot(people){
  const key=people.join(',');if(made===key)return;
  fs.mkdirSync(ROOT,{recursive:true});const r=path.join(ROOT,'README.txt');if(!fs.existsSync(r))fs.writeFileSync(r,README);
  people.forEach(p=>CATEGORIES.forEach(c=>fs.mkdirSync(path.join(ROOT,p,c.id),{recursive:true})));
  made=key;
}

function send(res,code,obj){res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
const ext=n=>(path.extname(n).slice(1)||'').toLowerCase();
// Keep the original name readable but safe: no folders, no hidden files, no odd characters.
function cleanName(n){
  n=path.basename(String(n||'').replace(/\\/g,'/')).normalize('NFC');
  n=n.replace(/[\u0000-\u001f\u007f<>:"|?*\/]/g,'').replace(/\s+/g,' ').trim().replace(/^\.+/,'');
  if(n.length>120){const e=path.extname(n);n=n.slice(0,120-e.length).trim()+e;}
  return n;
}
function today(){const d=new Date(),z=x=>String(x).padStart(2,'0');return d.getFullYear()+'-'+z(d.getMonth()+1)+'-'+z(d.getDate());}
// "2026-11-08 Blood results.pdf", then "2026-11-08 Blood results (2).pdf" if that exists.
function freeName(dir,name){
  const e=path.extname(name),b=name.slice(0,name.length-e.length);let n=today()+' '+name,i=2;
  while(fs.existsSync(path.join(dir,n)))n=today()+' '+b+' ('+(i++)+')'+e;
  return n;
}
function inside(p){const r=path.resolve(p);return r.startsWith(path.resolve(ROOT)+path.sep);}

// Works out whose files a request is for, and refuses anything not allowed.
function target(u,me,people){
  const person=String(u.searchParams.get('person')||me.person||'').toLowerCase();
  if(!people.includes(person))return {err:[404,'unknown person']};
  if(!me.admin&&person!==me.person)return {err:[403,'you can only see your own files']};
  return {person};
}
function fileTarget(u,t){
  const c=CAT[u.searchParams.get('category')];if(!c)return {err:[400,'unknown category']};
  const name=String(u.searchParams.get('name')||'');
  if(!name||name!==path.basename(name)||name.startsWith('.'))return {err:[400,'bad file name']};
  const f=path.join(ROOT,t.person,c.id,name);if(!inside(f))return {err:[400,'bad file name']};
  return {c,name,f};
}

function list(person){
  return CATEGORIES.map(c=>{
    const dir=path.join(ROOT,person,c.id);let files=[];
    try{files=fs.readdirSync(dir).filter(n=>!n.startsWith('.')&&!n.endsWith('.part')).map(n=>{const s=fs.statSync(path.join(dir,n));return s.isFile()?{name:n,size:s.size,at:s.mtimeMs}:null;}).filter(Boolean);}catch(e){}
    files.sort((a,b)=>b.name.localeCompare(a.name));  // newest date first
    return {id:c.id,label:c.label,hint:c.hint,accept:c.ext.map(e=>'.'+e).join(','),files};
  });
}

// Streams the request body straight to disk (as "<name>.part", renamed when complete).
function save(req,res,dir,name){
  fs.mkdirSync(dir,{recursive:true});
  const final=freeName(dir,name),tmp=path.join(dir,'.'+final+'.part'),out=fs.createWriteStream(tmp,{flags:'wx'});
  let size=0,failed=false;
  const fail=(code,msg)=>{if(failed)return;failed=true;out.destroy();fs.rm(tmp,{force:true},()=>{});if(!res.headersSent)send(res,code,{error:msg});req.destroy();};
  req.on('data',c=>{size+=c.length;if(size>MAX)fail(413,'That file is over 2 GB.');});
  req.on('aborted',()=>fail(400,'The upload was cancelled.'));
  out.on('error',e=>fail(500,'Could not save the file: '+e.message));
  out.on('finish',()=>{
    if(failed)return;
    if(!size){fs.rm(tmp,{force:true},()=>{});return send(res,400,{error:'The file is empty.'});}
    fs.rename(tmp,path.join(dir,final),e=>e?send(res,500,{error:'Could not save the file.'}):send(res,200,{ok:true,name:final,size}));
  });
  req.pipe(out);
}

async function handle(req,res,p,u,me,people){
  if(!p.startsWith('/api/uploads'))return false;
  ensureRoot(people);
  const t=target(u,me,people);if(t.err){send(res,t.err[0],{error:t.err[1]});return true;}
  // Changes must come from the app itself (a second guard on top of the SameSite cookie).
  if(req.method!=='GET'&&req.headers['x-requested-with']!=='files'){send(res,403,{error:'bad request'});return true;}

  if(p==='/api/uploads'&&req.method==='GET'){
    send(res,200,{person:t.person,people:me.admin?people:[me.person],categories:list(t.person)});return true;
  }
  if(p==='/api/uploads'&&req.method==='POST'){
    const c=CAT[u.searchParams.get('category')];if(!c){send(res,400,{error:'Pick what kind of file this is.'});return true;}
    const name=cleanName(u.searchParams.get('name'));
    if(!name||!ext(name)){send(res,400,{error:'The file needs a name with a type, like results.pdf.'});return true;}
    if(!c.ext.includes(ext(name))){send(res,400,{error:c.label+' takes '+c.ext.join(', ')+' files.'});return true;}
    if(+req.headers['content-length']>MAX){send(res,413,{error:'That file is over 2 GB.'});return true;}
    save(req,res,path.join(ROOT,t.person,c.id),name);return true;
  }
  if(p==='/api/uploads/file'){
    const f=fileTarget(u,t);if(f.err){send(res,f.err[0],{error:f.err[1]});return true;}
    if(req.method==='GET'){
      let st;try{st=fs.statSync(f.f);}catch(e){send(res,404,{error:'not found'});return true;}
      const type=INLINE[ext(f.name)],dl=u.searchParams.get('download')==='1'||!type;
      res.writeHead(200,{'Content-Type':type||'application/octet-stream','Content-Length':st.size,'Cache-Control':'private, no-store',
        'Content-Disposition':(dl?'attachment':'inline')+"; filename*=UTF-8''"+encodeURIComponent(f.name),
        'Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"});
      fs.createReadStream(f.f).pipe(res);return true;
    }
    if(req.method==='DELETE'){
      fs.rm(f.f,{force:true},e=>e?send(res,500,{error:'Could not delete it.'}):send(res,200,{ok:true}));return true;
    }
  }
  send(res,404,{error:'not found'});return true;
}
module.exports={handle,CATEGORIES,ROOT};
