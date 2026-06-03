import { NextResponse } from 'next/server';
import {
  getFile,
  putFile,
  parseCronFromYaml,
  parseCronDays,
  mskToCron,
  cronToMsk,
  updateCronInYaml,
  daysToCronStr,
} from '@/lib/github';

interface Settings {
  reminder1Time: string;
  reminder2Time: string;
  reportTime: string;
  enabledDays: number[];
}

const WORKFLOW_FILES = {
  reminder1: '.github/workflows/eod-reminder.yml',
  reminder2: '.github/workflows/eod-reminder-r2.yml',
  report: '.github/workflows/eod-inspector.yml',
};

export async function GET() {
  try {
    const results = await Promise.all([
      getFile(WORKFLOW_FILES.reminder1),
      getFile(WORKFLOW_FILES.reminder2),
      getFile(WORKFLOW_FILES.report),
    ]);

    const reminder1Cron = parseCronFromYaml(results[0].content) || '0 15 * * 1-5';
    const reminder2Cron = parseCronFromYaml(results[1].content) || '0 16 * * 1-5';
    const reportCron = parseCronFromYaml(results[2].content) || '0 17 * * 1-5';

    const settings: Settings = {
      reminder1Time: cronToMsk(reminder1Cron),
      reminder2Time: cronToMsk(reminder2Cron),
      reportTime: cronToMsk(reportCron),
      enabledDays: parseCronDays(results[2].content),
    };

    return NextResponse.json(settings);
  } catch (err: any) {
    console.error('Settings GET error:', err);
    // Return defaults on error
    return NextResponse.json({
      reminder1Time: '18:00',
      reminder2Time: '19:00',
      reportTime: '20:00',
      enabledDays: [1, 2, 3, 4, 5],
    });
  }
}

export async function POST(req: Request) {
  try {
    const settings: Settings = await req.json();
    const daysStr = daysToCronStr(settings.enabledDays);

    // Fetch current files to get SHAs
    const [reminder1File, reminder2File, reportFile] = await Promise.all([
      getFile(WORKFLOW_FILES.reminder1),
      getFile(WORKFLOW_FILES.reminder2),
      getFile(WORKFLOW_FILES.report),
    ]);

    // Update cron in each file
    const reminder1Cron = mskToCron(settings.reminder1Time, daysStr);
    const reminder2Cron = mskToCron(settings.reminder2Time, daysStr);
    const reportCron = mskToCron(settings.reportTime, daysStr);

    const updatedReminder1 = updateCronInYaml(reminder1File.content, reminder1Cron);
    const updatedReminder2 = updateCronInYaml(reminder2File.content, reminder2Cron);
    const updatedReport = updateCronInYaml(reportFile.content, reportCron);

    // Push updates sequentially to avoid SHA conflicts from parallel writes
    await putFile(WORKFLOW_FILES.reminder1, updatedReminder1, reminder1File.sha, 'chore: update EOD reminder #1 schedule');
    await putFile(WORKFLOW_FILES.reminder2, updatedReminder2, reminder2File.sha, 'chore: update EOD reminder #2 schedule');
    await putFile(WORKFLOW_FILES.report, updatedReport, reportFile.sha, 'chore: update EOD inspector report schedule');

    return NextResponse.json({ success: true, settings });
  } catch (err: any) {
    console.error('Settings POST error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
