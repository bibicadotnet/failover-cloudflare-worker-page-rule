// Global variables
let STATUS_STORE;
let pageRuleStatus = null;
let pageRuleBackupStatus = null;
let lastPageRuleCheck = 0;
let lastCheckTime = 0;

// Configuration
const CONFIG = {
  apiEmail: 'your-email@gmail.com',
  apiKey: 'your-cloudflare-api-key',
  zoneId: 'your-cloudflare-zone-id',
  pageRuleId: 'your-main-page-rule-id',
  pageRuleBackupId: 'your-backup-page-rule-id',
  targetDomain: 'yourdomain.com',
  checkInterval: 5000, // Kiểm tra mỗi 5 giây
  maxRetries: 3, // Số lần kiểm tra lại khi gặp lỗi
  retryDelay: 15000, // Thời gian giữa các lần kiểm tra lại
  telegram: {
    botToken: 'your-telegram-bot-token',
    chatId: 'your-telegram-chat-id'
  }
};

// Utility function to delay
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Get last notification status from KV
async function getLastNotificationStatus() {
  try {
    const status = await STATUS_STORE.get('lastStatus');
    return status || 'UP';
  } catch (error) {
    console.error('Failed to get last notification status:', error);
    return 'UP';
  }
}

// Update notification status in KV
async function updateLastNotificationStatus(status) {
  try {
    await STATUS_STORE.put('lastStatus', status);
    return true;
  } catch (error) {
    console.error('Failed to update notification status:', error);
    return false;
  }
}

// Send Telegram notification
async function sendTelegramNotification(message) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CONFIG.telegram.chatId,
          text: message,
          parse_mode: 'HTML'
        })
      }
    );
    const data = await response.json();
    return data.ok;
  } catch (error) {
    console.error('Failed to send Telegram notification:', error);
    return false;
  }
}

// Check domain status
async function checkDomainStatus(domain) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`https://${domain}`, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Cloudflare-Worker-Monitor' },
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

// Verify DOWN status with retries
async function verifyDownStatus() {
  let failCount = 0;

  for (let i = 0; i < CONFIG.maxRetries; i++) {
    const isUp = await checkDomainStatus(CONFIG.targetDomain);
    if (!isUp) {
      failCount++;
    } else {
      return false;
    }
    if (i < CONFIG.maxRetries - 1) {
      await delay(CONFIG.retryDelay);
    }
  }

  return failCount === CONFIG.maxRetries;
}

// Parse API response safely
async function parseJSON(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error('API returned non-JSON:', text);
    return null;
  }
}

// Get page rules status (cached 30s)
async function getPageRulesStatus() {
  if (
    pageRuleStatus !== null &&
    pageRuleBackupStatus !== null &&
    Date.now() - lastPageRuleCheck < 30000
  ) {
    return { main: pageRuleStatus, backup: pageRuleBackupStatus };
  }

  try {
    const [mainResponse, backupResponse] = await Promise.all([
      fetch(
        `https://api.cloudflare.com/client/v4/zones/${CONFIG.zoneId}/pagerules/${CONFIG.pageRuleId}`,
        {
          headers: {
            'X-Auth-Email': CONFIG.apiEmail,
            'X-Auth-Key': CONFIG.apiKey,
            'Content-Type': 'application/json'
          }
        }
      ),
      fetch(
        `https://api.cloudflare.com/client/v4/zones/${CONFIG.zoneId}/pagerules/${CONFIG.pageRuleBackupId}`,
        {
          headers: {
            'X-Auth-Email': CONFIG.apiEmail,
            'X-Auth-Key': CONFIG.apiKey,
            'Content-Type': 'application/json'
          }
        }
      )
    ]);

    const [mainData, backupData] = await Promise.all([
      parseJSON(mainResponse),
      parseJSON(backupResponse)
    ]);

    if (mainData?.result && backupData?.result) {
      pageRuleStatus = mainData.result.status === 'active';
      pageRuleBackupStatus = backupData.result.status === 'active';
      lastPageRuleCheck = Date.now();
    } else {
      console.error('Invalid API response, using cached values');
    }

    return {
      main: pageRuleStatus ?? false,
      backup: pageRuleBackupStatus ?? false
    };
  } catch (error) {
    console.error('Failed to get page rules status:', error);
    return {
      main: pageRuleStatus ?? false,
      backup: pageRuleBackupStatus ?? false
    };
  }
}

// Update page rules
async function updatePageRules(isDown) {
  if (pageRuleStatus === isDown && pageRuleBackupStatus === !isDown) {
    return true;
  }

  try {
    const [mainResponse, backupResponse] = await Promise.all([
      fetch(
        `https://api.cloudflare.com/client/v4/zones/${CONFIG.zoneId}/pagerules/${CONFIG.pageRuleId}`,
        {
          method: 'PATCH',
          headers: {
            'X-Auth-Email': CONFIG.apiEmail,
            'X-Auth-Key': CONFIG.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ status: isDown ? 'active' : 'disabled' })
        }
      ),
      fetch(
        `https://api.cloudflare.com/client/v4/zones/${CONFIG.zoneId}/pagerules/${CONFIG.pageRuleBackupId}`,
        {
          method: 'PATCH',
          headers: {
            'X-Auth-Email': CONFIG.apiEmail,
            'X-Auth-Key': CONFIG.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ status: isDown ? 'disabled' : 'active' })
        }
      )
    ]);

    if (mainResponse.ok && backupResponse.ok) {
      pageRuleStatus = isDown;
      pageRuleBackupStatus = !isDown;
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to update page rules:', error);
    return false;
  }
}

// Handle DOWN detection
async function handleDownDetection() {
  // Check lastStatus TRƯỚC để tránh verifyDownStatus() chạy 9s mỗi iteration khi đã DOWN
  const lastStatus = await getLastNotificationStatus();
  if (lastStatus === 'DOWN') return false;

  const isReallyDown = await verifyDownStatus();
  if (!isReallyDown) return false;

  const timestamp = new Date().toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false
  });

  console.log(`${CONFIG.targetDomain} is confirmed down. Updating Page Rules...`);

  const rulesUpdated = await updatePageRules(true);

  const message =
    `⚠️ <b>Website Down Alert</b>\n\n` +
    `Domain: ${CONFIG.targetDomain}\n` +
    `Status: DOWN\n` +
    `Time: ${timestamp}\n` +
    `Action: Main Page Rule ${rulesUpdated ? 'enabled' : 'failed to enable'}, ` +
    `Backup Page Rule ${rulesUpdated ? 'disabled' : 'failed to disable'}\n\n` +
    `➡️ Redirecting traffic to backup server`;

  await sendTelegramNotification(message);
  await updateLastNotificationStatus('DOWN');
  return true;
}

// Handle UP detection
async function handleUpDetection() {
  // Check lastStatus TRƯỚC, bỏ điều kiện currentRules để fix recovery bug giữa 2 run
  const lastStatus = await getLastNotificationStatus();
  if (lastStatus === 'UP') return false;

  const isReallyUp = await checkDomainStatus(CONFIG.targetDomain);
  if (!isReallyUp) return false;

  const timestamp = new Date().toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false
  });

  console.log(`${CONFIG.targetDomain} is up. Updating Page Rules...`);

  const rulesUpdated = await updatePageRules(false);

  const message =
    `✅ <b>Website Recovery Alert</b>\n\n` +
    `Domain: ${CONFIG.targetDomain}\n` +
    `Status: UP\n` +
    `Time: ${timestamp}\n` +
    `Action: Main Page Rule ${rulesUpdated ? 'disabled' : 'failed to disable'}, ` +
    `Backup Page Rule ${rulesUpdated ? 'enabled' : 'failed to enable'}\n\n` +
    `➡️ Traffic restored to main server`;

  await sendTelegramNotification(message);
  await updateLastNotificationStatus('UP');
  return true;
}

// Sync page rules với thực tế khi worker mới start
async function syncPageRules() {
  const isUp = await checkDomainStatus(CONFIG.targetDomain);

  if (isUp) {
    const rules = await getPageRulesStatus();
    if (rules.main || !rules.backup) {
      await updatePageRules(false);
    }
  } else {
    const rules = await getPageRulesStatus();
    if (!rules.main || rules.backup) {
      await updatePageRules(true);
    }
  }
}

// Main monitor loop
async function monitor() {
  await syncPageRules();
  const startTime = Date.now();

  while (Date.now() - startTime < CONFIG.maxExecutionTime) {
    const isUp = await checkDomainStatus(CONFIG.targetDomain);

    if (!isUp) {
      await handleDownDetection();
    } else {
      await handleUpDetection();
    }

    const elapsed = Date.now() - lastCheckTime;
    if (elapsed < CONFIG.checkInterval) {
      await delay(CONFIG.checkInterval - elapsed);
    }
    lastCheckTime = Date.now();
  }
}

// Handle API request (HTTP fetch)
async function handleRequest(request) {
  const isUp = await checkDomainStatus(CONFIG.targetDomain);
  const rules = await getPageRulesStatus();
  const lastStatus = await getLastNotificationStatus();

  return new Response(
    JSON.stringify({
      status: isUp ? 'up' : 'down',
      mainPageRuleEnabled: rules.main,
      backupPageRuleEnabled: rules.backup,
      lastNotificationStatus: lastStatus,
      timestamp: new Date().toISOString()
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

// Export worker handlers
export default {
  async fetch(request, env, ctx) {
    STATUS_STORE = env.NOTIFICATION_STATUS;
    return await handleRequest(request);
  },

  async scheduled(event, env, ctx) {
    STATUS_STORE = env.NOTIFICATION_STATUS;
    ctx.waitUntil(monitor());
  }
};
