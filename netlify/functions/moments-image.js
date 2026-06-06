export default async (req) => {
  return new Response(
    JSON.stringify({ error: 'Not implemented', message: 'This feature is coming soon' }),
    { status: 501, headers: { 'Content-Type': 'application/json' } }
  );
};
