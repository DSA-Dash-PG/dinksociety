#!/usr/bin/env python3
"""
Link-preview cards (og:image) for every public page, in the Quick Start style.

    python scripts/og-cards.py            # renders every card to public/img/og/<name>.png
    python scripts/og-cards.py sponsors   # just one

Needs: pip install playwright && python -m playwright install chromium
Inter must be installed locally (the Google Fonts request is not made).

Each card is 1200x630: lime eyebrow, white kicker, big lime headline, white sub,
lime rule, spaced tagline — and a small "panel" on the right (a phone-style
checklist, a standings skeleton, a scoreboard…). Edit CARDS below, re-run,
commit the PNGs. Pages reference them as /img/og/<name>.png.
"""
import sys, os, html
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'img' / 'og'

LIME = '#b8ff2c'

# ── panels ───────────────────────────────────────────────────────────────────
def panel_checklist(title, items, cta):
    rows = ''.join(
        f'<div class="row"><span class="box {"on" if on else ""}"></span>{html.escape(t)}</div>'
        for t, on in items)
    return f'''<div class="phone"><div class="ph-k">NEEDS YOU</div><div class="ph-t">{html.escape(title)}</div>
    {rows}<div class="ph-cta">{html.escape(cta)}</div></div>'''

def panel_list(title, badge, rows, widths=(78, 64, 70, 56, 66)):
    body = ''.join(
        f'<div class="lr"><span class="ln">{i+1}</span><span class="lb" style="width:{widths[i % len(widths)]}%"></span><span class="lv">{html.escape(v)}</span></div>'
        for i, v in enumerate(rows))
    return f'''<div class="phone"><div class="ph-k">{html.escape(badge)}</div><div class="ph-t">{html.escape(title)}</div>{body}</div>'''

def panel_score(a, b, label, foot):
    return f'''<div class="phone"><div class="ph-k live">● LIVE</div><div class="ph-t">{html.escape(label)}</div>
    <div class="sc"><span class="sb" style="width:70%"></span><span class="sn">{a}</span></div>
    <div class="sc"><span class="sb" style="width:52%"></span><span class="sn dim">{b}</span></div>
    <div class="sc"><span class="sb" style="width:64%"></span><span class="sn">{a}</span></div>
    <div class="sc"><span class="sb" style="width:58%"></span><span class="sn dim">{b}</span></div>
    <div class="ph-foot">{html.escape(foot)}</div></div>'''

def panel_stat(big, label, rows):
    body = ''.join(f'<div class="kv"><span>{html.escape(k)}</span><b>{html.escape(v)}</b></div>' for k, v in rows)
    return f'''<div class="phone"><div class="ph-k">{html.escape(label)}</div><div class="big">{html.escape(big)}</div>{body}</div>'''

def panel_article(kicker, lines=(92, 70, 84, 60)):
    body = ''.join(f'<span class="tl" style="width:{w}%"></span>' for w in lines)
    return f'''<div class="phone"><div class="ph-k">{html.escape(kicker)}</div><div class="hl"></div><div class="hl" style="width:70%"></div>
    <div class="tl-wrap">{body}</div><div class="photo"></div></div>'''

def panel_court():
    return '''<svg class="court" viewBox="392 178 458 886" fill="none" stroke="#b8ff2c" stroke-width="12" stroke-linecap="square">
      <rect x="392" y="178" width="458" height="886"/><line x1="621" y1="178" x2="621" y2="508"/><line x1="621" y1="734" x2="621" y2="1064"/>
      <line x1="392" y1="508" x2="850" y2="508" stroke-dasharray="34 26"/><line x1="392" y1="734" x2="850" y2="734" stroke-dasharray="34 26"/></svg>'''

# ── cards ────────────────────────────────────────────────────────────────────
# name: (eyebrow, kicker, headline, sub, tagline, panel_html)
CARDS = {
  'home': ('DINKSOCIETY.APP', 'SOUTH BAY, CALIFORNIA', 'THE DINK SOCIETY', 'SOCIAL PICKLEBALL LEAGUE',
           'THURSDAY NIGHTS · STANDINGS · THE DROP', panel_list('Standings', 'LIVE · UNOFFICIAL', ['3-0', '2-1', '2-1', '1-2', '0-3'])),
  'standings': ('THE DINK SOCIETY', 'WHERE EVERY TEAM STANDS', 'STANDINGS', 'LIVE ON GAME NIGHT · OFFICIAL AT FINALIZE',
                'POINTS · GAMES WON · HEAD-TO-HEAD', panel_list('Standings', 'LIVE · UNOFFICIAL', ['14', '12', '11', '8', '6'])),
  'schedule': ('THE DINK SOCIETY', 'EVERY MATCH · EVERY COURT', 'SCHEDULE', 'THURSDAYS AT 6:00 PM',
               'LINEUPS LOCK 10 MINUTES BEFORE GAME TIME', panel_score('11', '7', 'Thu · Court 5A & 5B', 'Round 2 of 2')),
  'leaderboard': ('THE DINK SOCIETY', 'PLAYER RANKINGS', 'LEADERBOARD', 'EVERY PLAYER · EVERY STAT',
                  'RANKINGS · MATCHUPS · LADDERS', panel_list('Rankings', 'DSR · SEASON', ['4.31', '4.18', '4.02', '3.97', '3.90'])),
  'teams': ('THE DINK SOCIETY', 'THE ROSTERS', 'TEAMS', 'WHO’S ON THE COURT THIS WEEK',
            'RECORDS · ROSTERS · HEAD-TO-HEAD', panel_list('Teams', 'SEASON', ['3-0', '2-1', '2-1', '1-2', '0-3'])),
  'team': ('THE DINK SOCIETY', 'TEAM PAGE', 'TEAM', 'ROSTER · RECORD · GAME LOG',
           'EVERY GAME · EVERY PARTNER · EVERY NIGHT', panel_stat('3-1', 'RECORD', [('Points', '14'), ('Games won', '31'), ('Diff', '+42'), ('Rank', '#2')])),
  'player': ('THE DINK SOCIETY', 'PLAYER PROFILE', 'PLAYER', 'STATS · PARTNERS · GAME LOG',
             'LEAGUE · LADDERS · CAREER', panel_stat('4.12', 'DSR', [('Record', '9-3'), ('Win %', '75%'), ('Diff', '+28'), ('Rank', '#5')])),
  'stats': ('THE DINK SOCIETY', 'THE NUMBERS', 'STATS', 'EVERY STAT WE TRACK',
            'SPLITS · PARTNERS · OPPONENTS', panel_stat('75%', 'WIN RATE', [('Games', '48'), ('Points for', '512'), ('Diff', '+88'), ('Streak', 'W4')])),
  'nvz': ('THE DINK SOCIETY', 'DEEP DIVES & MATCHUPS', 'THE NVZ', 'PLAYER VS PLAYER · TEAM VS TEAM',
          'NERDY BREAKDOWNS, EVERY WEEK', panel_score('6', '4', 'Head to head', 'Games won · all time')),
  'head-to-head': ('THE DINK SOCIETY', 'WHO OWNS WHO', 'HEAD TO HEAD', 'MATCH POINTS IN EVERY MATCHUP',
                   'TEAM VS TEAM · ALL SEASON', panel_score('8', '5', 'Season series', 'Match points')),
  'rankings-trajectory': ('THE DINK SOCIETY', 'WEEK BY WEEK', 'TRAJECTORY', 'HOW EVERY TEAM’S RANK HAS MOVED',
                          'RISERS · FALLERS · THE STANDINGS', panel_list('Movement', 'THIS WEEK', ['▲2', '▲1', '—', '▼1', '▼2'])),
  'strength-of-schedule': ('THE DINK SOCIETY', 'WHO HAD IT HARDEST', 'STRENGTH OF SCHEDULE', 'RATED BY OPPONENT DSR',
                           'EVERY TEAM · EVERY OPPONENT', panel_list('Schedule strength', 'OPP. DSR', ['4.21', '4.15', '4.08', '3.99', '3.91'])),
  'drop': ('THE DINK SOCIETY', 'THE WEEKLY EDITORIAL', 'THE DROP', 'THE WEEKLY WORD ON THE LEAGUE',
           'READ IT THE MORNING AFTER', panel_article('THIS WEEK’S EDITION')),
  'live': ('THE DINK SOCIETY', 'GAME NIGHT', 'LIVE', 'EVERY SCORE AS IT COMES IN',
           'THURSDAYS · 6:00 PM · SBTC', panel_score('11', '9', 'Thu · Court 5A & 5B', 'Game 7 of 12')),
  'gallery': ('THE DINK SOCIETY', 'GAME-NIGHT PHOTOS', 'GALLERY', 'EVERY WEEK · EVERY TEAM',
              'TAG US · @DINKSOCIETY.PB', panel_article('LATEST SET', lines=(60, 40))),
  'cards': ('THE DINK SOCIETY', 'SHAREABLE', 'PLAYER CARDS', 'PLAYER OF THE WEEK · STAT LEADERS · RESULTS',
            'MADE FOR YOUR STORY', panel_stat('POTW', 'PLAYER OF THE WEEK', [('Record', '4-0'), ('Diff', '+21'), ('DSR', '4.40'), ('Week', '6')])),
  'rules': ('THE DINK SOCIETY', 'HOW THE CIRCUIT WORKS', 'RULES', 'LINEUPS · SCORING · TIEBREAKERS',
            'READ ONCE · PLAY ALL SEASON', panel_checklist('The basics.', [('Lineups lock at game time', True), ('6 games max per night', True), ('Home enters, away confirms', True), ('Points → games → head-to-head', False), ('Top 4 make playoffs', False)], 'Full rules')),
  'register': ('THE DINK SOCIETY', 'GRAB YOUR SPOT', 'REGISTER', 'BRING A TEAM OR COME AS A FREE AGENT',
               'THURSDAY NIGHTS · SOUTH BAY', panel_checklist('Let’s go.', [('Pick a division', True), ('Build your roster', True), ('Sign the waiver', False), ('Pay the deposit', False), ('See you Thursday', False)], 'Register')),
  'register-success': ('THE DINK SOCIETY', 'WELCOME TO THE LEAGUE', 'YOU’RE IN', 'CHECK YOUR EMAIL FOR NEXT STEPS',
                       'GET THE APP · BUILD YOUR ROSTER', panel_checklist('Hi, Captain.', [('Registered', True), ('Deposit received', True), ('Build your roster', False), ('Waivers signed', False), ('Lock your lineup', False)], 'Open the app')),
  'ladders': ('THE DINK SOCIETY', 'OPEN PLAY · KING COURT', 'LADDERS', 'MIXED · MEN’S · WOMEN’S',
              'SIGN UP · PLAY UP · MOVE UP', panel_list('King Court', 'TONIGHT', ['👑', '▲', '▲', '▼', '▼'])),
  'ladder-result': ('THE DINK SOCIETY', 'LADDER NIGHT', 'RESULTS', 'FINAL STANDINGS · EVERY ROUND · AWARDS',
                    'WHO TOOK THE KING COURT', panel_list('Final', 'LADDER · FINAL', ['👑', '2nd', '3rd', '4th', '5th'])),
  'queen': ('THE DINK SOCIETY', 'THE WOMEN’S LADDER', 'QUEEN OF THE COURT', 'THE QUEEN BOARD · EVERY RESULT',
            'SIGN UP · PLAY UP · MOVE UP', panel_list('Queen board', 'THIS MONTH', ['👑', '2nd', '3rd', '4th', '5th'])),
  'me': ('THE DINK SOCIETY', 'YOUR LEAGUE, YOUR WEEK', 'PLAYER PORTAL', 'SCHEDULE · STATS · LINEUPS',
         'IT ALL RUNS THROUGH THE APP', panel_checklist('Hi, player.', [('Waiver signed', True), ('I’m in this week', True), ('Lineup revealed', False), ('Your games', False), ('Rank movement', False)], 'Open portal')),
  'sponsors': ('THE DINK SOCIETY', 'PARTNER WITH US', 'PUT YOUR BRAND ON THE COURT', '100+ PLAYERS · EVERY THURSDAY',
               'PRESENTING · PLAYER OF THE WEEK · THE DROP', panel_stat('100+', 'PLAYERS REACHED', [('Game weeks', '10'), ('Site visits / wk', '1,000+'), ('Emails / wk', '2'), ('Partners', 'Open')])),
  'contact': ('THE DINK SOCIETY', 'SAY HELLO', 'GET IN TOUCH', 'QUESTIONS · PARTNERSHIPS · FEEDBACK',
              'DINK@DINKSOCIETY.APP · @DINKSOCIETY.PB', panel_court()),
  'media': ('THE DINK SOCIETY', 'PHOTOS & VIDEO', 'MEDIA POLICY', 'WHAT WE SHOOT AND WHERE IT GOES',
            'TAG US · @DINKSOCIETY.PB', panel_court()),
  'waiver': ('THE DINK SOCIETY', 'BEFORE YOU PLAY', 'WAIVER', 'LIABILITY · MEDIA RELEASE · CODE OF CONDUCT',
             'SIGN ONCE · PLAY ALL SEASON', panel_checklist('Quick read.', [('Liability waiver', True), ('Photo & media release', True), ('Code of conduct', False), ('Venue waiver', False), ('Sign', False)], 'Sign waiver')),
  'terms': ('THE DINK SOCIETY', 'THE RULES OF THE ROAD', 'TERMS', 'USING DINKSOCIETY.APP', 'PLAIN ENGLISH, PROMISE', panel_court()),
  'privacy': ('THE DINK SOCIETY', 'YOUR DATA', 'PRIVACY', 'WHAT WE COLLECT · WHY · WHO SEES IT', 'ASK US ANYTHING', panel_court()),
  'refunds': ('THE DINK SOCIETY', 'FEES & REFUNDS', 'REFUNDS', 'SEASON FEES · LADDER FEES', 'WHEN AND HOW', panel_court()),
}

TEMPLATE = '''<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  html, body {{ width: 1200px; height: 630px; background: #0e0e0e; overflow: hidden; }}
  body {{ font-family: 'Inter', sans-serif; color: #f0f0ec; position: relative; -webkit-font-smoothing: antialiased; }}
  .card {{ position: absolute; inset: 0; padding: 70px 76px; display: flex; align-items: center; }}
  .left {{ flex: 1; min-width: 0; padding-right: 36px; }}
  .eyebrow {{ color: {LIME}; font-size: 22px; font-weight: 700; letter-spacing: 0.38em; text-transform: uppercase; }}
  .kicker {{ margin-top: 54px; font-size: 36px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; color: #f0f0ec; }}
  .headline {{ margin-top: 6px; font-family: 'Inter Display', 'Inter', sans-serif; font-size: {hsize}px; font-weight: 900; letter-spacing: -0.03em; line-height: 0.92; text-transform: uppercase; color: {LIME}; }}
  .sub {{ margin-top: 16px; font-size: 32px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; }}
  .rule {{ width: 96px; height: 4px; background: {LIME}; margin: 34px 0 30px; }}
  .tag {{ font-size: 21px; font-weight: 600; letter-spacing: 0.28em; text-transform: uppercase; color: #9a9e97; }}

  .phone {{ flex: 0 0 236px; height: 400px; border: 2px solid rgba(184,255,44,0.6); border-radius: 26px; background: #141414; padding: 24px 18px 20px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 0 0 1px rgba(184,255,44,0.12), 0 20px 60px rgba(0,0,0,0.6); }}
  .ph-k {{ font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase; color: #17d7b0; font-weight: 800; }}
  .ph-k.live {{ color: {LIME}; }}
  .ph-t {{ font-size: 20px; font-weight: 800; letter-spacing: -0.01em; margin: -2px 0 6px; }}
  .row {{ display: flex; align-items: center; gap: 9px; background: #1f1f1f; border-radius: 10px; padding: 9px 10px; font-size: 12px; font-weight: 700; color: #f0f0ec; }}
  .box {{ width: 14px; height: 14px; border-radius: 4px; border: 1.5px solid #5e625c; flex: none; }}
  .box.on {{ background: {LIME}; border-color: {LIME}; position: relative; }}
  .box.on::after {{ content: ''; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid #0e0e0e; border-width: 0 2px 2px 0; transform: rotate(45deg); }}
  .ph-cta {{ margin-top: auto; background: {LIME}; color: #0e0e0e; font-weight: 800; font-size: 13px; text-align: center; padding: 11px; border-radius: 999px; }}
  .ph-foot {{ margin-top: auto; font-size: 11px; color: #9a9e97; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }}
  .lr {{ display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.07); }}
  .lr:first-of-type .lb {{ background: {LIME}; }}
  .ln {{ width: 16px; font-size: 12px; font-weight: 800; color: #9a9e97; }}
  .lb {{ height: 10px; border-radius: 5px; background: #333; }}
  .lv {{ margin-left: auto; font-size: 13px; font-weight: 800; white-space: nowrap; }}
  .sc {{ display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.07); }}
  .sb {{ height: 12px; border-radius: 6px; background: #333; }}
  .sn {{ margin-left: auto; font-size: 22px; font-weight: 900; color: {LIME}; }}
  .sn.dim {{ color: #f0f0ec; }}
  .big {{ font-size: 56px; font-weight: 900; letter-spacing: -0.04em; color: {LIME}; line-height: 1; margin: 6px 0 10px; }}
  .kv {{ display: flex; justify-content: space-between; font-size: 13px; color: #9a9e97; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.07); }}
  .kv b {{ color: #f0f0ec; font-weight: 800; }}
  .hl {{ height: 16px; border-radius: 6px; background: {LIME}; margin-top: 4px; }}
  .tl-wrap {{ display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }}
  .tl {{ height: 8px; border-radius: 4px; background: #333; display: block; }}
  .photo {{ margin-top: auto; height: 110px; border-radius: 12px; background: linear-gradient(135deg, #262626, #1a1a1a); border: 1px solid rgba(255,255,255,0.08); }}
  .court {{ position: absolute; right: 90px; top: 95px; height: 440px; opacity: 0.4; }}
</style></head><body>
<div class="card">
  <div class="left">
    <div class="eyebrow">{eyebrow}</div>
    <div class="kicker">{kicker}</div>
    <div class="headline">{headline}</div>
    <div class="sub">{sub}</div>
    <div class="rule"></div>
    <div class="tag">{tag}</div>
  </div>
  {panel}
</div></body></html>'''

def hsize(headline):
    n = len(headline)
    if n <= 10: return 118
    if n <= 14: return 104
    if n <= 20: return 84
    return 64

def main(only=None):
    from playwright.sync_api import sync_playwright
    OUT.mkdir(parents=True, exist_ok=True)
    names = [only] if only else list(CARDS)
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1200, 'height': 630})
        for name in names:
            ey, k, h, s, t, panel = CARDS[name]
            doc = TEMPLATE.format(LIME=LIME, hsize=hsize(h), eyebrow=html.escape(ey), kicker=html.escape(k),
                                  headline=html.escape(h), sub=html.escape(s), tag=html.escape(t), panel=panel)
            pg.set_content(doc); pg.wait_for_timeout(150)
            pg.screenshot(path=str(OUT / f'{name}.png'))
            print('wrote', OUT / f'{name}.png')
        b.close()

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else None)
