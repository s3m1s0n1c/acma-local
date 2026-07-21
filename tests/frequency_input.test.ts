import { normalizeFrequencyPoint, normalizeFrequencyRange } from '../src/frequency_input.js';

describe('frequency input normalization', () => {
    test('accepts a MHz range without requiring the caller to convert it', () => {
        expect(normalizeFrequencyRange({
            freq_min_mhz: 476.425,
            freq_max_mhz: 477.4125,
        })).toEqual({
            input_unit: 'MHz',
            input_min: 476.425,
            input_max: 477.4125,
            freq_min_hz: 476_425_000,
            freq_max_hz: 477_412_500,
            freq_min_mhz: 476.425,
            freq_max_mhz: 477.4125,
        });
    });

    test('keeps existing Hz range inputs compatible', () => {
        const result = normalizeFrequencyRange({
            freq_min_hz: 476_425_000,
            freq_max_hz: 477_412_500,
        });
        expect(result.input_unit).toBe('Hz');
        expect(result.freq_min_hz).toBe(476_425_000);
        expect(result.freq_max_hz).toBe(477_412_500);
    });

    test('defaults an omitted upper bound to an exact-frequency search', () => {
        const result = normalizeFrequencyRange({ freq_min_mhz: 476.625 });
        expect(result.freq_min_hz).toBe(476_625_000);
        expect(result.freq_max_hz).toBe(476_625_000);
    });

    test('sorts reversed range bounds', () => {
        const result = normalizeFrequencyRange({
            freq_min_mhz: 477.4125,
            freq_max_mhz: 476.425,
        });
        expect(result.freq_min_hz).toBe(476_425_000);
        expect(result.freq_max_hz).toBe(477_412_500);
    });

    test('rejects mixed Hz and MHz fields', () => {
        expect(() => normalizeFrequencyRange({
            freq_min_mhz: 476.425,
            freq_max_hz: 477_412_500,
        })).toThrow(/either the \*_hz fields or the \*_mhz fields/i);
    });

    test('normalizes one MHz allocation lookup', () => {
        expect(normalizeFrequencyPoint({ freq_mhz: 87.1 })).toEqual({
            input_unit: 'MHz',
            input_value: 87.1,
            freq_hz: 87_100_000,
            freq_mhz: 87.1,
        });
    });

    test('rejects mixed point inputs', () => {
        expect(() => normalizeFrequencyPoint({
            freq_hz: 87_100_000,
            freq_mhz: 87.1,
        })).toThrow(/either freq_hz or freq_mhz/i);
    });
});
