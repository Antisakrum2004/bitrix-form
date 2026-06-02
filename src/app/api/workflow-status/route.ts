import { NextResponse } from 'next/server';
import { getWorkflowRuns } from '@/lib/github';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const workflow = url.searchParams.get('workflow') || 'eod-inspector.yml';

    const data = await getWorkflowRuns(workflow, 5);
    const runs = (data.workflow_runs || []).map((run: any) => ({
      id: run.id,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      htmlUrl: run.html_url,
      displayTitle: run.display_title || run.name,
    }));

    return NextResponse.json({ success: true, runs });
  } catch (err: any) {
    console.error('Workflow status error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
