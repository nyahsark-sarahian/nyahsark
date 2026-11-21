import {privateFetch} from './session.js';

export const PAGE_SIZE = 10;
export const MAX_PHOTOS = 4;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'dataset') Object.assign(node.dataset, value);
    else if (name in node && name !== 'form') node[name] = value;
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  return node;
}

export function replace(node, ...children) {
  node.replaceChildren(...children.filter(Boolean));
  return node;
}

export function announce(text, error = false) {
  const node = document.getElementById('message');
  if (!node) return;
  node.textContent = text;
  node.className = error ? 'message error' : 'message notice';
}

export function money(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) return 'Price not set';
  return new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(cents / 100);
}

export function parsePriceCents(value, {allowBlank = true, positive = false} = {}) {
  const source = String(value ?? '').trim();
  if (!source) {
    if (allowBlank) return null;
    throw new Error('Enter a price.');
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(source)) throw new Error('Use USD with no more than two decimal places.');
  const [whole, fraction = ''] = source.split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 100000000) throw new Error('Price is out of range.');
  if (positive && cents <= 0) throw new Error('Price must be greater than zero.');
  return cents;
}

export function formatPriceInput(cents) {
  return Number.isSafeInteger(cents) && cents >= 0 ? (cents / 100).toFixed(2) : '';
}

function eighthsFromFraction(whole, numerator, denominator) {
  const w = Number(whole || 0), n = Number(numerator || 0), d = Number(denominator || 1);
  if (![w, n, d].every(Number.isSafeInteger) || w < 0 || n < 0 || d < 1 || 8 % d !== 0 || n >= d) {
    throw new Error('Use a whole number and a fraction in eighths, quarters, or halves.');
  }
  return w * 8 + n * (8 / d);
}

export function parseEighths(value, {allowBlank = true} = {}) {
  const source = String(value ?? '').trim().replace(/\s+in(?:ches)?\.?$/i, '');
  if (!source) {
    if (allowBlank) return null;
    throw new Error('Enter a measurement.');
  }
  let eighths;
  let match = /^(\d+)\s+(\d+)\/(\d+)$/.exec(source);
  if (match) eighths = eighthsFromFraction(match[1], match[2], match[3]);
  else if ((match = /^(\d+)\/(\d+)$/.exec(source))) eighths = eighthsFromFraction(0, match[1], match[2]);
  else {
    if (!/^\d+(?:\.\d+)?$/.test(source)) throw new Error('Use a value such as 12 3/8 or 12.375.');
    const scaled = Number(source) * 8;
    if (!Number.isFinite(scaled) || Math.abs(scaled - Math.round(scaled)) > 1e-9) {
      throw new Error('Measurements must be in exact one-eighth-inch steps.');
    }
    eighths = Math.round(scaled);
  }
  if (!Number.isSafeInteger(eighths) || eighths <= 0 || eighths > 80000) throw new Error('Measurement must be positive and within range.');
  return eighths;
}

export function formatEighths(eighths) {
  if (!Number.isSafeInteger(eighths) || eighths <= 0) return '';
  const whole = Math.floor(eighths / 8), remainder = eighths % 8;
  if (!remainder) return `${whole} in`;
  const divisor = remainder % 4 === 0 ? 4 : remainder % 2 === 0 ? 2 : 1;
  const fraction = `${remainder / divisor}/${8 / divisor}`;
  return `${whole ? `${whole} ` : ''}${fraction} in`;
}

export function stepEighths(current, direction) {
  if (![1, -1].includes(direction)) throw new Error('Invalid measurement step.');
  if (current === null || current === undefined || current === '') return direction > 0 ? 1 : null;
  const value = Number(current) + direction;
  return Number.isSafeInteger(value) && value > 0 ? value : Number(current);
}

export function parseWhole(value, {allowBlank = true, min = 0, max = 1000000, label = 'Value'} = {}) {
  const source = String(value ?? '').trim();
  if (!source) {
    if (allowBlank) return null;
    throw new Error(`${label} is required.`);
  }
  const number = Number(source);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return number;
}

export async function api(path, options = {}) {
  const response = await privateFetch(path, options);
  const type = response.headers.get('content-type') || '';
  let data = null;
  if (type.includes('application/json')) data = await response.json();
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status}). No changes were confirmed.`);
    error.status = response.status;
    error.fieldErrors = data?.field_errors || null;
    error.details = data;
    throw error;
  }
  if (data === null) throw new Error('The administrator API returned an unexpected response.');
  return data;
}

export function sendJSON(path, method, body) {
  return api(path, {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
}

export function uuid() {
  return crypto.randomUUID();
}

export function debounce(fn, delay = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function safeAdminMedia(value) {
  if (typeof value !== 'string') return null;
  return /^\/api\/admin\/media\/[A-Za-z0-9_-]{1,100}\/(?:master|display|thumb)$/.test(value) ? value : null;
}

export function statusLabel(state) {
  return ({
    draft: 'Draft',
    published: 'Published',
    published_changes: 'Published with unpublished changes',
    archived: 'Archived',
  })[state] || 'Draft';
}

