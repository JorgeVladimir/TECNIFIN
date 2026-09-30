// Calculos de credito sin base: la tabla francesa en centavos y las bandas de cartera.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  amortizacionFrancesa, aTexto, bandasDesdePlan, cuentaPorBanda, tablaEnTexto,
} from '../src/modules/creditos/calculo.js';
import { readFileSync } from 'node:fs';

test('la tabla francesa suma exactamente el monto y cierra en saldo 0', () => {
  for (const [monto, tasa, plazo] of [['6000', '15', 12], ['3000.55', '22.5', 24], ['100', '0', 7], ['120000', '10', 180]]) {
    const { filas } = amortizacionFrancesa(monto, tasa, plazo);
    const capital = filas.reduce((s, f) => s + f.capital, 0);
    assert.equal(aTexto(capital), Number(monto).toFixed(2), `${monto} a ${plazo}`);
    assert.equal(filas.at(-1).saldo, 0);
    assert.equal(filas.length, plazo);
    assert.ok(filas.every(f => f.capital > 0 && f.interes >= 0));
  }
});

test('cuota de referencia: 6000 al 15 % en 12 meses', () => {
  const t = tablaEnTexto(amortizacionFrancesa('6000', '15', 12));
  // 6000 * 0.0125 / (1 - 1.0125^-12) = 541.5487... -> 541.55
  assert.equal(t.cuota, '541.55');
  assert.equal(t.cuotas[0].interes, '75.00');
  assert.equal(t.cuotas[0].capital, '466.55');
  assert.equal(t.totalPagar, (6000 + Number(t.totalInteres)).toFixed(2));
});

test('entradas fuera de rango se rechazan', () => {
  assert.throws(() => amortizacionFrancesa('0', '10', 12), RangeError);
  assert.throws(() => amortizacionFrancesa('100', '10', 0), RangeError);
  assert.throws(() => amortizacionFrancesa('100', '-1', 12), RangeError);
});

test('las bandas salen del catalogo y no son simetricas entre familias', () => {
  const plan = JSON.parse(readFileSync(new URL('../db/seeds/plan_cuentas_seps.json', import.meta.url)));
  const bandas = bandasDesdePlan((plan.filas || plan).filter(c => c.codigo.length === 6 && c.codigo >= '1401' && c.codigo < '1429'));
  assert.equal(cuentaPorBanda(bandas, '1402', 30), '140205');
  assert.equal(cuentaPorBanda(bandas, '1402', 31), '140210');
  assert.equal(cuentaPorBanda(bandas, '1402', 361), '140225');
  assert.equal(cuentaPorBanda(bandas, '1422', 300), bandas['1422'].at(-1).codigo, '1422 corta en 270');
  assert.equal(bandas['1423'].length, 6);
  assert.equal(cuentaPorBanda(bandas, '1402', 0), '140205', 'la banda mas baja arranca en 1');
  assert.equal(cuentaPorBanda(bandas, '9999', 10), null, 'sin bandas no se inventa cuenta');
});
