#!/usr/bin/env npx tsx
/**
 * GTA VI Twitch CCU Forecast - Launch Day Hourly Viewers
 * 
 * Forecasts 23 hours (hours 2-24) of GTA VI Twitch concurrent viewers
 * on launch day (2026-11-19) given hour 1's observed print.
 * 
 * Approach:
 * 1. Filter comparables to rolling-midnight launches (peak hour 15-22, peak/h0 > 3)
 * 2. Exclude extreme outliers (peak/h0 > 100)
 * 3. Normalize each curve by its launch-day hour-0 value (competition hour 1)
 * 4. Compute median shape and quantile bands across rolling comparables
 * 5. Scale median shape by observed hour-1 to get forecast
 * 6. Output 5 quantiles (0.05, 0.25, 0.5, 0.75, 0.95) for hours 2-24
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface HourlyPoint {
  from: string;
  viewers: number;
  channels: number;
  reads: number;
}

interface Comparable {
  day_start: string;
  hourly: HourlyPoint[];
}

interface InputData {
  checkpoint: string;
  known: Array<{ hour: number; viewers: number; from: string; until: string; channels: number; reads: number }>;
  history_hourly: HourlyPoint[];
  comparables: Comparable[];
  game: string;
  id: string;
  day_start: string;
  notes: string;
  levels: number[];
  forecast: Array<{ hour: number }>;
}

interface OutputData {
  hours: Array<{ hour: number; q: [number, number, number, number, number] }>;
}

// Parse ISO timestamp to Date
function parseDate(s: string): Date {
  return new Date(s);
}

// Get hour index relative to day_start (0-23 for launch day)
function hourIndex(dayStart: string, from: string): number {
  const start = parseDate(dayStart).getTime();
  const t = parseDate(from).getTime();
  return Math.floor((t - start) / 3_600_000);
}

// Extract 24-hour launch-day curve from a comparable (indices 0-23 = launch day hours 0-23)
function extractLaunchCurve(comp: Comparable): number[] {
  const curve = new Array(24).fill(NaN);
  for (const pt of comp.hourly) {
    const h = hourIndex(comp.day_start, pt.from);
    if (h >= 0 && h < 24) {
      curve[h] = pt.viewers;
    }
  }
  return curve;
}

// Check if a comparable is a rolling-midnight launch
// Competition hour 1 = launch day hour 0 (index 0)
// Competition hour 24 = launch day hour 23 (index 23)
// Rolling midnight peaks at competition hours 16-23 = launch day hours 15-22
function isRollingMidnight(curve: number[]): boolean {
  const valid = curve.filter(isFinite);
  if (valid.length < 12) return false;
  const h0 = curve[0];  // Launch day hour 0 = competition hour 1
  if (!isFinite(h0) || h0 <= 0) return false;
  const peak = Math.max(...valid);
  const peakHour = curve.indexOf(peak);  // 0-23 = launch day hour
  const ratio = peak / h0;
  // Rolling midnight: peak at launch day hours 15-22 (comp hours 16-23), significant growth from hour 0
  return peakHour >= 15 && peakHour <= 22 && ratio > 3 && ratio < 100;
}

// Normalize curve by launch day hour 0 (competition hour 1) value
function normalizeByHour0(curve: number[]): number[] | null {
  const h0 = curve[0];
  if (!isFinite(h0) || h0 <= 0) return null;
  return curve.map(v => isFinite(v) && v > 0 ? v / h0 : NaN);
}

// Compute quantile from array (filters NaN, sorts)
function quantile(arr: number[], q: number): number {
  const valid = arr.filter(isFinite).sort((a, b) => a - b);
  if (valid.length === 0) return NaN;
  const idx = (valid.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return valid[lo];
  return valid[lo] + (valid[hi] - valid[lo]) * (idx - lo);
}

// Winsorize extreme values (clip to 1st/99th percentile of finite values)
function winsorize(arr: number[]): number[] {
  const valid = arr.filter(isFinite).sort((a, b) => a - b);
  if (valid.length < 4) return arr.filter(isFinite);
  const p1 = valid[Math.floor((valid.length - 1) * 0.01)];
  const p99 = valid[Math.floor((valid.length - 1) * 0.99)];
  return arr.filter(isFinite).map(v => Math.max(p1, Math.min(p99, v)));
}

// Main forecasting function for a single case
function forecastCase(input: InputData): Array<{ hour: number; q: [number, number, number, number, number] }> {
  // Known value is for competition hour 1 = launch day hour 0
  const hour1Known = input.known.find(k => k.hour === 1)?.viewers ?? 0;
  if (hour1Known <= 0) {
    throw new Error("No valid hour-1 known value");
  }

  // Extract and classify launch-day curves from comparables
  const rollingCurves: number[][] = [];
  const globalCurves: number[][] = [];
  
  for (const comp of input.comparables) {
    const curve = extractLaunchCurve(comp);
    const valid = curve.filter(isFinite);
    if (valid.length < 12) continue;
    
    const norm = normalizeByHour0(curve);
    if (!norm) continue;
    
    if (isRollingMidnight(curve)) {
      rollingCurves.push(norm);
    } else {
      globalCurves.push(norm);
    }
  }

  // Use rolling-midnight curves as primary, fallback to all if insufficient
  const primaryCurves = rollingCurves.length >= 3 ? rollingCurves : [...rollingCurves, ...globalCurves];
  
  if (primaryCurves.length === 0) {
    throw new Error("No valid comparable curves");
  }

  // Compute median shape and quantile bands for each launch day hour (0-23)
  const medianShape = new Array(24).fill(NaN);
  const q05Shape = new Array(24).fill(NaN);
  const q25Shape = new Array(24).fill(NaN);
  const q75Shape = new Array(24).fill(NaN);
  const q95Shape = new Array(24).fill(NaN);

  for (let h = 0; h < 24; h++) {
    const vals = primaryCurves.map(c => c[h]);
    const w = winsorize(vals);
    if (w.length >= 3) {
      medianShape[h] = quantile(w, 0.5);
      q05Shape[h] = quantile(w, 0.05);
      q25Shape[h] = quantile(w, 0.25);
      q75Shape[h] = quantile(w, 0.75);
      q95Shape[h] = quantile(w, 0.95);
    }
  }

  // Hour 0 (competition hour 1) should be exactly 1.0 after normalization - enforce it
  medianShape[0] = 1.0;
  q05Shape[0] = q25Shape[0] = q75Shape[0] = q95Shape[0] = 1.0;

  // Shape-aware interpolation for missing hours
  for (let h = 0; h < 24; h++) {
    if (!isFinite(medianShape[h])) {
      // Find nearest valid neighbors
      let left = h - 1;
      while (left >= 0 && !isFinite(medianShape[left])) left--;
      let right = h + 1;
      while (right < 24 && !isFinite(medianShape[right])) right++;
      
      if (left >= 0 && right < 24) {
        const t = (h - left) / (right - left);
        medianShape[h] = medianShape[left] + t * (medianShape[right] - medianShape[left]);
        const q05L = isFinite(q05Shape[left]) ? q05Shape[left] : medianShape[left];
        const q05R = isFinite(q05Shape[right]) ? q05Shape[right] : medianShape[right];
        q05Shape[h] = q05L + t * (q05R - q05L);
        const q25L = isFinite(q25Shape[left]) ? q25Shape[left] : medianShape[left];
        const q25R = isFinite(q25Shape[right]) ? q25Shape[right] : medianShape[right];
        q25Shape[h] = q25L + t * (q25R - q25L);
        const q75L = isFinite(q75Shape[left]) ? q75Shape[left] : medianShape[left];
        const q75R = isFinite(q75Shape[right]) ? q75Shape[right] : medianShape[right];
        q75Shape[h] = q75L + t * (q75R - q75L);
        const q95L = isFinite(q95Shape[left]) ? q95Shape[left] : medianShape[left];
        const q95R = isFinite(q95Shape[right]) ? q95Shape[right] : medianShape[right];
        q95Shape[h] = q95L + t * (q95R - q95L);
      } else if (left >= 0) {
        medianShape[h] = medianShape[left];
        q05Shape[h] = q05Shape[left];
        q25Shape[h] = q25Shape[left];
        q75Shape[h] = q75Shape[left];
        q95Shape[h] = q95Shape[left];
      } else if (right < 24) {
        medianShape[h] = medianShape[right];
        q05Shape[h] = q05Shape[right];
        q25Shape[h] = q25Shape[right];
        q75Shape[h] = q75Shape[right];
        q95Shape[h] = q95Shape[right];
      }
    }
  }

  // Apply shape constraints for rolling-midnight pattern
  // Find peak hour in median shape (launch day hour, 0-23)
  let peakHour = 0;
  let peakVal = medianShape[0];
  for (let h = 1; h < 24; h++) {
    if (isFinite(medianShape[h]) && medianShape[h] > peakVal) {
      peakVal = medianShape[h];
      peakHour = h;
    }
  }

  // Enforce monotonic increase before peak, monotonic decrease after
  for (let h = 1; h <= peakHour; h++) {
    if (isFinite(medianShape[h]) && isFinite(medianShape[h-1]) && medianShape[h] < medianShape[h-1]) {
      medianShape[h] = medianShape[h-1];
    }
  }
  for (let h = peakHour + 1; h < 24; h++) {
    if (isFinite(medianShape[h]) && isFinite(medianShape[h-1]) && medianShape[h] > medianShape[h-1]) {
      medianShape[h] = medianShape[h-1];
    }
  }
  // Also enforce on quantiles
  for (let h = 1; h <= peakHour; h++) {
    [q05Shape, q25Shape, q75Shape, q95Shape].forEach(q => {
      if (isFinite(q[h]) && isFinite(q[h-1]) && q[h] < q[h-1]) q[h] = q[h-1];
    });
  }
  for (let h = peakHour + 1; h < 24; h++) {
    [q05Shape, q25Shape, q75Shape, q95Shape].forEach(q => {
      if (isFinite(q[h]) && isFinite(q[h-1]) && q[h] > q[h-1]) q[h] = q[h-1];
    });
  }

  // Scale shapes by known hour-1 value to get absolute forecasts
  // Competition hour h (2..24) = launch day hour (h-1) = index (h-1)
  const forecasts: Array<{ hour: number; q: [number, number, number, number, number] }> = [];
  for (const { hour } of input.forecast) {  // Hours 2-24 in order
    const idx = hour - 1;  // Launch day hour index (1-23)
    const scale = hour1Known;
    
    const baseMedian = isFinite(medianShape[idx]) ? medianShape[idx] : 1.0;
    const baseQ05 = isFinite(q05Shape[idx]) ? q05Shape[idx] : baseMedian;
    const baseQ25 = isFinite(q25Shape[idx]) ? q25Shape[idx] : baseMedian;
    const baseQ75 = isFinite(q75Shape[idx]) ? q75Shape[idx] : baseMedian;
    const baseQ95 = isFinite(q95Shape[idx]) ? q95Shape[idx] : baseMedian;
    
    const q05 = Math.max(1, Math.round(baseQ05 * scale));
    const q25 = Math.max(1, Math.round(baseQ25 * scale));
    const q50 = Math.max(1, Math.round(baseMedian * scale));
    const q75 = Math.max(1, Math.round(baseQ75 * scale));
    const q95 = Math.max(1, Math.round(baseQ95 * scale));

    // Ensure quantile ordering (non-decreasing)
    const ordered = [q05, q25, q50, q75, q95].sort((a, b) => a - b);
    
    forecasts.push({
      hour,
      q: [ordered[0], ordered[1], ordered[2], ordered[3], ordered[4]],
    });
  }

  return forecasts;
}

// Main entry point
mkdirSync(OUTPUT_DIR, { recursive: true });

// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();

for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const input = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as InputData;
  
  // Validate levels match expected
  const expectedLevels = [0.05, 0.25, 0.5, 0.75, 0.95];
  if (input.levels.length !== expectedLevels.length || 
      input.levels.some((t, j) => t !== expectedLevels[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(input.levels)}, not ${JSON.stringify(expectedLevels)}`);
  }
  
  const forecasts = forecastCase(input);
  const output: OutputData = { hours: forecasts };
  
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(output)}\n`);
}