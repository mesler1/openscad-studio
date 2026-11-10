import type { PrintRequestInfo } from '../services/agentBridge';

/** 70 -> "1h 10m", 11.67 -> "11m 40s". */
export function formatDuration(minutes: number): string {
  const total = Math.round(minutes * 60);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Only a complete, well-formed request counts; anything else is "no print request". */
export function validPrintRequest(value: unknown): PrintRequestInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Partial<PrintRequestInfo>;
  const e = r.estimate;
  if (
    typeof r.revisionId !== 'string' ||
    r.revisionId === '' ||
    !isNum(r.revisionNumber) ||
    typeof r.fileName !== 'string' ||
    typeof r.requestedAt !== 'string' ||
    typeof e !== 'object' ||
    e === null ||
    !isNum(e.printTimeMinutes) ||
    !isNum(e.filamentGrams) ||
    !isNum(e.layerCount) ||
    !isNum(e.nozzleTempC) ||
    !isNum(e.bedTempC)
  ) {
    return null;
  }
  return r as PrintRequestInfo;
}
