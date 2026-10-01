import { describe, it, expect } from 'vitest';
import { eopCategory } from './antispamReport.js';
import { parseRawHeaders } from '../services/messageParser.js';

const REPORT = 'CIP:203.0.113.5;CTRY:US;LANG:en;SCL:9;SRV:;IPV:NLI;SFV:SPM;H:mail.example.com;PTR:mail.example.com;CAT:PHSH;SFS:(13230040)(8096899003);DIR:INB;';

describe('eopCategory', () => {
  it('reads CAT from the report', () => {
    expect(eopCategory(REPORT)).toBe('PHSH');
    expect(eopCategory('SFV:SPM;CAT:SPM;DIR:INB')).toBe('SPM');
  });

  it('reads a report folded over several lines', () => {
    const raw = [
      'From: a@example.com',
      'X-Forefront-Antispam-Report: CIP:203.0.113.5;CTRY:US;SFV:SPM;',
      '\tH:mail.example.com;PTR:mail.example.com;CAT:MALW;',
      ' SFS:(13230040);DIR:INB;',
      'Subject: x',
      '',
    ].join('\r\n');
    expect(eopCategory(parseRawHeaders(raw)['x-forefront-antispam-report'])).toBe('MALW');
  });

  it('keeps the most dangerous category when the header comes more than once', () => {
    const raw = [
      'X-Forefront-Antispam-Report: SFV:NSPM;CAT:NONE;',
      'X-Forefront-Antispam-Report: SFV:SKQ;CAT:HPHISH;',
      '',
    ].join('\r\n');
    expect(eopCategory(parseRawHeaders(raw)['x-forefront-antispam-report'])).toBe('HPHISH');
  });

  it('reads a comma list of categories and upper-cases them', () => {
    expect(eopCategory('SFV:SPM;cat:bulk,spoof;')).toBe('SPOOF');
    expect(eopCategory('CAT: hspm ;')).toBe('HSPM');
  });

  it('ranks the Defender categories: malware over impersonation over spoofing', () => {
    expect(eopCategory('CAT:SPOOF,UIMP;')).toBe('UIMP');
    expect(eopCategory('CAT:DIMP,SAP;')).toBe('SAP');
    expect(eopCategory('CAT:INTOS;')).toBe('INTOS');
    expect(eopCategory('CAT:FTBP;')).toBe('FTBP');
  });

  it('does not split a value on the space unfolding leaves behind', () => {
    // A fold right after "CAT:" leaves a space before the value: still one category.
    const folded = parseRawHeaders('X-Forefront-Antispam-Report: SFV:SPM;CAT:\r\n PHSH;DIR:INB;\r\n')['x-forefront-antispam-report'];
    expect(eopCategory(folded)).toBe('PHSH');
    // A fold inside the value breaks it: "PH SH" is not a category, and not PH plus SH either.
    const broken = parseRawHeaders('X-Forefront-Antispam-Report: SFV:SPM;CAT:PH\r\n SH;\r\n')['x-forefront-antispam-report'];
    expect(eopCategory(broken)).toBeNull();
    expect(eopCategory('CAT:BULK SPOOF;')).toBeNull();
  });

  it('answers null without a category or with garbage in it', () => {
    expect(eopCategory(null)).toBeNull();
    expect(eopCategory('')).toBeNull();
    expect(eopCategory('SFV:NSPM;SCL:1;DIR:INB')).toBeNull();
    expect(eopCategory('CAT:;')).toBeNull();
    expect(eopCategory('CAT:<script>;')).toBeNull();
    expect(eopCategory('CAT:AVERYLONGCATEGORYNAME;')).toBeNull();
    // A field whose name only ends in CAT is not the category.
    expect(eopCategory('XCAT:PHSH;')).toBeNull();
  });
});
