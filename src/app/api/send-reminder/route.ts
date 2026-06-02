import { NextResponse } from 'next/server';
import { triggerWorkflow } from '@/lib/github';

export async function POST(req: Request) {
  try {
    const { round = 1 } = await req.json();

    const workflowFile = round === 2 ? 'eod-reminder-r2.yml' : 'eod-reminder.yml';
    const result = await triggerWorkflow(workflowFile, {
      round: String(round),
    });

    if (result.status === 204) {
      return NextResponse.json({
        success: true,
        output: `Напоминание #${round} запущено. Разработчикам придут сообщения через 1-2 минуты.`,
      });
    } else {
      return NextResponse.json({
        success: false,
        error: `GitHub API вернул статус ${result.status}`,
      });
    }
  } catch (err: any) {
    console.error('Send reminder error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
