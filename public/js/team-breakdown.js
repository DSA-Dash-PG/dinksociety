/* ════════════════════════════════════════════════════════════════════
   team-breakdown.js — The Dink Society
   The "Breakdown" stat card for a team: standings line, roster DSR bars,
   games-by-type (women's / men's / mixed) W–L split, clutch / points /
   sweeps tiles. Pure HTML from data the page already has — no fetches.
   Used by team.html (Overview tab) and drop.html (a storyline that names
   a team). Styles live in /css/team-breakdown.css (.dsb-*).

   API (window.DSBreakdown):
     html({ team, players, row, divCount, playerHref, teamHref, header, shortName })
       team       { id, name, emoji, photoUrl, roster:[{name,gender}] }
       players    players-aggregate entries for THIS team (from public-leaderboard?view=players)
       row        standings row { rank, wins, losses, ties, pointsScored, pointsAgainst,
                  pointDiff, totalGamesWon, totalGamesLost, overall:{sweeps} } or null
       divCount   teams in the division (for "#2 of 6")
       playerHref (name) → url  (optional; names become links)
       teamHref   url for the header / button (optional)
       header     true → team header row with "Team page ›" button (the article card)
       shortName  (name) → display name (optional)
       week       number → scope the WHOLE card to that week (The Drop's recap
                  editions): only the players who played that night, their
                  record that night, and that night's games-by-type / points /
                  clutch. Season numbers stay on the team page. Reads each
                  player's weeklyGameRecords[] + dsrHistory[] from the players
                  aggregate; `row` is ignored.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function signed(n){ if(n==null||n==='') return '—'; n=+n; if(!isFinite(n)) return '—'; return (n>0?'+':'')+n; }
  function slug(s){ return String(s||'').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,''); }

  function bar(p, o, max, top){
    var d = (p.composite!=null) ? Math.round(p.composite*10)/10 : null;
    var w = (d==null||!max) ? 0 : Math.max(2, Math.round(d/max*100));
    var g = (String(p.gender||'')[0]||'').toUpperCase();
    var recTxt = (p.gamesWon||0)+'–'+(p.gamesLost||0);
    var nm = esc(o.shortName ? o.shortName(p.name) : p.name);
    var nmHtml = o.playerHref ? '<a href="'+esc(o.playerHref(p.name))+'">'+nm+'</a>' : nm;
    var wkTxt = o.week!=null ? 'Week '+o.week : '';
    return '<div class="dsb-bar'+(top?' top':'')+'" title="'+esc(p.name)+' · '+(wkTxt?wkTxt+': ':'')+recTxt+' · '+(d==null?'no DSR yet':d+' DSR'+(wkTxt?' through '+wkTxt:''))+(p.diff!=null?' · '+signed(p.diff):'')+'">'
      + '<div class="dsb-bar__nm">'+nmHtml+'<small>'+(g?g+' · ':'')+recTxt+'</small></div>'
      + '<div class="dsb-bar__val">'+(d==null?'—':d)+'</div>'
      + '<div class="dsb-bar__tr"><div class="dsb-bar__fl" style="width:'+w+'%"></div></div>'
      + '</div>';
  }
  function splitRow(label, t){
    var g = t.played, w = t.won, l = Math.max(0, g - w);
    if(!g) return '<div class="dsb-split"><div class="dsb-split__l"><b>'+label+'</b><span class="dsb-empty">no games yet</span></div><div class="dsb-split__bar"></div></div>';
    var pw = Math.round(w/g*100);
    return '<div class="dsb-split" title="'+label+': '+w+'–'+l+' · '+t.ps+'–'+t.pa+' pts">'
      + '<div class="dsb-split__l"><b>'+label+'</b><span>'+w+'–'+l+' · '+t.ps+'–'+t.pa+'</span></div>'
      + '<div class="dsb-split__bar">'+(w?'<div class="dsb-split__w" style="width:'+pw+'%"></div>':'')+(l?'<div class="dsb-split__x" style="flex:1"></div>':'')+'</div>'
      + '</div>';
  }

  // ── Week scope ─────────────────────────────────────────────────────
  // weeklyGameRecords[] entry for a week: { week, w, l, date, teamId, ps, pa,
  // clutchW, clutchG, byType } (lib/standings.js). Aggregates built before the
  // detail fields existed only carry { week, w, l, date }.
  function weekRec(p, wk){
    var a = (p && p.weeklyGameRecords) || [];
    for(var i=0;i<a.length;i++){ if(a[i] && +a[i].week === +wk) return a[i]; }
    return null;
  }
  // Season-to-date DSR at the END of that week, so an old edition keeps the
  // number it was written with instead of drifting with later results.
  function weekDsr(p, wk){
    var h = (p && p.dsrHistory) || [];
    for(var i=0;i<h.length;i++){ if(h[i] && +h[i].week === +wk && h[i].dsr!=null) return h[i].dsr; }
    return null;
  }
  // The team's players who played in `wk`, reshaped to the season player shape
  // so the same bars / split / tiles code renders them.
  function weekPlayers(ps, team, wk){
    var out = [];
    ps.forEach(function(p){
      var r = weekRec(p, wk); if(!r) return;
      var g = (r.w||0) + (r.l||0); if(!g) return;
      if(r.teamId && team && team.id && r.teamId !== team.id) return;   // played that night for someone else
      var d = weekDsr(p, wk);
      out.push({
        name: p.name, gender: p.gender, composite: d!=null ? d : p.composite,
        gamesPlayed: g, gamesWon: r.w||0, gamesLost: r.l||0,
        detail: r.byType != null,
        byType: r.byType || {}, clutchW: r.clutchW||0, clutchG: r.clutchG||0,
        ps: r.ps||0, pa: r.pa||0, diff: r.byType != null ? (r.ps||0)-(r.pa||0) : null
      });
    });
    return out;
  }

  function html(o){
    o = o || {};
    var team = o.team || {}, ps = o.players || [], row = o.row || null;
    var nm = team.name || '';
    var short = o.shortName || function(n){ return n; };
    var wk = (o.week!=null && o.week!=='' && isFinite(+o.week)) ? +o.week : null;
    var hadPlayers = ps.length > 0, wkDetail = false;
    if(wk!=null){
      ps = weekPlayers(ps, team, wk); row = null;
      wkDetail = ps.length > 0 && ps.every(function(p){ return p.detail; });
    }
    var played = ps.filter(function(p){ return (p.gamesPlayed||0) > 0; }).sort(function(a,b){ return (b.composite||0)-(a.composite||0) || (b.gamesWon||0)-(a.gamesWon||0); });
    var playedNames = {}; played.forEach(function(p){ playedNames[String(p.name||'').toLowerCase()] = 1; });
    var rosterNames = (team.roster||[]).map(function(p){ return p.name; }).filter(Boolean);
    var dnp = rosterNames.filter(function(n){ return !playedNames[String(n).toLowerCase()]; });
    if(!rosterNames.length) dnp = ps.filter(function(p){ return !(p.gamesPlayed||0); }).map(function(p){ return p.name; });
    var rosterN = rosterNames.length || ps.length;
    var max = played.length ? Math.max.apply(null, played.map(function(p){ return p.composite||0; })) : 0;

    var rosterBox = wk!=null
      ? '<div class="dsb-box"><h6>Week '+wk+' lineup · DSR <span>'+played.length+' played</span></h6>'
      : '<div class="dsb-box"><h6>Roster · DSR <span>'+(played.length ? played.length+' played · '+rosterN+' rostered' : rosterN+' rostered')+'</span></h6>';
    if(wk!=null && !played.length){
      rosterBox += '<div class="dsb-empty">'+(hadPlayers ? 'No games in Week '+wk+'.' : 'Week '+wk+' numbers fill in once results are final.')+' Season stats are on the team page.</div>';
    } else if(played.length){
      rosterBox += played.map(function(p,i){ return bar(p, o, max, i===0); }).join('');
      if(wk==null && dnp.length) rosterBox += '<div class="dsb-more">Yet to play: '+dnp.slice(0,8).map(function(n){ return esc(short(n)); }).join(', ')+(dnp.length>8?' +'+(dnp.length-8)+' more':'')+'</div>';
    } else {
      rosterBox += '<div class="dsb-empty">DSR bars fill in after the first night.</div>';
      if(rosterNames.length) rosterBox += '<div class="dsb-more">'+rosterNames.map(function(n){ return esc(short(n)); }).join(', ')+'</div>';
    }
    rosterBox += '</div>';

    // Each game counts once per teammate in the players aggregate (two per
    // game), so halve the sums to get team games.
    var agg = { womens:{played:0,won:0,ps:0,pa:0}, mens:{played:0,won:0,ps:0,pa:0}, mixed:{played:0,won:0,ps:0,pa:0} };
    var clW=0, clG=0, pf=0, pa=0;
    ps.forEach(function(p){
      ['womens','mens','mixed'].forEach(function(k){ var b=(p.byType&&p.byType[k])||{}; agg[k].played+=(b.played||0); agg[k].won+=(b.won||0); agg[k].ps+=(b.ps||0); agg[k].pa+=(b.pa||0); });
      clW+=(p.clutchW||0); clG+=(p.clutchG||0); pf+=(p.ps||0); pa+=(p.pa||0);
    });
    Object.keys(agg).forEach(function(k){ var a=agg[k]; a.played=Math.round(a.played/2); a.won=Math.round(a.won/2); a.ps=Math.round(a.ps/2); a.pa=Math.round(a.pa/2); });
    clW=Math.round(clW/2); clG=Math.round(clG/2);
    if(row && row.pointsScored!=null){ pf = row.pointsScored; pa = row.pointsAgainst||0; } else { pf=Math.round(pf/2); pa=Math.round(pa/2); }
    var sweeps = row && row.overall && row.overall.sweeps!=null ? row.overall.sweeps : (row && row.sweeps!=null ? row.sweeps : null);
    var hasAny = !!(row || ps.length);
    // Week scope: team games that night (each game is on two teammates' lines).
    var wkW = 0, wkL = 0;
    if(wk!=null){ ps.forEach(function(p){ wkW += p.gamesWon||0; wkL += p.gamesLost||0; }); wkW = Math.round(wkW/2); wkL = Math.round(wkL/2); }
    var lastTile = wk!=null
      ? '<div class="dsb-tile" title="Games won – lost in Week '+wk+'"><div class="dsb-tile__n'+(wkW>wkL?' pos':(wkW<wkL?' neg':''))+'">'+wkW+'–'+wkL+'</div><div class="dsb-tile__l">Games</div></div>'
      : '<div class="dsb-tile" title="4–0 match wins"><div class="dsb-tile__n">'+(sweeps!=null?sweeps:'—')+'</div><div class="dsb-tile__l">Sweeps</div></div>';
    var splitBox = '<div class="dsb-box"><h6>'+(wk!=null?'Week '+wk+' games by type':'Games by type')+' <span>W–L · pts</span></h6>'
      + splitRow("Women's", agg.womens) + splitRow("Men's", agg.mens) + splitRow('Mixed', agg.mixed)
      + '<div class="dsb-tiles">'
      + '<div class="dsb-tile" title="Games decided by 3 points or fewer"><div class="dsb-tile__n'+(clG?(clW*2>clG?' pos':(clW*2<clG?' neg':'')):'')+'">'+(clG?clW+'–'+(clG-clW):'—')+'</div><div class="dsb-tile__l">Clutch</div></div>'
      + '<div class="dsb-tile" title="Points for – points against"><div class="dsb-tile__n">'+(hasAny?pf+'–'+pa:'—')+'</div><div class="dsb-tile__l">Points</div></div>'
      + lastTile
      + '</div></div>';
    // Week scope shows the right-hand box only when that night's detail is in
    // the aggregate (older aggregates carry W–L per week and nothing else).
    var showSplit = wk==null || wkDetail;

    var head = '';
    if(o.header){
      var href = o.teamHref || ('/team?id='+encodeURIComponent(slug(nm)));
      var crest = team.photoUrl ? '<img src="'+esc(team.photoUrl)+'" alt="">' : esc(team.emoji || '🏓');
      var sub = 'No results yet';
      if(wk!=null){
        sub = '<b>Week '+wk+'</b>' + (played.length
          ? ' · games <b>'+wkW+'–'+wkL+'</b>' + (wkDetail ? ' · '+signed(pf-pa)+' pts' : '')
          : ' · no games');
      } else if(row){
        var diff = row.pointDiff!=null ? row.pointDiff : ((row.pointsScored||0)-(row.pointsAgainst||0));
        sub = (row.rank?'<b>#'+row.rank+'</b>'+(o.divCount?' of '+o.divCount:'')+' · ':'')+'<b>'+(row.wins||0)+'–'+(row.losses||0)+(row.ties?'–'+row.ties:'')+'</b> · '+signed(diff)+' pts · games '+(row.totalGamesWon||0)+'–'+(row.totalGamesLost||0);
      }
      head = '<div class="dsb-head"><a class="dsb-id" href="'+esc(href)+'"><span class="dsb-crest">'+crest+'</span><div><div class="dsb-nm">'+esc(nm)+'</div><div class="dsb-sub">'+sub+'</div></div></a>'
        + '<a class="dsb-cta" href="'+esc(href)+'">Team page ›</a></div>';
    }
    return '<div class="dsb" id="breakdown-'+slug(nm)+'">' + head
      + '<div class="dsb-grid'+(showSplit?'':' dsb-grid--one')+'">'+rosterBox+(showSplit?splitBox:'')+'</div>'
      + '<div class="dsb-foot">'+(wk!=null ? 'Week '+wk+' only — season stats are on the team page.' : 'Live season stats — updates as results come in.')
      + (showSplit ? '<span class="dsb-legend"><span><i class="w"></i>Wins</span><span><i class="l"></i>Losses</span></span>' : '')+'</div>'
      + '</div>';
  }

  window.DSBreakdown = { html: html, slug: slug };
})();
