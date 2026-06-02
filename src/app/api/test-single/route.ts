import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

export async function POST(req: Request) {
  try {
    const { script, mode = 'private', round = 1 } = await req.json();
    const cwd = process.cwd();

    let cmd: string;

    switch (script) {
      case 'inspector':
        cmd = `REPORT_MODE=${mode} node inspector.js --dry-run`;
        break;
      case 'reminder':
        cmd = `node reminder.js --round=${round} --dry-run`;
        break;
      case 'productivity':
        cmd = `REPORT_MODE=${mode} node productivity.js --dry-run`;
        break;
      default:
        return NextResponse.json({ success: false, error: 'Unknown script' }, { status: 400 });
    }

    const output = execSync(cmd, { cwd: `${cwd}/eod-inspector`, timeout: 120000, encoding: 'utf-8' });

    return NextResponse.json({ success: true, output: output.slice(-2000) });
  } catch (err: any) {
    console.error('Test error:', err);
    return NextResponse.json({ 
      success: false, 
      error: err.message,
      output: (err.stdout || '').slice(-2000)
    }, { status: 500 });
  }
}
