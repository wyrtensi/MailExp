import { describe, expect, it } from 'vitest';
import { EOP_RANGES, isEopAddress, rangesFromEndpoints } from './eopRanges.js';

describe('isEopAddress', () => {
  it('finds addresses inside the published IPv4 and IPv6 ranges', () => {
    for (const ip of ['40.92.1.1', '40.93.255.254', '40.107.22.5', '52.100.0.1', '52.103.255.255', '104.47.127.1', '2a01:111:f400::25', '2a01:111:f403:c800::1']) {
      expect(isEopAddress(ip), ip).toBe(true);
    }
  });

  it('leaves out everything else and anything that is no address', () => {
    for (const value of ['40.94.0.1', '52.104.0.1', '104.47.128.1', '172.22.1.13', '2a01:111:f401::1', 'eop.test.local', '', null, undefined]) {
      expect(isEopAddress(value), String(value)).toBe(false);
    }
  });

  it('takes the ranges of a test instead of the static list', () => {
    expect(isEopAddress('172.22.1.13', { ipv4: ['172.22.1.0/24'], ipv6: [] })).toBe(true);
  });

  it('names its source and version', () => {
    expect(EOP_RANGES.version).toMatch(/^\d{10}$/);
    expect(EOP_RANGES.source).toContain('endpoints.office.com');
  });
});

describe('rangesFromEndpoints', () => {
  it('takes the Exchange entries with TCP 25 only, whatever their id, and skips unknown fields', () => {
    const endpoints = [
      { id: 1, serviceArea: 'Exchange', tcpPorts: '80,443', ips: ['13.107.6.152/31'] },
      { id: 10, serviceArea: 'Exchange', tcpPorts: '25', ips: ['40.92.0.0/15', '2a01:111:f400::/48'], urls: ['*.mail.protection.outlook.com'], somethingNew: true },
      { id: 11, serviceArea: 'Exchange', tcpPorts: '25,587', ips: ['52.100.0.0/14'] },
      { id: 56, serviceArea: 'Common', tcpPorts: '25', ips: ['20.190.128.0/18'] },
    ];
    expect(rangesFromEndpoints(endpoints)).toEqual({ ipv4: ['40.92.0.0/15', '52.100.0.0/14'], ipv6: ['2a01:111:f400::/48'] });
    expect(rangesFromEndpoints(null)).toEqual({ ipv4: [], ipv6: [] });
  });
});
