// netlify/functions/ping.js
// Keep-warm / health-check endpoint. The frontend pings this every few
// minutes (see public/js/partials.js) so functions stay warm during
// active browsing and dropdowns/data loads don't hit cold starts.

export default async () => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const config = { path: '/.netlify/functions/ping' };
