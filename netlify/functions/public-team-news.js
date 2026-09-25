// netlify/functions/public-team-news.js
//
// PUBLIC endpoint — no auth. Every PUBLISHED Drop edition that mentions a team,
// newest first, with where it was mentioned and a snippet. Powers the "News"
// tab on the team page.
//
//   GET /.netlify/functions/public-team-news?circuit=II&team=Bonkerz
//   GET /.netlify/functions/public-team-news?circuit=II&team=bonkerz   (slug works too)
//     → { circuit, team, items: [ { edition, label, short, kicker, title, dek,
//           publishedAt, href, featured, mentions: [ { where, label, title, snippet, href } ] } ],
//         photos: [ { id, caption, credit, focal, edition, label, kicker, publishedAt, href } ] }
//
// `photos` = every photo on a storyline tagged to this team (storyline.team),
// newest edition first, in the editor's order. Powers the team page Photos tab.
//
// `where` is one of: featured (a storyline ABOUT the team — scouting card),
// story (named in a storyline), around (its Around the League report),
// lead (named in the lead / headline / dek). `href` deep-links into the article
// (drop.html scrolls to #story-N-slug / #around-slug after it renders).
//
// ETag-cached like public-drop; drafts are never exposed.

import { listDrops } from './lib/drop.js';
import { circuitCode } from './lib/circuit.js';
import { etagJson } from './lib/http-cache.js';
import { htmlToPlain } from './lib/email.js';

function slug(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}
function plain(html) {
  try { return String(htmlToPlain(html || '') || '').replace(/\s+/g, ' ').trim(); }
  catch { return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
}
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Whole-name, case-insensitive match; returns the index of the first hit or -1.
function findName(text, name) {
  if (!text || !name) return -1;
  const re = new RegExp('(^|[^a-z0-9])' + escRe(name) + '(?=$|[^a-z0-9])', 'i');
  const m = re.exec(text);
  return m ? m.index + m[1].length : -1;
}
function snippetAt(text, idx, name, width = 170) {
  if (idx < 0) return '';
  const half = Math.floor((width - name.length) / 2);
  let a = Math.max(0, idx - half), b = Math.min(text.length, idx + name.length + half);
  // Snap to word boundaries so we don't cut mid-word.
  if (a > 0) { const sp = text.lastIndexOf(' ', a + 12); if (sp > 0 && sp <= a + 12) a = sp + 1; }
  if (b < text.length) { const sp = text.indexOf(' ', b - 12); if (sp > 0) b = sp; }
  return (a > 0 ? '…' : '') + text.slice(a, b).trim() + (b < text.length ? '…' : '');
}

export default async (req) => {
  const url = new URL(req.url);
  const circuit = circuitCode(url.searchParams.get('circuit') || 'I');
  const teamParam = String(url.searchParams.get('team') || '').trim();
  if (!teamParam) return etagJson(req, { circuit, team: null, items: [], message: 'team is required' }, { status: 400 });

  try {
    const recs = (await listDrops(circuit)).filter(r => r.status === 'published');
    const want = slug(teamParam);
    let teamName = teamParam;
    // Resolve the display name from any Around the League / storyline team field
    // that matches the slug, so ?team=bonkerz still matches "Bonkerz" in prose.
    for (const r of recs) {
      const hit = (r.teamReports || []).map(t => t.team).concat((r.storylines || []).map(s => s.team))
        .find(n => n && slug(n) === want);
      if (hit) { teamName = hit; break; }
    }

    const items = [];
    const photos = [];
    for (const r of recs) {
      const edHref = '/drop?edition=' + encodeURIComponent(r.edition);
      const mentions = [];
      let featured = false;

      // Storylines: a storyline ABOUT the team (team field) is "featured"; a
      // storyline that names the team in its headline/body is a "story" mention.
      (r.storylines || []).forEach((s, i) => {
        const sid = 'story-' + (i + 1) + (s.team ? '-' + slug(s.team) : '');
        const body = plain(s.html);
        if (s.team && slug(s.team) === want) {
          featured = true;
          const imgs = (Array.isArray(s.images) && s.images.length) ? s.images : (s.image ? [s.image] : []);
          imgs.forEach(im => {
            if (!im || !im.id) return;
            photos.push({ id: im.id, caption: im.caption || null, credit: im.credit || null, focal: im.focal || null,
              edition: r.edition, label: r.label, kicker: r.kicker || null, order: r.order ?? 0,
              publishedAt: r.publishedAt || null, href: edHref + '#' + sid });
          });
          mentions.push({ where: 'featured', label: s.tag || 'Team report', title: s.title || '', snippet: body.slice(0, 200) + (body.length > 200 ? '…' : ''), href: edHref + '#' + sid });
          return;
        }
        const inTitle = findName(s.title || '', teamName);
        const inBody = findName(body, teamName);
        if (inTitle >= 0 || inBody >= 0) {
          mentions.push({ where: 'story', label: s.tag || 'Storyline', title: s.title || '', snippet: inBody >= 0 ? snippetAt(body, inBody, teamName) : snippetAt(s.title, inTitle, teamName), href: edHref + '#' + sid });
        }
      });

      // Around the League entry for this team.
      (r.teamReports || []).forEach(t => {
        if (t.team && slug(t.team) === want) {
          mentions.push({ where: 'around', label: 'Around the League', title: '', snippet: String(t.blurb || '').slice(0, 220) + (String(t.blurb || '').length > 220 ? '…' : ''), href: edHref + '#around-' + want });
        } else {
          const idx = findName(String(t.blurb || ''), teamName);
          if (idx >= 0) mentions.push({ where: 'around', label: 'Around the League · ' + t.team, title: '', snippet: snippetAt(String(t.blurb || ''), idx, teamName), href: edHref + '#around-' + slug(t.team) });
        }
      });

      // Lead / headline / dek.
      const head = [r.title, r.dek].filter(Boolean).join(' — ');
      const lead = plain(r.leadHtml);
      const inHead = findName(head, teamName), inLead = findName(lead, teamName);
      if (inHead >= 0 || inLead >= 0) {
        mentions.push({ where: 'lead', label: 'The Lead', title: r.title || '', snippet: inLead >= 0 ? snippetAt(lead, inLead, teamName) : snippetAt(head, inHead, teamName), href: edHref });
      }

      if (!mentions.length) continue;
      // Featured first, then story, around, lead.
      const rank = { featured: 0, story: 1, around: 2, lead: 3 };
      mentions.sort((a, b) => rank[a.where] - rank[b.where]);
      items.push({
        edition: r.edition, label: r.label, short: r.short, order: r.order,
        kicker: r.kicker || null, title: r.title || '', dek: r.dek || null,
        publishedAt: r.publishedAt || null, href: edHref, featured, mentions,
      });
    }
    items.sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
    // Newest edition first; within an edition keep the editor's photo order.
    const seen = new Set();
    const photoList = photos
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (b.p.order - a.p.order) || (a.i - b.i))
      .map(x => x.p)
      .filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true)));
    return etagJson(req, { circuit, team: teamName, items, photos: photoList });
  } catch (err) {
    console.error('public-team-news error:', err);
    return etagJson(req, { circuit, team: teamParam, items: [], photos: [], message: 'News is unavailable right now.' });
  }
};

export const config = { path: '/.netlify/functions/public-team-news' };
