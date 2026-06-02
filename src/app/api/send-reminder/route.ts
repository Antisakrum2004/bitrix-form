import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

export async function POST(req: Request) {
  try {
    const { round = 1 } = await req.json();
    const cwd = process.cwd();

    const output = execSync(
      `node reminder.js --round=${round}`,
      { cwd: `${cwd}/eod-inspector`, timeout: 120000, encoding: 'utf-8' }
    );

    return NextResponse.json({ success: true, output: output.slice(-500) });
  } catch (err: any) {
    console.error('Send reminder error:', err);
    return NextResponse.json({ 
      success: false, 
      error: err.message,
      output: err.stdout?.slice(-500) || ''
    }, { status: 500 });
  }
}
