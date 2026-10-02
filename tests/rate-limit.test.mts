// Tests de src/lib/rate-limit.ts — quel plafond s'applique, et comment lire
// la valeur que bump_rate_limit() renvoie vraiment.
//
// Le fichier est séparé de src/proxy.ts parce que ce dernier importe
// next/server, que `node --test` ne charge pas. Toute la décision (méthode →
// plafond, true = dépassé) vit donc ici, testable sans le proxy.
//
// Exécute avec : node --experimental-strip-types --test tests/rate-limit.test.mts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WRITE_RULE,
  isOverLimit,
  ruleFor,
} from '../src/lib/rate-limit.ts';

describe('ruleFor : seules les écritures sont comptées', () => {
  it('les quatre méthodes d’écriture reçoivent le plafond serré', () => {
    for (const methode of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.deepEqual(ruleFor(methode), WRITE_RULE, methode);
    }
  });

  it('les lectures passent outre', () => {
    for (const methode of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(ruleFor(methode), null, methode);
    }
  });

  it('normalise la casse et les espaces de la méthode', () => {
    assert.deepEqual(ruleFor('post'), WRITE_RULE);
    assert.deepEqual(ruleFor(' DELETE '), WRITE_RULE);
    assert.equal(ruleFor('get'), null);
    assert.equal(ruleFor('  Get  '), null);
  });

  it('10 écritures par minute : le plafond attendu par bump_rate_limit()', () => {
    assert.equal(WRITE_RULE.max, 10);
    assert.equal(WRITE_RULE.windowSeconds, 60);
  });
});

describe('isOverLimit : bump_rate_limit() renvoie l’inverse d’un « autorisé »', () => {
  it('true veut dire DÉPASSÉ, donc refusé', () => {
    assert.equal(isOverLimit(true), true);
  });

  it('false veut dire dans la limite, donc autorisé', () => {
    assert.equal(isOverLimit(false), false);
  });

  it('tout ce qui n’est pas strictement true est autorisé', () => {
    // Un corps absent ou inattendu ne doit jamais couper une inscription :
    // c'est le fail-open écrit dans src/proxy.ts.
    for (const valeur of [null, undefined, 0, 1, 'true', 'false', {}, []]) {
      assert.equal(isOverLimit(valeur), false, JSON.stringify(valeur));
    }
  });

  it('dix appels passent, le onzième est bloqué — sans inversion du booléen', () => {
    // Reproduit `RETURN v_count > p_max` avec p_max = WRITE_RULE.max : la
    // fonction bascule à true à la requête max + 1.
    let compte = 0;
    const autorise = () => !isOverLimit(++compte > WRITE_RULE.max);

    const résultats = Array.from({ length: WRITE_RULE.max + 1 }, () => autorise());
    assert.equal(résultats.filter(Boolean).length, WRITE_RULE.max);
    assert.equal(résultats.at(-1), false);
  });
});
