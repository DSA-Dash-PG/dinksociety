/* ════════════════════════════════════════════════════════════════════
   ladder-hub.js — The Dink Society
   One hub for every ladder division, used by two pages:

     ladders.html   window.LADDER_HUB = { brand:'ladder' }
                    All · Mixed · Men's · Women's, switchable.
     queen.html     window.LADDER_HUB = { brand:'queen', division:'womens' }
                    The women's division on its own page, same design.

   Tabs (the same at every width): Overview · Results · Board · Kitchen ·
   Photos · Rules. Sign-up, payment, cancel, waitlist and invite links are
   the same calls the old Challengers page made — only the layout changed.

   ONE BOARD RULE everywhere: rank by wins → point differential → Dink
   Rating, 10 games to qualify. Mixed / Men's / Women's boards count only
   their own division's nights. "Overall" (All) pools every night that
   counts toward the ladder and defaults to ranking by Dink Rating, the one
   number that follows a player across formats.
   ════════════════════════════════════════════════════════════════════ */
const API='/.netlify/functions';
const HUB=Object.assign({ brand:'ladder', division:null, home:'/ladders.html' }, window.LADDER_HUB||{});
let ACTIVE=[], COMPLETED=[], STATS=null, MYCREDIT=0, MYREG={};
// The signed-in player's gender, when we have it on file. Men's/women's-only
// ladders need it to check eligibility; null means the signup sheet asks.
let MYGENDER=null;
let MYDUPR=null; // DUPR ID on file (master player profile) — prefills DUPR-rated signups
let MYCLUB=null; // DUPR club status on file: 'verified' (an admin checked) | 'confirmed' (ticked before) | null
let DIV=HUB.division||'all', TAB='overview';
const DSTATS={};          // division → its scoped stats response (kitchen, top performers…)
let PHALBUMS=null;        // public-ladder-photos albums
const RECAP_URLS=window.DS_RECAP_URLS||{};
const PREVIEW_URLS=window.DS_PREVIEW_URLS||{};
const MIN_LB_GAMES=10;    // games before a player is ranked on a season board
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ── Names, dates, money ── */
// Ladder views show FIRST NAME only where space is tight; ranked lists use
// first name + last initial. Pair rows ("Ryan Hom & Annie Lee") shorten per side.
const firstName=s=>{ s=String(s||'').trim(); if(s.includes(' & ')) return s.split(' & ').map(firstName).join(' & '); return s.split(/\s+/)[0]||s; };
const firstLast=s=>{ if(String(s||'').includes(' & ')) return String(s).split(' & ').map(firstLast).join(' & '); const p=String(s||'').trim().split(/\s+/); return p.length>1?`${p[0]} ${p[p.length-1][0].toUpperCase()}`:(p[0]||String(s||'')); };
const rowName=p=>p&&p.pair&&p.names?p.names.map(firstLast).join(' & '):firstLast(p&&p.name);
const fmt=c=>'$'+((Number(c)||0)/100%1===0?(Number(c)||0)/100:((Number(c)||0)/100).toFixed(2));
const cardTotal=c=>(Number(c)||0)+Math.round((Number(c)||0)*0.10);
const TL={mixed:'Mixed',mens:"Men's",womens:"Women's"};
const DIVNAME={all:'Overall',mixed:'Mixed',mens:"Men's",womens:"Women's"};
const wd=s=>{ if(!s)return''; const d=new Date(s+'T12:00:00'); return isNaN(d)?'':d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}); };
const md=s=>{ if(!s)return''; const d=new Date(s+'T12:00:00'); return isNaN(d)?'':d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); };
const wdLong=s=>{ if(!s)return''; const d=new Date(s+'T12:00:00'); return isNaN(d)?'':d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}); };
const num=n=>(Number(n)||0).toLocaleString('en-US');
const signed=d=>(d==null?'–':d>0?'+'+d:d<0?'−'+Math.abs(d):'0');
const ordinal=n=>{ const s=['th','st','nd','rd'],v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); };
const nightUrl=id=>'/ladder-result.html?event='+encodeURIComponent(id);
const profileUrl=p=>'/profile?ladderId='+encodeURIComponent(p&&p.pair?((p.ids||[])[0]||p.id):(p&&p.id));
// Queen of the Court wordmark — shown on the Queen page hero.
const QOTC=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="60 28 360 186" role="img" aria-label="Queen of the Court">
  <g transform="translate(240,60)" fill="currentColor"><path d="M-40 20 L-27 -14 L-9 8 L0 -24 L9 8 L27 -14 L40 20 Z"/><rect x="-40" y="20" width="80" height="9" rx="2.5"/><circle cx="0" cy="-24" r="4.5"/><circle cx="-27" cy="-14" r="3.5"/><circle cx="27" cy="-14" r="3.5"/></g>
  <text x="240" y="150" text-anchor="middle" font-family="'Cormorant Garamond',serif" font-style="italic" font-weight="600" font-size="62" style="fill:var(--color-text)">Queen</text>
  <text x="240" y="184" text-anchor="middle" font-family="Inter,sans-serif" font-weight="800" font-size="16.5" letter-spacing="9" fill="currentColor">OF THE COURT</text>
  <g stroke="currentColor" stroke-width="2"><line x1="150" y1="203" x2="206" y2="203"/><line x1="274" y1="203" x2="330" y2="203"/></g>
  <circle cx="240" cy="203" r="4" fill="currentColor"/>
</svg>`;

/* ── Avatars (public-ladder-avatars), fetched after first paint ── */
let AVATARS={}; const AV_ASKED=new Set();
const ini=n=>{ const p=String(n||'').split(' & ')[0].trim().split(/\s+/).filter(Boolean); return p.length?((p[0][0]||'')+(p.length>1?(p[p.length-1][0]||''):'')).toUpperCase():'?'; };
const avId=p=>p&&p.pair?((p.ids||[])[0]||p.id):(p&&p.id);
function av(p){ const u=AVATARS[avId(p)], i=esc(ini(rowName(p))); return `<span class="dk-av" data-ini="${i}" aria-hidden="true">${u?`<img src="${esc(u)}" alt="" loading="lazy" onerror="var b=this.parentNode;this.remove();if(b)b.textContent=b.dataset.ini;">`:i}</span>`; }
function avPic(p){ const u=AVATARS[avId(p)]; return (u?`<img src="${esc(u)}" alt="" loading="lazy" onerror="this.remove()">`:'')+esc(ini(rowName(p))); }
const idsOf=rows=>(rows||[]).flatMap(r=>r&&r.pair?(r.ids||[]):[r&&r.id]).filter(Boolean);
async function ensureAvatars(ids,onDone){ const want=[...new Set(ids)].filter(id=>!AV_ASKED.has(id)); if(!want.length) return; want.forEach(id=>AV_ASKED.add(id)); try{ const d=await (await fetch(`${API}/public-ladder-avatars?ids=${encodeURIComponent(want.join(','))}`)).json(); const got=d.photos||{}; if(!Object.keys(got).length) return; Object.assign(AVATARS,got); if(onDone) onDone(); }catch(e){} }

// Minimal markdown renderer used by ladder description / rules panels. Keep in
// sync with the version in admin-ladders.html — supports headings, **bold**,
// *italic*, `code`, [links](url), > blockquotes, -/* bullets, 1. numbered
// lists, blank-line paragraphs, and single-newline <br>s. HTML-escapes first.
function mdRender(src){
  if(!src) return '';
  let s = String(src).replace(/[<>&]/g,m=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]));
  s = s.replace(/^### (.+)$/gm,'<h3>$1</h3>')
       .replace(/^## (.+)$/gm,'<h2>$1</h2>')
       .replace(/^# (.+)$/gm,'<h1>$1</h1>');
  s = s.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');
  s = s.replace(/(?:^[-*] .+(?:\n|$))+/gm, m=>{
    const items = m.trim().split(/\n/).map(l=>l.replace(/^[-*] /,'').trim()).map(x=>'<li>'+x+'</li>').join('');
    return '<ul>'+items+'</ul>\n';
  });
  s = s.replace(/(?:^\d+\. .+(?:\n|$))+/gm, m=>{
    const items = m.trim().split(/\n/).map(l=>l.replace(/^\d+\. /,'').trim()).map(x=>'<li>'+x+'</li>').join('');
    return '<ol>'+items+'</ol>\n';
  });
  s = s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
       .replace(/(^|[^*])\*([^*\n]+)\*/g,'$1<em>$2</em>')
       .replace(/`([^`]+)`/g,'<code>$1</code>')
       .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  const parts = s.split(/\n{2,}/).map(p=>{
    const t = p.trim(); if(!t) return '';
    if(/^<(h\d|ul|ol|blockquote)/.test(t)) return t;
    return '<p>'+t.replace(/\n/g,'<br>')+'</p>';
  });
  return parts.filter(Boolean).join('\n');
}

/* ════════════════ Scope: which division is showing ════════════════ */
const typeOf=l=>(l&&l.type)||'mixed';
const inScope=l=>DIV==='all'||typeOf(l)===DIV;
const activeDivs=()=>{ const a=(STATS&&STATS.activeDivisions)||[]; const live=new Set([...ACTIVE,...COMPLETED].map(typeOf)); return ['mixed','mens','womens'].filter(d=>a.includes(d)||live.has(d)); };
const scopeStats=()=>DIV==='all'?STATS:((DSTATS[DIV]&&DSTATS[DIV]!=='loading')?DSTATS[DIV]:null);
async function ensureDiv(){
  if(DIV==='all'||DSTATS[DIV]) return;
  const d=DIV; DSTATS[d]='loading';
  try{ DSTATS[d]=await (await fetch(`${API}/public-ladder-stats?division=${d}`,{credentials:'include'})).json(); }catch(e){ delete DSTATS[d]; return; }
  if(DIV===d){ renderKitchen(); renderOverview(); }
}
const divRows=d=>{ const D=(STATS&&STATS.divisions)||{}; if(d==='all') return D.all||(STATS&&STATS.leaderboard)||[]; return D[d]||[]; };
const games=p=>(p.w||0)+(p.l||0);
const ranked=rows=>rows.filter(p=>!p.tie&&games(p)>=MIN_LB_GAMES);
const openNights=()=>ACTIVE.filter(inScope).slice().sort((a,b)=>(startMsOf(a)||9e15)-(startMsOf(b)||9e15));
const doneNights=()=>COMPLETED.filter(inScope).slice().sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
const albumFor=id=>(PHALBUMS||[]).find(a=>a.eventId===id);
// Admin-set focal point (Photos tab → Focus) → object-position on cover crops.
const fpos=p=>(Number.isFinite(p.fx)?p.fx:50)+'% '+(Number.isFinite(p.fy)?p.fy:50)+'%';
function podiumFor(id){
  const pools=[(scopeStats()||{}).recentWinners,(STATS||{}).recentWinners];
  for(const pool of pools){ const ev=(pool||[]).find(e=>e.eventId===id); if(ev&&(ev.winners||[]).length) return { rows:ev.winners, field:(ev.standings||[]).length }; }
  const w=(STATS&&STATS.winnersByEvent&&STATS.winnersByEvent[id])||[];
  return { rows:w, field:0 };
}

/* ════════════════ Routing ════════════════
   #overview · #results · #board/<division>/<sort> · #kitchen · #photos · #rules
   The old Challengers hashes still work: #home, #ladders/<eventId>,
   #ladders/completed, #leaderboard/<sort>, #recaps. */
const TABS=[['overview','Overview'],['results','Results'],['board','Board'],['kitchen','Kitchen'],['photos','Photos'],['rules','Rules']];
let lbSort=null, lbGender='all', lbShowAll=false, lbShowUnq=false;
const curSort=()=>lbSort||(DIV==='all'?'dr':'wins');
function writeHash(){
  let h=TAB;
  if(!HUB.division&&DIV!=='all') h+='/'+DIV;
  if(TAB==='board'&&lbSort){ if(HUB.division||DIV==='all') h+=(HUB.division?'':'/all'); h+='/'+lbSort; }
  if(location.hash.replace(/^#/,'')!==h) history.replaceState(null,'',location.pathname+location.search+'#'+h);
}
function route(){
  const parts=(location.hash||'').replace(/^#/,'').split('/').filter(Boolean).map(decodeURIComponent);
  let t=parts[0]||'overview', focus=null;
  const legacy={home:'overview',leaderboard:'board',recaps:'results',gallery:'photos'};
  if(t==='ladders'){
    const sub=parts[1]||'';
    if(sub==='completed'||sub==='past') t='results';
    else if(sub&&sub!=='register'){
      // A finished night has its own page now; an open one opens on its card.
      if(COMPLETED.some(x=>x.id===sub)){ location.replace(nightUrl(sub)); return; }
      t='overview'; focus=sub;
    } else t='overview';
  } else if(legacy[t]){ if(t==='leaderboard'&&['wins','points','xp','dr'].includes(parts[1])) lbSort=parts[1]; t=legacy[t]; }
  else if(TABS.some(x=>x[0]===t)){
    const rest=parts.slice(1);
    if(!HUB.division&&['all','mixed','mens','womens'].includes(rest[0])) DIV=rest.shift();
    if(t==='board'&&['wins','points','xp','dr'].includes(rest[0])) lbSort=rest[0];
  } else t='overview';
  TAB=t;
  if(!HUB.division&&DIV!=='all'&&!activeDivs().includes(DIV)) DIV='all';
  if(focus){ const l=ACTIVE.find(x=>x.id===focus); if(l&&!HUB.division&&DIV!=='all'&&typeOf(l)!==DIV) DIV='all'; }
  renderAll();
  if(focus) focusLadder(focus);
}
window.addEventListener('hashchange', route);
function focusLadder(id){
  LEXP[id]=true;
  renderOverview(); renderHero();
  setTimeout(()=>{ const el=document.querySelector(`[data-lad="${CSS.escape(id)}"]`); if(!el) return;
    el.scrollIntoView({behavior:'smooth',block:'center'}); el.style.transition='box-shadow .3s'; el.style.boxShadow='0 0 0 2px var(--color-lime)'; setTimeout(()=>{ el.style.boxShadow=''; },1800); },160);
}
function setTab(t,scroll){
  TAB=t; writeHash(); paintTabs();
  if(scroll!==false){ const bar=$('lh-bar'); if(bar){ const top=bar.getBoundingClientRect().top+window.pageYOffset-(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dk-top'),10)||65); if(window.pageYOffset>top) window.scrollTo({top,behavior:'auto'}); } }
}
function setDiv(d){ DIV=d; lbShowAll=false; lbShowUnq=false; if(d!=='all'&&d!=='mixed') lbGender='all'; writeHash(); renderAll(); }
function paintTabs(){
  document.querySelectorAll('#lh-tabs [data-tab]').forEach(b=>{ const on=b.dataset.tab===TAB; b.classList.toggle('on',on); b.setAttribute('aria-selected',on?'true':'false'); });
  document.querySelectorAll('#hub .dk-panel').forEach(p=>p.classList.toggle('on',p.dataset.panel===TAB));
}

/* ════════════════ Load ════════════════ */
// Private/invite-only ladders the player has opened a direct link for.
const INV_KEY='ds_invited_ladders';
function invitedIds(){ try{ const a=JSON.parse(localStorage.getItem(INV_KEY)||'[]'); return Array.isArray(a)?a.filter(x=>typeof x==='string'):[]; }catch(e){ return []; } }
function rememberInvite(id){ try{ const a=invitedIds().filter(x=>x!==id); a.unshift(id); localStorage.setItem(INV_KEY,JSON.stringify(a.slice(0,10))); }catch(e){} }
function forgetInvite(id){ try{ localStorage.setItem(INV_KEY,JSON.stringify(invitedIds().filter(x=>x!==id))); }catch(e){} }
let BOOTED=false;
async function init(){
  let pl={}, st={};
  // Returning from Stripe card / Apple Pay checkout → reconcile the payment so the
  // roster shows "paid" even if the webhook hasn't landed yet.
  const _q=new URLSearchParams(location.search);
  if(_q.get('paid')==='1' && _q.get('session_id')){
    try{ await fetch(`${API}/ladder-checkout-confirm?session_id=${encodeURIComponent(_q.get('session_id'))}`,{method:'POST',credentials:'include'}); }catch(e){}
    history.replaceState(null,'',location.pathname+location.hash);
  }
  try{ pl=await (await fetch(`${API}/public-ladders`,{credentials:'include'})).json(); }catch(e){}
  try{ st=await (await fetch(`${API}/public-ladder-stats`,{credentials:'include'})).json(); }catch(e){}
  // A private/invite-only ladder never appears in the /public-ladders LIST above,
  // but its direct link (?event=ID, shared by hand by the organizer) still works —
  // fetch that one ladder specifically and splice it in so whoever followed the
  // link can see it and register, without it being discoverable any other way.
  // The invite id is also remembered in localStorage so the ladder keeps
  // showing after the player is bounced through sign-in (which loses the
  // query string) or comes back later on the same phone.
  const _evId=_q.get('event');
  if(_evId) rememberInvite(_evId);
  const _inv=[...new Set([_evId,...invitedIds()].filter(Boolean))];
  for(const iid of _inv){
    if((pl.ladders||[]).some(l=>l.id===iid)) continue;
    try{
      const one=await (await fetch(`${API}/public-ladders?event=${encodeURIComponent(iid)}`,{credentials:'include'})).json();
      if(one&&one.ladder&&['open','closed','full','live'].includes(one.ladder.status||'open')){
        one.ladder._invited=true;
        pl.ladders=[one.ladder,...(pl.ladders||[])];
      } else if(iid!==_evId){ forgetInvite(iid); } // played / cancelled — stop remembering it
    }catch(e){}
  }
  // Landed on a private-ladder link: open on that card unless the URL already says where to go.
  if(_evId && !location.hash) history.replaceState(null,'',location.pathname+location.search+'#ladders/'+encodeURIComponent(_evId));
  // Signed-in player's own signups → powers the "You're in / Cancel my spot"
  // state on each card. 401 (not signed in) just leaves MYREG empty.
  MYREG={}; MYGENDER=null;
  try{ const r=await fetch(`${API}/player-ladder-events`,{credentials:'include'}); if(r.ok){ const me=await r.json(); (me.registered||[]).forEach(ev=>{ MYREG[ev.id]={list:ev.list,paymentStatus:ev.paymentStatus}; }); MYGENDER=(me.me&&me.me.gender)||null; MYDUPR=(me.me&&me.me.duprId)||null; MYCLUB=(me.me&&me.me.duprClub)||null; } }catch(e){}
  ACTIVE=pl.ladders||[]; COMPLETED=pl.completed||[]; STATS=st||{}; MYCREDIT=(st&&st.youCreditCents)||0;
  Object.keys(DSTATS).forEach(k=>delete DSTATS[k]);
  route();
  if(BOOTED) return; BOOTED=true;
  // Photo albums and avatars are best-effort, after first paint.
  fetch(`${API}/public-ladder-photos`).then(r=>r.json()).then(p=>{ PHALBUMS=p.albums||[]; renderAll(); }).catch(()=>{ PHALBUMS=[]; renderPhotos(); });
  { const d=(st&&st.divisions)||{}; const ids=idsOf((st&&st.leaderboard)||[]).concat(...Object.values(d).map(r=>idsOf(ranked(r).slice(0,40)))); ensureAvatars(ids,()=>{ renderOverview(); renderBoard(); }); }
}

/* ════════════════ Open nights: the register card ════════════════ */
const LEXP={}, LDESC={};
function parseTimeJs(s){ if(!s)return null; s=String(s).trim().toLowerCase().replace(/\s+/g,''); let m=s.match(/^(\d{1,2})[:.](\d{2})(am|pm)?$/)||s.match(/^(\d{1,2})(\d{2})(am|pm)$/); if(!m){const m2=s.match(/^(\d{1,2})(am|pm)$/); if(m2)m=[m2[0],m2[1],'00',m2[2]];} if(!m){const m3=s.match(/^(\d{2})(\d{2})$/); if(m3&&+m3[1]<=23)m=[m3[0],m3[1],m3[2],undefined];} if(!m)return null; let h=parseInt(m[1],10),min=parseInt(m[2],10); const ap=m[3]; if(ap==='pm'&&h<12)h+=12; if(ap==='am'&&h===12)h=0; if(h>23||min>59)return null; return {h,m:min}; }
function startMsOf(l){ if(!l||!l.date)return null; const t=parseTimeJs(l.startTime); if(!t&&l.startTime)return null; const d=new Date(l.date+'T00:00:00'); if(isNaN(d))return null; const tt=t||{h:0,m:0}; d.setHours(tt.h,tt.m,0,0); return d.getTime(); }
function countdownLabel(ms){ if(ms==null)return''; if(ms<=0)return'Live now'; const m=Math.floor(ms/60000),h=Math.floor(m/60),d=Math.floor(h/24); if(d>=1)return d+' day'+(d>1?'s':'')+' '+(h%24)+' hr'+((h%24)!==1?'s':''); if(h>=1)return h+'h '+(m%60)+'m'; return m+' min'; }
setInterval(function(){ document.querySelectorAll('[data-cd]').forEach(function(el){ el.textContent=countdownLabel(+el.dataset.cd-Date.now()); }); },30000);
function feeLabel(l){ if((l.paymentMethods||[]).includes('free')) return 'Free'; const base=fmt(l.feeCents); return l.format==='fixed-partner' ? base+'/player' : base; }
const FORMAT={individual:'Individual','fixed-partner':'Fixed partner','round-robin':'Round robin'};
// Fixed-partner nights: keep a duo together and put the woman first. Entries
// arrive with a shared pairId; anyone unpaired keeps their place in line.
function orderRosterPairs(roster){
  const list=(roster||[]).slice();
  if(!list.some(p=>p&&p.pairId)) return list;
  const out=[], done=new Set();
  list.forEach((p,i)=>{
    if(done.has(i)) return;
    done.add(i);
    if(!p||!p.pairId){ out.push(p); return; }
    const j=list.findIndex((q,k)=>k>i&&q&&q.pairId===p.pairId&&!done.has(k));
    if(j<0){ out.push(p); return; }
    done.add(j);
    const mate=list[j];
    const flip=mate.gender==='F'&&p.gender!=='F';
    out.push(flip?mate:p, flip?p:mate);
  });
  return out;
}
// Never show HOW someone paid — just Paid or Pending.
function lineupHtml(roster){ const list=orderRosterPairs(roster), half=Math.ceil(list.length/2), out=[]; for(let r=0;r<half;r++){ for(const c of [0,1]){ const k=c*half+r; if(k>=list.length){ out.push('<div style="border:0"></div>'); continue; } const p=list[k]; out.push(`<div><span>${k+1}</span><span>${esc(firstName(p.name))}</span><i class="${p.paid?'paid':''}">${p.paid?'Paid':'Pending'}</i></div>`); } } return `<div class="lh-lineup">${out.join('')}</div>`; }
// Signed-in + registered → your status and a self-serve cancel replace Register.
function myRegBlock(l){
  const my=MYREG[l.id]; if(!my) return '';
  const wait=my.list==='waitlist';
  return `<div class="lh-state${wait?' wait':''}">${wait?'You’re on the waitlist':'You’re in'+(my.paymentStatus==='paid'?' · paid':'')}</div>
    <button type="button" class="lh-link danger" data-cancel="${esc(l.id)}" data-wait="${wait?1:0}">${wait?'Leave the waitlist':'Can’t make it? Cancel my spot'}</button>`;
}
function nightCard(l,hero){
  const cap=l.capacity||0, full=(l.spotsLeft||0)<=0, pct=cap?Math.round((cap-l.spotsLeft)/cap*100):0, tt=typeOf(l);
  const time=l.startTime?(l.endTime?`${l.startTime} to ${l.endTime}`:l.startTime):'';
  const fee=feeLabel(l), closed=l.status==='closed', live=l.status==='live', my=MYREG[l.id];
  const hasDesc=!!(l.description&&l.description.trim()), hasRules=!!(l.rules&&l.rules.trim());
  const names=(Array.isArray(l.courtNames)&&l.courtNames.length)?l.courtNames:(l.courtNumbers?String(l.courtNumbers).split('·').map(s=>s.trim()).filter(Boolean):[]);
  const nCourts=l.courts||names.length;
  let left, leftCls='';
  if(live) left='Live now';
  else if(my) left=my.list==='waitlist'?'On the waitlist':'You’re in';
  else if(closed){ left='Registration closed'; leftCls=' off'; }
  else if(full){ left=l.waitlistCount?l.waitlistCount+' waiting':'Full · waitlist open'; leftCls=' full'; }
  else left=l.spotsLeft+' spot'+(l.spotsLeft===1?'':'s')+' left';
  const start=startMsOf(l), ms=start?start-Date.now():null;
  const action = live
    ? `<a class="dk-btn" href="/ladder-live?event=${encodeURIComponent(l.id)}">Watch live</a>`
    : closed ? (myRegBlock(l)||'<div class="lh-state off">Registration is closed for this ladder</div>')
    : (myRegBlock(l)||`<button type="button" class="dk-btn${full?' dk-btn--out':''}" data-signup="${esc(l.id)}">${full?'Join the waitlist':'Register · '+esc(fee)}</button>`);
  const maps=l.place?`<a class="lh-map" href="https://maps.google.com/?q=${encodeURIComponent(l.address||l.place)}" target="_blank" rel="noopener">${esc(l.place)}</a>`:'—';
  return `<article class="dk-card ${hero?'dk-card--hot lh-hero-card ':''}lh-night" data-lad="${esc(l.id)}"${hero?' id="lh-herocard"':''}>
    <div class="lh-night__top"><span class="dk-pill">${hero?'Next ladder':esc(wd(l.date))}</span><span class="lh-night__left${leftCls}">${esc(left)}</span></div>
    <div class="lh-night__name">${esc(l.name)}</div>
    <div class="lh-chiprow"><span class="lh-tag ${tt}">${TL[tt]||'Mixed'}</span><span class="lh-chip">${FORMAT[l.format]||'Individual'}</span>${l.duprRated?'<span class="lh-chip">DUPR rated</span>':''}</div>
    ${l._invited?'<div class="lh-invite">Invite only. This link was shared with you directly.</div>':''}
    ${hero?`<div class="lh-facts">
      <div><small>When</small><b>${esc(wd(l.date))||'Date to come'}</b><span>${esc(time)}</span></div>
      <div><small>Where</small><b>${maps}</b><span>${nCourts?nCourts+' court'+(nCourts===1?'':'s')+' · ':''}${esc(fee)}</span></div>
    </div>`:`<div class="lh-line">${[esc(time),maps,nCourts?nCourts+' court'+(nCourts===1?'':'s'):'',esc(fee)].filter(Boolean).join(' · ')}</div>`}
    <div class="lh-fill"><span class="dk-track"><i class="${full?'full':pct>=80?'warn':''}" style="width:${Math.min(100,pct)}%"></i></span>
      <div><span>${cap-(l.spotsLeft||0)} of ${cap} in</span>${(!live&&ms!=null&&ms>0)?`<span>Starts in <span class="lh-cd" data-cd="${start}">${countdownLabel(ms)}</span></span>`:''}</div></div>
    <div class="lh-night__acts">${action}
      ${PREVIEW_URLS[l.id]?`<a class="lh-link" href="${esc(PREVIEW_URLS[l.id])}">Read the preview</a>`:''}
      ${(l.roster&&l.roster.length)?`<button type="button" class="lh-link" data-lineup="${esc(l.id)}" aria-expanded="${LEXP[l.id]?'true':'false'}">${LEXP[l.id]?'Hide who’s in':'See who’s in'}</button>`:''}
      ${(hasDesc||hasRules||names.length)?`<button type="button" class="lh-link" data-desc="${esc(l.id)}" aria-expanded="${LDESC[l.id]?'true':'false'}">${LDESC[l.id]?'Hide details':'Details'}</button>`:''}
      <button type="button" class="lh-link" data-share="${esc(l.id)}">Invite a friend</button>
    </div>
    ${(LEXP[l.id]&&l.roster&&l.roster.length)?lineupHtml(l.roster):''}
    ${LDESC[l.id]?((names.length?`<div class="lh-desc"><h4>Courts, top court first</h4><div class="lh-chiprow">${names.map((c,i)=>`<span class="lh-chip court">${esc(/^court/i.test(String(c).trim())?c:'Court '+c)}${i===0?' · King Court':''}</span>`).join('')}</div></div>`:'')+(hasDesc?`<div class="lh-desc"><h4>About this ladder</h4>${mdRender(l.description)}</div>`:'')+(hasRules?`<div class="lh-desc"><h4>Rules</h4>${mdRender(l.rules)}</div>`:'')):''}
  </article>`;
}

/* ════════════════ Hero ════════════════ */
function latestNight(){ return doneNights().find(n=>podiumFor(n.id).rows.length)||null; }
function renderHero(){
  const el=$('lh-hero'); if(!el) return;
  const open=openNights(), live=open.find(l=>l.status==='live'), last=latestNight(), next=open.find(l=>l.status!=='live')||open[0]||null;
  const brandPill=HUB.brand==='queen'?'<span class="dk-pill dk-pill--lime">Women’s ladder</span>':'<span class="dk-pill dk-pill--lime">Ladders</span>';
  const mark=HUB.brand==='queen'?`<div class="lh-mark">${QOTC}</div>`:'';
  let eyebrow, h1, lede='', acts='';
  if(live){
    eyebrow=`<span class="dk-pill dk-pill--live"><i></i>Live</span><span class="a">${esc(TL[typeOf(live)])} ladder</span><span class="b">${esc(live.place||'')}</span>`;
    h1=`${esc(live.name)} is <span class="lime">on court.</span>`;
    lede='Pairings and scores update as each round finishes.';
    acts=`<a class="dk-btn" href="/ladder-live?event=${encodeURIComponent(live.id)}">Open the live board</a>`;
  } else if(last){
    const pod=podiumFor(last.id), w=pod.rows, a=w[0], verb=(a.pair||String(a.name).includes(' & '))?'take':'takes';
    eyebrow=`${brandPill}<span class="a">Latest ladder${HUB.division?'':' · '+esc(TL[typeOf(last)])}</span><span class="b">${esc(wdLong(last.date))}</span>`;
    h1=`${esc(firstName(a.name))} ${verb} <span class="lime">${esc(last.name)}.</span>`;
    const place=last.place?String(last.place).split(' - ')[0]:'';
    lede=`<b>${a.w}–${a.l}</b>${a.diff!=null?` with a ${signed(a.diff)} point differential`:''}${place?' at '+esc(place):''}.`
      +(w[1]?` ${esc(rowName(w[1]))} finished second at ${w[1].w}–${w[1].l}`+(w[2]?` and ${esc(rowName(w[2]))} third at ${w[2].w}–${w[2].l}`:'')+(pod.field?`, in a field of ${pod.field}`:'')+'.':'');
    const recap=RECAP_URLS[last.id];
    acts=`<a class="dk-btn" href="${nightUrl(last.id)}">Full results</a>${recap?`<a class="dk-btn dk-btn--out" href="${esc(recap)}">Read the recap</a>`:''}`;
  } else {
    eyebrow=`${brandPill}<span class="a">Open play, one ladder at a time</span>`;
    h1=HUB.brand==='queen'?'Queen of the <span class="lime">Court.</span>':'Climb the <span class="lime">ladder.</span>';
    lede='Win and you move up a court. Lose and you move down. New partner every round.';
  }
  const side=next?nightCard(next,true)
    :`<article class="dk-card lh-hero-card lh-night" id="lh-herocard"><div class="lh-night__top"><span class="dk-pill dk-pill--out">Next ladder</span></div><div class="lh-night__name">Nothing open right now</div><p class="dk-sub" style="margin:0;font-size:14px;line-height:1.5;">New ladders are posted here as soon as registration opens.</p><div class="lh-night__acts"><button type="button" class="lh-link" data-tab="rules">How a ladder works</button></div></article>`;
  el.innerHTML=`<div class="dk-wrap dk-hero__in"><div class="dk-hero__txt">${mark}<div class="dk-eyebrow">${eyebrow}</div><h1 class="dk-h1">${h1}</h1>${lede?`<p class="dk-lede">${lede}</p>`:''}${acts?`<div class="dk-acts">${acts}</div>`:''}</div>${side}</div>`;
  renderMbar(next);
}
// Phones: once the hero card scrolls away, the next night stays one tap away.
let MBAR_IO=null;
function renderMbar(next){
  const bar=$('lh-mbar'); if(!bar) return;
  if(MBAR_IO){ MBAR_IO.disconnect(); MBAR_IO=null; }
  const ok=next&&next.status!=='closed'&&!MYREG[next.id];
  if(!ok){ bar.classList.remove('on'); document.body.classList.remove('lh-has-mbar'); return; }
  const full=(next.spotsLeft||0)<=0, live=next.status==='live';
  bar.innerHTML=`<div><b>${esc(next.name)}</b><span>${esc([wd(next.date),next.startTime,live?'live now':full?'waitlist open':next.spotsLeft+' spot'+(next.spotsLeft===1?'':'s')+' left'].filter(Boolean).join(' · '))}</span></div>`
    +(live?`<a class="dk-btn dk-btn--sm" href="/ladder-live?event=${encodeURIComponent(next.id)}">Watch</a>`:`<button type="button" class="dk-btn dk-btn--sm" data-signup="${esc(next.id)}">${full?'Waitlist':'Register'}</button>`);
  const card=$('lh-herocard');
  if(!card||!('IntersectionObserver' in window)){ bar.classList.add('on'); document.body.classList.add('lh-has-mbar'); return; }
  MBAR_IO=new IntersectionObserver(es=>{ const vis=es[0].isIntersecting; bar.classList.toggle('on',!vis); document.body.classList.toggle('lh-has-mbar',!vis); },{threshold:0.15});
  MBAR_IO.observe(card);
}

/* ════════════════ Bar: division + tabs ════════════════ */
function renderBar(){
  const el=$('lh-barin'); if(!el) return;
  let chips='';
  if(!HUB.division){
    const divs=activeDivs();
    if(divs.length>1) chips=`<div class="dk-chips" role="group" aria-label="Division">${['all',...divs].map(d=>`<button type="button" class="${DIV===d?'on':''}" data-div="${d}" aria-pressed="${DIV===d}">${d==='all'?'All':TL[d]}</button>`).join('')}</div>`;
  } else {
    chips=`<div class="dk-chips"><a href="/ladders.html">‹ All ladders</a></div>`;
  }
  el.innerHTML=chips+`<div class="dk-tabs lh-tabs" id="lh-tabs" role="tablist" aria-label="Ladder sections">${TABS.map(([id,lab])=>`<button type="button" role="tab" data-tab="${id}" aria-selected="${TAB===id}" class="${TAB===id?'on':''}">${lab}</button>`).join('')}</div>`;
}

/* ════════════════ Overview ════════════════ */
function tilesHtml(){
  const done=doneNights(), rows=divRows(DIV), rk=ranked(rows), open=openNights().filter(l=>l.status!=='live'&&l.status!=='closed');
  const top=(DIV==='all'?[...rk].sort((a,b)=>(b.dr??-1)-(a.dr??-1)):rk)[0];
  return `<section class="dk-tiles" aria-label="Season so far">
    <div class="dk-tile"><small>Ladders played</small><b>${done.length}</b><span>${DIV==='all'?'across every division':esc(TL[DIV])+' ladders'}</span></div>
    <div class="dk-tile"><small>Players</small><b>${rows.length}</b><span>${rk.length} ranked, ${MIN_LB_GAMES} games to qualify</span></div>
    <div class="dk-tile ${open.length?'hot':''}"><small>Open now</small><b>${open.length}</b><span>${open.length===1?'ladder taking sign-ups':'ladders taking sign-ups'}</span></div>
    ${top?`<div class="dk-tile"><small>${HUB.brand==='queen'?'Current Queen':'Holds #1'}</small><b style="font-size:24px;white-space:normal;line-height:1.1;">${esc(rowName(top))}</b><span>${top.w}–${top.l} · ${top.dr==null?'–':top.dr} DR${DIV==='all'?' · by rating':''}</span></div>`:''}
  </section>`;
}
function topCard(d){
  const rk=ranked(divRows(d)); if(!rk.length) return '';
  const a=rk[0];
  return `<article class="dk-card lh-top">
    <div class="lh-top__one"><a class="lh-top__pic" href="${profileUrl(a)}" aria-hidden="true" tabindex="-1">${avPic(a)}</a>
      <div class="lh-top__b"><div class="lh-top__k lh-div ${d}">${TL[d]} ladder</div><div class="dk-sub" style="font-size:12px;">${divRows(d).length} players, ${rk.length} ranked</div>
        <a class="lh-top__n" href="${profileUrl(a)}">${esc(rowName(a))}</a>
        <div class="lh-top__s"><span>${a.w}–${a.l}</span><span class="lime">${a.dr==null?'–':a.dr} DR</span><span class="muted">${a.nights||0} ladder${a.nights===1?'':'s'}</span></div></div></div>
    <div class="lh-top__rest">${rk.slice(1,3).map((p,i)=>`<div class="lh-mini"><span class="rk">${i+2}</span><a href="${profileUrl(p)}">${esc(rowName(p))}</a><span class="r">${p.w}–${p.l}</span><span class="v">${p.dr==null?'–':p.dr}</span></div>`).join('')}
      <button type="button" class="lh-link" data-board="${d}">Full board</button></div>
  </article>`;
}
function resCard(n){
  const pod=podiumFor(n.id).rows.slice(0,3), a=albumFor(n.id), ph=a&&a.photos&&a.photos[0], tt=typeOf(n), recap=RECAP_URLS[n.id];
  const pic=ph?`<a class="lh-res__pic" href="${nightUrl(n.id)}" aria-label="${esc(n.name)}" style="background-image:url('${esc(ph.thumb)}');background-position:${fpos(ph)}"></a>`
    :`<a class="lh-res__pic" href="${nightUrl(n.id)}" aria-hidden="true" tabindex="-1">${esc(md(n.date))}</a>`;
  return `<article class="dk-card lh-res" data-n="${esc(String(n.name||'').toLowerCase())} ${esc(String(n.place||'').toLowerCase())}">
    ${pic}<div class="lh-res__b">
      <div class="lh-res__k">${HUB.division?'':`<span class="lh-div ${tt}">${TL[tt]}</span>`}<span>${esc(wd(n.date))}</span></div>
      <a class="lh-res__n" href="${nightUrl(n.id)}">${esc(n.name)}</a>
      ${n.place?`<div class="lh-res__p">${esc(String(n.place).split(' - ')[0])}${a?` · ${a.count} photo${a.count===1?'':'s'}`:''}</div>`:''}
      <div>${pod.map((p,i)=>`<div class="lh-pod${i===0?' first':''}"><span class="rk">${i+1}</span><span class="nm">${esc(rowName(p))}</span><span class="r">${p.w}–${p.l}</span>${p.diff!=null?`<span class="d">${signed(p.diff)}</span>`:''}</div>`).join('')}</div>
      <div class="lh-res__f"><a href="${nightUrl(n.id)}">Results and rounds</a>${recap?`<a href="${esc(recap)}">Recap</a>`:''}</div>
    </div></article>`;
}
// Game night: a self-updating live board — current round by court, refreshed every 20s.
let LIVE_TIMER=null;
function stopLivePoll(){ if(LIVE_TIMER){ clearInterval(LIVE_TIMER); LIVE_TIMER=null; } }
function startLivePoll(id){ stopLivePoll(); setTimeout(()=>pollLive(id),60); LIVE_TIMER=setInterval(()=>pollLive(id),20000); }
function liveBoardHtml(l){
  startLivePoll(l.id);
  return `<section><div class="dk-card dk-card--hot lh-live">
    <div class="lh-live__top"><span class="dk-pill dk-pill--live"><i></i>Live now</span><b>${esc(l.name)}</b><a class="dk-btn dk-btn--sm" href="/ladder-live?event=${encodeURIComponent(l.id)}">Open the full live board</a></div>
    <div class="lh-live__body" id="liveBody"><div class="dk-empty">Loading the live board…</div></div></div></section>`;
}
async function pollLive(id){
  const el=$('liveBody');
  if(!el){ stopLivePoll(); return; }
  let j=null; try{ j=await (await fetch(`${API}/public-ladder-night?event=${encodeURIComponent(id)}`)).json(); }catch(e){ return; }
  const p=j&&j.play;
  if(!p||!p.started){ el.innerHTML='<div class="dk-empty">Round 1 is being set. Pairings appear here the moment play starts.</div>'; return; }
  const rd=p.rounds[p.currentRound]||p.rounds[p.rounds.length-1];
  if(!rd){ el.innerHTML='<div class="dk-empty">Waiting for the first round…</div>'; return; }
  // The engine's HIGHEST court number is the King Court; courtNames[0] is the
  // top court. Label = names[tC - num], and courts render King-first.
  const tC=(p.rounds[0]&&p.rounds[0].courts&&p.rounds[0].courts.length)||(rd.courts||[]).length;
  const cname=n=>{ const names=p.courtNames, idx=tC-n; const v=(Array.isArray(names)&&idx>=0&&idx<names.length)?String(names[idx]||'').trim():''; return v?(/^court/i.test(v)?v:'Court '+v):'Court '+(tC-n+1); };
  // First name only, except anyone sharing a first name with someone else tonight.
  const dup={}; ((j&&j.roster)||[]).forEach(pl=>{ const f=String((pl&&pl.name)||'').trim().split(/\s+/)[0]; if(f) dup[f.toLowerCase()]=(dup[f.toLowerCase()]||0)+1; });
  const nn=n=>{ const s=String(n||'').trim(), f=s.split(/\s+/)[0]||s; return dup[f.toLowerCase()]>1?s:f; };
  const pl=t=>(t||[]).map(x=>esc(nn(x.name))).join(' &amp; ')||'—';
  el.innerHTML=`<div class="rd">Round ${rd.round} of ${p.totalRounds}${p.finished?' · Final':''}</div>`+
    [...(rd.courts||[])].sort((a,b)=>(b.court||0)-(a.court||0)).map(c=>{
      const s=c.score, has=!!(s&&(s.t1!=null||s.t2!=null)), w1=has&&(s.t1||0)>(s.t2||0), w2=has&&(s.t2||0)>(s.t1||0), king=c.court===tC;
      return `<div class="lh-court${king?' king':''}"><div class="lh-court__top"><b>${esc(cname(c.court))}</b><span>${king?'King Court':''}</span></div>
        <div class="lh-side ${w1?'win':has?'':'tbd'}"><span class="n">${pl(c.team1)}</span><b>${has?(s.t1??0):''}</b></div>
        <div class="lh-side ${w2?'win':has?'':'tbd'}"><span class="n">${pl(c.team2)}</span><b>${has?(s.t2??0):''}</b></div></div>`;
    }).join('');
}
const KIT_CATS=[
  {k:'oneNightWonder',t:'One-Night Wonder',s:'most points in a single ladder',u:r=>({v:r.pts,x:r.date,w:'points in one ladder'})},
  {k:'kingOfTheCourt',t:HUB.brand==='queen'?'Queen of the Court':'King of the Court',s:'wins on the King Court',u:r=>({v:r.wins,x:'',w:'wins on the King Court'})},
  {k:'perRoundTop',t:'Per-Round Top',s:'highest average points (min 6 games)',u:r=>({v:r.avg,x:r.games+' games',w:'points a round'})},
  {k:'mostPoints',t:'Most Points',s:'season total, bonus included',u:r=>({v:num(r.total),x:r.crowns?r.crowns+' ladder win'+(r.crowns===1?'':'s'):'',w:'season points'})},
  {k:'hotStreak',t:'Hot Streak',s:'longest run of wins',u:r=>({v:r.streak,x:'',w:'wins in a row'})},
  {k:'bestDuo',t:'Best Duo',s:'win % (min 3 games together)',u:r=>({v:r.pct+'%',x:r.w+'–'+r.l,w:'won together'})},
  {k:'theWall',t:'The Wall',s:'fewest points allowed a round (min 6 games)',u:r=>({v:r.avg,x:'',w:'points allowed a round'})},
  {k:'ironPlayer',t:'Iron Player',s:'most ladders attended',u:r=>({v:r.nights,x:'',w:'ladders played'})},
  {k:'bigMover',t:'Big Mover',s:'biggest court climb in one ladder',u:r=>({v:'+'+r.climb,x:r.date,w:'courts climbed in one ladder'})},
  {k:'beatDown',t:'Beat Down',s:'biggest single-game margin',u:r=>({v:'+'+r.margin,x:'Round '+r.round,w:'point winning margin'})},
  {k:'comebackKid',t:'Comeback Kid',s:'wins straight after a loss',u:r=>({v:r.count,x:'',w:'wins after a loss'})},
  {k:'highestSingleGame',t:'Highest Single Game',s:'most points in one round',u:r=>({v:r.pts,x:'Round '+r.round,w:'points in one round'})},
];
const kitName=(cat,r)=>cat.k==='bestDuo'?`${firstName(r.a)} & ${firstName(r.b)}`:firstLast(r.name);
function renderOverview(){
  const el=$('p-overview'); if(!el) return;
  if(DIV!=='all'&&!HUB.division) ensureDiv(); else if(HUB.division) ensureDiv();
  const open=openNights(), live=open.find(l=>l.status==='live'), heroNext=open.find(l=>l.status!=='live')||open[0]||null;
  const rest=open.filter(l=>l!==heroNext&&l.status!=='live');
  let h=tilesHtml();
  if(live) h+=liveBoardHtml(live); else stopLivePoll();
  if(rest.length) h+=`<section id="play"><div class="dk-head"><h2 class="dk-h2 dk-h2--lg">More ladders open</h2><span>${rest.length} more taking sign-ups</span></div><div class="dk-grid" style="--min:320px;align-items:start;">${rest.map(l=>nightCard(l,false)).join('')}</div></section>`;
  // Who holds #1: one card per division on "All", the top five on a single division.
  if(DIV==='all'){
    const cards=activeDivs().map(topCard).filter(Boolean).join('');
    if(cards) h+=`<section><div class="dk-head"><h2 class="dk-h2 dk-h2--lg">Who holds #1</h2><span>Ranked by wins. ${MIN_LB_GAMES} games to qualify, on every board.</span></div><div class="dk-grid">${cards}</div></section>`;
  } else {
    const rk=ranked(divRows(DIV)).slice(0,5);
    if(rk.length) h+=`<section><div class="dk-head"><h2 class="dk-h2 dk-h2--lg">Top of the ${HUB.brand==='queen'?'Queen':esc(TL[DIV])} board</h2><button type="button" class="dk-more" data-tab="board">Full board</button></div>
      <div class="dk-card dk-rows">${rk.map((p,i)=>boardRow(p,i+1,'wins')).join('')}</div></section>`;
  }
  const done=doneNights().slice(0,4);
  if(done.length) h+=`<section><div class="dk-head"><h2 class="dk-h2">Latest results</h2><button type="button" class="dk-more" data-tab="results">All ${doneNights().length} ladders</button></div><div class="dk-grid" style="--min:260px;">${done.map(resCard).join('')}</div></section>`;
  const K=(scopeStats()||{}).kitchen;
  if(K){
    const tiles=KIT_CATS.map(cat=>{ const r=(K[cat.k]||[]).find(x=>!x.tie); if(!r) return ''; const u=cat.u(r);
      return `<div class="dk-tile"><small>${esc(cat.t)}</small><b>${esc(String(u.v))}</b><span class="nm" style="margin-top:6px;font-size:15px;font-weight:800;color:var(--color-text);">${esc(kitName(cat,r))}</span><span style="margin-top:2px;">${esc(u.w)}${u.x?' · '+esc(String(u.x)):''}</span></div>`; }).filter(Boolean).slice(0,6).join('');
    if(tiles) h+=`<section><div class="dk-head"><h2 class="dk-h2">The Kitchen <span class="lime">· season awards</span></h2><button type="button" class="dk-more" data-tab="kitchen">All 12 awards</button></div><div class="dk-tiles" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));">${tiles}</div></section>`;
  }
  const al=(PHALBUMS||[]).filter(a=>inScope(a)&&(a.photos||[]).length)[0];
  if(al) h+=`<section><div class="dk-head"><h2 class="dk-h2">In pictures</h2><button type="button" class="dk-more" data-tab="photos">Every album</button></div>
    <div class="dk-pics">${al.photos.slice(0,6).map((p,i)=>`<button type="button" data-ev="${esc(al.eventId)}" data-i="${i}" aria-label="Open photo ${i+1} from ${esc(al.name)}"><img src="${esc(p.thumb)}" alt="${esc(p.caption||al.name)}" loading="lazy" style="object-position:${fpos(p)}"></button>`).join('')}</div></section>`;
  if(!STATS||(!done.length&&!open.length)) h+='<div class="dk-card dk-empty">No ladders played yet. Results show up here after the first one is scored.</div>';
  el.innerHTML=h;
}

/* ════════════════ Results ════════════════ */
let resAll=false, resFind='';
function renderResults(){
  const el=$('p-results'); if(!el) return;
  const all=doneNights();
  if(!all.length){ el.innerHTML='<div class="dk-card dk-empty">No finished ladders yet.</div>'; return; }
  el.innerHTML=`<div class="dk-head dk-head--mid" style="margin-bottom:0;"><h2 class="dk-h2 dk-h2--lg">Results <span class="lime">· ${all.length} ladder${all.length===1?'':'s'}</span></h2><span>Podium, full field, rounds and the write-up</span></div>
    ${all.length>8?`<div><label class="dk-sr" for="lh-rfind">Find a ladder</label><input class="dk-find" id="lh-rfind" type="search" placeholder="Find a ladder by name or place" autocomplete="off" value="${esc(resFind)}"></div>`:''}
    <div class="dk-grid" style="--min:260px;" id="lh-rlist"></div><div id="lh-rmore" style="text-align:center;"></div>`;
  paintResults();
}
function paintResults(){
  const list=$('lh-rlist'); if(!list) return;
  const q=resFind.trim().toLowerCase(), all=doneNights().filter(n=>!q||String(n.name||'').toLowerCase().includes(q)||String(n.place||'').toLowerCase().includes(q));
  const show=(resAll||q)?all:all.slice(0,12);
  list.innerHTML=show.length?show.map(resCard).join(''):`<div class="dk-empty" style="grid-column:1/-1;">No ladder matches “${esc(resFind)}”.</div>`;
  $('lh-rmore').innerHTML=(!resAll&&!q&&all.length>12)?`<button type="button" class="dk-btn dk-btn--out" data-resall="1">Show all ${all.length} ladders</button>`:'';
}

/* ════════════════ Board ════════════════ */
const SORTS=[['wins','Wins'],['points','Points'],['dr','DR'],['xp','XP']];
const sortVal=(p,m)=>m==='xp'?(p.xp||0):m==='dr'?(p.dr??-1):m==='points'?(p.seasonPts!=null?p.seasonPts:(p.pf||0)):(p.w||0);
const gOf=p=>{ const c=String(p&&p.gender||'').toUpperCase()[0]; return c==='M'?'M':c==='F'?'F':null; };
function sortRows(rows,m){ if(m==='wins') return [...rows].sort((a,b)=>((b.w||0)-(a.w||0))||((b.diff||0)-(a.diff||0))||((b.dr??-1)-(a.dr??-1))); return [...rows].sort((a,b)=>(sortVal(b,m)-sortVal(a,m))||((b.w||0)-(a.w||0))||((b.dr??-1)-(a.dr??-1))); }
function boardRow(p,rank,m){
  const g=games(p), pc=g?Math.round(100*(p.w||0)/g)+'%':'–', me=STATS&&STATS.you&&STATS.you.id===p.id, st=p.streak||0;
  const sub=[`${p.nights||0} ladder${p.nights===1?'':'s'}`, p.podiums?`${p.podiums} podium${p.podiums===1?'':'s'}`:'', st>0?`won ${st>1?st+' straight':'1'}`:st<0?`lost ${st<-1?(-st)+' straight':'1'}`:''].filter(Boolean).join(' · ');
  const c=(k,lab,val,cls)=>`<div><small>${lab}</small><b class="${m===k?'main':''}${cls?' '+cls:''}">${val}</b></div>`;
  return `<div class="dk-row lh-row${me?' me':''}"><div class="who"><span class="rk">${rank||''}</span>${av(p)}<div><a class="nm" href="${profileUrl(p)}">${esc(rowName(p))}${me?' <span class="g">You</span>':''}</a><span class="sm">${esc(sub)}</span></div></div>
    <div class="dk-cells" style="--n:6;">${c('wins','W–L',`${p.w||0}–${p.l||0}`)}${c('pct','Win %',pc)}${c('diff','Diff',signed(p.diff),p.diff>0?'pos':p.diff<0?'neg':'')}${c('points','Pts',num(sortVal(p,'points')))}${c('dr','DR',p.dr==null?'–':p.dr)}${c('xp','XP',num(p.xp||0))}</div></div>`;
}
function podCard(p,rank,m){
  const big={wins:[p.w||0,'wins'],points:[num(sortVal(p,'points')),'points'],dr:[p.dr==null?'–':p.dr,'DR'],xp:[num(p.xp||0),'XP']}[m];
  return `<a class="dk-pc${rank===1?' first':''}" href="${profileUrl(p)}"><span class="dk-pc__pic">${avPic(p)}</span><span class="dk-pc__b">
    <span class="dk-pc__k">${ordinal(rank)}</span><span class="dk-pc__n">${esc(rowName(p))}</span>
    <span class="dk-pc__v"><b>${big[0]}</b><span>${big[1]}</span></span>
    <span class="dk-pc__s"><span>${p.w||0}–${p.l||0}</span><span>${signed(p.diff)}</span>${m!=='dr'?`<span>${p.dr==null?'–':p.dr} DR</span>`:''}<span>${p.nights||0} ladder${p.nights===1?'':'s'}</span></span></span></a>`;
}
let lbFind='';
function renderBoard(){
  const el=$('p-board'); if(!el) return;
  const src=divRows(DIV);
  if(!src.length){ el.innerHTML='<div class="dk-card dk-empty">No results yet. The board fills in after the first scored ladder.</div>'; return; }
  const m=curSort(), showG=(DIV==='all'||DIV==='mixed');
  const title=DIV==='all'?'The overall <span class="lime">board.</span>':HUB.brand==='queen'?'The Queen <span class="lime">board.</span>':`The ${esc(TL[DIV])} <span class="lime">board.</span>`;
  const note=DIV==='all'
    ?'Everyone, across every ladder that counts toward the standings. Wins and points only compare fairly inside one division, so Overall is ranked by Dink Rating unless you pick another column.'
    :`Only ${esc(TL[DIV]).toLowerCase()} ladders count here. Ranked by wins, then point differential, then Dink Rating.`;
  el.innerHTML=`<div class="dk-head" style="margin-bottom:0;"><h2 class="dk-h2 dk-h2--lg">${title}</h2><span>${ranked(src).length} ranked of ${src.length} players</span></div>
    <p class="dk-sub" style="margin:-20px 0 0;max-width:720px;line-height:1.5;">${note}</p>
    ${DIV==='womens'&&!HUB.division?'<p class="dk-sub" style="margin:-20px 0 0;">This is the same board as the <a class="lime" href="/queen.html#board" style="font-weight:700;">Queen of the Court page</a>.</p>':''}
    <div class="dk-ctl">
      <div class="grow"><label class="dk-lbl" for="lh-bfind">Find a player</label><input class="dk-find" id="lh-bfind" type="search" placeholder="Start typing a name" autocomplete="off" value="${esc(lbFind)}"></div>
      ${showG?`<div><span class="dk-lbl">Show</span><div class="dk-seg" role="group" aria-label="Show">${[['all','All'],['M','Men'],['F','Women']].map(([k,l])=>`<button type="button" class="${lbGender===k?'on':''}" data-gender="${k}" aria-pressed="${lbGender===k}">${l}</button>`).join('')}</div></div>`:''}
    </div>
    <div class="lh-board"><div class="lh-sortbar"><span class="dk-lbl">Rank by</span><div class="dk-seg" role="group" aria-label="Rank by">${SORTS.map(([k,l])=>`<button type="button" class="${m===k?'on':''}" data-sort="${k}" aria-pressed="${m===k}">${l}</button>`).join('')}</div></div>
    <div id="lh-blist" style="display:flex;flex-direction:column;gap:24px;"></div></div>`;
  paintBoard();
}
function paintBoard(){
  const list=$('lh-blist'); if(!list) return;
  const src=divRows(DIV), m=curSort(), showG=(DIV==='all'||DIV==='mixed'), g=showG?lbGender:'all', q=lbFind.trim().toLowerCase();
  let rows=sortRows(ranked(src),m); if(g!=='all') rows=rows.filter(p=>gOf(p)===g);
  rows=rows.map((p,i)=>({p,rank:i+1}));
  const unq=sortRows(src.filter(p=>!p.tie&&games(p)>0&&games(p)<MIN_LB_GAMES&&(g==='all'||gOf(p)===g)),m);
  let h='';
  if(!rows.length) h+=`<div class="dk-card dk-empty">Players join the board after ${MIN_LB_GAMES} games, about two ladders.</div>`;
  else if(q){
    const hit=rows.filter(r=>String(rowName(r.p)).toLowerCase().includes(q)||String(r.p.name||'').toLowerCase().includes(q));
    const hitU=unq.filter(p=>String(p.name||'').toLowerCase().includes(q));
    h+=(hit.length||hitU.length)?`<div class="dk-card dk-rows">${hit.map(r=>boardRow(r.p,r.rank,m)).join('')}${hitU.map(p=>boardRow(p,'',m)).join('')}</div>${hitU.length?`<p class="dk-note" style="padding:0;">Players without a rank have played fewer than ${MIN_LB_GAMES} games.</p>`:''}`
      :`<div class="dk-card dk-empty">No player matches “${esc(lbFind)}”.</div>`;
  } else {
    const top=rows.slice(0,3), rest=rows.slice(3), show=lbShowAll?rest:rest.slice(0,22);
    if(top.length>=3) h+=`<div class="dk-grid" style="--min:240px;">${top.map(r=>podCard(r.p,r.rank,m)).join('')}</div>`;
    const body=(top.length>=3?show:rows.slice(0,lbShowAll?rows.length:25));
    if(body.length) h+=`<div class="dk-card dk-rows">${body.map(r=>boardRow(r.p,r.rank,m)).join('')}
      ${(!lbShowAll&&rows.length>25)?`<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 20px;padding-top:14px;"><span class="dk-sub">Showing 25 of ${rows.length} ranked players.</span><button type="button" class="dk-btn dk-btn--out dk-btn--sm" data-lball="1">Show all ${rows.length}</button></div>`:''}</div>`;
    if(unq.length) h+=`<div class="dk-card"><div class="lh-unq"><div><b>Not yet ranked · ${unq.length} player${unq.length===1?'':'s'}</b><span>Fewer than ${MIN_LB_GAMES} games played.</span></div><button type="button" class="dk-btn dk-btn--out dk-btn--sm" data-lbunq="1" aria-expanded="${lbShowUnq}">${lbShowUnq?'Hide them':'Show them'}</button></div>${lbShowUnq?`<div class="dk-rows" style="border-top:1px solid var(--color-border);">${unq.map(p=>boardRow(p,'',m)).join('')}</div>`:''}</div>`;
  }
  list.innerHTML=h;
  ensureAvatars(idsOf(rows.slice(0,60).map(r=>r.p)),()=>paintBoard());
}

/* ════════════════ Kitchen ════════════════ */
function renderKitchen(){
  const el=$('p-kitchen'); if(!el) return;
  if(DIV!=='all') ensureDiv();
  const S=scopeStats(), K=S&&S.kitchen;
  if(DIV!=='all'&&!S){ el.innerHTML='<div class="dk-card dk-empty">Loading the Kitchen…</div>'; return; }
  if(!K){ el.innerHTML='<div class="dk-card dk-empty">Fun stats show up once a ladder or two has been scored.</div>'; return; }
  const row=(cat,r,i)=>{ if(r.tie) return `<div class="lh-kr tie">${r.count} players tied for the last spot</div>`; const u=cat.u(r); return `<div class="lh-kr"><span class="rk">${i+1}</span><span class="nm">${esc(kitName(cat,r))}</span>${u.x?`<span class="xt">${esc(String(u.x))}</span>`:''}<span class="vl">${esc(String(u.v))}</span></div>`; };
  const cards=KIT_CATS.map(cat=>{ const rows=K[cat.k]||[]; return `<div class="dk-card lh-kc"><h3>${esc(cat.t)}</h3><p>${esc(cat.s)}</p>${rows.length?rows.map((r,i)=>row(cat,r,i)).join(''):'<div class="lh-kr tie">Not enough games yet.</div>'}</div>`; }).join('');
  const simple=(title,sub,rows)=>rows&&rows.length?`<div class="dk-card lh-kc"><h3>${title}</h3><p>${sub}</p>${rows.join('')}</div>`:'';
  const mvp=(S.mvpLeaders||[]).map((x,i)=>x.tie?`<div class="lh-kr tie">${x.count} players tied for the last spot</div>`:`<div class="lh-kr"><span class="rk">${i+1}</span><a class="nm" href="/profile?ladderId=${encodeURIComponent(x.id)}">${esc(firstLast(x.name))}</a><span class="vl">${x.count}×</span></div>`);
  let pr=(S.partnerships||[]).filter(p=>p.tie||(p.w+p.l)>=3); if(!pr.filter(p=>!p.tie).length) pr=S.partnerships||[];
  const duo=pr.map((p,i)=>p.tie?`<div class="lh-kr tie">${p.count} pairs tied for the last spot</div>`:`<div class="lh-kr"><span class="rk">${i+1}</span><span class="nm">${esc(firstName(p.a))} &amp; ${esc(firstName(p.b))}</span><span class="xt">${p.w}–${p.l}</span><span class="vl">${p.pct}%</span></div>`);
  el.innerHTML=`<div class="dk-head" style="margin-bottom:0;"><h2 class="dk-h2 dk-h2--lg">The Kitchen <span class="lime">· ${DIV==='all'?'season awards':esc(TL[DIV])+' ladders'}</span></h2><span>Bragging rights, updated after every ladder. 10 games and 2 ladders to qualify.</span></div>
    <div class="lh-kit">${cards}${simple('Top performers','most round-best finishes',mvp)}${simple('Best partnerships','win % together (min 3 games)',duo)}</div>`;
}

/* ════════════════ Photos ════════════════ */
const SEL={};
function renderPhotos(){
  const el=$('p-photos'); if(!el) return;
  if(PHALBUMS===null){ el.innerHTML='<div class="dk-card dk-empty">Loading photos…</div>'; return; }
  const albums=PHALBUMS.filter(a=>inScope(a)&&(a.photos||[]).length);
  if(!albums.length){ el.innerHTML='<div class="dk-card dk-empty">No photos yet. They appear here, grouped by ladder, as soon as they are added.</div>'; return; }
  const total=albums.reduce((n,a)=>n+a.photos.length,0);
  el.innerHTML=`<div class="dk-head" style="margin-bottom:0;"><h2 class="dk-h2 dk-h2--lg">Photos <span class="lime">· ${total}</span></h2><span>Newest first. Tap a photo to open it full size.</span></div>
    <div>${albums.map(a=>`<div class="lh-album" id="album-${esc(a.eventId)}">
      <div class="lh-album__h"><h3>${esc(a.name)}</h3><span>${esc(wd(a.date))} · ${a.photos.length} photo${a.photos.length===1?'':'s'}</span><a class="dk-more" href="${nightUrl(a.eventId)}">Results</a><button type="button" class="dk-more" data-sel="${esc(a.eventId)}">Select</button></div>
      <div class="lh-selbar"><span data-selcount>0 selected</span><span style="display:flex;gap:8px;flex-wrap:wrap;"><button type="button" class="dk-btn dk-btn--out dk-btn--sm" data-selall="${esc(a.eventId)}">Select all</button><button type="button" class="dk-btn dk-btn--sm" data-seldl="${esc(a.eventId)}">Download</button></span></div>
      <div class="dk-pics">${a.photos.map((p,i)=>`<button type="button" class="lh-ph" data-ev="${esc(a.eventId)}" data-i="${i}" aria-label="Open photo ${i+1} from ${esc(a.name)}"><img src="${esc(p.thumb)}" alt="${esc(p.caption||a.name)}" loading="lazy" style="object-position:${fpos(p)}"><span class="ck" aria-hidden="true"></span></button>`).join('')}</div></div>`).join('')}</div>`;
}
/* Downloads: no zip. One photo is a plain link with dl=1; a multi-select fires
   those links one at a time, spaced out, because browsers drop a burst. */
function fire(url){ const a=document.createElement('a'); a.href=url; a.download=''; a.style.display='none'; document.body.appendChild(a); a.click(); setTimeout(()=>a.remove(),1000); }
function toggleSel(id){ const w=$('album-'+id); if(!w) return; const on=!w.classList.contains('selmode'); w.classList.toggle('selmode',on); SEL[id]=new Set(); w.querySelectorAll('.lh-ph.sel').forEach(p=>p.classList.remove('sel')); const b=w.querySelector('[data-sel]'); if(b) b.textContent=on?'Done':'Select'; paintSel(id); }
function paintSel(id){ const w=$('album-'+id), c=w&&w.querySelector('[data-selcount]'); if(c) c.textContent=((SEL[id]||new Set()).size)+' selected'; }
let LB_ALBUM=null, LB_I=0;
function lbEl(){
  let lb=$('lh-lb'); if(lb) return lb;
  lb=document.createElement('div'); lb.id='lh-lb'; lb.setAttribute('role','dialog'); lb.setAttribute('aria-modal','true'); lb.setAttribute('aria-label','Photo viewer');
  lb.innerHTML='<div class="top"><span id="lh-lbct"></span><button class="x" type="button" data-lbx aria-label="Close">&times;</button></div><div class="body"><button class="nav" type="button" data-lbstep="-1" aria-label="Previous">‹</button><img id="lh-lbimg" alt=""><button class="nav" type="button" data-lbstep="1" aria-label="Next">›</button></div><div class="foot"><div id="lh-lbcap"></div><div class="acts"><a class="pri" id="lh-lbdl" href="#" download>Download</a><button type="button" data-lbshare>Share</button><a id="lh-lbnight" href="#">Results from this ladder</a></div></div>';
  document.body.appendChild(lb);
  let sx=null;
  lb.addEventListener('touchstart',e=>{ sx=e.touches[0].clientX; },{passive:true});
  lb.addEventListener('touchend',e=>{ if(sx===null) return; const dx=e.changedTouches[0].clientX-sx; if(Math.abs(dx)>45) stepLb(dx<0?1:-1); sx=null; },{passive:true});
  return lb;
}
function openLb(evId,i){ LB_ALBUM=albumFor(evId); LB_I=i||0; if(!LB_ALBUM) return; lbEl().classList.add('on'); document.body.style.overflow='hidden'; paintLb(); }
function paintLb(){ const p=LB_ALBUM.photos[LB_I]; if(!p) return; $('lh-lbimg').src=p.url; $('lh-lbimg').alt=p.caption||LB_ALBUM.name; $('lh-lbcap').textContent=[p.caption,LB_ALBUM.name,wd(LB_ALBUM.date)].filter(Boolean).join(' · '); $('lh-lbct').textContent=`${LB_I+1} / ${LB_ALBUM.photos.length}`; $('lh-lbdl').href=p.download||p.url; $('lh-lbnight').href=nightUrl(LB_ALBUM.eventId);
  [LB_I-1,LB_I+1].forEach(i=>{ const n=LB_ALBUM.photos[i]; if(n) new Image().src=n.url; }); }
function stepLb(n){ if(!LB_ALBUM) return; const i=LB_I+n; if(i>=0&&i<LB_ALBUM.photos.length){ LB_I=i; paintLb(); } }
function closeLb(){ const lb=$('lh-lb'); if(!lb) return; lb.classList.remove('on'); document.body.style.overflow=''; $('lh-lbimg').src=''; }
document.addEventListener('keydown',e=>{ const lb=$('lh-lb'); if(!lb||!lb.classList.contains('on')) return; if(e.key==='Escape') closeLb(); else if(e.key==='ArrowLeft') stepLb(-1); else if(e.key==='ArrowRight') stepLb(1); });

/* ════════════════ Rules ════════════════ */
const RULES_COMMON=[
  ['Games to 11, win by 1','Every game is first to 11. Reach 11 before your opponents and you win, played within the round’s allotted time.'],
  ['Beat the clock','If time runs out before either team reaches 11, the team ahead when the buzzer sounds wins the game. Tied when time runs out? The team that reached that score first wins.'],
  ['Winners up, losers down','After each round, winning teams rise a court, losing teams drop one, and partners split. Fresh teams every round. The top court is the King Court.'],
];
const RULES={
  ladder:[...RULES_COMMON,
    ['Round Robin ladders (2 courts)','Nine games in three blocks. Games 1 to 3: random courts, same court, new partner every game. After games 3 and 6, each court re-ranks on that block: the top 2 move up, the bottom 2 move down. Finish first and your next ladder is free.'],
    ['Who wins the ladder','1. Most wins. 2. If tied, highest point differential. 3. Still tied, higher Dink Rating (DR).'],
    ['Dink Rating (DR)','A 0 to 100 skill score from your results. It is the final tiebreaker, it is used to balance teams, and it follows you across every division.'],
    ['Three divisions, one ladder','Mixed, Men’s and Women’s ladders each build their own board, so a result only moves the rankings of its own division. The Overall board puts everyone together by Dink Rating.'],
    ['Entry and payment','Pay by card (+10% service fee), Venmo (fee-free), or ladder credit. Your spot is held until paid.'],
    ['Cancellations','Cancel and your spot reopens for the next player. No refunds, no credit.'],
    ['Waitlist','If a ladder is full, join the waitlist. The next person gets 30 minutes to claim an opening. Inside 24 hours it is first come, first served.'],
  ],
  queen:[
    ['Women’s field only','Registration is gender-locked. If your profile has no gender on file, the sign-up sheet asks once and saves it.'],
    ...RULES_COMMON,
    ['Who wins the ladder','1. Most wins. 2. If tied, highest point differential. 3. Still tied, higher Dink Rating (DR).'],
    ['Dink Rating (DR)','A 0 to 100 skill score from your results. It is the final tiebreaker, and it is cumulative across every format you play.'],
    ['Where the stats land','Results build the Queen board, which is the Women’s board on the ladder page. Your profile still shows the overall sum across every format, plus a per-format breakdown.'],
    ['Cancellations','Cancel and your spot reopens for the next player. No refunds, no credit.'],
  ],
};
function renderRules(){
  const el=$('p-rules'); if(!el) return;
  const list=RULES[HUB.brand==='queen'?'queen':'ladder'];
  el.innerHTML=`<div class="dk-head" style="margin-bottom:0;"><h2 class="dk-h2 dk-h2--lg">${HUB.brand==='queen'?'Queen ladder rules':'Ladder rules'}</h2><span>How a Dink Society ladder works</span></div>
    <div class="lh-rules">${list.map((r,i)=>`<div class="dk-card lh-rule"><i>${i+1}</i><div><b>${esc(r[0])}</b><p>${esc(r[1])}</p></div></div>`).join('')}</div>`;
}

function renderAll(){
  if(!$('hub')) return;
  renderHero(); renderBar(); renderOverview(); renderResults(); renderBoard(); renderKitchen(); renderPhotos(); renderRules(); paintTabs(); setTop();
}
// The bar sits under the fixed nav, whatever its height is today.
function setTop(){ let h=0; ['.ds-nav','.ds-pastbar'].forEach(s=>{ const n=document.querySelector(s); if(!n) return; const r=n.getBoundingClientRect(); if(r.height>0&&r.bottom>h&&r.top<=0) h=r.bottom; }); document.documentElement.style.setProperty('--dk-top',Math.max(0,Math.round(h))+'px'); const bar=$('lh-bar'); if(bar) document.documentElement.style.setProperty('--lh-barh',Math.round(bar.getBoundingClientRect().height)+'px'); }
window.addEventListener('resize',setTop); setTimeout(setTop,300); setTimeout(setTop,1500);

/* ════════════════ Events ════════════════ */
document.addEventListener('click',e=>{
  const t=e.target;
  let b;
  if((b=t.closest('[data-lbx]'))){ closeLb(); return; }
  if((b=t.closest('[data-lbstep]'))){ stepLb(+b.dataset.lbstep); return; }
  if((b=t.closest('[data-lbshare]'))){ const p=LB_ALBUM&&LB_ALBUM.photos[LB_I]; if(!p) return; const url=location.origin+p.url;
    if(navigator.share){ navigator.share({title:LB_ALBUM.name,url}).catch(()=>{}); return; }
    if(navigator.clipboard) navigator.clipboard.writeText(url).then(()=>{ if(window.dsToast) dsToast({type:'success',title:'Link copied'}); }); return; }
  if(t.id==='lh-lb'||(t.classList&&t.classList.contains('body')&&t.closest('#lh-lb'))){ closeLb(); return; }
  if(!t.closest('#hub')&&!t.closest('#lh-mbar')&&!t.closest('#lh-bar')) return;
  if((b=t.closest('[data-tab]'))){ setTab(b.dataset.tab); return; }
  if((b=t.closest('[data-div]'))){ setDiv(b.dataset.div); return; }
  if((b=t.closest('[data-board]'))){ DIV=b.dataset.board; lbSort=null; TAB='board'; writeHash(); renderAll(); setTab('board'); return; }
  if((b=t.closest('[data-signup]'))){ openSignup(b.dataset.signup); return; }
  if((b=t.closest('[data-cancel]'))){ cancelSpot(b.dataset.cancel,b.dataset.wait==='1'); return; }
  if((b=t.closest('[data-lineup]'))){ LEXP[b.dataset.lineup]=!LEXP[b.dataset.lineup]; renderHero(); renderOverview(); return; }
  if((b=t.closest('[data-desc]'))){ LDESC[b.dataset.desc]=!LDESC[b.dataset.desc]; renderHero(); renderOverview(); return; }
  if((b=t.closest('[data-share]'))){ ladShare(b.dataset.share); return; }
  if((b=t.closest('[data-sort]'))){ lbSort=b.dataset.sort; writeHash(); segOn(b); paintBoard(); return; }
  if((b=t.closest('[data-gender]'))){ lbGender=b.dataset.gender; segOn(b); paintBoard(); return; }
  if((b=t.closest('[data-lball]'))){ lbShowAll=true; paintBoard(); return; }
  if((b=t.closest('[data-lbunq]'))){ lbShowUnq=!lbShowUnq; paintBoard(); return; }
  if((b=t.closest('[data-resall]'))){ resAll=true; paintResults(); return; }
  if((b=t.closest('[data-sel]'))){ toggleSel(b.dataset.sel); return; }
  if((b=t.closest('[data-selall]'))){ const a=albumFor(b.dataset.selall); if(!a) return; SEL[a.eventId]=new Set(a.photos.map((_,i)=>i)); $('album-'+a.eventId).querySelectorAll('.lh-ph').forEach(p=>p.classList.add('sel')); paintSel(a.eventId); return; }
  if((b=t.closest('[data-seldl]'))){ const a=albumFor(b.dataset.seldl); if(!a) return; const idx=[...(SEL[a.eventId]||new Set())].sort((x,y)=>x-y);
    if(!idx.length){ if(window.dsToast) dsToast({type:'info',message:'Pick a photo first.'}); return; }
    if(window.dsToast) dsToast({type:'info',message:`Downloading ${idx.length} photo${idx.length===1?'':'s'}…`}); idx.forEach((i,n)=>setTimeout(()=>fire(a.photos[i].download||a.photos[i].url),n*450)); return; }
  if((b=t.closest('[data-ev][data-i]'))){ const id=b.dataset.ev, i=+b.dataset.i, w=$('album-'+id);
    if(w&&w.classList.contains('selmode')&&b.classList.contains('lh-ph')){ SEL[id]=SEL[id]||new Set(); if(SEL[id].has(i)){ SEL[id].delete(i); b.classList.remove('sel'); } else { SEL[id].add(i); b.classList.add('sel'); } paintSel(id); return; }
    openLb(id,i); return; }
});
document.addEventListener('input',e=>{
  if(e.target.id==='lh-bfind'){ lbFind=e.target.value; paintBoard(); }
  else if(e.target.id==='lh-rfind'){ resFind=e.target.value; paintResults(); }
});
const segOn=b=>b.parentNode.querySelectorAll('button').forEach(x=>{ const on=x===b; x.classList.toggle('on',on); x.setAttribute('aria-pressed',on); });
function closeOv(id){ $(id).classList.remove('on'); }

/* ════════════════ Cancel / share ════════════════ */
function curLadder(id){ return ACTIVE.find(l=>l.id===id); }
async function cancelSpot(id,wait){
  const l=curLadder(id)||{};
  const nm=l.name||'this ladder';
  const paid=(l.feeCents||0)>0;
  const getsCredit=paid&&(l.cancelPolicy||'auto_credit')==='auto_credit';
  const ok = wait
    ? await dsConfirm({ title:'Leave the waitlist?', message:"You'll drop off the waitlist for "+nm+".", confirmLabel:'Leave waitlist', cancelLabel:'Stay on' })
    : await dsConfirm({ title:'Cancel your spot?', message:"Your spot for "+nm+" reopens for the next player"+(getsCredit?", and you get ladder credit for what you paid (no refunds)":" — no refunds, no credit")+".", confirmLabel:'Cancel my spot', cancelLabel:'Keep my spot', danger:true });
  if(!ok) return;
  try{
    const r=await fetch(`${API}/ladder-signup?event=${encodeURIComponent(id)}`,{method:'DELETE',credentials:'include'});
    const d=await r.json().catch(()=>({}));
    if(r.status===401){ dsToast({ type:'warn', title:'Sign in needed', message:'Sign in on your Profile, then try again.' }); return; }
    if(!d.ok){ dsToast({ type:'error', message:d.error||'Could not cancel — try again or contact the organizer.' }); return; }
    if(wait||d.was==='waitlist'){ dsCelebrate({ glyph:'🎟', title:"You're off the waitlist", message:'Your waitlist spot has been released.' }); } else { dsCelebrate({ glyph:'🎟', title:"You're off the list", html:true, message:((d.creditedCents||0)>0?'A <b>'+fmt(d.creditedCents)+'</b> ladder credit is on your account for next time.':'Thanks for letting us know!') }); }
    init();
  }catch(e){ dsToast({ type:'error', message:'Network problem — check your connection and try again.' }); }
}
// One tap opens the phone's own share sheet (Messages, WhatsApp, wherever), so
// a player can pull a friend into the night without leaving the page. Desktop
// browsers mostly lack navigator.share, so there we copy the invite instead.
function ladShareUrl(l){ return location.origin+'/ladders?event='+encodeURIComponent(l.id); }
function ladShareText(l){
  const when=[wd(l.date), l.startTime?(l.endTime?l.startTime+'–'+l.endTime:l.startTime):''].filter(Boolean).join(' at ');
  const where=l.place?(' · '+l.place):'';
  const full=(l.spotsLeft||0)<=0;
  const room=full?"It's full, but you can grab a waitlist spot"
    :(l.spotsLeft===1?'1 spot left':l.spotsLeft+' spots left');
  return `Come play ${l.name} — ${when}${where}. ${room}. Sign up: ${ladShareUrl(l)}`;
}
async function ladShare(id){
  const l=curLadder(id); if(!l) return;
  const text=ladShareText(l);
  if(navigator.share){
    // The sheet carries the link separately so Messages renders a rich preview.
    try{ await navigator.share({ title:l.name, text, url:ladShareUrl(l) }); return; }
    catch(err){ if(err&&err.name==='AbortError') return; }  // they closed the sheet
  }
  try{ await navigator.clipboard.writeText(text); dsToast({ type:'success', title:'Invite copied', message:'Paste it into a text to your friends.' }); }
  catch(e){ dsToast({ type:'info', title:'Share this link', message:ladShareUrl(l) }); }
  try{ if(/android|iphone|ipad|ipod/i.test(navigator.userAgent)) location.href='sms:?&body='+encodeURIComponent(text); }catch(e){}
}

/* ════════════════ Sign up / pay ════════════════ */
const DUPR_CLUB_URL='https://dashboard.dupr.com/dashboard/browse/clubs/5171426386';
// DUPR ID + Fixed-Partner fields, shown above the payment options when the
// ladder needs them. Same block on both the "join waitlist" view and the
// normal payment-options view (openSignup below).
function extrasHtml(l){
  let h='';
  // Men's/women's-only ladder and we have no gender on file (a brand-new
  // account, or a league player whose roster entry never had one). Ask once,
  // here, rather than bouncing them to the organizer — the server saves it to
  // their profile so this is the only time they see it.
  if(ladNeedsGender(l)){
    const lab=l.type==='womens'?"women's":"men's";
    h+=`<div class="frow" style="margin-bottom:6px"><label class="l" for="su-my-gender">Your gender</label><select class="i" id="su-my-gender"><option value="">Select…</option><option value="F">Woman</option><option value="M">Man</option></select></div>`;
    h+=`<div class="note" style="margin-bottom:12px">This is a <b>${lab}-only</b> ladder, so we need this to confirm your spot. We'll save it to your profile — you'll only be asked once.</div>`;
  }
  if(l.duprRated){
    const dv=MYDUPR?` value="${String(MYDUPR).replace(/"/g,'&quot;')}"`:'';
    h+=`<div class="frow" style="margin-bottom:10px"><label class="l" for="su-dupr">Your DUPR ID</label><input class="i" id="su-dupr" placeholder="e.g. ABC1234"${dv}></div>`;
    // Joining the league's club on DUPR is required: scores can only be posted
    // for members. We can't check DUPR from here, so the player confirms and an
    // admin verifies on the roster. Once verified, they are not asked again.
    if(MYCLUB==='verified'){
      h+=`<div class="dupr ok"><b>DUPR-rated ladder.</b> You're in the Dink Society - South Bay club on DUPR, so you're set.</div>`;
    } else {
      const pair=l.format==='fixed-partner';
      h+=`<div class="dupr"><b>Required: join our club on DUPR.</b> This is a DUPR-rated ladder, and your scores can only be posted if you're a member of the <b>Dink Society - South Bay</b> club. It's free and takes a minute.
        <a class="dupr-btn" href="${DUPR_CLUB_URL}" target="_blank" rel="noopener">Join the club on DUPR</a>
        <label class="dupr-ck"><input type="checkbox" id="su-dupr-club"> <span>${pair?"My partner and I have both joined the club.":"I've joined the club."}</span></label></div>`;
    }
  }
  if(l.format==='fixed-partner'){
    h+=`<div class="frow" style="margin-bottom:8px"><span class="l" style="margin:2px 0 8px">Your partner · you'll play together the whole time</span><label class="l" for="su-p-name">Partner's full name</label><input class="i" id="su-p-name" placeholder="Full name"></div>`;
    if(l.type!=='mens'&&l.type!=='womens'){
      h+=`<div class="frow" style="margin-bottom:8px"><label class="l" for="su-p-gender">Partner's gender</label><select class="i" id="su-p-gender"><option value="">Select…</option><option value="M">Male</option><option value="F">Female</option></select></div>`;
    }
    h+=`<div class="frow"><label class="l" for="su-p-email">Partner's email</label><input class="i" id="su-p-email" type="email" placeholder="they'll get their own confirmation"></div>`;
    if(l.duprRated) h+=`<div class="frow" style="margin-bottom:14px"><label class="l" for="su-p-dupr">Partner's DUPR ID</label><input class="i" id="su-p-dupr" placeholder="e.g. XYZ5678"></div>`;
  }
  return h;
}
// True when this ladder is gender-locked and we don't know the player's yet.
function ladNeedsGender(l){ return (l.type==='mens'||l.type==='womens') && !MYGENDER; }

// Reads + validates the extras above → {ok:true, body} or {ok:false, err}.
function collectSignupExtras(l){
  const body={};
  if(ladNeedsGender(l)){
    const g=document.getElementById('su-my-gender')?.value||'';
    if(!g) return {ok:false, err:'Select your gender to confirm you\'re eligible for this ladder.'};
    if(g!==(l.type==='womens'?'F':'M')){
      return {ok:false, err:`This is a ${l.type==='womens'?"women's":"men's"}-only ladder, so you're not eligible to register. Have a look at the other ladders — plenty are open to everyone.`};
    }
    body.gender=g;
  }
  if(l.duprRated){
    const v=(document.getElementById('su-dupr')?.value||'').trim();
    if(!v) return {ok:false, err:'Enter your DUPR ID.'};
    body.duprId=v;
    if(MYCLUB!=='verified'){
      const ck=document.getElementById('su-dupr-club');
      if(!ck||!ck.checked) return {ok:false, err:'Join the Dink Society - South Bay club on DUPR, then tick the box. It\'s required so your scores can be posted.'};
      body.duprClub=true;
    }
  }
  if(l.format==='fixed-partner'){
    const name=(document.getElementById('su-p-name')?.value||'').trim();
    if(!name) return {ok:false, err:"Enter your partner's name."};
    const gendered=(l.type==='mens'||l.type==='womens');
    const gender=gendered?(l.type==='mens'?'M':'F'):(document.getElementById('su-p-gender')?.value||'');
    if(!gendered && !gender) return {ok:false, err:"Select your partner's gender."};
    const pEmail=(document.getElementById('su-p-email')?.value||'').trim();
    if(!pEmail) return {ok:false, err:"Enter your partner's email."};
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pEmail)) return {ok:false, err:"Enter a valid email for your partner."};
    const partner={name, gender, email:pEmail};
    if(l.duprRated){
      const pd=(document.getElementById('su-p-dupr')?.value||'').trim();
      if(!pd) return {ok:false, err:"Enter your partner's DUPR ID."};
      partner.duprId=pd;
    }
    body.partner=partner;
  }
  return {ok:true, body};
}
function openSignup(id){
  const l=curLadder(id); if(!l) return;
  document.getElementById('payTitle').textContent=(l.spotsLeft<=0?'Join waitlist · ':'Sign up · ')+l.name;
  document.getElementById('paySub').textContent=[wd(l.date),l.startTime,l.place].filter(Boolean).join(' · ');
  document.getElementById('payMsg').innerHTML='';
  if(l.spotsLeft<=0){ document.getElementById('payBody').innerHTML=extrasHtml(l)+'<button class="btn" onclick="joinWaitlist(\''+id+'\')">Join the waitlist</button><div class="note" style="margin-top:8px">No charge now — we\'ll email you to pay &amp; claim when a spot opens.</div>'; document.getElementById('payOv').classList.add('on'); return; }
  const methods=l.paymentMethods||['card','venmo'];
  let h=extrasHtml(l);
  if(methods.includes('free')){
    h+=`<button class="payopt" onclick="payFree('${id}')"><div class="payic">Free</div><div><div class="payt">Join — it's free</div><div class="pays">No entry fee, no payment needed</div></div><div class="payamt">Free</div></button>`;
    document.getElementById('payBody').innerHTML=h;
    document.getElementById('payOv').classList.add('on');
    return;
  }
  const pairFee=(l.feeCents||0)*(l.format==='fixed-partner'?2:1);
  const pairNote=l.format==='fixed-partner'?' <span style="font-weight:600">(both of you)</span>':'';
  // Ladder credit only appears once a player actually has a balance (e.g. after a cancellation).
  if(MYCREDIT>0) h+=`<button class="payopt" onclick="payCredit('${id}')"><div class="payic">CR</div><div><div class="payt">Use ladder credit</div><div class="pays">Balance ${fmt(MYCREDIT)}${pairNote}</div></div><div class="payamt">${fmt(pairFee)}</div></button>`;
  if(methods.includes('card')) h+=`<button class="payopt" onclick="payCard('${id}')"><div class="payic">Card</div><div><div class="payt">Card / Apple Pay</div><div class="pays">Instant · +10% fee${pairNote}</div></div><div class="payamt">${fmt(cardTotal(pairFee))}</div></button>`;
  if(methods.includes('venmo')) h+=`<button class="payopt" onclick="payVenmo('${id}')"><div class="payic">V</div><div><div class="payt">Venmo</div><div class="pays">Fee-free · organizer confirms${pairNote}</div></div><div class="payamt">${fmt(pairFee)}</div></button>`;
  document.getElementById('payBody').innerHTML=h;
  document.getElementById('payOv').classList.add('on');
}
function payMsg(c,t){ document.getElementById('payMsg').innerHTML=`<div class="msg ${c}">${t}</div>`; }
// A successful sign-up changes the card (You're in), so reload the lists behind the sheet.
function paidOk(t){ payMsg('ok',t); init(); }
// The server can tell us it needs a gender we thought we had (stale page, or a
// profile that lost it). Re-open the sheet so the picker is there, rather than
// leaving the player staring at an error they can't act on.
function payErr(id,d){
  if(d&&d.needsGender){ MYGENDER=null; openSignup(id); payMsg('warn',d.error||'Pick your gender above to continue.'); return; }
  payMsg('err',(d&&d.error)||'Something went wrong.');
}
// Not signed in. Send them to /me.html with a ?next= that brings them straight
// back to THIS ladder after the magic link — the link's ?event= is how a
// private ladder is reachable at all, so it must survive the round trip.
function needSignIn(id){
  const back=id?`${HUB.home}?event=${encodeURIComponent(id)}#ladders/${encodeURIComponent(id)}`:HUB.home;
  const n='?next='+encodeURIComponent(back);
  payMsg('warn',`One quick step first:<br><b>New here?</b> <a href="/me.html${n}#register">Create your free account</a> — 10 seconds, no team needed.<br><b>Been here before?</b> <a href="/me.html${n}">Sign in</a>.<br>Tap the link we email you and you'll land right back here to grab your spot.`);
}
async function post(path,body){ const r=await fetch(`${API}${path}`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}); return {status:r.status,d:await r.json().catch(()=>({}))}; }
async function payFree(id){ const l=curLadder(id); const ex=collectSignupExtras(l); if(!ex.ok) return payMsg('err',ex.err); const {status,d}=await post(`/ladder-signup?event=${id}`,{paymentMethod:'free',...ex.body}); if(status===401)return needSignIn(id); if(d.ok)return paidOk("You're in — no payment needed."); payErr(id,d); }
async function payCredit(id){ const l=curLadder(id); const ex=collectSignupExtras(l); if(!ex.ok) return payMsg('err',ex.err); const {status,d}=await post(`/ladder-signup?event=${id}`,{paymentMethod:'credit',...ex.body}); if(status===401)return needSignIn(id); if(status===402)return payMsg('err','Not enough ladder credit — pick card or Venmo.'); if(d.ok)return paidOk("You're in — covered by ladder credit."); payErr(id,d); }
async function payCard(id){ const l=curLadder(id); const ex=collectSignupExtras(l); if(!ex.ok) return payMsg('err',ex.err); const {status,d}=await post(`/ladder-checkout?event=${id}`,ex.body); if(status===401)return needSignIn(id); if(status===409)return payMsg('err',d.error||'This ladder is full.'); if(d.checkoutUrl){ location.href=d.checkoutUrl; return; } payErr(id,d); }
// Venmo on iOS only opens from a REAL anchor tap — JS location.href gets
// silently dropped. So: a plain <a> whose href is the venmo://paycharge deep
// link (recipient + amount + note all prefilled) on phones, with a venmo.com/u
// universal-link fallback underneath for anyone without the app. Desktop gets
// the web link.
function venmoLinks(handle,amt,note){
  const h=encodeURIComponent(String(handle||'').replace(/^@/,''));
  const deep=`venmo://paycharge?txn=pay&recipients=${h}&amount=${amt}&note=${encodeURIComponent(note||'Ladder entry')}`;
  const web=`https://venmo.com/u/${h}`;
  const mobile=/android|iphone|ipad|ipod/i.test(navigator.userAgent);
  const btn=`<a href="${mobile?deep:web}" ${mobile?'':'target="_blank" rel="noopener"'} style="display:inline-block;margin-top:9px;background:#3d95ce;color:#fff;font-weight:800;font-size:14px;border-radius:9999px;padding:11px 22px;text-decoration:none">Open Venmo · $${amt}</a>`;
  const fb=mobile?`<br><a href="${web}" target="_blank" rel="noopener" style="font-size:12px;font-weight:600">App didn't open? Venmo on the web</a>`:'';
  return btn+fb;
}
async function payVenmo(id){ const l=curLadder(id); const ex=collectSignupExtras(l); if(!ex.ok) return payMsg('err',ex.err); const {status,d}=await post(`/ladder-signup?event=${id}`,{paymentMethod:'venmo',...ex.body}); if(status===401)return needSignIn(id); if(d.ok){ const handle=(l.venmoHandle||'@DinkSociety').replace(/^@/,''); const totalCents=(l.feeCents||0)*(l.format==='fixed-partner'?2:1); const amt=(totalCents/100).toFixed(2); const name=l.name; paidOk(`Spot held. Send <b>${fmt(totalCents)}</b> to <b>@${esc(handle)}</b> with note “<b>${esc(name)}</b>”.<br>${venmoLinks(handle,amt,name)}<br><span style="font-size:12px;font-weight:600">An organizer confirms and you'll get a "you're in" email.</span>`); return; } payErr(id,d); }
async function joinWaitlist(id){ const l=curLadder(id); const ex=collectSignupExtras(l); if(!ex.ok) return payMsg('err',ex.err); const {status,d}=await post(`/ladder-signup?event=${id}`,ex.body); if(status===401)return needSignIn(id); if(d.status==='waitlist'){ paidOk("You're on the waitlist — we'll email you the moment a spot opens."); } else if(status>=400){ payErr(id,d); } else payMsg('info',d.message||'Done.'); }

init();
