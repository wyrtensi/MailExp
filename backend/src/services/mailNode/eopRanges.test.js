import { describe, expect, it } from 'vitest';
import { EOP_RANGES, eopRangeList, isEopAddress, networkOf, networksOverlap, rangesFromEndpoints } from './eopRanges.js';

describe('networksOverlap', () => {
  it('finds a network that holds a range, one inside it, and the same one', () => {
    expect(networksOverlap('40.0.0.0/8', '40.92.0.0/15')).toBe(true);
    expect(networksOverlap('40.92.5.0/24', '40.92.0.0/15')).toBe(true);
    expect(networksOverlap('40.93.255.1', '40.92.0.0/15')).toBe(true);
    expect(networksOverlap('40.92.0.0/15', '40.92.0.0/15')).toBe(true);
    expect(networksOverlap('2a01:111::/32', '2a01:111:f400::/48')).toBe(true);
    expect(networksOverlap('2A01:111:F400:0:0:0:0:25', '2a01:111:f400::/48')).toBe(true);
  });

  it('keeps apart networks that share no address, other families and anything that is no network', () => {
    expect(networksOverlap('40.94.0.0/16', '40.92.0.0/15')).toBe(false);
    expect(networksOverlap('198.51.100.7', '40.92.0.0/15')).toBe(false);
    expect(networksOverlap('2a01:111:f401::/48', '2a01:111:f400::/48')).toBe(false);
    expect(networksOverlap('::ffff:40.92.0.1', '40.92.0.0/15')).toBe(false);
    expect(networksOverlap('mail.example.com', '40.92.0.0/15')).toBe(false);
    expect(networkOf('40.92.0.0/33')).toBeNull();
    expect(networkOf('40.92.0.0/15/1')).toBeNull();
  });
});

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

  it('reads a port list with blanks, as the web service writes some', () => {
    expect(rangesFromEndpoints([{ serviceArea: 'Exchange', tcpPorts: '143, 25, 993', ips: ['40.107.0.0/16'] }]))
      .toEqual({ ipv4: ['40.107.0.0/16'], ipv6: [] });
  });
});

describe('eopRangeList', () => {
  it('lists the static ranges, IPv4 first, with their version', () => {
    expect(eopRangeList()).toEqual({
      version: EOP_RANGES.version,
      cidrs: ['40.92.0.0/15', '40.107.0.0/16', '52.100.0.0/14', '104.47.0.0/17', '2a01:111:f400::/48', '2a01:111:f403::/48'],
    });
  });

  it('refuses a list without IPv4 ranges, with a malformed entry or without a version', () => {
    expect(eopRangeList({ version: '2026081400', ipv4: [], ipv6: ['2a01:111:f400::/48'] })).toBeNull();
    for (const bad of ['40.92.0.0', '40.92.0.0/33', '40.92.0.0/x', '300.1.1.1/8', '2a01:111:f400::/129', 'eop.example/24', '', null]) {
      expect(eopRangeList({ version: '2026081400', ipv4: ['40.107.0.0/16', bad], ipv6: [] }), String(bad)).toBeNull();
    }
    expect(eopRangeList({ version: '2026081400', ipv4: ['40.107.0.0/16'], ipv6: ['40.92.0.0/15'] })).toBeNull();
    expect(eopRangeList({ version: '', ipv4: ['40.107.0.0/16'], ipv6: [] })).toBeNull();
    expect(eopRangeList(null)).toBeNull();
  });

  it('refuses a range wider than /8 (IPv4) or /24 (IPv6), as the host timer does', () => {
    expect(eopRangeList({ version: '1', ipv4: ['40.0.0.0/7'], ipv6: [] })).toBeNull();
    expect(eopRangeList({ version: '1', ipv4: ['0.0.0.0/0'], ipv6: [] })).toBeNull();
    expect(eopRangeList({ version: '1', ipv4: ['40.92.0.0/15'], ipv6: ['2a01::/23'] })).toBeNull();
    expect(eopRangeList({ version: '1', ipv4: ['40.0.0.0/8'], ipv6: ['2a01::/24'] })).toEqual({ version: '1', cidrs: ['40.0.0.0/8', '2a01::/24'] });
  });

  it('lowercases IPv6 and drops repeats', () => {
    expect(eopRangeList({ version: '1', ipv4: ['40.107.0.0/16', '40.107.0.0/16'], ipv6: ['2A01:111:F400::/48'] }))
      .toEqual({ version: '1', cidrs: ['40.107.0.0/16', '2a01:111:f400::/48'] });
  });
});
