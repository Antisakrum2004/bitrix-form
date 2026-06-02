import { NextResponse } from 'next/server';
import { triggerWorkflow } from '@/lib/github';

export async function POST(req: Request) {
  try {
    const { round = 1, dryRun = false } = await req.json();

    const inputs: Record<string, string> = {
      round: String(round),
    };
    if (dryRun) inputs.dry_run = 'true';

    const workflowFile = round === 2 ? 'eod-reminder-r2.yml' : 'eod-reminder.yml';
    const result = await triggerWorkflow(workflowFile, inputs);

    if (result.status === 204) {
      return NextResponse.json({
        success: true,
        output: `Reminder round #${round} workflow triggered (dryRun=${dryRun}). Check GitHub Actions for results.`,
      });
    } else {
      return NextResponse.json({
        success: false,
        error: `GitHub API returned status ${result.status}`,
      });
    }
  } catch (err: any) {
    console.error('Send reminder error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
