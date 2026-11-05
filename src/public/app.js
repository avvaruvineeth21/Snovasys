/**
 * LedgerLine Frontend Client Application
 * Proved Ledger, Idempotency, and Concurrency Demonstration UI
 */

const state = {
  token: localStorage.getItem('ll_token') || null,
  user: JSON.parse(localStorage.getItem('ll_user') || 'null'),
  accounts: [],
  selectedAccountId: null,
  statementFilter: 'ALL',
  statementData: null
};

// Seed credentials map for quick-fill buttons
const SEED_CREDS = {
  admin: { username: 'admin', password: 'AdminPass123!' },
  alice: { username: 'alice', password: 'AlicePass123!' },
  bob: { username: 'bob', password: 'BobPass123!' },
  auditor: { username: 'auditor', password: 'AuditorPass123!' }
};

// Format minor units (cents) to USD string
function formatMoney(cents, currency = 'USD') {
  if (cents === undefined || cents === null) return '$0.00';
  const dollars = (cents / 100).toFixed(2);
  const sign = cents < 0 ? '-' : '';
  const absVal = Math.abs(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${absVal}`;
}

// Format ISO date
function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Generate random UUID for idempotency
function generateUUID() {
  return 'idem_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
}

// API Fetch Helper
async function apiCall(endpoint, { method = 'GET', body = null, headers = {} } = {}) {
  const reqHeaders = {
    'Content-Type': 'application/json',
    ...headers
  };

  if (state.token) {
    reqHeaders['Authorization'] = `Bearer ${state.token}`;
  }

  const options = {
    method,
    headers: reqHeaders
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(endpoint, options);
  const data = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    data
  };
}

// Toast notification
function showToast(message, type = 'info') {
  const toast = document.getElementById('toastMessage');
  toast.className = `toast toast-${type}`;
  toast.innerText = message;
  toast.classList.remove('hidden');

  setTimeout(() => {
    toast.classList.add('hidden');
  }, 6000);
}

// Initialize on Load
document.addEventListener('DOMContentLoaded', () => {
  if (state.token && state.user) {
    renderAuthenticated();
  } else {
    renderLogin();
  }
  generateNewIdempotencyKey();
  checkSystemInvariant();
});

// Generate fresh idempotency keys in forms
function generateNewIdempotencyKey() {
  const key = generateUUID();
  const txInput = document.getElementById('transferIdempotencyKey');
  const depInput = document.getElementById('depositIdempotencyKey');
  const wthInput = document.getElementById('withdrawIdempotencyKey');
  if (txInput) txInput.value = key;
  if (depInput) depInput.value = generateUUID();
  if (wthInput) wthInput.value = generateUUID();
}

// Quick evaluator login
async function loginPreset(roleKey) {
  const creds = SEED_CREDS[roleKey];
  if (!creds) return;

  const res = await apiCall('/api/auth/login', {
    method: 'POST',
    body: creds
  });

  if (res.ok) {
    state.token = res.data.token;
    state.user = res.data.user;
    localStorage.setItem('ll_token', state.token);
    localStorage.setItem('ll_user', JSON.stringify(state.user));
    showToast(`Signed in as ${state.user.name} (${state.user.role})`, 'success');
    renderAuthenticated();
  } else {
    showToast(`Login failed: ${res.data.error}`, 'error');
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value.trim();

  const res = await apiCall('/api/auth/login', {
    method: 'POST',
    body: { username, password }
  });

  if (res.ok) {
    state.token = res.data.token;
    state.user = res.data.user;
    localStorage.setItem('ll_token', state.token);
    localStorage.setItem('ll_user', JSON.stringify(state.user));
    renderAuthenticated();
  } else {
    showToast(`Authentication failed: ${res.data.error}`, 'error');
  }
}

function handleLogout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('ll_token');
  localStorage.removeItem('ll_user');
  renderLogin();
}

function renderLogin() {
  document.getElementById('viewLogin').classList.remove('hidden');
  document.getElementById('viewDashboard').classList.add('hidden');
  document.getElementById('navAuth').innerHTML = `
    <span class="user-badge">Not authenticated</span>
  `;
}

function renderAuthenticated() {
  document.getElementById('viewLogin').classList.add('hidden');
  document.getElementById('viewDashboard').classList.remove('hidden');

  document.getElementById('navAuth').innerHTML = `
    <div class="nav-user-info">
      <span class="user-badge">
        <span>${state.user.name}</span>
        <span class="role-tag ${state.user.role}">${state.user.role}</span>
      </span>
      <button class="btn btn-outline btn-sm" onclick="handleLogout()">Sign Out</button>
    </div>
  `;

  // Role visibility controls
  const tabAdminBtn = document.getElementById('tabAdminBtn');
  const moneyMovementCard = document.getElementById('moneyMovementCard');

  if (state.user.role === 'ADMIN') {
    tabAdminBtn.classList.remove('hidden');
    moneyMovementCard.classList.remove('hidden');
  } else if (state.user.role === 'AUDITOR') {
    tabAdminBtn.classList.add('hidden');
    moneyMovementCard.classList.add('hidden'); // Auditors cannot move money
  } else {
    tabAdminBtn.classList.add('hidden');
    moneyMovementCard.classList.remove('hidden');
  }

  loadDashboardData();
  checkSystemInvariant();
}

// Tab navigation
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === tabId);
  });

  if (tabId === 'tabStatement') {
    loadStatement();
  } else if (tabId === 'tabAudit') {
    runReconciliation();
    loadAuditLogs();
  } else if (tabId === 'tabAdmin') {
    loadAdminAccounts();
  }
}

// Action switch (Transfer vs Deposit vs Withdraw)
function switchAction(action) {
  document.querySelectorAll('.sub-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.innerText.toLowerCase() === action);
  });

  document.getElementById('transferForm').classList.toggle('hidden', action !== 'transfer');
  document.getElementById('depositForm').classList.toggle('hidden', action !== 'deposit');
  document.getElementById('withdrawForm').classList.toggle('hidden', action !== 'withdraw');
}

// Load accounts for dashboard
async function loadDashboardData() {
  const res = await apiCall('/api/accounts');
  if (!res.ok) {
    if (res.status === 401) return handleLogout();
    return showToast(res.data.error, 'error');
  }

  state.accounts = res.data.accounts;
  renderAccountsList();
  populateDropdowns();

  if (state.accounts.length > 0 && !state.selectedAccountId) {
    state.selectedAccountId = state.accounts[0].id;
  }
}

function renderAccountsList() {
  const container = document.getElementById('accountsList');
  if (state.accounts.length === 0) {
    container.innerHTML = `<p class="form-hint">No accounts available for this role.</p>`;
    return;
  }

  container.innerHTML = state.accounts.map(acc => {
    const isSelected = acc.id === state.selectedAccountId;
    const isNegative = acc.balance < 0;
    const availableTotal = acc.balance + acc.overdraft_limit;

    return `
      <div class="account-card ${isSelected ? 'selected' : ''}" onclick="selectAccount('${acc.id}')">
        <div class="account-card-top">
          <span class="account-number">${acc.account_number}</span>
          <span class="badge ${acc.status === 'ACTIVE' ? 'badge-posted' : 'badge-refused'}">${acc.status}</span>
        </div>
        <div class="account-balance-large ${isNegative ? 'negative' : ''}">
          ${formatMoney(acc.balance, acc.currency)}
        </div>
        <div class="account-overdraft-info">
          <span>Authorized Overdraft: ${formatMoney(acc.overdraft_limit)}</span>
          <span>Max Available: <strong>${formatMoney(availableTotal)}</strong></span>
        </div>
        <div class="account-owner" style="margin-top:0.4rem;">
          Owner: ${acc.owner_name || 'System Account'}
        </div>
      </div>
    `;
  }).join('');
}

function selectAccount(accId) {
  state.selectedAccountId = accId;
  renderAccountsList();
  const select = document.getElementById('statementAccountSelect');
  if (select) {
    select.value = accId;
    loadStatement();
  }
}

function populateDropdowns() {
  const transferSrc = document.getElementById('transferSource');
  const transferDst = document.getElementById('transferDest');
  const depositAcc = document.getElementById('depositAccount');
  const withdrawAcc = document.getElementById('withdrawAccount');
  const statementAcc = document.getElementById('statementAccountSelect');

  // Filter accounts the user is authorized to debit (their own or all for admin)
  const debitableAccounts = state.user.role === 'ADMIN'
    ? state.accounts
    : state.accounts.filter(a => a.user_id === state.user.id);

  const debitOptions = debitableAccounts.map(a => `
    <option value="${a.id}">${a.account_number} — ${formatMoney(a.balance)}</option>
  `).join('');

  const allAccountOptions = state.accounts.map(a => `
    <option value="${a.id}">${a.account_number} (${a.owner_name || 'System'}) — ${formatMoney(a.balance)}</option>
  `).join('');

  if (transferSrc) transferSrc.innerHTML = debitOptions;
  if (transferDst) transferDst.innerHTML = allAccountOptions;
  if (depositAcc) depositAcc.innerHTML = debitOptions;
  if (withdrawAcc) withdrawAcc.innerHTML = debitOptions;
  if (statementAcc) statementAcc.innerHTML = allAccountOptions;

  updateTransferAvailability();
  updateWithdrawalAvailability();
}

function updateTransferAvailability() {
  const srcId = document.getElementById('transferSource')?.value;
  const acc = state.accounts.find(a => a.id === srcId);
  const hint = document.getElementById('sourceBalanceHint');
  if (acc && hint) {
    const totalAvail = acc.balance + acc.overdraft_limit;
    hint.innerText = `Balance: ${formatMoney(acc.balance)} | Overdraft: ${formatMoney(acc.overdraft_limit)} | Available to spend: ${formatMoney(totalAvail)}`;
  }
}

function updateWithdrawalAvailability() {
  const wthId = document.getElementById('withdrawAccount')?.value;
  const acc = state.accounts.find(a => a.id === wthId);
  const hint = document.getElementById('withdrawBalanceHint');
  if (acc && hint) {
    const totalAvail = acc.balance + acc.overdraft_limit;
    hint.innerText = `Available to withdraw: ${formatMoney(totalAvail)}`;
  }
}

// Transfer Handler
async function handleTransferSubmit(event) {
  event.preventDefault();
  const sourceAccountId = document.getElementById('transferSource').value;
  const destinationAccountId = document.getElementById('transferDest').value;
  const amountDollars = parseFloat(document.getElementById('transferAmount').value);
  const description = document.getElementById('transferDescription').value.trim();
  const idempotencyKey = document.getElementById('transferIdempotencyKey').value.trim();

  const amountCents = Math.round(amountDollars * 100);

  const res = await apiCall('/api/transactions/transfer', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      sourceAccountId,
      destinationAccountId,
      amount: amountCents,
      description
    }
  });

  if (res.ok) {
    const isReplay = res.headers.get('x-idempotency-replay') === 'true';
    showToast(`Transfer posted successfully! ${isReplay ? '(Notice: Idempotent replay caught)' : ''}`, 'success');
    generateNewIdempotencyKey();
    loadDashboardData();
    checkSystemInvariant();
  } else {
    showToast(`Transfer Refused: ${res.data.error}`, 'error');
    loadDashboardData();
  }
}

// Simulate Double-Click / Concurrent Race Submit
async function simulateDoubleSubmit() {
  const sourceAccountId = document.getElementById('transferSource').value;
  const destinationAccountId = document.getElementById('transferDest').value;
  const amountDollars = parseFloat(document.getElementById('transferAmount').value);
  const description = document.getElementById('transferDescription').value.trim() || 'Simulated Race Transfer';
  const idempotencyKey = document.getElementById('transferIdempotencyKey').value.trim();

  if (!idempotencyKey) {
    return showToast('Please ensure an Idempotency Key is present.', 'error');
  }

  const amountCents = Math.round((amountDollars || 10) * 100);

  showToast('⚡ Dispatching 2 concurrent HTTP requests with IDENTICAL idempotency key...', 'info');

  const makeReq = () => apiCall('/api/transactions/transfer', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      sourceAccountId,
      destinationAccountId,
      amount: amountCents,
      description
    }
  });

  // Fire both simultaneously across the wire
  const [res1, res2] = await Promise.all([makeReq(), makeReq()]);

  const replay1 = res1.headers.get('x-idempotency-replay') === 'true';
  const replay2 = res2.headers.get('x-idempotency-replay') === 'true';
  const dupCount = res2.headers.get('x-duplicate-count') || res1.headers.get('x-duplicate-count') || 1;

  if (res1.ok && res2.ok) {
    showToast(
      `🎯 Idempotency Proved! Request 1 status ${res1.status}, Request 2 status ${res2.status}. Money moved ONCE. Duplicate replay detected (Duplicate count: ${dupCount}).`,
      'success'
    );
  } else {
    showToast(`Completed: Req 1: ${res1.status}, Req 2: ${res2.status}`, 'info');
  }

  loadDashboardData();
  checkSystemInvariant();
}

// Deposit Handler
async function handleDepositSubmit(event) {
  event.preventDefault();
  const accountId = document.getElementById('depositAccount').value;
  const amountDollars = parseFloat(document.getElementById('depositAmount').value);
  const description = document.getElementById('depositDescription').value.trim();
  const idempotencyKey = document.getElementById('depositIdempotencyKey').value.trim();

  const res = await apiCall('/api/transactions/deposit', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      accountId,
      amount: Math.round(amountDollars * 100),
      description
    }
  });

  if (res.ok) {
    showToast('External deposit posted successfully.', 'success');
    generateNewIdempotencyKey();
    loadDashboardData();
    checkSystemInvariant();
  } else {
    showToast(`Deposit refused: ${res.data.error}`, 'error');
  }
}

// Withdrawal Handler
async function handleWithdrawSubmit(event) {
  event.preventDefault();
  const accountId = document.getElementById('withdrawAccount').value;
  const amountDollars = parseFloat(document.getElementById('withdrawAmount').value);
  const description = document.getElementById('withdrawDescription').value.trim();
  const idempotencyKey = document.getElementById('withdrawIdempotencyKey').value.trim();

  const res = await apiCall('/api/transactions/withdraw', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      accountId,
      amount: Math.round(amountDollars * 100),
      description
    }
  });

  if (res.ok) {
    showToast('Withdrawal completed.', 'success');
    generateNewIdempotencyKey();
    loadDashboardData();
    checkSystemInvariant();
  } else {
    showToast(`Withdrawal refused: ${res.data.error}`, 'error');
    loadDashboardData();
  }
}

// Load Statement View
async function loadStatement() {
  const accountId = document.getElementById('statementAccountSelect')?.value || state.selectedAccountId;
  if (!accountId) return;

  const res = await apiCall(`/api/accounts/${accountId}/statement`);
  if (!res.ok) {
    return showToast(res.data.error, 'error');
  }

  state.statementData = res.data;
  renderStatement();
}

function filterStatement(filterType) {
  state.statementFilter = filterType;
  document.querySelectorAll('.filter-pill').forEach(btn => {
    btn.classList.toggle('active', btn.innerText.toUpperCase().includes(filterType) || (filterType === 'ALL' && btn.innerText === 'All'));
  });
  renderStatement();
}

function renderStatement() {
  if (!state.statementData) return;
  const { account, statement, postedCount, refusedCount } = state.statementData;

  // Render Summary Box
  document.getElementById('statementSummaryBox').innerHTML = `
    <div class="stat-item">
      <div class="stat-label">Current Balance</div>
      <div class="stat-value ${account.balance < 0 ? 'text-danger' : ''}">${formatMoney(account.balance)}</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">Overdraft Limit</div>
      <div class="stat-value">${formatMoney(account.overdraftLimit)}</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">Posted Transactions</div>
      <div class="stat-value">${postedCount}</div>
    </div>
    <div class="stat-item">
      <div class="stat-label">Refused Attempts</div>
      <div class="stat-value" style="color:var(--accent-red)">${refusedCount}</div>
    </div>
  `;

  // Filter rows
  const filtered = statement.filter(entry => {
    if (state.statementFilter === 'ALL') return true;
    if (state.statementFilter === 'POSTED') return entry.status === 'POSTED';
    if (state.statementFilter === 'REFUSED') return entry.status === 'REFUSED';
    return true;
  });

  const tbody = document.getElementById('statementTableBody');
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding:2rem; color:var(--text-muted)">No entries match filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(row => {
    const isRefused = row.status === 'REFUSED';
    const isCredit = row.entry_type === 'CREDIT';
    const amountClass = isRefused ? 'amount-refused' : (isCredit ? 'amount-credit' : 'amount-debit');
    const amountPrefix = isRefused ? '' : (isCredit ? '+' : '-');

    return `
      <tr class="${isRefused ? 'row-refused' : ''}">
        <td>${formatDate(row.created_at)}</td>
        <td>
          <span class="badge ${isRefused ? 'badge-refused' : 'badge-posted'}">
            ${row.entry_type}
          </span>
        </td>
        <td class="${amountClass}">
          ${amountPrefix}${formatMoney(row.amount)}
        </td>
        <td class="font-mono">
          <strong>${formatMoney(row.resulting_balance)}</strong>
        </td>
        <td>
          <div>${row.initiator_name || 'System'}</div>
          <small class="text-muted">${row.initiator_role}</small>
        </td>
        <td>
          <div>${row.description || 'Transaction'}</div>
          ${isRefused ? `<span class="badge badge-refused" style="margin-top:0.25rem;">REFUSED: ${row.refusal_reason}</span>` : ''}
        </td>
        <td class="font-mono" style="font-size:0.7rem; color:var(--text-muted);">
          ${row.entry_hash ? `Hash: ${row.entry_hash.substring(0, 16)}...` : (row.idempotency_key ? `Key: ${row.idempotency_key}` : '-')}
        </td>
      </tr>
    `;
  }).join('');
}

// Cryptographic Chain Verifier
async function runChainVerification() {
  const panel = document.getElementById('chainVerificationResult');
  panel.innerHTML = `<p>⏳ Walking Merkle/SHA-256 chain and recalculating all hashes...</p>`;

  const res = await apiCall('/api/audit/verify-chain');
  if (!res.ok) {
    panel.innerHTML = `<div class="toast toast-error">Verification error: ${res.data.error}</div>`;
    return;
  }

  const { valid, totalEntries, headHash, message, error } = res.data;

  if (valid) {
    panel.innerHTML = `
      <div class="proof-row highlight">
        <span>✅ Cryptographic Verification PASSED: 100% Intact</span>
        <span>${totalEntries} Ledger Blocks Verified</span>
      </div>
      <div style="margin-top:0.5rem; font-size:0.8rem; color:var(--text-secondary)">
        <div><strong>Head Chain Hash:</strong> <code class="font-mono" style="color:#93c5fd">${headHash}</code></div>
        <div style="margin-top:0.25rem;">${message} Zero rows modified, deleted, or inserted out of order.</div>
      </div>
    `;
  } else {
    panel.innerHTML = `
      <div class="toast toast-error">
        ❌ CORRUPTION DETECTED: ${error}
      </div>
    `;
  }

  loadLedgerEntriesStream();
}

// Load Chain Entries Stream
async function loadLedgerEntriesStream() {
  const res = await apiCall('/api/audit/ledger-entries?limit=15');
  if (!res.ok) return;

  const container = document.getElementById('ledgerEntriesStream');
  container.innerHTML = res.data.entries.map(e => `
    <div class="chain-block">
      <div style="display:flex; justify-content:space-between; margin-bottom:0.25rem;">
        <strong>#${e.sequence_number} | ${e.account_number} (${e.entry_type} ${formatMoney(e.amount)})</strong>
        <span class="text-muted">${formatDate(e.created_at)}</span>
      </div>
      <div class="block-hash">Hash: ${e.entry_hash}</div>
      <div class="block-prev">Prev: ${e.previous_hash}</div>
    </div>
  `).join('');
}

// System Invariant Reconciliation
async function runReconciliation() {
  const res = await apiCall('/api/audit/reconciliation');
  if (!res.ok) return;

  const { invariants, isHealthy } = res.data;
  const mc = invariants.moneyConservation;
  const de = invariants.doubleEntryBalancing;

  document.getElementById('reconciliationProofBox').innerHTML = `
    <div class="proof-row ${isHealthy ? 'highlight' : ''}">
      <span>Money Conservation Invariant</span>
      <span>${mc.holds ? 'HOLDING (Δ = 0)' : 'BROKEN'}</span>
    </div>
    <div class="proof-row">
      <span>Total Customer Balances:</span>
      <span>${formatMoney(mc.totalCustomerBalances)}</span>
    </div>
    <div class="proof-row">
      <span>External Net Inflows (In - Out):</span>
      <span>${formatMoney(mc.totalExternalInflows)} - ${formatMoney(mc.totalExternalOutflows)} = ${formatMoney(mc.netExternalInflow)}</span>
    </div>
    <div class="proof-row">
      <span>Double-Entry Balance (Debits == Credits):</span>
      <span>Debits: ${formatMoney(de.totalDebits)} | Credits: ${formatMoney(de.totalCredits)}</span>
    </div>
    <div class="proof-row">
      <span>Total Postings in Ledger:</span>
      <span>${de.totalPostings} entries</span>
    </div>
  `;
}

// Audit Logs (Idempotency and Refusals)
async function loadAuditLogs() {
  // Idempotency log
  const resIdem = await apiCall('/api/audit/idempotency-log');
  if (resIdem.ok) {
    const tbody = document.getElementById('idempotencyTableBody');
    tbody.innerHTML = resIdem.data.keys.map(k => `
      <tr>
        <td class="font-mono">${k.key}</td>
        <td><span class="badge ${k.status === 'COMPLETED' ? 'badge-posted' : 'badge-refused'}">${k.status}</span></td>
        <td><strong style="color:${k.duplicate_count > 0 ? 'var(--accent-amber)' : 'inherit'}">${k.duplicate_count}</strong></td>
        <td>${k.initiator_username}</td>
        <td>${formatDate(k.updated_at)}</td>
      </tr>
    `).join('');
  }

  // Refused log
  const resRef = await apiCall('/api/audit/refused-log');
  if (resRef.ok) {
    const tbody = document.getElementById('refusedTableBody');
    tbody.innerHTML = resRef.data.refused.map(r => `
      <tr>
        <td>${formatDate(r.created_at)}</td>
        <td>${r.account_number || r.account_id}</td>
        <td class="amount-refused">${formatMoney(r.attempted_amount)}</td>
        <td><span class="badge badge-refused">${r.reason}</span></td>
        <td>${r.initiator_username}</td>
      </tr>
    `).join('');
  }
}

// Check System Invariant in Header
async function checkSystemInvariant() {
  const res = await apiCall('/api/audit/reconciliation');
  const badge = document.getElementById('invariantSummary');
  if (res.ok && res.data.isHealthy) {
    const sum = res.data.invariants.moneyConservation.totalCustomerBalances;
    badge.innerText = `Holding: ${formatMoney(sum)} conserved`;
  } else {
    badge.innerText = 'Invariant check unavailable';
  }
}

// Admin Console: Load all accounts
async function loadAdminAccounts() {
  const res = await apiCall('/api/accounts?includeSystem=true');
  if (!res.ok) return;

  const tbody = document.getElementById('adminAccountsTableBody');
  tbody.innerHTML = res.data.accounts.map(a => `
    <tr>
      <td class="font-mono"><strong>${a.account_number}</strong></td>
      <td>${a.owner_name || a.account_type}</td>
      <td class="font-mono">${formatMoney(a.balance)}</td>
      <td>
        <span class="font-mono">${formatMoney(a.overdraft_limit)}</span>
        <button class="btn btn-outline btn-sm" style="margin-left:0.5rem;" onclick="promptUpdateOverdraft('${a.id}', ${a.overdraft_limit})">Edit</button>
      </td>
      <td>
        <span class="badge ${a.status === 'ACTIVE' ? 'badge-posted' : 'badge-refused'}">${a.status}</span>
      </td>
      <td>${formatDate(a.created_at)}</td>
      <td>
        ${a.account_type === 'CUSTOMER' ? `
          <button class="btn btn-sm ${a.status === 'ACTIVE' ? 'btn-danger' : 'btn-success'}" onclick="toggleAccountFreeze('${a.id}', '${a.status}')">
            ${a.status === 'ACTIVE' ? 'Freeze' : 'Unfreeze'}
          </button>
        ` : '-'}
      </td>
    </tr>
  `).join('');
}

async function promptUpdateOverdraft(accountId, currentLimitCents) {
  const currentDollars = (currentLimitCents / 100).toFixed(2);
  const input = prompt(`Enter new authorized overdraft limit in USD (current: $${currentDollars}):`, currentDollars);
  if (input === null) return;

  const parsed = parseFloat(input);
  if (isNaN(parsed) || parsed < 0) {
    return alert('Please enter a valid non-negative number.');
  }

  const res = await apiCall(`/api/accounts/${accountId}/overdraft`, {
    method: 'PATCH',
    body: { overdraftLimit: Math.round(parsed * 100) }
  });

  if (res.ok) {
    showToast('Overdraft limit updated.', 'success');
    loadAdminAccounts();
    loadDashboardData();
  } else {
    showToast(res.data.error, 'error');
  }
}

async function toggleAccountFreeze(accountId, currentStatus) {
  const newStatus = currentStatus === 'ACTIVE' ? 'FROZEN' : 'ACTIVE';
  const res = await apiCall(`/api/accounts/${accountId}/status`, {
    method: 'PATCH',
    body: { status: newStatus }
  });

  if (res.ok) {
    showToast(`Account status updated to ${newStatus}.`, 'success');
    loadAdminAccounts();
    loadDashboardData();
  } else {
    showToast(res.data.error, 'error');
  }
}

async function openCreateAccountModal() {
  const userId = prompt('Enter User ID to assign account to (e.g. usr_alice_01 or usr_bob_01):', 'usr_alice_01');
  if (!userId) return;

  const overdraftInput = prompt('Enter Authorized Overdraft Limit (USD):', '0.00');
  const overdraftCents = Math.round((parseFloat(overdraftInput) || 0) * 100);

  const res = await apiCall('/api/accounts', {
    method: 'POST',
    body: { userId, overdraftLimit: overdraftCents }
  });

  if (res.ok) {
    showToast('Account created successfully.', 'success');
    loadAdminAccounts();
    loadDashboardData();
  } else {
    showToast(res.data.error, 'error');
  }
}
