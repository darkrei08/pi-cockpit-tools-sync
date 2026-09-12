/**
 * pi-cockpit-tools-sync — Pi Agent Extension for Cockpit Tools
 * 
 * Provides native slash commands and workflow functions for Pi CLI:
 * - /cockpit & /cockpit-status: Show current account, subscription tier, and model quota table
 * - /cockpit-accounts: List all Cockpit Tools accounts
 * - /cockpit-switch <email>: Switch active Cockpit account and sync OAuth token to Pi
 * - /cockpit-sync: Sync current Cockpit account to Pi auth.json
 * - /cockpit-provision: Provision all Cockpit accounts into tuxevil-rotator
 * - /cockpit-proxy <cmd>: Run tuxevil-rotator status, doctor, import, or start
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { createDecipheriv } = require('crypto');

const HOME = os.homedir();

// ── Multi-OS Cockpit Tools Path Resolver ────────────────────────────────────

function getCockpitDataDir() {
  const candidates = [
    path.join(HOME, '.antigravity_cockpit'),
    path.join(HOME, '.local', 'share', 'cockpit-tools'),
    path.join(HOME, '.config', 'cockpit-tools'),
    path.join(HOME, '.wizard-ai', 'cockpit-tools'),
    path.join(HOME, 'Library', 'Application Support', 'cockpit-tools'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'cockpit-tools') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'cockpit-tools') : null,
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'accounts.json')) || fs.existsSync(path.join(dir, 'account-token.key'))) {
      return dir;
    }
  }
  return path.join(HOME, '.antigravity_cockpit');
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ── Account & Quota Loader ──────────────────────────────────────────────────

function loadCockpitAccounts() {
  const dataDir = getCockpitDataDir();
  const accountsFile = path.join(dataDir, 'accounts.json');
  const accountsData = readJson(accountsFile);
  if (!accountsData || !Array.isArray(accountsData.accounts)) {
    return { accounts: [], currentId: null };
  }
  return {
    accounts: accountsData.accounts,
    currentId: accountsData.current_account_id || null,
  };
}

function loadAccountDetail(accountId) {
  const dataDir = getCockpitDataDir();
  const detailFile = path.join(dataDir, 'accounts', `${accountId}.json`);
  const detail = readJson(detailFile);
  if (!detail) return null;

  // Cockpit Tools stores newer accounts with an encrypted token (AES-256-GCM)
  // instead of a plaintext `token` field. Decrypt using the local key file.
  if (!detail.token && detail.token_encrypted) {
    try {
      const keyFile = path.join(dataDir, 'account-token.key');
      if (!fs.existsSync(keyFile)) return detail;

      const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
      const enc = detail.token_encrypted;
      const nonce = Buffer.from(enc.nonce, 'base64');
      const ciphertextAndTag = Buffer.from(enc.ciphertext, 'base64');

      // Last 16 bytes are the GCM authentication tag
      const authTag = ciphertextAndTag.slice(-16);
      const ciphertext = ciphertextAndTag.slice(0, -16);

      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(ciphertext, null, 'utf8');
      decrypted += decipher.final('utf8');

      detail.token = JSON.parse(decrypted);
    } catch {
      // Decryption failed — return detail without token
    }
  }

  return detail;
}

function getCockpitStatus() {
  const { accounts, currentId } = loadCockpitAccounts();
  if (accounts.length === 0) {
    return { ok: false, error: 'cockpit_not_found', message: 'Cockpit Tools not detected or no accounts configured.' };
  }

  const currentAcc = accounts.find(a => a.id === currentId) || accounts[0];
  const detail = loadAccountDetail(currentAcc.id);

  const models = detail?.quota?.models || [];
  const modelList = models.map(m => {
    const pct = m.percentage ?? 100;
    let icon = '🟢';
    if (pct < 10) icon = '🔴';
    else if (pct < 50) icon = '🟡';
    return {
      name: m.name,
      displayName: m.display_name || m.name,
      percentage: pct,
      icon,
      resetTime: m.reset_time,
    };
  });

  return {
    ok: true,
    currentAccount: {
      id: currentAcc.id,
      email: detail?.email || currentAcc.email || 'Unknown',
      tier: detail?.quota?.subscription_tier || 'free-tier',
    },
    totalAccounts: accounts.length,
    models: modelList,
  };
}

function provisionRotator() {
  const { accounts } = loadCockpitAccounts();
  if (accounts.length === 0) {
    return { ok: false, error: 'cockpit_not_found' };
  }

  const configDir = process.env.TUXEVIL_ROTATOR_DIR || path.join(HOME, '.tuxevil-rotator');
  const configPath = path.join(configDir, 'accounts.json');
  const existingConfig = readJson(configPath) || { proxyPort: 51200, accounts: [] };
  const existingAccounts = Array.isArray(existingConfig.accounts) ? existingConfig.accounts : [];

  const keptAccounts = existingAccounts.filter(a => !a.syncedFromCockpit);
  const provisioned = [];

  for (const account of accounts) {
    const detail = loadAccountDetail(account.id);
    if (!detail || !detail.token || detail.disabled || !detail.token.refresh_token) continue;

    const email = detail.email || detail.token?.email || account.email;
    let tier = detail.quota?.subscription_tier || 'unknown';
    if (tier.includes('pro')) tier = 'pro';
    else if (tier.includes('free')) tier = 'free';
    else if (tier.includes('plus')) tier = 'plus';
    else if (tier.includes('ultra')) tier = 'ultra';
    else tier = 'unknown';

    const projectId = detail.token.project_id || detail.project_id || 'aicode-consumers';
    const credential = {
      provider: 'google-antigravity',
      refreshToken: detail.token.refresh_token,
      projectId,
      projectSource: 'google',
    };

    provisioned.push({
      provider: 'google-antigravity',
      email,
      refreshToken: detail.token.refresh_token,
      projectId,
      projectSource: 'google',
      label: `Cockpit: ${email}`,
      tier,
      credentials: [credential],
      syncedFromCockpit: true,
    });
  }

  existingConfig.proxyPort = existingConfig.proxyPort || 51200;
    existingConfig.accounts = [...keptAccounts, ...provisioned];
  writeJson(configPath, existingConfig);

  return {
    ok: true,
    provisionedCount: provisioned.length,
    configPath,
  };
}

function syncPiAuth() {
  const { accounts, currentId } = loadCockpitAccounts();
  if (accounts.length === 0) return { ok: false, error: 'no_accounts' };

  let currentAcc = accounts.find(a => a.id === currentId) || accounts[0];
  let detail = loadAccountDetail(currentAcc.id);
  
  let avgQuota = 0;
  if (detail && detail.quota && detail.quota.models) {
      const validPcts = detail.quota.models.map(m => m.percentage).filter(p => typeof p === 'number');
      if (validPcts.length > 0) {
          avgQuota = Math.round(validPcts.reduce((a, b) => a + b, 0) / validPcts.length);
      }
  }

  if (avgQuota <= 0) {
      let best = null;
      let maxQuota = -1;
      for (const acc of accounts) {
          const accDetail = loadAccountDetail(acc.id);
          if (!accDetail) continue;
          const models = accDetail.quota?.models || [];
          let avg = 0;
          const vPcts = models.map(m => m.percentage).filter(p => typeof p === 'number');
          if (vPcts.length > 0) {
              avg = Math.round(vPcts.reduce((a, b) => a + b, 0) / vPcts.length);
          }
          if (avg > maxQuota) {
              maxQuota = avg;
              best = acc;
          }
      }
      
      if (best && maxQuota > 0) {
          const dataDir = getCockpitDataDir();
          const accountsFile = path.join(dataDir, 'accounts.json');
          const accountsData = readJson(accountsFile) || {};
          accountsData.current_account_id = best.id;
          writeJson(accountsFile, accountsData);
          currentAcc = best;
          detail = loadAccountDetail(best.id);
      } else {
          return { ok: false, error: 'All accounts exhausted or disabled: rotation returned no available account' };
      }
  }

  if (!detail || !detail.token) return { ok: false, error: 'no_token' };

  const authFile = path.join(HOME, '.pi', 'agent', 'auth.json');
  const auth = readJson(authFile) || {};


  auth['google-antigravity'] = {
    type: 'oauth',
    refreshToken: detail.token.refresh_token,
    accessToken: detail.token.access_token || 'proxy-managed',
    expires: Date.now() + 3600 * 1000,
    projectId: detail.token.project_id || 'cockpit-managed',
  };
  auth['antigravity'] = {
    type: 'oauth',
    refreshToken: detail.token.refresh_token,
    accessToken: detail.token.access_token || 'proxy-managed',
    expires: Date.now() + 3600 * 1000,
    projectId: detail.token.project_id || 'cockpit-managed',
  };

  writeJson(authFile, auth);
  return { ok: true, email: detail.email || currentAcc.email };
}

// ── Main Pi Extension Export ────────────────────────────────────────────────

module.exports = function cockpitToolsExtension(api) {
  // Slash command: /cockpit or /cockpit-status
  const handleStatus = (_args, ctx) => {
    const st = getCockpitStatus();
    if (!st.ok) {
      ctx.ui.notify('⚠️ Cockpit Tools not detected. Use /login for manual authentication.', 'warning');
      return;
    }

    const lines = [
      '🚀 Cockpit Tools Bridge & Quota Monitor',
      `Account: ${st.currentAccount.email} (${st.currentAccount.tier})`,
      `Total Accounts Available: ${st.totalAccounts}`,
      '',
      'Model Quotas:',
      ...st.models.slice(0, 8).map(m => `${m.icon} ${m.displayName.padEnd(28)} : ${m.percentage}%`),
      '',
      'Commands: /cockpit-accounts, /cockpit-switch <email>, /cockpit-provision, /cockpit-proxy status',
    ];
    ctx.ui.notify(lines.join('\n'), 'info');
  };

  api.registerCommand('cockpit', { description: 'Show current Cockpit account, tier, and model quotas', handler: handleStatus });
  api.registerCommand('cockpit-status', { description: 'Show current Cockpit account, tier, and model quotas', handler: handleStatus });

  // Slash command: /cockpit-accounts
  api.registerCommand('cockpit-accounts', {
    description: 'List all Cockpit Tools accounts',
    handler: (_args, ctx) => {
      const { accounts, currentId } = loadCockpitAccounts();
      if (accounts.length === 0) {
        ctx.ui.notify('⚠️ No Cockpit Tools accounts found.', 'warning');
        return;
      }

      const lines = [
        `📋 Cockpit Tools Accounts (${accounts.length} total):`,
        '',
        ...accounts.map((acc, i) => `${i + 1}. ${acc.email || acc.id}${acc.id === currentId ? ' (Active ✅)' : ''}`),
        '',
        'Use /cockpit-switch <email> to switch active account.',
      ];
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  // Slash command: /cockpit-switch <email>
  api.registerCommand('cockpit-switch', {
    description: 'Switch active Cockpit account and sync OAuth token to Pi',
    handler: (args, ctx) => {
      const email = (args || '').trim();
      if (!email) {
        ctx.ui.notify('Usage: /cockpit-switch <email>', 'warning');
        return;
      }

      const dataDir = getCockpitDataDir();
      const accountsFile = path.join(dataDir, 'accounts.json');
      const { accounts } = loadCockpitAccounts();
      const target = accounts.find(a => a.email && a.email.toLowerCase() === email.toLowerCase());
      if (!target) {
        ctx.ui.notify(`⚠️ Account "${email}" not found in Cockpit Tools.`, 'warning');
        return;
      }

      const accountsData = readJson(accountsFile) || {};
      accountsData.current_account_id = target.id;
      writeJson(accountsFile, accountsData);

      const syncRes = syncPiAuth();
      if (syncRes.ok) {
        ctx.ui.notify(`✅ Switched active Cockpit account to: ${target.email}\nPi auth.json successfully synced.`, 'info');
      } else {
        ctx.ui.notify(`⚠️ Switched account in Cockpit, but failed to sync Pi auth: ${syncRes.error}`, 'warning');
      }
    },
  });

  // Slash command: /cockpit-model <modelName>
  api.registerCommand('cockpit-model', {
    description: 'Show or set the default model for the active account',
    handler: (args, ctx) => {
      const modelName = (args || '').trim();
      if (!modelName) {
        const st = getCockpitStatus();
        const lines = ['🤖 Available Models for Active Account:'];
        if (st.ok && st.models) {
          st.models.slice(0, 10).forEach((m, idx) => {
            lines.push(`[${idx + 1}] ${m.icon} ${m.displayName.padEnd(28)} (${m.name}) : ${m.percentage}%`);
          });
        }
        lines.push('', 'Usage: /cockpit-model <modelName> (e.g. /cockpit-model gemini-3.6-flash-high)');
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      const settingsPath = path.join(HOME, '.pi', 'agent', 'settings.json');
      try {
        const settings = readJson(settingsPath) || {};
        settings.defaultModel = modelName;
        writeJson(settingsPath, settings);
        ctx.ui.notify(`✅ Default Model updated in settings.json to: ${modelName}`, 'info');
      } catch (e) {
        ctx.ui.notify(`❌ Failed to update model: ${e.message}`, 'error');
      }
    },
  });

  // Slash command: /cockpit-sync
  api.registerCommand('cockpit-sync', {
    description: 'Sync current Cockpit account to Pi auth.json',
    handler: (_args, ctx) => {
      const res = syncPiAuth();
      if (res.ok) {
        ctx.ui.notify(`✅ Synced current Cockpit account (${res.email}) to Pi auth.json.`, 'info');
      } else {
        ctx.ui.notify(`❌ Failed to sync Cockpit account: ${res.error}`, 'error');
      }
    },
  });

  // Slash command: /cockpit-provision
  api.registerCommand('cockpit-provision', {
    description: 'Provision all Cockpit accounts into tuxevil-rotator',
    handler: (_args, ctx) => {
      const res = provisionRotator();
      if (res.ok) {
        ctx.ui.notify(`✅ Provisioned ${res.provisionedCount} Cockpit accounts into Proxy Rotator (${res.configPath}).`, 'info');
      } else {
        ctx.ui.notify('❌ Failed to provision Cockpit accounts into rotator.', 'error');
      }
    },
  });

  // Slash command: /cockpit-proxy <cmd>
  api.registerCommand('cockpit-proxy', {
    description: 'Run tuxevil-rotator status, doctor, import, or start',
    handler: (args, ctx) => {
      const cmd = (args || 'status').trim().split(/\s+/)[0];
        const supported = new Set(['status', 'doctor', 'import', 'start']);
        if (!supported.has(cmd)) {
          ctx.ui.notify('Usage: /cockpit-proxy [status|doctor|import|start]', 'warning');
          return;
        }
        const binary = process.env.TUXEVIL_ROTATOR_BIN || 'tuxevil-rotator';
        if (cmd === 'start') {
          const child = spawn(binary, ['start'], { detached: true, stdio: 'ignore', windowsHide: true });
          child.unref();
          ctx.ui.notify('✅ Started tuxevil-rotator in the background.', 'info');
          return;
        }
        try {
          const output = execFileSync(binary, [cmd], { encoding: 'utf8' });
          ctx.ui.notify(output || `tuxevil-rotator ${cmd} completed.`, 'info');
        } catch (e) {
          ctx.ui.notify(`tuxevil-rotator ${cmd} error: ${e.message}`, 'error');
        }
                },
      });

  console.log('🛠️ pi-cockpit-tools-sync extension loaded.');
};

// Export helpers for programmatic usage
module.exports.getCockpitStatus = getCockpitStatus;
module.exports.provisionRotator = provisionRotator;
module.exports.syncPiAuth = syncPiAuth;
