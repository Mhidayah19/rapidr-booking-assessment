import { NextResponse } from 'next/server';
import { listPatients } from '@/data/catalog';

export async function GET() {
  return NextResponse.json({ patients: await listPatients() });
}
