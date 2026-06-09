// netlify/functions/broadcast-files-serve.js
// Streams a broadcast attachment from the 'broadcast-files' blob store.
//   /.netlify/functions/broadcast-files-serve?id=<id>            → inline
//   /.netlify/functions/broadcast-files-serve?id=<id>&dl=1       → force download
// Public by unguessable 16-hex id — the same URL Resend fetches at send time
// and that portal download links point to.

import { getStore } from '@netlify/blobs';

export default async (req) => {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const forceDownload = url.searchParams.get('dl') === '1';

  if (!id || !/^[a-f0-9]{16}$/.test(id)) return new Response('Invalid id', { status: 400 });

  try {
    const store = getStore('broadcast-files');
    const result = await store.getWithMetadata(`file/${id}`, { type: 'arrayBuffer' });
    if (!result || !result.data) return new Response('Not found', { status: 404 });

    const contentType = result.metadata?.contentType || 'application/octet-stream';
    const filename = (result.metadata?.filename || 'attachment').toString().replace(/[\r\n"]/g, '');
    const disposition = `${forceDownload ? 'attachment' : 'inline'}; filename="${filename}"`;

    return new Response(result.data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': disposition,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      },
    });
  } catch (err) {
    console.error('broadcast-files-serve error:', err);
    return new Response('Error loading file', { status: 500 });
  }
};

export const config = { path: '/.netlify/functions/broadcast-files-serve' };
