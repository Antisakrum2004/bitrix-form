import { NextResponse } from 'next/server';
import { triggerWorkflow } from '@/lib/github';

export async function POST(req: Request) {
  try {
    const { mode = 'group' } = await req.json();

    const result = await triggerWorkflow('eod-inspector.yml', {
      report_mode: mode,
    });

    if (result.status === 204) {
      const target = mode === 'group' ? 'Общий чат' : 'Личка (Андрей)';
      return NextResponse.json({
        success: true,
        output: `Рейтинг продуктивности запущен → ${target}. Отчёт придёт через 1-2 минуты.`,
      });
    } else {
      return NextResponse.json({
        success: false,
        error: `GitHub API вернул статус ${result.status}`,
      });
    }
  } catch (err: any) {
    console.error('Send productivity error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
