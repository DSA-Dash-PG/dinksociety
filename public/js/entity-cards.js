/* ════════════════════════════════════════════════════════════════════
   entity-cards.js — The Dink Society
   Editorial-only player/team name enrichment for "The Drop".

   Known player + team names in editorial prose become links (click →
   player/team page) with a hover/focus preview card showing quick stats.
   Used by drop.html (full article) and the homepage Drop teaser ONLY —
   the standings/leaderboard tables keep their own plain links.

   API (window.DSEntity):
     buildIndex({ teams, players, standings }) → { info, entities }
     linkify(html, index) → html with known names wrapped in <a.ds-ent>
     mount(rootEl, index)  → attaches the hover card behavior (delegated)
   ════════════════════════════════════════════════════════════════════ */
(function () {
  function slug(s){ return String(s||'').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,30) || 'team'; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function initials(name){ if(!name) return '?'; var p=String(name).trim().split(/\s+/); return ((p[0][0]||'')+(p.length>1?p[p.length-1][0]:'')).toUpperCase(); }
  function teamHref(name,id){ return '/team?id='+encodeURIComponent(id||slug(name)); }
  function playerHref(name,teamName){ return '/player?team='+encodeURIComponent(slug(teamName||''))+'&name='+encodeURIComponent(name); }

  /* Build the name → info map (for cards) and a length-sorted entity list (for
     safe longest-first matching). `players` come from the player-stats
     aggregate; `standings` supplies team rank/record. */
  function buildIndex(data){
    data = data || {};
    var teams = data.teams || [], players = data.players || [], standings = data.standings || null;
    var info = {}, entities = [], seen = {};

    var teamStat = {};
    if (standings && standings.divisions){
      Object.keys(standings.divisions).forEach(function(dk){
        var div = standings.divisions[dk];
        (div.teams||[]).forEach(function(t){
          teamStat[t.teamName] = { rank: t.rank, rec: (t.wins||0)+'–'+(t.losses||0), division: div.label || div.divisionLabel || '', emoji: t.teamEmoji };
        });
      });
    }
    function addTeam(name, id, emoji, divLabel){
      if (!name || seen['t:'+name]) return; seen['t:'+name] = 1;
      var st = teamStat[name] || {};
      info[name] = { kind:'team', name:name, href:teamHref(name,id), emoji: emoji || st.emoji || '🏓', division: divLabel || st.division || '', rank: st.rank || null, rec: st.rec || null };
      entities.push({ name:name, href:info[name].href });
    }
    teams.forEach(function(t){ if(t) addTeam(t.name, t.id, t.emoji, t.divisionLabel); });
    Object.keys(teamStat).forEach(function(nm){ addTeam(nm, null, null, null); });

    players.forEach(function(p){
      if (!p || !p.name || p.name.indexOf(' ') < 1 || seen['p:'+p.name]) return; seen['p:'+p.name] = 1;
      var dsr = (p.composite!=null) ? Math.round(p.composite*10)/10 : (p.dsr!=null ? p.dsr : null);
      var isChef = Array.isArray(p.awards) && p.awards.length > 0;
      info[p.name] = { kind:'player', name:p.name, href:playerHref(p.name, p.teamName), teamName: p.teamName||'', dsr:dsr, rec:((p.gamesWon||0)+'–'+(p.gamesLost||0)), diff:(p.diff!=null?p.diff:null), gender:p.gender||'', isChef:isChef };
      entities.push({ name:p.name, href:info[p.name].href });
    });

    entities.sort(function(a,b){ return b.name.length - a.name.length; });
    return { info:info, entities:entities };
  }

  // First whole-word occurrence of `name` in `text` at/after `from`. -1 if none.
  function indexOfWord(text, name, from){
    var i = from || 0;
    while (true){
      var idx = text.indexOf(name, i);
      if (idx < 0) return -1;
      var b = idx === 0 ? '' : text.charAt(idx-1);
      var a = text.charAt(idx + name.length);
      if (!/[A-Za-z0-9]/.test(b) && !/[A-Za-z0-9]/.test(a)) return idx;
      i = idx + 1;
    }
  }

  function linkifyTextNode(node, entities, used){
    var text = node.nodeValue, frag = document.createDocumentFragment(), pos = 0, hit = false;
    while (pos < text.length){
      var best = -1, bestEnt = null;
      for (var e = 0; e < entities.length; e++){
        var ent = entities[e]; if (used[ent.name]) continue;
        var idx = indexOfWord(text, ent.name, pos);
        if (idx >= 0 && (best < 0 || idx < best || (idx === best && ent.name.length > bestEnt.name.length))){ best = idx; bestEnt = ent; }
      }
      if (best < 0){ frag.appendChild(document.createTextNode(text.slice(pos))); break; }
      hit = true;
      if (best > pos) frag.appendChild(document.createTextNode(text.slice(pos, best)));
      var a = document.createElement('a');
      a.className = 'ds-ent'; a.setAttribute('href', bestEnt.href); a.setAttribute('data-ent', bestEnt.name); a.textContent = bestEnt.name;
      frag.appendChild(a); used[bestEnt.name] = 1; pos = best + bestEnt.name.length;
    }
    if (hit) node.parentNode.replaceChild(frag, node);
  }

  function linkify(html, index){
    if (!html || !index || !index.entities.length) return html || '';
    var box = document.createElement('div'); box.innerHTML = html;
    var used = {};
    var walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, { acceptNode: function(n){
      var p = n.parentNode; while (p && p !== box){ if (p.tagName === 'A') return NodeFilter.FILTER_REJECT; p = p.parentNode; }
      return (n.nodeValue && n.nodeValue.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }});
    var nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function(n){ linkifyTextNode(n, index.entities, used); });
    return box.innerHTML;
  }

  /* ── hover card ────────────────────────────────────────────── */
  var tip = null, hideT = null;
  function ensureTip(){ if (tip) return tip; injectStyle(); tip = document.createElement('div'); tip.className = 'ds-entcard'; tip.style.display = 'none'; document.body.appendChild(tip); return tip; }

  function cardHtml(d){
    if (!d) return '';
    if (d.kind === 'player'){
      var stats = [];
      if (d.dsr != null) stats.push('<span><b>'+esc(d.dsr)+'</b><i>DSR</i></span>');
      if (d.rec)         stats.push('<span><b>'+esc(d.rec)+'</b><i>Rec</i></span>');
      if (d.diff != null)stats.push('<span><b>'+(d.diff>0?'+':'')+esc(d.diff)+'</b><i>Diff</i></span>');
      return '<div class="ds-entcard__h"><span class="ds-entcard__av '+(/^f/i.test(d.gender)?'f':'m')+'">'+esc(initials(d.name))+(d.isChef?'<i class="chef">👨‍🍳</i>':'')+'</span>'
        + '<div><div class="ds-entcard__nm">'+esc(d.name)+'</div>'+(d.teamName?'<div class="ds-entcard__sub">'+esc(d.teamName)+'</div>':'')+'</div></div>'
        + (stats.length?'<div class="ds-entcard__stats">'+stats.join('')+'</div>':'')
        + '<div class="ds-entcard__go">View player →</div>';
    }
    var meta = []; if (d.rank) meta.push('#'+esc(d.rank)); if (d.rec) meta.push(esc(d.rec)); if (d.division) meta.push(esc(d.division));
    return '<div class="ds-entcard__h"><span class="ds-entcard__crest">'+esc(d.emoji||'🏓')+'</span>'
      + '<div><div class="ds-entcard__nm">'+esc(d.name)+'</div>'+(meta.length?'<div class="ds-entcard__sub">'+meta.join(' · ')+'</div>':'')+'</div></div>'
      + '<div class="ds-entcard__go">View team →</div>';
  }

  function show(el, d){
    var t = ensureTip(); t.innerHTML = cardHtml(d); t.style.display = 'block';
    var r = el.getBoundingClientRect(), tr = t.getBoundingClientRect();
    var top = r.top - tr.height - 8, place = 'top';
    if (top < 8){ top = r.bottom + 8; place = 'bottom'; }
    var left = r.left + r.width/2 - tr.width/2;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
    t.style.top = Math.round(top) + 'px'; t.style.left = Math.round(left) + 'px';
    t.setAttribute('data-place', place);
  }
  function hide(){ if (tip) tip.style.display = 'none'; }

  function mount(root, index){
    if (!root || !index) return;
    root.addEventListener('mouseover', function(e){
      var el = e.target.closest && e.target.closest('.ds-ent'); if (!el || !root.contains(el)) return;
      var d = index.info[el.getAttribute('data-ent')]; if (!d) return;
      if (hideT){ clearTimeout(hideT); hideT = null; } show(el, d);
    });
    root.addEventListener('mouseout', function(e){
      var el = e.target.closest && e.target.closest('.ds-ent'); if (!el) return;
      hideT = setTimeout(hide, 120);
    });
    root.addEventListener('focusin', function(e){
      var el = e.target.closest && e.target.closest('.ds-ent'); if (!el) return;
      var d = index.info[el.getAttribute('data-ent')]; if (d) show(el, d);
    });
    root.addEventListener('focusout', function(e){ var el = e.target.closest && e.target.closest('.ds-ent'); if (el) hide(); });
    window.addEventListener('scroll', hide, { passive: true });
  }

  function injectStyle(){
    if (document.getElementById('ds-entcard-style')) return;
    var css = ''
      + '.ds-ent{color:var(--color-lime,#b8ff2c);text-decoration:none;border-bottom:1px solid rgba(184,255,44,.35);cursor:pointer;}'
      + '.ds-ent:hover{border-bottom-color:var(--color-lime,#b8ff2c);}'
      + '.ds-entcard{position:fixed;z-index:9999;width:236px;background:var(--color-surface,#161616);border:1px solid var(--color-border-strong,rgba(255,255,255,.14));border-radius:14px;padding:13px;box-shadow:0 12px 34px rgba(0,0,0,.45);pointer-events:none;animation:dsEntIn .12s ease;}'
      + '@keyframes dsEntIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}'
      + '.ds-entcard__h{display:flex;gap:11px;align-items:center;}'
      + '.ds-entcard__av,.ds-entcard__crest{width:42px;height:42px;border-radius:11px;flex:none;display:grid;place-items:center;font-weight:800;font-size:16px;position:relative;background:var(--color-surface-3,#262626);}'
      + '.ds-entcard__av.m{color:var(--color-lime,#b8ff2c);}.ds-entcard__av.f{color:var(--color-teal,#17d7b0);}'
      + '.ds-entcard__av .chef{position:absolute;bottom:-5px;right:-5px;font-size:11px;font-style:normal;background:var(--color-gold,#f0c040);border-radius:50%;width:19px;height:19px;display:grid;place-items:center;border:2px solid var(--color-surface,#161616);}'
      + '.ds-entcard__crest{background:var(--color-lime,#b8ff2c);color:var(--color-text-inverse,#0e0e0e);font-size:20px;}'
      + '.ds-entcard__nm{font-weight:800;font-size:14px;color:var(--color-text,#f0f0ec);line-height:1.1;}'
      + '.ds-entcard__sub{font-size:11.5px;color:var(--color-text-muted,#9a9e97);margin-top:2px;}'
      + '.ds-entcard__stats{display:flex;gap:16px;margin:11px 0 4px;padding-top:10px;border-top:1px solid var(--color-border,rgba(255,255,255,.08));}'
      + '.ds-entcard__stats span{display:flex;flex-direction:column;}'
      + '.ds-entcard__stats b{font-size:15px;font-weight:800;color:var(--color-text,#f0f0ec);line-height:1;}'
      + '.ds-entcard__stats i{font-size:9px;font-style:normal;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-faint,#5e625c);margin-top:3px;}'
      + '.ds-entcard__go{margin-top:9px;font-size:11px;font-weight:700;color:var(--color-lime,#b8ff2c);}';
    var s = document.createElement('style'); s.id = 'ds-entcard-style'; s.textContent = css; document.head.appendChild(s);
  }

  window.DSEntity = { slug:slug, teamHref:teamHref, playerHref:playerHref, buildIndex:buildIndex, linkify:linkify, mount:mount };
})();
