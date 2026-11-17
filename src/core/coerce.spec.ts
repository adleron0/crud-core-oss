import { describe, expect, it } from 'vitest';

import { coerceId, coerceRow, coerceValue } from './coerce';
import { CrudError } from './crud-error';

const types = {
  rankId: { type: 'number' as const, nullable: false },
  number: { type: 'number' as const, nullable: true },
  price: { type: 'number' as const, nullable: true },
  featured: { type: 'boolean' as const, nullable: false },
  birthDate: { type: 'date' as const, nullable: true },
  faq: { type: 'json' as const, nullable: true },
  name: { type: 'string' as const, nullable: false },
};

describe('coerceRow — corpo multipart (tudo string)', () => {
  // O caso que derrubava todo create/update vindo do front: FormData manda "1".
  it('converte cada campo pelo tipo da coluna', () => {
    expect(coerceRow({ rankId: '1', price: '10.50', featured: 'true', birthDate: '2000-01-02', faq: '[{"q":1}]', name: 'Ana' }, types))
      .toEqual({ rankId: 1, price: 10.5, featured: true, birthDate: new Date('2000-01-02'), faq: [{ q: 1 }], name: 'Ana' });
  });

  it('vazio vira null em coluna nulável e some em coluna obrigatória', () => {
    expect(coerceRow({ number: '', rankId: '' }, types)).toEqual({ number: null });
  });

  it('"null"/"undefined" literais (FormData) são tratados como vazio', () => {
    expect(coerceRow({ number: 'null', price: 'undefined' }, types)).toEqual({ number: null, price: null });
  });

  it('número inválido é 400 com o campo, não 500 do banco', () => {
    try {
      coerceRow({ rankId: 'abc' }, types);
      throw new Error('não lançou');
    } catch (error) {
      expect(error).toBeInstanceOf(CrudError);
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED', field: 'rankId' });
    }
  });

  it('booleano aceita 1/0/on', () => {
    expect(coerceValue('f', '1', 'boolean', false)).toBe(true);
    expect(coerceValue('f', 'off', 'boolean', false)).toBe(false);
    expect(() => coerceValue('f', 'talvez', 'boolean', false)).toThrow(CrudError);
  });

  it('data inválida e JSON inválido são 400', () => {
    expect(() => coerceValue('d', 'ontem', 'date', true)).toThrow(/data/);
    expect(() => coerceValue('j', '{quebrado', 'json', true)).toThrow(/JSON/);
  });

  it('valores já tipados (JSON body) passam intactos', () => {
    expect(coerceRow({ rankId: 3, featured: false, faq: { a: 1 } }, types)).toEqual({ rankId: 3, featured: false, faq: { a: 1 } });
  });

  it('campo sem metadado passa como veio', () => {
    expect(coerceRow({ outro: '1' }, types)).toEqual({ outro: '1' });
  });
});

describe('coerceId — :id da URL', () => {
  it('pk numérica: "42" vira 42', () => expect(coerceId('42', 'number')).toBe(42));
  // GET /student-courses/my-courses caía em /:id e estourava 500 no banco.
  it('pk numérica com texto é NOT_FOUND, não 500', () => {
    expect(() => coerceId('my-courses', 'number')).toThrow(CrudError);
  });
  it('pk texto passa intacta', () => expect(coerceId('abc-uuid', 'string')).toBe('abc-uuid'));
});

describe('coerceRow — listas e enums', () => {
  const t = {
    paymentMethods: { type: 'string' as const, nullable: true, isList: true, enumValues: ['pix', 'boleto', 'cartaoCredito'] },
    kind: { type: 'string' as const, nullable: false, enumValues: ['a', 'b'] },
    tags: { type: 'string' as const, nullable: true, isList: true },
  };
  // fails-without: o campo de lista era ignorado e a turma salvava sem métodos.
  it('CSV do multipart vira lista tipada', () => {
    expect(coerceRow({ paymentMethods: 'pix, boleto' }, t)).toEqual({ paymentMethods: ['pix', 'boleto'] });
  });
  it('array (JSON) e JSON-string também', () => {
    expect(coerceRow({ paymentMethods: ['pix'] }, t)).toEqual({ paymentMethods: ['pix'] });
    expect(coerceRow({ tags: '["x","y"]' }, t)).toEqual({ tags: ['x', 'y'] });
  });
  it('vazio vira lista vazia', () => expect(coerceRow({ paymentMethods: '' }, t)).toEqual({ paymentMethods: [] }));
  it('item fora do enum é 400 com o campo', () => {
    expect(() => coerceRow({ paymentMethods: 'pix,dinheiro' }, t)).toThrow(/aceita/);
  });
  it('enum escalar valida o valor', () => {
    expect(coerceRow({ kind: 'a' }, t)).toEqual({ kind: 'a' });
    expect(() => coerceRow({ kind: 'z' }, t)).toThrow(CrudError);
  });
});
