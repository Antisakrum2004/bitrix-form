import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

interface Settings {
  reminder1Time: string; // "18:00" МСК
  reminder2Time: string; // "19:00" МСК
  reportTime: string;    // "20:00" МСК
  enabledDays: number[]; // [1,2,3,4,5] = Mon-Fri
}

const SETTINGS_FILE = path.join(process.cwd(), 'eod-inspector', 'settings.json');

const DEFAULT_SETTINGS: Settings = {
  reminder1Time: '18:00',
  reminder2Time: '19:00',
  reportTime: '20:00',
  enabledDays: [1, 2, 3, 4, 5],
};

function timeToCron(timeStr: string): string {
  const [h, m] = timeStr.split(':').map(Number);
  // Convert MSK (UTC+3) to UTC
  let utcH = h - 3;
  if (utcH < 0) utcH += 24;
  return `${m} ${utcH}`;
}

function daysToCron(days: number[]): string {
  if (days.length === 5 && days.every(d => d >= 1 && d <= 5)) return '1-5';
  return days.join(',');
}

export async function GET() {
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf-8');
    const settings = JSON.parse(data);
    return NextResponse.json(settings);
  } catch {
    return NextResponse.json(DEFAULT_SETTINGS);
  }
}

export async function POST(req: Request) {
  try {
    const settings: Settings = await req.json();

    // Save settings
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));

    // Update GitHub Actions workflow files
    const workflowsDir = path.join(process.cwd(), '.github', 'workflows');

    // Reminder 1
    const reminder1Cron = timeToCron(settings.reminder1Time);
    const days = daysToCron(settings.enabledDays);
    const r1Yml = `name: EOD Reminder

on:
  schedule:
    - cron: '${reminder1Cron} * * ${days}'

  workflow_dispatch:
    inputs:
      target_date:
        description: 'Target date (YYYY-MM-DD), leave empty for today'
        required: false
        default: ''
      round:
        description: 'Reminder round (1 or 2)'
        required: false
        default: '1'
        type: choice
        options:
          - '1'
          - '2'
      dry_run:
        description: 'Dry run (no message sent)'
        required: false
        type: boolean
        default: false

jobs:
  remind:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repo
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Send EOD Reminders (Round 1)
        working-directory: eod-inspector
        run: |
          ARGS="--round=1"
          if [ -n "\${{ github.event.inputs.target_date }}" ]; then
            ARGS="$ARGS \${{ github.event.inputs.target_date }}"
          fi
          if [ "\${{ github.event.inputs.dry_run }}" = "true" ]; then
            ARGS="$ARGS --dry-run"
          fi
          node reminder.js $ARGS
`;
    await fs.writeFile(path.join(workflowsDir, 'eod-reminder.yml'), r1Yml);

    // Reminder 2
    const reminder2Cron = timeToCron(settings.reminder2Time);
    const r2Yml = `name: EOD Reminder Round 2

on:
  schedule:
    - cron: '${reminder2Cron} * * ${days}'

  workflow_dispatch:
    inputs:
      target_date:
        description: 'Target date (YYYY-MM-DD), leave empty for today'
        required: false
        default: ''
      dry_run:
        description: 'Dry run (no message sent)'
        required: false
        type: boolean
        default: false

jobs:
  remind:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repo
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Send EOD Reminders (Round 2)
        working-directory: eod-inspector
        run: |
          ARGS="--round=2"
          if [ -n "\${{ github.event.inputs.target_date }}" ]; then
            ARGS="$ARGS \${{ github.event.inputs.target_date }}"
          fi
          if [ "\${{ github.event.inputs.dry_run }}" = "true" ]; then
            ARGS="$ARGS --dry-run"
          fi
          node reminder.js $ARGS
`;
    await fs.writeFile(path.join(workflowsDir, 'eod-reminder-r2.yml'), r2Yml);

    // Inspector + Productivity
    const reportCron = timeToCron(settings.reportTime);
    const inspectorYml = `name: EOD Inspector

on:
  schedule:
    - cron: '${reportCron} * * ${days}'

  workflow_dispatch:
    inputs:
      target_date:
        description: 'Target date (YYYY-MM-DD), leave empty for today'
        required: false
        default: ''
      dry_run:
        description: 'Dry run (no message sent)'
        required: false
        type: boolean
        default: false

jobs:
  inspect:
    runs-on: ubuntu-latest

    env:
      REPORT_MODE: group
      REPORT_CHAT_ID: '2'

    steps:
      - name: Checkout repo
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Run EOD Inspector
        working-directory: eod-inspector
        run: |
          ARGS=""
          if [ -n "\${{ github.event.inputs.target_date }}" ]; then
            ARGS="$ARGS \${{ github.event.inputs.target_date }}"
          fi
          if [ "\${{ github.event.inputs.dry_run }}" = "true" ]; then
            ARGS="$ARGS --dry-run"
          fi
          node inspector.js $ARGS

      - name: Send Productivity Rating
        working-directory: eod-inspector
        run: |
          ARGS=""
          if [ -n "\${{ github.event.inputs.target_date }}" ]; then
            ARGS="$ARGS \${{ github.event.inputs.target_date }}"
          fi
          if [ "\${{ github.event.inputs.dry_run }}" = "true" ]; then
            ARGS="$ARGS --dry-run"
          fi
          node productivity.js $ARGS
`;
    await fs.writeFile(path.join(workflowsDir, 'eod-inspector.yml'), inspectorYml);

    // Git commit & push
    try {
      execSync('git add .github/workflows/ eod-inspector/settings.json', { cwd: process.cwd() });
      execSync('git commit -m "chore: update EOD schedule settings"', { cwd: process.cwd() });
      execSync('git push origin main', { cwd: process.cwd() });
    } catch (gitErr: any) {
      console.error('Git push error:', gitErr.message);
      return NextResponse.json({ success: true, settings, gitWarning: 'Settings saved but git push may have failed' });
    }

    return NextResponse.json({ success: true, settings });
  } catch (err: any) {
    console.error('Settings save error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
