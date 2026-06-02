import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

export async function POST(req: Request) {
  try {
    const { mode = 'group' } = await req.json();
    const cwd = process.cwd();

    const output = execSync(
      `REPORT_MODE=${mode} node productivity.js`,
      { cwd: `${cwd}/eod-inspector`, timeout: 120000, encoding: 'utf-8' }
    );

    return NextResponse.json({ success: true, output: output.slice(-500) });
  } catch (err: any) {
    console.error('Send productivity error:', err);
    return NextResponse.json({ 
      success: false, 
      error: err.message,
      output: err.stdout?.slice(-500) || ''
    }, { status: 500 });
  }
}
