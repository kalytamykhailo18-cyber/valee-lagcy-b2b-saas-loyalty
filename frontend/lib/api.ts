const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

let isRefreshing = false;

async function tryRefreshToken(): Promise<boolean> {
  if (isRefreshing) return false;
  const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;
  if (!refreshToken) return false;

  isRefreshing = true;
  try {
    // Try consumer refresh first, then merchant refresh
    for (const endpoint of ['/api/consumer/auth/refresh', '/api/merchant/auth/refresh']) {
      try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) continue;
        const data = await res.json();
        if (data.accessToken) {
          localStorage.setItem('accessToken', data.accessToken);
          if (data.refreshToken) localStorage.setItem('refreshToken', data.refreshToken);
          return true;
        }
      } catch { continue; }
    }
    return false;
  } finally {
    isRefreshing = false;
  }
}

function redirectToLogin() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  const path = window.location.pathname;
  if (path.startsWith('/merchant')) {
    localStorage.removeItem('staffRole');
    localStorage.removeItem('staffName');
    localStorage.removeItem('tenantName');
    localStorage.removeItem('tenantLogoUrl');
    if (path !== '/merchant/login') window.location.href = '/merchant/login';
  } else if (path.startsWith('/admin')) {
    if (path !== '/admin/login') window.location.href = '/admin/login';
  } else {
    // Consumer routes — main page has its own login screen
    if (path.startsWith('/consumer') || path.startsWith('/catalog') || path.startsWith('/scan') || path.startsWith('/my-codes')) {
      window.location.href = '/consumer';
    }
  }
}

async function request(path: string, options: RequestInit = {}) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;

  // Only set Content-Type if there's a body. Fastify rejects requests with
  // Content-Type: application/json but empty body.
  const baseHeaders: Record<string, string> = {};
  if (options.body) baseHeaders['Content-Type'] = 'application/json';
  if (token) baseHeaders['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...baseHeaders, ...options.headers },
  });

  // Defensive JSON parse: when the upstream is briefly down or nginx returns
  // an HTML error page, the raw "Unexpected token '<'" is useless to the user.
  // Parse once, catch HTML, and bubble a friendly error instead.
  async function safeJson(r: Response): Promise<any> {
    const text = await r.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch {
      const snippet = text.trim().slice(0, 60);
      throw { status: r.status, error: `El servidor respondio con un formato inesperado (${r.status}). Intenta de nuevo.`, rawPreview: snippet };
    }
  }

  // Auto-refresh on 401: try refreshing the token and retry ONCE
  if (res.status === 401 && !path.includes('/auth/')) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      const newToken = localStorage.getItem('accessToken');
      const retryHeaders: Record<string, string> = {};
      if (options.body) retryHeaders['Content-Type'] = 'application/json';
      if (newToken) retryHeaders['Authorization'] = `Bearer ${newToken}`;
      const retryRes = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: { ...retryHeaders, ...options.headers },
      });
      const retryData = await safeJson(retryRes);
      if (!retryRes.ok) {
        if (retryRes.status === 401) redirectToLogin();
        throw { status: retryRes.status, ...retryData };
      }
      return retryData;
    } else {
      redirectToLogin();
    }
  }

  const data = await safeJson(res);
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}

export const api = {
  // Consumer Auth
  requestOTP: (phoneNumber: string, tenantSlug?: string) =>
    request('/api/consumer/auth/request-otp', { method: 'POST', body: JSON.stringify({ phoneNumber, tenantSlug }) }),

  verifyOTP: (phoneNumber: string, otp: string, tenantSlug?: string) =>
    request('/api/consumer/auth/verify-otp', { method: 'POST', body: JSON.stringify({ phoneNumber, otp, tenantSlug }) }),

  selectMerchant: (tenantSlug: string) =>
    request('/api/consumer/auth/select-merchant', { method: 'POST', body: JSON.stringify({ tenantSlug }) }),

  // Consumer Data
  getBalance: () => request('/api/consumer/balance'),
  getHistory: (limit = 50, offset = 0) => request(`/api/consumer/history?limit=${limit}&offset=${offset}`),
  getAccount: () => request('/api/consumer/account'),
  getCatalog: (limit = 20, offset = 0) => request(`/api/consumer/catalog?limit=${limit}&offset=${offset}`),

  // Consumer Actions
  validateInvoice: (data: any) =>
    request('/api/consumer/validate-invoice', { method: 'POST', body: JSON.stringify(data) }),

  /** Upload an actual invoice image for OCR + validation (multipart/form-data) */
  uploadInvoiceImage: async (file: File, assetTypeId: string, opts?: { latitude?: string; longitude?: string; deviceId?: string; branchId?: string }) => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    const form = new FormData();
    form.append('invoice', file);
    form.append('assetTypeId', assetTypeId);
    if (opts?.latitude) form.append('latitude', opts.latitude);
    if (opts?.longitude) form.append('longitude', opts.longitude);
    if (opts?.deviceId) form.append('deviceId', opts.deviceId);
    if (opts?.branchId) form.append('branchId', opts.branchId);

    const res = await fetch(`${API_BASE}/api/consumer/validate-invoice`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw { status: res.status, ...data };
    return data;
  },
  redeemProduct: (productId: string, assetTypeId: string) =>
    request('/api/consumer/redeem', { method: 'POST', body: JSON.stringify({ productId, assetTypeId }) }),
  getActiveRedemptions: () => request('/api/consumer/active-redemptions'),

  // Referrals — consumer invites friends, earns tenant-configured bonus on friend's first claim
  getReferralQr: () => request('/api/consumer/referral-qr'),
  getReferrals: () => request('/api/consumer/referrals'),
  getConsumerBranches: () => request('/api/consumer/branches'),

  // Consumer image upload (for dispute screenshots)
  uploadConsumerImage: async (file: File): Promise<{ success: boolean; url: string }> => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_BASE}/api/consumer/upload-image`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw { status: res.status, ...data };
    return data;
  },

  // Merchant Auth
  merchantLogin: (email: string, password: string, tenantSlug?: string) =>
    request('/api/merchant/auth/login', { method: 'POST', body: JSON.stringify({ email, password, ...(tenantSlug ? { tenantSlug } : {}) }) }),

  // Merchant Data
  uploadProductImage: async (file: File): Promise<{ success: boolean; url: string }> => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_BASE}/api/merchant/upload-image`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw { status: res.status, ...data };
    return data;
  },
  uploadCSV: (csvContent: string) =>
    request('/api/merchant/csv-upload', { method: 'POST', body: JSON.stringify({ csvContent }) }),
  getInvoices: (params: { status?: string; batchId?: string; search?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams()
    if (params.status) qs.set('status', params.status)
    if (params.batchId) qs.set('batchId', params.batchId)
    if (params.search) qs.set('search', params.search)
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.offset != null) qs.set('offset', String(params.offset))
    return request(`/api/merchant/invoices${qs.toString() ? `?${qs}` : ''}`)
  },
  getProducts: () => request('/api/merchant/products'),
  createProduct: (data: any) =>
    request('/api/merchant/products', { method: 'POST', body: JSON.stringify(data) }),
  updateProduct: (id: string, data: any) =>
    request(`/api/merchant/products/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  toggleProduct: (id: string) =>
    request(`/api/merchant/products/${id}/toggle`, { method: 'PATCH' }),
  scanRedemption: (token: string) =>
    request('/api/merchant/scan-redemption', { method: 'POST', body: JSON.stringify({ token }) }),
  merchantSignup: (data: {
    businessName: string;
    slug?: string;
    ownerName: string;
    ownerEmail: string;
    password: string;
    rif?: string;
    contactPhone?: string;
    address?: string;
    description?: string;
  }) =>
    request('/api/merchant/signup', { method: 'POST', body: JSON.stringify(data) }),
  getCustomers: (params?: { limit?: number; offset?: number; search?: string }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    if (params?.search) qs.set('search', params.search);
    return request(`/api/merchant/customers?${qs}`);
  },
  lookupCustomer: (phoneNumber: string) =>
    request(`/api/merchant/customer-lookup/${encodeURIComponent(phoneNumber)}`),
  upgradeIdentity: (phoneNumber: string, cedula: string, force?: boolean) =>
    request('/api/merchant/identity-upgrade', { method: 'POST', body: JSON.stringify({ phoneNumber, cedula, force }) }),
  updateCustomer: (id: string, data: { displayName?: string | null; cedula?: string | null }) =>
    request(`/api/merchant/customers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getAllAccounts: () => request('/api/consumer/all-accounts'),
  getAffiliatedMerchants: () => request('/api/consumer/affiliated-merchants'),
  initiateDualScan: (amount: string, branchId?: string) =>
    request('/api/merchant/dual-scan/initiate', { method: 'POST', body: JSON.stringify({ amount, branchId }) }),
  confirmDualScan: (token: string) =>
    request('/api/consumer/dual-scan/confirm', { method: 'POST', body: JSON.stringify({ token }) }),
  getPlanUsage: () => request('/api/merchant/plan-usage'),
  getMerchantSettings: () => request('/api/merchant/settings'),
  updateMerchantSettings: (data: {
    welcomeBonusAmount?: number;
    referralBonusAmount?: number;
    rif?: string;
    preferredExchangeSource?: string | null;
    referenceCurrency?: string;
    trustLevel?: string;
    logoUrl?: string | null;
    name?: string;
    address?: string | null;
    contactPhone?: string | null;
    contactEmail?: string | null;
    website?: string | null;
    description?: string | null;
    instagramHandle?: string | null;
  }) =>
    request('/api/merchant/settings', { method: 'PUT', body: JSON.stringify(data) }),
  getExchangeRates: () => request('/api/merchant/exchange-rates'),
  getAnalytics: () => request('/api/merchant/analytics'),
  getMerchantMetrics: (branchId?: string) => {
    const qs = branchId ? `?branchId=${branchId}` : '';
    return request(`/api/merchant/metrics${qs}`);
  },
  getProductPerformance: () => request('/api/merchant/product-performance'),
  getTransactions: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request(`/api/merchant/transactions${qs}`);
  },
  getRedemptionStatus: (tokenId: string) =>
    request(`/api/consumer/redemption-status/${tokenId}`),
  cancelRedemption: (tokenId: string) =>
    request(`/api/consumer/redemption/${tokenId}/cancel`, { method: 'POST' }),
  getRecurrenceRules: () => request('/api/merchant/recurrence-rules'),
  createRecurrenceRule: (data: any) =>
    request('/api/merchant/recurrence-rules', { method: 'POST', body: JSON.stringify(data) }),
  toggleRecurrenceRule: (id: string) =>
    request(`/api/merchant/recurrence-rules/${id}/toggle`, { method: 'PATCH' }),
  updateRecurrenceRule: (id: string, data: any) =>
    request(`/api/merchant/recurrence-rules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteRecurrenceRule: (id: string) =>
    request(`/api/merchant/recurrence-rules/${id}`, { method: 'DELETE' }),
  getRecurrenceEligible: (id: string) =>
    request(`/api/merchant/recurrence-rules/${id}/eligible`),
  getRecurrenceNotifications: (limit = 50, offset = 0) =>
    request(`/api/merchant/recurrence-notifications?limit=${limit}&offset=${offset}`),
  getMultiplier: () => request('/api/merchant/multiplier'),
  setMultiplier: (multiplier: string, assetTypeId: string) =>
    request('/api/merchant/multiplier', { method: 'PUT', body: JSON.stringify({ multiplier, assetTypeId }) }),
  createStaff: (data: any) =>
    request('/api/merchant/staff', { method: 'POST', body: JSON.stringify(data) }),
  listStaff: () => request('/api/merchant/staff'),
  deactivateStaff: (id: string) =>
    request(`/api/merchant/staff/${id}/deactivate`, { method: 'PATCH' }),
  generateStaffQr: (id: string) =>
    request(`/api/merchant/staff/${id}/qr`, { method: 'POST' }),
  getStaffPerformance: (days = 30) =>
    request(`/api/merchant/staff-performance?days=${days}`),

  // Branches
  getBranches: () => request('/api/merchant/branches'),
  createBranch: (data: { name: string; address?: string; latitude?: number; longitude?: number }) =>
    request('/api/merchant/branches', { method: 'POST', body: JSON.stringify(data) }),
  toggleBranch: (id: string) =>
    request(`/api/merchant/branches/${id}/toggle`, { method: 'PATCH' }),
  updateBranch: (id: string, data: { name?: string; address?: string | null; latitude?: number | null; longitude?: number | null }) =>
    request(`/api/merchant/branches/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteBranch: (id: string) =>
    request(`/api/merchant/branches/${id}`, { method: 'DELETE' }),
  generateBranchQR: (id: string, reason?: string) =>
    request(`/api/merchant/branches/${id}/generate-qr`, {
      method: 'POST',
      ...(reason ? { body: JSON.stringify({ reason }) } : {}),
    }),

  // Disputes (merchant)
  getDisputes: (status?: string) =>
    request(`/api/merchant/disputes${status ? `?status=${status}` : ''}`),
  resolveDispute: (id: string, data: { action: string; reason: string; adjustmentAmount?: string; assetTypeId?: string }) =>
    request(`/api/merchant/disputes/${id}/resolve`, { method: 'POST', body: JSON.stringify(data) }),

  // Disputes (consumer)
  submitDispute: (data: { description: string; screenshotUrl?: string }) =>
    request('/api/consumer/disputes', { method: 'POST', body: JSON.stringify(data) }),

  // Admin Auth
  adminLogin: (email: string, password: string) =>
    request('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  // Admin Data
  getTenants: () => request('/api/admin/tenants'),
  createTenant: (data: any) =>
    request('/api/admin/tenants', { method: 'POST', body: JSON.stringify(data) }),
  getLedger: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request(`/api/admin/ledger${qs}`);
  },
  verifyHashChain: (tenantId?: string) =>
    request('/api/admin/verify-hash-chain', { method: 'POST', body: JSON.stringify({ tenantId }) }),
  manualAdjustment: (data: any) =>
    request('/api/admin/manual-adjustment', { method: 'POST', body: JSON.stringify(data) }),
  getMetrics: () => request('/api/admin/metrics'),
  getExecDashboard: (idleDays = 14, weeks = 8) =>
    request(`/api/admin/exec-dashboard?idleDays=${idleDays}&weeks=${weeks}`),
  getPlatformHealth: (windowHours = 24) =>
    request(`/api/admin/platform-health?windowHours=${windowHours}`),
  forceLogoutAccount: (accountId: string, reason: string) =>
    request(`/api/admin/accounts/${accountId}/force-logout`, { method: 'POST', body: JSON.stringify({ reason }) }),
  forceLogoutStaff: (staffId: string, reason: string) =>
    request(`/api/admin/staff/${staffId}/force-logout`, { method: 'POST', body: JSON.stringify({ reason }) }),
  searchAccounts: (phone: string) =>
    request(`/api/admin/accounts/search?phone=${encodeURIComponent(phone)}`),
  searchStaff: (email: string) =>
    request(`/api/admin/staff/search?email=${encodeURIComponent(email)}`),
  getAuditLog: (params: { tenantId?: string; actionType?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.tenantId)   qs.set('tenantId', params.tenantId);
    if (params.actionType) qs.set('actionType', params.actionType);
    if (params.limit != null)  qs.set('limit',  String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    const q = qs.toString();
    return request(`/api/admin/audit-log${q ? `?${q}` : ''}`);
  },
  deactivateTenant: (tenantId: string, reason: string) =>
    request(`/api/admin/tenants/${tenantId}/deactivate`, { method: 'PATCH', body: JSON.stringify({ reason }) }),
  reactivateTenant: (tenantId: string, reason: string) =>
    request(`/api/admin/tenants/${tenantId}/reactivate`, { method: 'PATCH', body: JSON.stringify({ reason }) }),
};
