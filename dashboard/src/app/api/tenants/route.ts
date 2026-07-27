import { NextResponse } from 'next/server';
import { Client } from 'pg';

const AGENT_URL = process.env.PROVISIONING_AGENT_URL!;
const AGENT_SECRET = process.env.PROVISIONING_AGENT_SECRET!;
const DATABASE_URL = process.env.DATABASE_URL!;

export async function GET() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  const result = await client.query(
    'SELECT slug, db_name, tariff, backups_enabled, created_at FROM kunden ORDER BY created_at DESC'
  );
  await client.end();
  return NextResponse.json(result.rows);
}

export async function POST(req: Request) {
  const body = await req.json();
  const res = await fetch(`${AGENT_URL}/tenants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Secret': AGENT_SECRET,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
