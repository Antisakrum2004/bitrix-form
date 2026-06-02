import { NextResponse } from 'next/server';

// Deprecated — dry run removed. All sends are real, to specific targets.
export async function POST() {
  return NextResponse.json({ success: false, error: 'Use send-report or send-reminder instead' }, { status: 400 });
}
