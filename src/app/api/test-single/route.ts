import { NextResponse } from 'next/server';
import { triggerWorkflow } from '@/lib/github';

export async function POST(req: Request) {
  try {
    const { script, mode = 'private', round = 1 } = await req.json();

    const inputs: Record<string, string> = {
      dry_run: 'true',
    };

    let workflowFile: string;
    let description: string;

    switch (script) {
      case 'inspector':
        workflowFile = 'eod-inspector.yml';
        description = 'EOD Inspector';
        break;
      case 'reminder':
        workflowFile = round === 2 ? 'eod-reminder-r2.yml' : 'eod-reminder.yml';
        inputs.round = String(round);
        description = `Reminder round #${round}`;
        break;
      case 'productivity':
        workflowFile = 'eod-inspector.yml';
        description = 'Productivity';
        break;
      default:
        return NextResponse.json({ success: false, error: 'Unknown script' }, { status: 400 });
    }

    const result = await triggerWorkflow(workflowFile, inputs);

    if (result.status === 204) {
      return NextResponse.json({
        success: true,
        output: `${description} dry-run workflow triggered. Check GitHub Actions for results.`,
      });
    } else {
      return NextResponse.json({
        success: false,
        error: `GitHub API returned status ${result.status}`,
      });
    }
  } catch (err: any) {
    console.error('Test single error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
