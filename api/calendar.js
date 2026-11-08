// Turns a person's "Suggested eating times" from plan.json into calendar events.
//   GET /api/calendar/<person>.ics?start=YYYY-MM-DD  -> calendar file (Apple Calendar, Outlook, Google import)
//   GET /api/calendar/<person>.json?start=...        -> the same events as JSON (the page builds Google links from it)
// Times are "floating" (no time zone), so each calendar uses the phone's own time zone.
const fs=require('fs'),crypto=require('crypto');
const PLAN_FILE=process.env.PLAN_FILE||'/site/plan.json',WEEKS=4,REMIND_MIN=10;

function to24(h,mi,ap){h=+h;mi=+(mi||0);ap=(ap||'').toLowerCase();if(ap==='pm'&&h<12)h+=12;if(ap==='am'&&h===12)h=0;return h*60+mi;}
// "6:30 to 7:30 am (Mon to Fri)", "7:30 am", "12:00 to 12:30 pm" -> {start,end} in minutes after midnight
function parseWhen(when){
  const m=/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*(?:to|-|\u2013)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i.exec(when||'');
  if(!m)return null;
  let start=to24(m[1],m[2],m[3]||m[6]),end=m[4]?to24(m[4],m[5],m[6]||m[3]):start+30;
  if(end<=start&&m[4])start-=12*60;                      // "11:30 to 12:30 pm"
  if(start<0||end>24*60)return null;
  return {start,end};
}
function title(what){
  let t=String(what||'').split(/[.:(]/)[0].split(',')[0].trim();
  if(t.length>60)t=t.slice(0,57)+'...';
  return t||'Plan reminder';
}
const pad=n=>String(n).padStart(2,'0');
const ymd=d=>d.getUTCFullYear()+pad(d.getUTCMonth()+1)+pad(d.getUTCDate());
const hm=min=>pad(Math.floor(min/60))+pad(min%60)+'00';

function events(personKey,startDate){
  const f=fs.existsSync(PLAN_FILE)?PLAN_FILE:PLAN_FILE.replace(/plan\.json$/,'plan.example.json'),plan=JSON.parse(fs.readFileSync(f,'utf8')),P=(plan.people||{})[personKey];
  if(!P||!Array.isArray(P.times)||!P.times.length)return null;
  const base=/^\d{4}-\d{2}-\d{2}$/.test(startDate||'')?new Date(startDate+'T00:00:00Z'):new Date(Date.now()+864e5);
  const out=[];
  for(const t of P.times){
    const tm=parseWhen(t.when);if(!tm)continue;
    const weekdays=/\bmon(day)?\s*(to|-|\u2013)\s*fri(day)?\b/i.test(t.when+' '+t.what);
    const d=new Date(base);if(weekdays)while([0,6].includes(d.getUTCDay()))d.setUTCDate(d.getUTCDate()+1);
    const until=new Date(base);until.setUTCDate(until.getUTCDate()+WEEKS*7-1);
    const rrule=(weekdays?'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR':'FREQ=DAILY')+';UNTIL='+ymd(until)+'T235959';
    const details=String(t.what||'')+(P.timesNote?'\n\n'+P.timesNote:'');
    out.push({title:title(t.what),when:t.when,details,date:ymd(d),start:hm(tm.start),end:hm(tm.end),rrule,weekdays});
  }
  return {name:P.name||personKey,events:out};
}

const esc=s=>String(s).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
function fold(line){                                     // lines max 75 bytes
  const out=[];let cur='';
  for(const ch of line){if(Buffer.byteLength(cur+ch)>(out.length?74:75)){out.push(cur);cur='';}cur+=ch;}
  out.push(cur);return out.join('\r\n ');
}
function ics(cal){
  const now=new Date(),stamp=ymd(now)+'T'+pad(now.getUTCHours())+pad(now.getUTCMinutes())+pad(now.getUTCSeconds())+'Z';
  const L=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//shopping-list-selfhost//meal plan//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:'+esc(cal.name+"'s eating times")];
  for(const e of cal.events){
    const uid=crypto.createHash('sha1').update(cal.name+e.when+e.title+e.date).digest('hex').slice(0,16)+'@shopping-list';
    L.push('BEGIN:VEVENT','UID:'+uid,'DTSTAMP:'+stamp,'DTSTART:'+e.date+'T'+e.start,'DTEND:'+e.date+'T'+e.end,'RRULE:'+e.rrule,
      'SUMMARY:'+esc(e.title),'DESCRIPTION:'+esc(e.details),
      'BEGIN:VALARM','ACTION:DISPLAY','TRIGGER:-PT'+REMIND_MIN+'M','DESCRIPTION:'+esc(e.title),'END:VALARM','END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n')+'\r\n';
}

// Returns true if it answered the request.
function handle(req,res,p,u){
  const m=/^\/api\/calendar\/([a-z0-9_-]+)\.(ics|json)$/.exec(p);
  if(!m||req.method!=='GET')return false;
  let cal;
  try{cal=events(m[1],u.searchParams.get('start'));}catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"could not read plan.json"}');return true;}
  if(!cal){res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"no suggested times for that person"}');return true;}
  if(m[2]==='json'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(cal));return true;}
  const file=cal.name.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'-eating-times.ics';
  res.writeHead(200,{'Content-Type':'text/calendar; charset=utf-8','Content-Disposition':'inline; filename="'+file+'"','Cache-Control':'no-store'});
  res.end(ics(cal));return true;
}
module.exports={handle,parseWhen,events,ics};
