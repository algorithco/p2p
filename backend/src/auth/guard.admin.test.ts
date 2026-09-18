import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock config before importing guard
vi.mock('../config', () => ({
  config: {
    apiKey: 'generic_service_key_32_chars_12345678',
    adminApiKey: 'admin_secret_key_32_chars_ABCDEFGH',
    adminTelegramIds: [111, 222],
    botToken: 'test',
    allowDevAuth: false,
  },
}));

import { requireAdmin } from './guard';

function mockReq(headers: Record<string, string> = {}, user?: { id: number }): Request {
  return {
    headers,
    user,
  } as unknown as Request;
}

function mockRes(): Response & { statusCode: number; body: unknown } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: unknown };
}

describe('P0-2 requireAdmin with scoped keys', () => {
  it('rejects generic API_KEY alone (cannot release/refund)', () => {
    const req = mockReq({ 'x-api-key': 'generic_service_key_32_chars_12345678' });
    const res = mockRes();
    const next = vi.fn();
    requireAdmin(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows ADMIN_API_KEY via x-admin-api-key', () => {
    const req = mockReq({ 'x-admin-api-key': 'admin_secret_key_32_chars_ABCDEFGH' });
    const res = mockRes();
    const next = vi.fn();
    requireAdmin(req, res, next as NextFunction);
    expect(next).toHaveBeenCalled();
  });

  it('rejects ADMIN_API_KEY via x-api-key header (distinct header only, see guard.ts adminApiKeyMatches)', () => {
    const req = mockReq({ 'x-api-key': 'admin_secret_key_32_chars_ABCDEFGH' });
    const res = mockRes();
    const next = vi.fn();
    requireAdmin(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows verified Telegram admin', () => {
    const req = mockReq({}, { id: 111 });
    const res = mockRes();
    const next = vi.fn();
    requireAdmin(req, res, next as NextFunction);
    expect(next).toHaveBeenCalled();
  });

  it('rejects non-admin Telegram user', () => {
    const req = mockReq({}, { id: 999 });
    const res = mockRes();
    const next = vi.fn();
    requireAdmin(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
  });

  it('rejects anonymous', () => {
    const req = mockReq({});
    const res = mockRes();
    const next = vi.fn();
    requireAdmin(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
  });
});
