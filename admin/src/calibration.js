import {HttpError} from './http.js';

export const CALIBRATION_PUBLICATION_GUARDS = Object.freeze([
  'calibration_never_publish',
  'calibration_never_set_published_head'
]);

export function calibrationMode(env = {}) {
  const value = env.CALIBRATION_MODE;
  if (value == null || value === '' || value === 'no') return false;
  if (value === 'yes') return true;
  throw new Error('CALIBRATION_MODE must be yes or no');
}

export async function verifyCalibrationPublicationGuards(database) {
  if (!database?.prepare) throw new Error('Calibration database is unavailable');
  const placeholders = CALIBRATION_PUBLICATION_GUARDS.map(() => '?').join(',');
  const row = await database.prepare(
    `SELECT count(*) AS guard_count FROM sqlite_master WHERE type='trigger' AND name IN (${placeholders})`
  ).bind(...CALIBRATION_PUBLICATION_GUARDS).first();
  if (Number(row?.guard_count) !== CALIBRATION_PUBLICATION_GUARDS.length) {
    throw new Error('Calibration publication guards are unavailable');
  }
}

export function assertPublicationAllowed(env = {}) {
  if (calibrationMode(env)) {
    throw new HttpError(409, 'Publication is disabled in the isolated calibration environment', {
      code: 'CALIBRATION_NO_PUBLISH'
    });
  }
}
