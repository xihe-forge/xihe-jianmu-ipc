import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitive } from '../lib/redact.mjs';

// ── 密码脱敏 ──────────────────────────────────────────────────────────────────

test('密码脱敏: password=xxx', () => {
  const result = redactSensitive('password=mysecret123');
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(!result.includes('mysecret123'));
});

test('密码脱敏: passwd:xxx', () => {
  const result = redactSensitive('passwd:abc123');
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(!result.includes('abc123'));
});

test('密码脱敏: pwd=xxx', () => {
  const result = redactSensitive('pwd=qwerty');
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(!result.includes('qwerty'));
});

// ── token脱敏 ─────────────────────────────────────────────────────────────────

test('token脱敏: token=xxx', () => {
  const result = redactSensitive('token=abc123xyz');
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(!result.includes('abc123xyz'));
});

test('token脱敏: secret=xxx', () => {
  const result = redactSensitive('secret=topsecret');
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(!result.includes('topsecret'));
});

// ── API key脱敏 ───────────────────────────────────────────────────────────────

test('API key脱敏: api_key=xxx', () => {
  const result = redactSensitive('api_key=myapikey123');
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(!result.includes('myapikey123'));
});

test('API key脱敏: apikey=xxx', () => {
  const result = redactSensitive('apikey=myapikey456');
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(!result.includes('myapikey456'));
});

// ── Bearer token脱敏 ──────────────────────────────────────────────────────────

test('Bearer token脱敏: Authorization: Bearer xxx', () => {
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
  const result = redactSensitive(`Authorization: Bearer ${token}`);
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(!result.includes(token));
});

// ── GitHub PAT脱敏 ────────────────────────────────────────────────────────────

test('GitHub PAT脱敏: ghp_xxxx', () => {
  const pat = 'ghp_' + 'A'.repeat(36);
  const result = redactSensitive(`My token is ${pat} please keep it safe`);
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(!result.includes(pat));
});

// ── 私钥脱敏 ──────────────────────────────────────────────────────────────────

test('私钥脱敏: RSA PRIVATE KEY block', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK\n-----END RSA PRIVATE KEY-----';
  const result = redactSensitive(key);
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(!result.includes('MIIEpAIBAAK'));
});

test('私钥脱敏: PRIVATE KEY block（无RSA）', () => {
  const key = '-----BEGIN PRIVATE KEY-----\nSomeBase64Data==\n-----END PRIVATE KEY-----';
  const result = redactSensitive(key);
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(!result.includes('SomeBase64Data'));
});

// ── sk-密钥脱敏 ───────────────────────────────────────────────────────────────

test('sk-密钥脱敏: OpenAI风格sk-xxx', () => {
  const key = 'sk-' + 'a'.repeat(32);
  const result = redactSensitive(`Using key: ${key}`);
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(!result.includes(key));
});

// ── 普通文本不变 ──────────────────────────────────────────────────────────────

test('普通文本: 不受影响', () => {
  const text = '你好，今天天气不错，我们去公园吧';
  assert.equal(redactSensitive(text), text);
});

test('普通文本: 英文普通句子不受影响', () => {
  const text = 'Hello world, this is a normal message without secrets';
  assert.equal(redactSensitive(text), text);
});

test('普通文本: 数字和符号不受影响', () => {
  const text = 'Order #12345 total: $99.99';
  assert.equal(redactSensitive(text), text);
});

test('非字符串: 原样返回', () => {
  assert.equal(redactSensitive(null), null);
  assert.equal(redactSensitive(undefined), undefined);
  assert.equal(redactSensitive(42), 42);
});
