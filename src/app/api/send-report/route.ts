import { NextResponse } from 'next/server';
import { triggerWorkflow } from '@/lib/github';

export async function POST(req: Request) {
  try {
    const { mode = 'group', dryRun = false } = await req.json();

    const inputs: Record<string, string> = {};
    if (dryRun) inputs.dry_run = 'true';

    // EOD Inspector workflow runs both inspector + productivity
    const result = await triggerWorkflow('eod-inspector.yml', inputs);

    if (result.status === 204) {
      return NextResponse.json({
        success: true,
        output: `EOD Inspector workflow triggered (mode=${mode}, dryRun=${dryRun}). Check GitHub Actions for results.`,
      });
    } else {
      return NextResponse.json({
        success: false,
        error: `GitHub API returned status ${result.status}`,
      });
    }
  } catch (err: any) {
    console.error('Send report error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
