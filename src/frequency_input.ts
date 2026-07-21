export interface FrequencyRangeInput {
    freq_min_hz?: unknown;
    freq_max_hz?: unknown;
    freq_min_mhz?: unknown;
    freq_max_mhz?: unknown;
}

export interface FrequencyPointInput {
    freq_hz?: unknown;
    freq_mhz?: unknown;
}

export interface NormalizedFrequencyRange {
    input_unit: 'Hz' | 'MHz';
    input_min: number;
    input_max: number;
    freq_min_hz: number;
    freq_max_hz: number;
    freq_min_mhz: number;
    freq_max_mhz: number;
}

export interface NormalizedFrequencyPoint {
    input_unit: 'Hz' | 'MHz';
    input_value: number;
    freq_hz: number;
    freq_mhz: number;
}

function positiveNumber(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${field} must be a positive number.`);
    }
    return value;
}

function mhzToHz(value: number): number {
    // RRL frequency fields are stored as integer Hz. Rounding also avoids
    // floating-point artefacts such as 476.425 * 1e6 = 476424999.99999994.
    return Math.round(value * 1_000_000);
}

/**
 * Accept a range expressed entirely in Hz or entirely in MHz and return both
 * representations. Keeping the unit in the field name means an MCP client
 * never has to infer a unit or perform its own conversion.
 */
export function normalizeFrequencyRange(input: FrequencyRangeInput): NormalizedFrequencyRange {
    const hasHz = input.freq_min_hz !== undefined || input.freq_max_hz !== undefined;
    const hasMhz = input.freq_min_mhz !== undefined || input.freq_max_mhz !== undefined;

    if (hasHz && hasMhz) {
        throw new Error('Use either the *_hz fields or the *_mhz fields, not both.');
    }
    if (!hasHz && !hasMhz) {
        throw new Error('Provide freq_min_hz or freq_min_mhz.');
    }

    const unit = hasMhz ? 'MHz' : 'Hz';
    const minField = hasMhz ? 'freq_min_mhz' : 'freq_min_hz';
    const maxField = hasMhz ? 'freq_max_mhz' : 'freq_max_hz';
    const rawMin = positiveNumber(input[minField], minField);
    const rawMax = input[maxField] === undefined ? rawMin : positiveNumber(input[maxField], maxField);
    const inputMin = Math.min(rawMin, rawMax);
    const inputMax = Math.max(rawMin, rawMax);
    const minHz = hasMhz ? mhzToHz(inputMin) : inputMin;
    const maxHz = hasMhz ? mhzToHz(inputMax) : inputMax;

    return {
        input_unit: unit,
        input_min: inputMin,
        input_max: inputMax,
        freq_min_hz: minHz,
        freq_max_hz: maxHz,
        freq_min_mhz: minHz / 1_000_000,
        freq_max_mhz: maxHz / 1_000_000,
    };
}

/** Normalize one frequency supplied as either freq_hz or freq_mhz. */
export function normalizeFrequencyPoint(input: FrequencyPointInput): NormalizedFrequencyPoint {
    const hasHz = input.freq_hz !== undefined;
    const hasMhz = input.freq_mhz !== undefined;

    if (hasHz && hasMhz) {
        throw new Error('Use either freq_hz or freq_mhz, not both.');
    }
    if (!hasHz && !hasMhz) {
        throw new Error('Provide freq_hz or freq_mhz.');
    }

    const unit = hasMhz ? 'MHz' : 'Hz';
    const field = hasMhz ? 'freq_mhz' : 'freq_hz';
    const value = positiveNumber(input[field], field);
    const hz = hasMhz ? mhzToHz(value) : value;
    return {
        input_unit: unit,
        input_value: value,
        freq_hz: hz,
        freq_mhz: hz / 1_000_000,
    };
}
