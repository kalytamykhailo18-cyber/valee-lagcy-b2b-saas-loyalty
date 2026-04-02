const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

async function request(path: string, options: RequestInit = {}) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  const data = await res.json();
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}

export const api = {
  // Consumer Auth
  requestOTP: (phoneNumber: string, tenantSlug: string) =>
    request('/api/consumer/auth/request-otp', { method: 'POST', body: JSON.stringify({ phoneNumber, tenantSlug }) }),

  verifyOTP: (phoneNumber: string, otp: string, tenantSlug: string) =>
    request('/api/consumer/auth/verify-otp', { method: 'POST', body: JSON.stringify({ phoneNumber, otp, tenantSlug }) }),

  // Consumer Data
  getBalance: () => request('/api/consumer/balance'),
  getHistory: (limit = 50, offset = 0) => request(`/api/consumer/history?limit=${limit}&offset=${offset}`),
  getAccount: () => request('/api/consumer/account'),
  getCatalog: (limit = 20, offset = 0) => request(`/api/consumer/catalog?limit=${limit}&offset=${offset}`),

  // Consumer Actions
  validateInvoice: (data: any) =>
    request('/api/consumer/validate-invoice', { method: 'POST', body: JSON.stringify(data) }),
  redeemProduct: (productId: string, assetTypeId: string) =>
    request('/api/consumer/redeem', { method: 'POST', body: JSON.stringify({ productId, assetTypeId }) }),

  // Merchant Auth
  merchantLogin: (email: string, password: string, tenantSlug: string) =>
    request('/api/merchant/auth/login', { method: 'POST', body: JSON.stringify({ email, password, tenantSlug }) }),

  // Merchant Data
  uploadCSV: (csvContent: string) =>
    request('/api/merchant/csv-upload', { method: 'POST', body: JSON.stringify({ csvContent }) }),
  getProducts: () => request('/api/merchant/products'),
  createProduct: (data: any) =>
    request('/api/merchant/products', { method: 'POST', body: JSON.stringify(data) }),
  updateProduct: (id: string, data: any) =>
    request(`/api/merchant/products/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  toggleProduct: (id: string) =>
    request(`/api/merchant/products/${id}/toggle`, { method: 'PATCH' }),
  scanRedemption: (token: string) =>
    request('/api/merchant/scan-redemption', { method: 'POST', body: JSON.stringify({ token }) }),
  lookupCustomer: (phoneNumber: string) =>
    request(`/api/merchant/customer-lookup/${encodeURIComponent(phoneNumber)}`),
  upgradeIdentity: (phoneNumber: string, cedula: string) =>
    request('/api/merchant/identity-upgrade', { method: 'POST', body: JSON.stringify({ phoneNumber, cedula }) }),
  getAnalytics: () => request('/api/merchant/analytics'),
  getRecurrenceRules: () => request('/api/merchant/recurrence-rules'),
  createRecurrenceRule: (data: any) =>
    request('/api/merchant/recurrence-rules', { method: 'POST', body: JSON.stringify(data) }),
  toggleRecurrenceRule: (id: string) =>
    request(`/api/merchant/recurrence-rules/${id}/toggle`, { method: 'PATCH' }),
  getRecurrenceNotifications: (limit = 50, offset = 0) =>
    request(`/api/merchant/recurrence-notifications?limit=${limit}&offset=${offset}`),
  getMultiplier: () => request('/api/merchant/multiplier'),
  setMultiplier: (multiplier: string, assetTypeId: string) =>
    request('/api/merchant/multiplier', { method: 'PUT', body: JSON.stringify({ multiplier, assetTypeId }) }),
  createStaff: (data: any) =>
    request('/api/merchant/staff', { method: 'POST', body: JSON.stringify(data) }),

  // Admin Auth
  adminLogin: (email: string, password: string) =>
    request('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  // Admin Data
  getTenants: () => request('/api/admin/tenants'),
  createTenant: (data: any) =>
    request('/api/admin/tenants', { method: 'POST', body: JSON.stringify(data) }),
  deactivateTenant: (id: string) =>
    request(`/api/admin/tenants/${id}/deactivate`, { method: 'PATCH' }),
  getLedger: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request(`/api/admin/ledger${qs}`);
  },
  verifyHashChain: (tenantId?: string) =>
    request('/api/admin/verify-hash-chain', { method: 'POST', body: JSON.stringify({ tenantId }) }),
  manualAdjustment: (data: any) =>
    request('/api/admin/manual-adjustment', { method: 'POST', body: JSON.stringify(data) }),
  getMetrics: () => request('/api/admin/metrics'),
};
