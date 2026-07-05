import { NextResponse } from 'next/server';
import { listDoctors } from '@/data/catalog';

export async function GET() {
  return NextResponse.json({ doctors: await listDoctors() });
}
