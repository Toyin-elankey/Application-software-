// Liveness probe. Reports only that the process is serving requests.
// It does not touch the database; a readiness check arrives with the data layer (Stage 2).
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
