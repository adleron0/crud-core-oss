import { describe, expect, it } from 'vitest';

import { aggregateFields, parseAggregateSpec, toLegacyShape } from './aggregate';

describe('parseAggregateSpec — formato herdado', () => {
  it('campo:count:sum:valor', () => {
    expect(parseAggregateSpec('status:count:sum:value')).toEqual({
      groupBy: 'status',
      count: true,
      sum: ['value'],
    });
  });

  it('múltiplos campos por operação em CSV', () => {
    expect(parseAggregateSpec('status:sum:value,discount')).toEqual({
      groupBy: 'status',
      count: false,
      sum: ['value', 'discount'],
    });
  });

  it('operações combinadas', () => {
    expect(parseAggregateSpec('status:sum:value:avg:score:max:value')).toEqual({
      groupBy: 'status',
      count: false,
      sum: ['value'],
      avg: ['score'],
      max: ['value'],
    });
  });

  it('sem operação assume count', () => {
    expect(parseAggregateSpec('status')).toEqual({ groupBy: 'status', count: true });
  });

  it('operação desconhecida é erro, não silêncio', () => {
    expect(() => parseAggregateSpec('status:mediana:value')).toThrow(/desconhecida/);
  });

  it('operação sem campos é erro', () => {
    expect(() => parseAggregateSpec('status:sum')).toThrow(/sem campos/);
  });

  it('sem campo de agrupamento é erro', () => {
    expect(() => parseAggregateSpec('')).toThrow(/agrupamento/);
  });
});

describe('aggregateFields', () => {
  it('lista todo campo citado — é o que passa pela allowlist', () => {
    expect(aggregateFields(parseAggregateSpec('status:count:sum:value,discount:max:score'))).toEqual([
      'status',
      'value',
      'discount',
      'score',
    ]);
  });
});

describe('toLegacyShape', () => {
  it('produz o mapa por valor de grupo com as chaves _count/_sum', () => {
    expect(
      toLegacyShape([
        { key: 'pending', count: 2, sum: { value: 30 } },
        { key: 'paid', count: 1, sum: { value: 100 } },
      ]),
    ).toEqual({
      pending: { _count: 2, _sum: { value: 30 } },
      paid: { _count: 1, _sum: { value: 100 } },
    });
  });

  it('omite blocos ausentes', () => {
    expect(toLegacyShape([{ key: 1, count: 5 }])).toEqual({ '1': { _count: 5 } });
  });
});
