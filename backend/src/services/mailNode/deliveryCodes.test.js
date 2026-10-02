import { describe, expect, it } from 'vitest';
import { DELIVERY_CODES, explainDeliveryCode, matchDeliveryCodes, statusCodeIn } from './deliveryCodes.js';

const keys = (entries) => entries.map((e) => e.key);

describe('the shared delivery code list', () => {
  it('has the codes R-17 names, each alert key one of the node alerts', () => {
    expect(DELIVERY_CODES.map((e) => [e.key, e.codes, e.alert])).toEqual([
      ['tenant_attribution', ['5.7.64'], 'tenant_attribution'],
      ['connector_blocked', ['5.7.711'], 'connector_blocked'],
      ['terrl_exceeded', ['5.7.233'], 'terrl_exceeded'],
      ['terrl_trial', ['5.7.232'], 'terrl_exceeded'],
      ['recipient_not_accepted', ['5.4.1'], null],
      ['routing_loop', ['5.4.14'], null],
    ]);
  });

  it('matches the exact code, the code standing alone in the text, and AS(2204)', () => {
    expect(keys(matchDeliveryCodes({ code: '5.4.1' }))).toEqual(['recipient_not_accepted']);
    expect(keys(matchDeliveryCodes({ code: '5.0.0', text: '550 5.7.711 Access denied' }))).toEqual(['connector_blocked']);
    expect(keys(matchDeliveryCodes({ text: 'bad inbound connector. AS(2204)' }))).toEqual(['connector_blocked']);
    expect(keys(matchDeliveryCodes({ code: '5.4.14', text: '554 5.4.14 Hop count exceeded - possible mail loop' }))).toEqual(['routing_loop']);
    // Not part of a longer code, an address or 5.4.14.
    expect(matchDeliveryCodes({ code: '4.4.2', text: 'from [5.7.64.12] and 15.7.711.3 and 5.7.2330' })).toEqual([]);
    expect(keys(matchDeliveryCodes({ code: '5.4.14' }))).not.toContain('recipient_not_accepted');
  });

  it('explains a code by its entry, else by its class', () => {
    expect(explainDeliveryCode({ code: '5.4.1', text: '550 5.4.1 Recipient address rejected' })).toEqual({ key: 'recipient_not_accepted', class: 'permanent', code: '5.4.1' });
    expect(explainDeliveryCode({ code: '5.7.232' })).toEqual({ key: 'terrl_trial', class: 'permanent', code: '5.7.232' });
    expect(explainDeliveryCode({ code: '4.7.500', text: '451 4.7.500 Server busy' })).toEqual({ key: 'temporary', class: 'temporary', code: '4.7.500' });
    expect(explainDeliveryCode({ code: '5.1.1' })).toEqual({ key: 'permanent', class: 'permanent', code: '5.1.1' });
    expect(explainDeliveryCode({ text: 'smtp; 550 5.7.64 TenantAttribution' })).toEqual({ key: 'tenant_attribution', class: 'permanent', code: '5.7.64' });
    expect(explainDeliveryCode({ text: 'lost connection' })).toEqual({ key: null, class: null, code: null });
  });

  it('finds the enhanced code in a reply', () => {
    expect(statusCodeIn('550 5.4.1 Recipient address rejected')).toBe('5.4.1');
    expect(statusCodeIn('host x said: 451 4.7.500 Server busy')).toBe('4.7.500');
    expect(statusCodeIn('no code at [5.7.64.12]')).toBeNull();
  });
});
