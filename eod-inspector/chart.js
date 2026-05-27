/**
 * EOD Chart — generates "tasks in work per day" chart image
 *
 * Usage:
 *   node chart.js                    # last 7 days, send to chat
 *   node chart.js --days 14          # last 14 days
 *   node chart.js 2026-05-19         # from specific date
 *   node chart.js --dry-run          # don't send, just save image
 *
 * How it works:
 *   1. For each day in range, fetch time entries per developer
 *   2. Generate Chart.js config
 *   3. Render via QuickChart.io API (free, no auth)
 *   4. Download PNG image
 *   5. Upload to Bitrix24 disk (2-step: get URL → upload)
 *   6. Send as file attachment in chat
 *
 * Fallback: If QuickChart is unavailable, generates text-based chart
 */

const config = require('./config');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Args ───
const DAYS = parseInt(process.argv.find(a => a.startsWith('--days'))?.split('=')[1] || '7', 10);
const DRY_RUN = process.argv.includes('--dry-run');
const START_DATE = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;

const DATA_WEBHOOK = config.DATA_WEBHOOK;
const SEND_WEBHOOK = config.BOT_WEBHOOK;
const CHART_FILE = path.join(__dirname, 'chart_output.png');

// Bot's disk storage root folder ID (from disk.storage.getlist → ROOT_OBJECT_ID)
const BOT_STORAGE_ROOT_FOLDER_ID = '32322';

console.log(`[EOD Chart] Days: ${DAYS}, Start: ${START_DATE || 'auto'}, Dry: ${DRY_RUN}`);

// ─── Bitrix24 API helpers ───
function bxRequest(webhook, method, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhook + method);
    const body = JSON.stringify(params);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error for ${method}: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Timeout: ${method}`)); });
    req.write(body);
    req.end();
  });
}

function bxData(method, params = {}) { return bxRequest(DATA_WEBHOOK, method, params); }
function bxSend(method, params = {}) { return bxRequest(SEND_WEBHOOK, method, params); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Multipart upload to a specific URL
function multipartUpload(uploadUrl, fieldName, fileName, fileBuffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);

    const prefix = '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="' + fieldName + '"; filename="' + fileName + '"\r\n' +
      'Content-Type: image/png\r\n\r\n';
    const suffix = '\r\n--' + boundary + '--\r\n';

    const body = Buffer.concat([Buffer.from(prefix), fileBuffer, Buffer.from(suffix)]);

    const url = new URL(uploadUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Parse error: ' + data.substring(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Date helpers ───
function getDates(days, startStr) {
  const dates = [];
  const start = startStr ? new Date(startStr + 'T00:00:00') : new Date();
  start.setDate(start.getDate() - (days - 1));

  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const str = d.toLocaleDateString('sv-SE', { timeZone: config.TIMEZONE });
    const dayOfWeek = d.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      dates.push(str);
    }
  }
  return dates;
}

// ─── Fetch task counts per developer per day ───
async function fetchDailyTaskCounts(devId, dates) {
  const counts = [];

  for (const dateStr of dates) {
    const workedTasks = new Set();
    let start = 0;

    try {
      while (true) {
        const r = await bxData('task.elapseditem.getlist', {
          ORDER: { ID: 'DESC' },
          FILTER: {
            USER_ID: devId,
            '>=CREATED_DATE': dateStr + 'T00:00:00',
            '<=CREATED_DATE': dateStr + 'T23:59:59',
          },
          ...(start > 0 ? { start } : {}),
        });

        if (r?.error) break;

        const items = r?.result || [];
        for (const item of items) {
          const taskId = String(item.TASK_ID || '');
          if (taskId) workedTasks.add(taskId);
        }

        if (!r?.next) break;
        start = r.next;
      }
    } catch (e) {
      console.log(`  [!] Error fetching for ${dateStr}: ${e.message}`);
    }

    counts.push(workedTasks.size);
    await delay(200);
  }

  return counts;
}

// ─── QuickChart.io API ───
function generateChartConfig(dates, devData, totals) {
  const labels = dates.map(d => {
    const parts = d.split('-');
    return `${parts[2]}.${parts[1]}`;
  });

  const colors = [
    { bg: 'rgba(76, 120, 168, 0.8)', border: '#4C78A8' },   // Константин
    { bg: 'rgba(245, 133, 24, 0.8)', border: '#F58518' },    // Александр
    { bg: 'rgba(228, 87, 86, 0.8)', border: '#E45756' },     // Саша
    { bg: 'rgba(114, 183, 178, 0.8)', border: '#72B7B2' },   // Тимур
    { bg: 'rgba(84, 162, 75, 0.8)', border: '#54A24B' },     // Елена
    { bg: 'rgba(238, 202, 59, 0.8)', border: '#EECA3B' },    // Ольга
    { bg: 'rgba(178, 121, 162, 0.8)', border: '#B279A2' },   // Марина
  ];

  const datasets = devData.map((dev, i) => ({
    type: 'bar',
    label: dev.name,
    data: dev.counts,
    backgroundColor: colors[i % colors.length].bg,
    borderColor: colors[i % colors.length].border,
    borderWidth: 1,
    stack: 'tasks',
  }));

  // Total line
  datasets.push({
    type: 'line',
    label: 'Итого',
    data: totals,
    borderColor: '#222222',
    backgroundColor: 'rgba(34, 34, 34, 0.1)',
    borderWidth: 2,
    pointRadius: 4,
    pointBackgroundColor: '#222222',
    fill: false,
    tension: 0.2,
  });

  return {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: 'Задачи в работе по дням',
          font: { size: 16, weight: 'bold' },
        },
        legend: {
          position: 'bottom',
          labels: { usePointStyle: true, padding: 15 },
        },
        datalabels: {
          display: false,
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { stepSize: 5 },
          title: { display: true, text: 'Задач' },
        },
      },
    },
  };
}

function downloadQuickChart(chartConfig) {
  return new Promise((resolve, reject) => {
    const configStr = JSON.stringify(chartConfig);
    const encodedConfig = encodeURIComponent(configStr);
    const chartUrl = `https://quickchart.io/chart?c=${encodedConfig}&w=900&h=500&f=png&bkg=white`;

    console.log(`[QuickChart] Downloading chart image...`);
    console.log(`[QuickChart] URL length: ${chartUrl.length}`);

    https.get(chartUrl, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const redirectUrl = res.headers.location;
        https.get(redirectUrl, (res2) => {
          const chunks = [];
          res2.on('data', chunk => chunks.push(chunk));
          res2.on('end', () => {
            const buffer = Buffer.concat(chunks);
            fs.writeFileSync(CHART_FILE, buffer);
            console.log(`[QuickChart] Image saved: ${CHART_FILE} (${buffer.length} bytes)`);
            resolve(CHART_FILE);
          });
        }).on('error', reject);
      } else {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          fs.writeFileSync(CHART_FILE, buffer);
          console.log(`[QuickChart] Image saved: ${CHART_FILE} (${buffer.length} bytes)`);
          resolve(CHART_FILE);
        });
      }
    }).on('error', reject);
  });
}

// ─── Send image via Bitrix IM (2-step upload) ───
async function sendChartImage(imagePath) {
  // Step 1: Upload image to imgur (anonymous) to get a public URL
  console.log(`[Imgur] Uploading chart image...`);
  const imgUrl = await uploadToImgur(imagePath);
  console.log(`[Imgur] Image URL: ${imgUrl}`);

  // Step 2: Send message with IMAGE attachment pointing to imgur URL
  // Also include the URL in message body so Bitrix can show a preview
  const params = {
    MESSAGE: `📊 Задачи в работе по дням\n${imgUrl}`,
    URL_PREVIEW: 'Y',  // Enable preview so Bitrix shows the image
  };

  // Chart always goes to Andrey (116) private — not to group chat
  params.USER_ID = config.REPORT_USER_ID;

  const sendResult = await bxSend('im.message.add', params);
  console.log(`[Send] Result:`, JSON.stringify(sendResult).substring(0, 300));

  if (sendResult?.error) {
    throw new Error(`Send error: ${sendResult.error_description || sendResult.error}`);
  }

  return sendResult;
}

/**
 * Upload image to imgur (anonymous) and return public URL.
 * Uses Client-ID for anonymous uploads (no auth required).
 */
function uploadToImgur(imagePath) {
  return new Promise((resolve, reject) => {
    const boundary = '----ImgurBoundary' + Math.random().toString(36).slice(2);
    const fileBuffer = fs.readFileSync(imagePath);

    const prefix = '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="image"; filename="chart.png"\r\n' +
      'Content-Type: image/png\r\n\r\n';
    const suffix = '\r\n--' + boundary + '--\r\n';
    const body = Buffer.concat([Buffer.from(prefix), fileBuffer, Buffer.from(suffix)]);

    const options = {
      hostname: 'api.imgur.com',
      path: '/3/upload',
      method: 'POST',
      headers: {
        'Authorization': 'Client-ID 546c25a59c58ad7',
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.success && json.data?.link) {
            resolve(json.data.link);
          } else {
            reject(new Error('Imgur upload failed: ' + (json.data?.error || JSON.stringify(json).substring(0, 200))));
          }
        } catch (e) { reject(new Error('Imgur parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Imgur timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── Fallback: text-based chart ───
function generateTextChart(dates, devData, totals) {
  const maxCount = Math.max(...totals, 1);
  const barWidth = 30;

  let lines = [];
  lines.push('📊 Задачи в работе по дням');
  lines.push('');

  for (let i = 0; i < dates.length; i++) {
    const dateParts = dates[i].split('-');
    const label = `${dateParts[2]}.${dateParts[1]}`;
    const bar = '█'.repeat(Math.round((totals[i] / maxCount) * barWidth));
    lines.push(`${label} │${bar} ${totals[i]}`);
  }

  lines.push('');
  lines.push('По разработчикам:');

  for (const dev of devData) {
    const total = dev.counts.reduce((a, b) => a + b, 0);
    const bar = '▓'.repeat(Math.round((total / (maxCount * dates.length)) * barWidth * 2));
    lines.push(`  ${dev.name}: ${bar} ${total} (avg ${(total / dates.length).toFixed(1)})`);
  }

  return lines.join('\n');
}

// ─── Main ───
async function main() {
  try {
    const dates = getDates(DAYS, START_DATE);
    console.log(`[EOD Chart] Dates: ${dates.join(', ')}`);

    const devData = [];

    for (const dev of config.DEVELOPERS) {
      console.log(`\n[Fetching] ${dev.name} (id=${dev.id})...`);
      const counts = await fetchDailyTaskCounts(dev.id, dates);
      devData.push({ name: dev.name, id: dev.id, counts });
      console.log(`  Counts: ${counts.join(', ')}`);
    }

    const totals = dates.map((_, i) => devData.reduce((sum, dev) => sum + dev.counts[i], 0));
    console.log(`\nTotals: ${totals.join(', ')}`);

    let chartSent = false;

    try {
      const chartConfig = generateChartConfig(dates, devData, totals);
      const imagePath = await downloadQuickChart(chartConfig);

      if (!DRY_RUN) {
        try {
          await sendChartImage(imagePath);
          chartSent = true;
          console.log('\n[✓] Chart image sent successfully!');
        } catch (imgErr) {
          console.log(`\n[!] Failed to send image: ${imgErr.message}`);
          console.log('[*] Falling back to text chart...');
        }
      } else {
        console.log(`\n[DRY RUN] Chart image saved to: ${imagePath}`);
        chartSent = true;
      }
    } catch (chartErr) {
      console.log(`\n[!] Chart generation failed: ${chartErr.message}`);
      console.log('[*] Falling back to text chart...');
    }

    // Fallback: send text chart
    if (!chartSent && !DRY_RUN) {
      const textChart = generateTextChart(dates, devData, totals);
      const params = {
        MESSAGE: textChart,
        URL_PREVIEW: 'N',
        SKIP_CONNECTOR_CHECK: 'Y',
      };
      // Chart always goes to Andrey (116) private
      params.USER_ID = config.REPORT_USER_ID;
      await bxSend('im.message.add', params);
      console.log('\n[✓] Text chart sent.');
    } else if (!chartSent && DRY_RUN) {
      const textChart = generateTextChart(dates, devData, totals);
      console.log('\n[DRY RUN] Text chart:');
      console.log(textChart);
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    if (!DRY_RUN) process.exit(1);
  }
}

main();
